import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { resolveSessionMessageStateDirectory } from "./runtime-config.js";
import { SESSION_MESSAGE_MAX_RESPONSE_BYTES, SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";

export { SESSION_MESSAGE_PROTOCOL } from "./session-message-protocol.js";
export const WAKE_PREFIX = "[agent-governance-suite:wake:";

export interface BrokerEndpoint {
  protocolVersion: string;
  address: "127.0.0.1";
  port: number;
  pid: number;
  startedAt: string;
  certificateFingerprint256: string;
}

class BrokerRequestRejected extends Error {}

const BROKER_STARTUP_TIMEOUT_MS = 15_000;
const SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 20_000;
const BROKER_REQUEST_TIMEOUT_MS = 2_500;
const BROKER_STARTUP_DEADLINE_MESSAGE = "The session message broker did not become ready before the startup deadline.";
const SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE = "The session message request deadline expired.";
const deadlineMetadata = new WeakMap<AbortSignal, { deadline: number; message: string }>();

function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path.join(stateDirectory, "endpoint.json"),
    token: path.join(stateDirectory, "broker.token"),
    certificate: path.join(stateDirectory, "broker-cert.pem"),
  };
}

function deadlineError(message: string): Error {
  return new Error(message);
}

function signalError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : deadlineError(deadlineMetadata.get(signal)?.message ?? SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE);
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
): Promise<T> {
  const parentDeadline = parentSignal ? deadlineMetadata.get(parentSignal) : undefined;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineError(parentDeadline?.message ?? message);
  const now = performance.now();
  const requestedDeadline = now + timeoutMs;
  const inherited = parentDeadline && parentDeadline.deadline <= requestedDeadline ? parentDeadline : undefined;
  const deadline = inherited?.deadline ?? requestedDeadline;
  const deadlineMessage = inherited?.message ?? message;
  const remaining = deadline - now;
  if (remaining < 1) throw deadlineError(deadlineMessage);
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parentSignal ? signalError(parentSignal) : deadlineError(message));
  if (parentSignal?.aborted) onParentAbort();
  else parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  deadlineMetadata.set(controller.signal, { deadline, message: deadlineMessage });
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
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, { encoding: "utf8", signal }),
    readFile(paths.token, { encoding: "utf8", signal }),
    readFile(paths.certificate, { encoding: "utf8", signal }),
  ]);
  const endpoint = JSON.parse(rawEndpoint) as BrokerEndpoint;
  if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL
    || endpoint.address !== "127.0.0.1"
    || !Number.isInteger(endpoint.port)
    || endpoint.port < 1
    || endpoint.port > 65535
    || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256)
    || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
    throw new Error("The session message broker endpoint is invalid.");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}

export async function requestSessionMessageOnce<T>(
  operation: string,
  payload: Record<string, unknown>,
  stateDirectory?: string,
  timeoutMs = BROKER_REQUEST_TIMEOUT_MS,
  parentSignal?: AbortSignal,
): Promise<T> {
  return withDeadline(Math.min(BROKER_REQUEST_TIMEOUT_MS, timeoutMs), parentSignal, "The session message broker timed out.", async (signal) => {
    const { endpoint, token, certificate } = await readEndpoint(stateDirectory, signal);
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let buffer = "";
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
          : new Error("The session message broker certificate pin did not match."),
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
      socket.once("secureConnect", () => {
        const peer = socket.getPeerCertificate();
        if (!peer.fingerprint256 || peer.fingerprint256 !== endpoint.certificateFingerprint256) {
          finish(new Error("The session message broker certificate pin did not match."));
          return;
        }
        socket.write(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload })}\n`);
      });
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) return finish(new Error("The broker response exceeded its limit."));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline)) as { ok: boolean; data?: T; error?: string };
          if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request."));
          else finish(undefined, response.data);
        } catch {
          finish(new Error("The broker returned invalid JSON."));
        }
      });
      socket.once("error", (error) => finish(error));
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
): Promise<void> {
  return withDeadline(timeoutMs, parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
    let spawnError: Error | null = null;
    const onError = (error: Error) => { spawnError = error; };
    child.once("error", onError);
    try {
      while (true) {
        throwIfAborted(signal);
        if (spawnError) throw spawnError;
        if ((child.exitCode !== null && child.exitCode !== 0) || child.signalCode !== null) {
          throw new Error(
            `The session message broker exited before it was ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`,
          );
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
          return;
        } catch (error) {
          throwIfAborted(signal);
          if (error instanceof BrokerRequestRejected) throw error;
        }
      }
    } finally {
      child.off("error", onError);
    }
  });
}

export async function ensureSessionMessageBroker(
  stateDirectory = resolveSessionMessageStateDirectory(),
  timeoutMs = BROKER_STARTUP_TIMEOUT_MS,
  parentSignal?: AbortSignal,
  prepareStateDirectory: (directory: string) => Promise<void> = async (directory) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await chmod(directory, 0o700); } catch { /* Windows ACLs remain governed by the user profile. */ }
  },
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
      throwIfAborted(signal);
      if (error instanceof BrokerRequestRejected) throw error;
      await prepareStateDirectory(stateDirectory);
      throwIfAborted(signal);
      assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
      const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
      const brokerPath = existsSync(adjacentBroker)
        ? adjacentBroker
        : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
      const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: sessionMessageBrokerEnvironment(),
      });
      child.unref();
      await waitForSessionMessageBrokerReady(
        stateDirectory,
        child,
        remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
        signal,
      );
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
  } = {},
): Promise<T> {
  const totalTimeoutMs = options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
  return withDeadline(totalTimeoutMs, undefined, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE, async (signal, deadline) => {
    try {
      return await requestSessionMessageOnce<T>(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof BrokerRequestRejected) throw error;
      await ensureSessionMessageBroker(
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        options.prepareStateDirectory,
      );
      throwIfAborted(signal);
      return requestSessionMessageOnce<T>(operation, payload, stateDirectory, remainingMilliseconds(deadline, signal), signal);
    }
  });
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
