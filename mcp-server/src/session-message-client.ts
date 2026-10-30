import { randomBytes } from "node:crypto";
import { types as utilTypes } from "node:util";
import { producerFailureReason, retainFailureCause, retainFailureSecondary, tagProducerFailure } from "./failure-diagnostics.js";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";
import path from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { resolveSessionMessageStateDirectory } from "./runtime-config.js";
import { brokerStartupCode, SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL, SESSION_MESSAGE_CLAIM_OPERATIONS, sessionMessageLineReader } from "./session-message-protocol.js";
import { encodeIdentityDeadline } from "./broker-identity-budget.js";

export { SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";
export const WAKE_PREFIX = "[agent-governance-suite:wake:";

export interface BrokerEndpoint {
  protocolVersion: string;
  claimReceiptVersion?: number;
  address: "127.0.0.1";
  port: number;
  pid: number;
  startedAt: string;
  certificateFingerprint256: string;
}

/** A broker answer, not a transport failure; details is set only for a bounded-capacity rejection. */
export class BrokerRequestRejected extends Error {
  readonly details: { scope: "sender" | "global"; earliestReleaseAt: string | null } | null;

  constructor(message: string, details: unknown = null) {
    super(message);
    tagProducerFailure(this, "BROKER_REQUEST_REJECTED");
    const record = details && typeof details === "object" && !Array.isArray(details) ? details as Record<string, unknown> : null;
    this.details = record && (record.scope === "sender" || record.scope === "global")
      && (record.earliestReleaseAt === null || typeof record.earliestReleaseAt === "string")
      ? { scope: record.scope, earliestReleaseAt: record.earliestReleaseAt }
      : null;
  }
}

const BROKER_STARTUP_TIMEOUT_MS = 15_000;
export const SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 20_000;
const BROKER_REQUEST_TIMEOUT_MS = 2_500;
const BROKER_STARTUP_DEADLINE_MESSAGE = "The session message broker did not become ready before the startup deadline.";
const SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE = "The session message request deadline expired.";
const deadlineMetadata = new WeakMap<AbortSignal, { deadline: number; message: string; enforceDeadline?: boolean }>();

function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path.join(stateDirectory, "endpoint.json"),
    token: path.join(stateDirectory, "broker.token"),
    certificate: path.join(stateDirectory, "broker-cert.pem"),
  };
}

function deadlineError(message: string): Error {
  return tagProducerFailure(new Error(message), "BROKER_DEADLINE_EXPIRED");
}

/** A client operation preserves native Error identity and privately retains other thrown values. */
function clientFailure(reason: string, message: string, cause: unknown): Error {
  return utilTypes.isNativeError(cause) ? tagProducerFailure(cause, reason)
    : retainFailureCause(tagProducerFailure(new Error(message), reason), cause);
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : deadlineMetadata.has(signal) ? deadlineError(deadlineMetadata.get(signal)!.message)
      : retainFailureCause(tagProducerFailure(new Error("The session message operation was aborted."), "BROKER_OPERATION_ABORTED"), signal.reason);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signalError(signal);
}

function remainingMilliseconds(
  deadline: number,
  signal?: AbortSignal,
  message = SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE,
): number {
  throwIfAborted(signal);
  const inherited = signal ? deadlineMetadata.get(signal) : undefined;
  const remaining = (inherited?.deadline ?? deadline) - performance.now();
  if (remaining < 1) throw deadlineError(inherited?.message ?? message);
  return remaining;
}

function assertWithinDeadline(deadline: number, signal: AbortSignal, message: string): void {
  remainingMilliseconds(deadline, signal, message);
}

async function withDeadline<T>(
  timeoutMs: number,
  parentSignal: AbortSignal | undefined,
  message: string,
  work: (signal: AbortSignal, deadline: number) => Promise<T>,
  absoluteDeadline?: number,
): Promise<T> {
  const parentDeadline = parentSignal ? deadlineMetadata.get(parentSignal) : undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineError(parentDeadline?.message ?? message);
  const now = performance.now();
  if (absoluteDeadline !== undefined && !Number.isFinite(absoluteDeadline)) throw deadlineError(message);
  const requestedDeadline = Math.min(now + timeoutMs, absoluteDeadline ?? Infinity);
  const inherited = parentDeadline && parentDeadline.deadline <= requestedDeadline ? parentDeadline : undefined;
  const deadline = inherited?.deadline ?? requestedDeadline;
  const deadlineMessage = inherited?.message ?? message;
  const remaining = deadline - now;
  if (remaining < 1) throw deadlineError(deadlineMessage);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal ? signalError(parentSignal) : deadlineError(message));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  deadlineMetadata.set(controller.signal, { deadline, message: deadlineMessage,
    enforceDeadline: absoluteDeadline !== undefined || parentDeadline?.enforceDeadline === true });
  const timer = setTimeout(() => controller.abort(deadlineError(deadlineMessage)), remaining);
  let removeAbortListener = () => {};
  try {
    throwIfAborted(controller.signal);
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(signalError(controller.signal));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    });
    return await Promise.race([work(controller.signal, deadline), aborted]);
  } finally {
    removeAbortListener();
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", onParentAbort);
  }
}

export function sessionMessageBrokerEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}

async function readEndpoint(stateDirectory?: string, signal?: AbortSignal): Promise<{ endpoint: BrokerEndpoint; token: string; certificate: string }> {
  throwIfAborted(signal);
  const paths = statePaths(stateDirectory);
  let rawEndpoint: string;
  let rawToken: string;
  let certificate: string;
  try {
    [rawEndpoint, rawToken, certificate] = await Promise.all([
      readFile(paths.endpoint, { encoding: "utf8", signal }),
      readFile(paths.token, { encoding: "utf8", signal }),
      readFile(paths.certificate, { encoding: "utf8", signal }),
    ]);
  } catch (cause) {
    // An aborted read reports the abort reason, not a read failure.
    throwIfAborted(signal);
    throw clientFailure("BROKER_ENDPOINT_READ_FAILED", "Cannot read the session message broker endpoint.", cause);
  }
  let endpoint: BrokerEndpoint;
  try {
    endpoint = JSON.parse(rawEndpoint) as BrokerEndpoint;
    if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL
      || endpoint.address !== "127.0.0.1"
      || !Number.isInteger(endpoint.port)
      || endpoint.port < 1
      || endpoint.port > 65535
      || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256)
      || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
      throw new Error("The session message broker endpoint is invalid.");
    }
  } catch (cause) {
    throw clientFailure("BROKER_ENDPOINT_INVALID", "The session message broker endpoint is invalid.", cause);
  }
  if (endpoint.claimReceiptVersion !== 1) {
    throw tagProducerFailure(new Error("The running message broker does not support claim receipts; update its owned runtime before retrying."),
      "BROKER_CLAIM_RECEIPTS_REQUIRED");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}

export async function requestSessionMessageOnce<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory?: string,
  timeoutMs = BROKER_REQUEST_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  options: { enforceDeadline?: boolean; onOperationWrite?: () => void } = {},
): Promise<T> {
  return withDeadline(Math.min(BROKER_REQUEST_TIMEOUT_MS, timeoutMs), parentSignal, "The session message broker timed out.", async (signal, deadline) => {
    const enforceDeadline = options.enforceDeadline === true || deadlineMetadata.get(signal)?.enforceDeadline === true;
    const { endpoint, token, certificate } = await readEndpoint(stateDirectory, signal);
    if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const readLine = sessionMessageLineReader(SESSION_MESSAGE_MAX_RESPONSE_BYTES);
      const socket = tls.connect({
        host: endpoint.address,
        port: endpoint.port,
        ca: certificate,
        servername: "localhost",
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        rejectUnauthorized: true,
        checkServerIdentity: (_host, certificate) => certificate.fingerprint256 === endpoint.certificateFingerprint256
          ? undefined
          : tagProducerFailure(new Error("The session message broker certificate pin did not match."), "BROKER_CERTIFICATE_PIN_MISMATCH"),
      });
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value as T);
      };
      const onAbort = () => finish(signalError(signal));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) return onAbort();
      let writeObserved = false;
      socket.once("secureConnect", () => {
        if (settled) return;
        try {
          if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
          const peer = socket.getPeerCertificate();
          if (!peer.fingerprint256 || peer.fingerprint256 !== endpoint.certificateFingerprint256) {
            finish(tagProducerFailure(new Error("The session message broker certificate pin did not match."), "BROKER_CERTIFICATE_PIN_MISMATCH"));
            return;
          }
          let frame: string;
          try { frame = `${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload,
            ...(SESSION_MESSAGE_CLAIM_OPERATIONS.includes(operation) ? { claimReceiptVersion: 1 } : {}),
            ...(["ensure-relay", "acquire-relay"].includes(operation) ? { identityDeadlineNs: encodeIdentityDeadline(deadline) } : {}) })}\n`; }
          catch (cause) { throw clientFailure("BROKER_REQUEST_ENCODING_FAILED", "Cannot encode the broker request.", cause); }
          if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
          try { socket.write(frame); }
          catch (cause) { throw clientFailure("BROKER_WRITE_FAILED", "The broker write failed.", cause); }
          finally {
            // A false return or synchronous throw can still mean an attempted write.
            if (!writeObserved) {
              writeObserved = true;
              try { Promise.resolve(options.onOperationWrite?.()).catch(() => {}); }
              catch { /* Observation cannot replay an operation or prevent cleanup. */ }
            }
          }
        } catch (error) {
          finish(clientFailure("BROKER_REQUEST_PREPARATION_FAILED", "The broker request preparation failed.", error));
        }
      });
      socket.on("data", (chunk: Buffer) => {
        if (settled) return;
        let line: string | null;
        try { line = readLine(chunk); } catch (cause) { return finish(retainFailureCause(tagProducerFailure(new Error("The broker response exceeded its limit."), "BROKER_RESPONSE_TOO_LARGE"), cause)); }
        if (line === null) return;
        try {
          const response = JSON.parse(line) as { ok: boolean; data?: T; error?: string; details?: unknown };
          if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request.", response.details));
          else {
            if (enforceDeadline) assertWithinDeadline(deadline, signal, "The session message broker timed out.");
            finish(undefined, response.data);
          }
        } catch (error) {
          const failure = enforceDeadline && error instanceof Error ? error : new Error("The broker returned invalid JSON.");
          finish(producerFailureReason(failure) ? failure : failure === error ? tagProducerFailure(failure, "BROKER_RESPONSE_INVALID_JSON")
            : retainFailureCause(tagProducerFailure(failure, "BROKER_RESPONSE_INVALID_JSON"), error));
        }
      });
      socket.once("error", (error) => finish(tagProducerFailure(error, "BROKER_TRANSPORT_FAILED")));
      if (enforceDeadline) {
        const onClosed = () => finish(tagProducerFailure(new Error("The broker connection closed before a complete response."), "BROKER_RESPONSE_INCOMPLETE"));
        socket.once("end", onClosed);
        socket.once("close", onClosed);
      }
    });
  });
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(signalError(signal));
    function finish(error?: Error): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export async function waitForSessionMessageBrokerReady(
  stateDirectory: string,
  child: ChildProcess,
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  startupDiagnostic?: Readable | null,
): Promise<void> {
  let diagnostic = "";
  let diagnosticOverflow = false;
  let diagnosticDone = !startupDiagnostic;
  let diagnosticEnded = false;
  let diagnosticFailed = false;
  const onDiagnosticData = (chunk: Buffer) => {
    if (diagnosticOverflow) return;
    if (Buffer.byteLength(diagnostic, "utf8") + chunk.length > 128) { diagnostic = ""; diagnosticOverflow = true; return; }
    diagnostic += chunk.toString("utf8");
  };
  const onDiagnosticEnd = () => { diagnosticEnded = true; diagnosticDone = true; };
  const onDiagnosticClose = () => { diagnosticDone = true; };
  const onDiagnosticError = () => { diagnosticFailed = true; diagnosticDone = true; };
  startupDiagnostic?.on("data", onDiagnosticData);
  startupDiagnostic?.once("end", onDiagnosticEnd);
  startupDiagnostic?.once("close", onDiagnosticClose);
  startupDiagnostic?.once("error", onDiagnosticError);
  let probeFailed = false;
  let lastProbeFailure: unknown;
  try {
    return await withDeadline(timeoutMs, parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
      let spawnError: Error | null = null;
      const onError = (error: Error) => { spawnError = tagProducerFailure(error, "BROKER_START_FAILED"); };
      child.once("error", onError);
      const retainLastProbe = () => { if (probeFailed) retainFailureSecondary(signal.reason, lastProbeFailure); };
      signal.addEventListener("abort", retainLastProbe, {once: true});
      try {
        while (true) {
          throwIfAborted(signal);
          if (spawnError) throw spawnError;
          if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) {
            // exit can precede the last pipe data; never wait beyond the existing deadline.
            if (startupDiagnostic && !diagnosticDone) await new Promise<void>((resolve) => {
              const done = () => {
                startupDiagnostic.off("end", done); startupDiagnostic.off("close", done);
                startupDiagnostic.off("error", done); signal.removeEventListener("abort", done); resolve();
              };
              startupDiagnostic.once("end", done); startupDiagnostic.once("close", done);
              startupDiagnostic.once("error", done); signal.addEventListener("abort", done, { once: true });
              if (diagnosticDone || signal.aborted) done();
            });
            throwIfAborted(signal);
            const frame = diagnosticEnded && !diagnosticFailed && !diagnosticOverflow ? /^([A-Z0-9_]+)\n$/u.exec(diagnostic) : null;
            const code = brokerStartupCode(frame?.[1]);
            throw tagProducerFailure(new Error(
              `The session message broker exited before it was ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)})${code ? `; startup diagnostic: ${code}` : ""}.`,
            ), "BROKER_EXITED_BEFORE_READY");
          }
          await delay(Math.min(100, remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE)), signal);
          try {
            await requestSessionMessageOnce(
              "ping",
              {},
              stateDirectory,
              remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
              signal,
            );
            if (child.pid !== undefined && child.exitCode === null) {
              const { endpoint } = await readEndpoint(stateDirectory, signal);
              // Another broker can answer while this owned launcher has not entered
              // startup yet. Settle only its own published endpoint or a normal loser exit.
              if (!Number.isSafeInteger(endpoint.pid) || endpoint.pid < 1 || endpoint.pid !== child.pid) continue;
            }
            if (spawnError || child.signalCode !== null || (child.exitCode !== null && child.exitCode !== 0)) continue;
            return;
          } catch (error) {
            if (!signal.aborted) { probeFailed = true; lastProbeFailure = error; }
            throwIfAborted(signal);
            if (error instanceof BrokerRequestRejected) throw error;
          }
        }
      } finally {
        signal.removeEventListener("abort", retainLastProbe);
        child.off("error", onError);
      }
    });
  } catch (error) {
    if (probeFailed) retainFailureSecondary(error, lastProbeFailure);
    throw error;
  } finally {
    startupDiagnostic?.off("data", onDiagnosticData);
    startupDiagnostic?.off("end", onDiagnosticEnd);
    startupDiagnostic?.off("close", onDiagnosticClose);
    startupDiagnostic?.off("error", onDiagnosticError);
    startupDiagnostic?.destroy();
  }
}

export async function ensureSessionMessageBroker(
  stateDirectory = resolveSessionMessageStateDirectory(),
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  prepareStateDirectory?: (directory: string) => Promise<void>,
): Promise<void> {
  return withDeadline(Math.min(BROKER_STARTUP_TIMEOUT_MS, timeoutMs), parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
    try {
      await requestSessionMessageOnce(
        "ping",
        {},
        stateDirectory,
        remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
        signal,
      );
      return;
    } catch (error) {
      const retainInitialFailure = () => { retainFailureSecondary(signal.reason, error); };
      signal.addEventListener("abort", retainInitialFailure, {once: true});
      try {
        throwIfAborted(signal);
        if (error instanceof BrokerRequestRejected || producerFailureReason(error) === "BROKER_CLAIM_RECEIPTS_REQUIRED") throw error;
        if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        try {
          if (prepareStateDirectory) await prepareStateDirectory(stateDirectory);
          else await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
        } catch (cause) {
          throw clientFailure("BROKER_STATE_DIRECTORY_FAILED", "Cannot prepare the session message state directory.", cause);
        }
        if (!prepareStateDirectory) {
          if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
          try { await chmod(stateDirectory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
        }
        throwIfAborted(signal);
        assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
        const brokerPath = existsSync(adjacentBroker)
          ? adjacentBroker
          : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
        if (deadlineMetadata.get(signal)?.enforceDeadline) assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
        let child: ChildProcess;
        try {
          child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory,
            "--startup-identity-deadline-ns", encodeIdentityDeadline(deadline), "--startup-diagnostic"], {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", "ignore", "ignore", "pipe"],
            env: sessionMessageBrokerEnvironment(),
          });
        } catch (cause) {
          throw clientFailure("BROKER_START_FAILED", "Cannot start the session message broker.", cause);
        }
        child.unref();
        const diagnostic = child.stdio[3] as Readable | null;
        try {
          await waitForSessionMessageBrokerReady(
            stateDirectory,
            child,
            remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
            signal,
            diagnostic,
          );
        } finally {
          // Also covers a deadline expiring before the readiness function is entered.
          diagnostic?.destroy();
        }
      } catch (recoveryError) { throw retainFailureSecondary(recoveryError, error); }
      finally { signal.removeEventListener("abort", retainInitialFailure); }
    }
  });
}

export async function sessionMessageRequest<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory = resolveSessionMessageStateDirectory(),
  options: {
    totalTimeoutMs?: number;
    prepareStateDirectory?: (directory: string) => Promise<void>;
    /** Same-process performance.now() deadline, never a wall-clock timestamp. */
    deadlineMonotonicMs?: number;
    /** Prepare/ping first, then attempt the target operation once. Lost replies are not replayed. */
    noOperationReplay?: boolean;
    onOperationWrite?: () => void;
  } = {},
): Promise<T> {
  options = { ...options };
  const totalTimeoutMs = options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
  const absoluteDeadline = options.deadlineMonotonicMs ?? (options.noOperationReplay ? performance.now() + totalTimeoutMs : undefined);
  return withDeadline(totalTimeoutMs, undefined, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE, async (signal, deadline) => {
    if (options.noOperationReplay) {
      await ensureSessionMessageBroker(stateDirectory, remainingMilliseconds(deadline, signal), signal, options.prepareStateDirectory);
      assertWithinDeadline(deadline, signal, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE);
      return requestSessionMessageOnce<T>(operation, payload, stateDirectory, remainingMilliseconds(deadline, signal), signal,
        { enforceDeadline: true, ...(options.onOperationWrite ? { onOperationWrite: options.onOperationWrite } : {}) });
    }
    let operationWriteAttempted = false;
    const onOperationWrite = () => {
      operationWriteAttempted = true;
      return options.onOperationWrite?.();
    };
    try {
      return await requestSessionMessageOnce<T>(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        { enforceDeadline: options.deadlineMonotonicMs !== undefined, onOperationWrite },
      );
    } catch (error) {
      try {
        throwIfAborted(signal);
        // Only issued-ID send has a retained receipt that makes a post-write retry safe.
        if (error instanceof BrokerRequestRejected || (operationWriteAttempted && operation !== "send")) throw error;
        await ensureSessionMessageBroker(
          stateDirectory,
          remainingMilliseconds(deadline, signal),
          signal,
          options.prepareStateDirectory,
        );
        throwIfAborted(signal);
        return await requestSessionMessageOnce<T>(operation, payload, stateDirectory, remainingMilliseconds(deadline, signal), signal,
          { enforceDeadline: options.deadlineMonotonicMs !== undefined, onOperationWrite });
      } catch (recoveryError) { throw retainFailureSecondary(recoveryError, error); }
    }
  }, absoluteDeadline);
}

export function wakeMessage(nonce: string): string {
  return `${WAKE_PREFIX}${nonce}]`;
}

export function parseWakeMessages(value: unknown): { nonces: string[]; wakeOnly: boolean } {
  if (typeof value !== "string") return { nonces: [], wakeOnly: false };
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const nonces: string[] = [];
  let wakeOnly = lines.length > 0;
  for (const line of lines) {
    if (!line.startsWith(WAKE_PREFIX) || !line.endsWith("]")) {
      wakeOnly = false;
      continue;
    }
    const nonce = line.slice(WAKE_PREFIX.length, -1);
    if (!/^[A-Za-z0-9_-]{22,128}$/u.test(nonce)) {
      wakeOnly = false;
      continue;
    }
    nonces.push(nonce);
  }
  return { nonces: [...new Set(nonces)], wakeOnly };
}

export function newWakeNonce(): string {
  return randomBytes(24).toString("base64url");
}
