#!/usr/bin/env node

// mcp-server/src/session-message-cli.ts
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// mcp-server/src/session-message-client.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path2 from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path from "node:path";
function sharedUserStateDirectory(environment, homeDirectory) {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path.normalize(configured);
  }
  return path.resolve(homeDirectory, ".agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path.resolve(currentWorkingDirectory, configured);
  return path.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}

// mcp-server/src/session-message-protocol.ts
var SESSION_MESSAGE_PROTOCOL = "1.0.0";
var SESSION_MESSAGE_MAX_REQUEST_BYTES = 32 * 1024;
var SESSION_MESSAGE_MAX_RESPONSE_BYTES = 32 * 1024;

// mcp-server/src/session-message-client.ts
var BrokerRequestRejected = class extends Error {
};
var BROKER_STARTUP_TIMEOUT_MS = 15e3;
var SESSION_MESSAGE_REQUEST_TIMEOUT_MS = 2e4;
var BROKER_REQUEST_TIMEOUT_MS = 2500;
var BROKER_STARTUP_DEADLINE_MESSAGE = "The session message broker did not become ready before the startup deadline.";
var SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE = "The session message request deadline expired.";
var deadlineMetadata = /* @__PURE__ */ new WeakMap();
function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path2.join(stateDirectory, "endpoint.json"),
    token: path2.join(stateDirectory, "broker.token"),
    certificate: path2.join(stateDirectory, "broker-cert.pem")
  };
}
function deadlineError(message) {
  return new Error(message);
}
function signalError(signal) {
  return signal.reason instanceof Error ? signal.reason : deadlineError("The session message request deadline expired.");
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signalError(signal);
}
function remainingMilliseconds(deadline, signal, message = SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE) {
  throwIfAborted(signal);
  const inherited = signal ? deadlineMetadata.get(signal) : void 0;
  const remaining = (inherited?.deadline ?? deadline) - performance.now();
  if (remaining <= 0) throw deadlineError(inherited?.message ?? message);
  return remaining;
}
async function withDeadline(timeoutMs, parentSignal, message, work) {
  const parentDeadline = parentSignal ? deadlineMetadata.get(parentSignal) : void 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw deadlineError(parentDeadline?.message ?? message);
  const now = performance.now();
  const requestedDeadline = now + timeoutMs;
  const inherited = parentDeadline && parentDeadline.deadline <= requestedDeadline ? parentDeadline : void 0;
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
  let removeAbortListener = () => {
  };
  try {
    throwIfAborted(controller.signal);
    const aborted = new Promise((_resolve, reject) => {
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
function sessionMessageBrokerEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}
async function readEndpoint(stateDirectory, signal) {
  throwIfAborted(signal);
  const paths = statePaths(stateDirectory);
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, { encoding: "utf8", signal }),
    readFile(paths.token, { encoding: "utf8", signal }),
    readFile(paths.certificate, { encoding: "utf8", signal })
  ]);
  const endpoint = JSON.parse(rawEndpoint);
  if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL || endpoint.address !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256) || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
    throw new Error("The session message broker endpoint is invalid.");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}
async function requestSessionMessageOnce(operation, payload, stateDirectory, timeoutMs = BROKER_REQUEST_TIMEOUT_MS, parentSignal) {
  return withDeadline(Math.min(BROKER_REQUEST_TIMEOUT_MS, timeoutMs), parentSignal, "The session message broker timed out.", async (signal) => {
    const { endpoint, token, certificate } = await readEndpoint(stateDirectory, signal);
    return new Promise((resolve, reject) => {
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
        checkServerIdentity: (_host, certificate2) => certificate2.fingerprint256 === endpoint.certificateFingerprint256 ? void 0 : new Error("The session message broker certificate pin did not match.")
      });
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
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
        socket.write(`${JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, token, operation, payload })}
`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        if (Buffer.byteLength(buffer, "utf8") > SESSION_MESSAGE_MAX_RESPONSE_BYTES) return finish(new Error("The broker response exceeded its limit."));
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const response = JSON.parse(buffer.slice(0, newline));
          if (!response.ok) finish(new BrokerRequestRejected(response.error || "The broker rejected the request."));
          else finish(void 0, response.data);
        } catch {
          finish(new Error("The broker returned invalid JSON."));
        }
      });
      socket.once("error", (error) => finish(error));
    });
  });
}
async function delay(milliseconds, signal) {
  throwIfAborted(signal);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(finish, milliseconds);
    const onAbort = () => finish(signalError(signal));
    function finish(error) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}
async function waitForSessionMessageBrokerReady(stateDirectory, child, timeoutMs = BROKER_STARTUP_TIMEOUT_MS, parentSignal) {
  return withDeadline(timeoutMs, parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
    let spawnError = null;
    const onError = (error) => {
      spawnError = error;
    };
    child.once("error", onError);
    try {
      while (true) {
        throwIfAborted(signal);
        if (spawnError) throw spawnError;
        if (child.exitCode !== null && child.exitCode !== 0 || child.signalCode !== null) {
          throw new Error(
            `The session message broker exited before it was ready (code ${String(child.exitCode)}, signal ${String(child.signalCode)}).`
          );
        }
        await delay(Math.min(100, remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE)), signal);
        try {
          await requestSessionMessageOnce(
            "ping",
            {},
            stateDirectory,
            remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
            signal
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
async function ensureSessionMessageBroker(stateDirectory = resolveSessionMessageStateDirectory(), timeoutMs = BROKER_STARTUP_TIMEOUT_MS, parentSignal, prepareStateDirectory = async (directory) => {
  await mkdir(directory, { recursive: true, mode: 448 });
  try {
    await chmod(directory, 448);
  } catch {
  }
}) {
  return withDeadline(Math.min(BROKER_STARTUP_TIMEOUT_MS, timeoutMs), parentSignal, BROKER_STARTUP_DEADLINE_MESSAGE, async (signal, deadline) => {
    try {
      await requestSessionMessageOnce(
        "ping",
        {},
        stateDirectory,
        remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
        signal
      );
      return;
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof BrokerRequestRejected) throw error;
      await prepareStateDirectory(stateDirectory);
      throwIfAborted(signal);
      remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
      const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
      const brokerPath = existsSync(adjacentBroker) ? adjacentBroker : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
      const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
        env: sessionMessageBrokerEnvironment()
      });
      child.unref();
      await waitForSessionMessageBrokerReady(
        stateDirectory,
        child,
        remainingMilliseconds(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE),
        signal
      );
    }
  });
}
async function sessionMessageRequest(operation, payload, stateDirectory = resolveSessionMessageStateDirectory(), options = {}) {
  const totalTimeoutMs = options.totalTimeoutMs ?? SESSION_MESSAGE_REQUEST_TIMEOUT_MS;
  return withDeadline(totalTimeoutMs, void 0, SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE, async (signal, deadline) => {
    try {
      return await requestSessionMessageOnce(
        operation,
        payload,
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal
      );
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof BrokerRequestRejected) throw error;
      await ensureSessionMessageBroker(
        stateDirectory,
        remainingMilliseconds(deadline, signal),
        signal,
        options.prepareStateDirectory
      );
      throwIfAborted(signal);
      return requestSessionMessageOnce(operation, payload, stateDirectory, remainingMilliseconds(deadline, signal), signal);
    }
  });
}

// mcp-server/src/session-message-cli.ts
var OPERATIONS = /* @__PURE__ */ new Set(["send", "claim", "acknowledge", "status", "pending"]);
async function runSessionMessageCli(raw, stateDirectory) {
  const request = JSON.parse(raw);
  if (typeof request.operation !== "string" || !OPERATIONS.has(request.operation)) throw new Error("Unsupported session message operation.");
  if (!request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) throw new Error("payload must be an object.");
  const payload = request.payload;
  const normalizedPayload = request.operation === "send" && payload.messageId === void 0 ? { ...payload, messageId: randomUUID() } : payload;
  const data = await sessionMessageRequest(request.operation, normalizedPayload, stateDirectory);
  return { protocolVersion: "1.0.0", ok: true, data };
}
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  void runSessionMessageCli(raw).then(
    (output) => process.stdout.write(`${JSON.stringify(output)}
`),
    (error) => {
      process.stdout.write(`${JSON.stringify({ protocolVersion: "1.0.0", ok: false, error: error instanceof Error ? error.message : "Session message request failed." })}
`);
      process.exitCode = 1;
    }
  );
}
export {
  runSessionMessageCli
};
