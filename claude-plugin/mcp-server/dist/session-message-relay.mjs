#!/usr/bin/env node

// mcp-server/src/session-message-relay.ts
import { execFile } from "node:child_process";
import net from "node:net";
import path3 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
import { randomUUID } from "node:crypto";

// mcp-server/src/session-message-client.ts
import { randomBytes } from "node:crypto";
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
var WAKE_PREFIX = "[agent-governance-suite:wake:";
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
  return signal.reason instanceof Error ? signal.reason : deadlineError(deadlineMetadata.get(signal)?.message ?? SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE);
}
function throwIfAborted(signal) {
  if (signal?.aborted) throw signalError(signal);
}
function remainingMilliseconds(deadline, signal, message = SESSION_MESSAGE_REQUEST_DEADLINE_MESSAGE) {
  throwIfAborted(signal);
  const inherited = signal ? deadlineMetadata.get(signal) : void 0;
  const remaining = (inherited?.deadline ?? deadline) - performance.now();
  if (remaining < 1) throw deadlineError(inherited?.message ?? message);
  return remaining;
}
function assertWithinDeadline(deadline, signal, message) {
  remainingMilliseconds(deadline, signal, message);
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
      assertWithinDeadline(deadline, signal, BROKER_STARTUP_DEADLINE_MESSAGE);
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
function wakeMessage(nonce) {
  return `${WAKE_PREFIX}${nonce}]`;
}
function newWakeNonce() {
  return randomBytes(24).toString("base64url");
}

// mcp-server/src/process-identity.ts
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
function processStartToken(pid, platform = process.platform) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    if (platform === "win32") {
      return execFileSync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`
      ], { encoding: "utf8", windowsHide: true, timeout: 5e3, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    }
    if (platform === "linux") {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/u);
      return fields[19] ?? null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 3e3, stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function processExists(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function processIdentityState(pid, expectedStartToken, readStartToken = processStartToken) {
  if (!expectedStartToken) return "mismatch";
  if (!processExists(pid)) return "mismatch";
  const actual = readStartToken(pid);
  if (actual === null) return "unknown";
  return actual === expectedStartToken ? "match" : "mismatch";
}

// mcp-server/src/session-message-relay.ts
var LOOP_MS = 5e3;
var IDENTITY_RECHECK_MS = 10 * 6e4;
var IDENTITY_RETRY_MS = 6e4;
var IDENTITY_UNKNOWN_LIMIT = 3;
var WAKE_BACKOFF_BASE_MS = 3e4;
var WAKE_BACKOFF_MAX_MS = 10 * 6e4;
function wakeBackoffDelay(attempt) {
  return Math.min(WAKE_BACKOFF_MAX_MS, WAKE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt));
}
function relayIdentityDecision(identity, previousUnknowns) {
  if (identity === "mismatch") return { proceed: false, stop: true, unknowns: 0 };
  if (identity === "match") return { proceed: true, stop: false, unknowns: 0 };
  const unknowns = previousUnknowns + 1;
  return { proceed: false, stop: unknowns >= IDENTITY_UNKNOWN_LIMIT, unknowns };
}
function transportWakeCapabilities(transport) {
  if (transport === "claude-inbox") return { wakeVisibility: "silent", canWakeSilently: true };
  if (transport === "codex-queue") return { wakeVisibility: "user-message", canWakeSilently: false };
  return { wakeVisibility: "none", canWakeSilently: false };
}
function codexWakeOutcome(error, spawned) {
  return !error ? "submitted" : spawned ? "accepted-or-unknown" : "definite-failure";
}
function claudeWakeOutcome(hadError, connected, wrote) {
  return !hadError && wrote ? "submitted" : connected || wrote ? "accepted-or-unknown" : "definite-failure";
}
function shouldReleaseWake(outcome) {
  return outcome === "definite-failure";
}
function wakeRetryState(outcome, released, attempt, now) {
  const retry = outcome === "definite-failure" && released;
  return {
    retry,
    nextRingAt: retry ? now + wakeBackoffDelay(attempt) : 0,
    ringAttempts: retry ? attempt + 1 : 0
  };
}
function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}
async function ringCodex(sessionId, message) {
  return new Promise((resolve) => {
    let spawned = false;
    const child = execFile("codex", ["queue", "--thread", sessionId, "--message", message], { windowsHide: true, timeout: 1e4 }, (error) => resolve(codexWakeOutcome(error, spawned)));
    child.once("spawn", () => {
      spawned = true;
    });
  });
}
async function ringClaude(message) {
  const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath || !token) return "definite-failure";
  return new Promise((resolve) => {
    let settled = false;
    let connected = false;
    let wrote = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const socket = net.createConnection(socketPath);
    socket.setTimeout(5e3, () => socket.destroy(new Error("Claude inbox timed out.")));
    socket.once("connect", () => {
      connected = true;
      try {
        wrote = true;
        socket.end(`${JSON.stringify({ type: "auth", token })}
${JSON.stringify({ type: "user", message: { role: "user", content: message }, priority: "now" })}
`);
      } catch {
        finish("accepted-or-unknown");
      }
    });
    socket.once("close", (hadError) => finish(claudeWakeOutcome(hadError, connected, wrote)));
    socket.once("error", () => finish(claudeWakeOutcome(true, connected, wrote)));
  });
}
async function delay2(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function runSessionMessageRelay(options) {
  const target = { host: options.host, sessionId: options.sessionId };
  const relayId = randomUUID();
  let acquired = false;
  let acquisitionUnknowns = 0;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const identity = processIdentityState(options.parentPid, options.parentStartToken);
    const decision = relayIdentityDecision(identity, acquisitionUnknowns);
    acquisitionUnknowns = decision.unknowns;
    if (decision.stop) return;
    try {
      if (decision.proceed) {
        const result = await sessionMessageRequest("acquire-relay", {
          target,
          transport: options.transport,
          relayId,
          pid: process.pid,
          parentPid: options.parentPid
        });
        acquired = result.acquired;
        if (acquired) break;
      }
    } catch {
    }
    await delay2(3e3);
  }
  if (!acquired) return;
  try {
    let retryNonce = null;
    let ringAttempts = 0;
    let nextRingAt = 0;
    let identityUnknowns = 0;
    let nextIdentityCheck = Date.now() + IDENTITY_RECHECK_MS;
    while (true) {
      if (!processExists(options.parentPid)) return;
      const now = Date.now();
      let checkedIdentity = null;
      if (now >= nextIdentityCheck) {
        checkedIdentity = processIdentityState(options.parentPid, options.parentStartToken);
        if (checkedIdentity === "mismatch") return;
        if (checkedIdentity === "unknown") {
          identityUnknowns += 1;
          if (identityUnknowns >= IDENTITY_UNKNOWN_LIMIT) return;
          nextIdentityCheck = now + IDENTITY_RETRY_MS;
        } else {
          identityUnknowns = 0;
          nextIdentityCheck = now + IDENTITY_RECHECK_MS;
        }
      }
      try {
        const heartbeat = await sessionMessageRequest("heartbeat-relay", { target, transport: options.transport, relayId });
        if (!heartbeat.alive) return;
        await sessionMessageRequest("presence-heartbeat", { target, instanceId: options.instanceId });
        if (options.transport === "codex-deferred") {
          await delay2(LOOP_MS);
          continue;
        }
        const pending = await sessionMessageRequest("pending", { target });
        if (pending.count === 0) {
          retryNonce = null;
          ringAttempts = 0;
          nextRingAt = 0;
        } else if (now >= nextRingAt) {
          const identity = checkedIdentity ?? processIdentityState(options.parentPid, options.parentStartToken);
          if (identity === "mismatch") return;
          if (identity === "unknown") {
            if (checkedIdentity === null) identityUnknowns += 1;
            if (identityUnknowns >= IDENTITY_UNKNOWN_LIMIT) return;
            nextIdentityCheck = Math.min(nextIdentityCheck, now + IDENTITY_RETRY_MS);
            nextRingAt = now + IDENTITY_RETRY_MS;
            await delay2(LOOP_MS);
            continue;
          }
          identityUnknowns = 0;
          nextIdentityCheck = now + IDENTITY_RECHECK_MS;
          const nonce = retryNonce ?? newWakeNonce();
          const reservation = await sessionMessageRequest("reserve-wake", { target, nonce });
          if (!reservation.dispatch) {
            retryNonce = null;
            ringAttempts = 0;
            nextRingAt = 0;
          } else {
            const bell = wakeMessage(nonce);
            const outcome = options.transport === "codex-queue" ? await ringCodex(options.sessionId, bell) : await ringClaude(bell);
            let released = false;
            if (shouldReleaseWake(outcome)) {
              const result = await sessionMessageRequest("release-wake", { target, nonce });
              released = result.released;
            }
            const retry = wakeRetryState(outcome, released, ringAttempts, now);
            retryNonce = retry.retry ? nonce : null;
            nextRingAt = retry.nextRingAt;
            ringAttempts = retry.ringAttempts;
          }
        }
      } catch {
      }
      await delay2(LOOP_MS);
    }
  } finally {
    try {
      await sessionMessageRequest("presence-end", {
        target,
        instanceId: options.instanceId,
        reason: "host-process-ended"
      }, void 0, { totalTimeoutMs: 3e3 });
    } catch {
    }
  }
}
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  const host = argument("--host");
  const sessionId = argument("--session-id");
  const instanceId = argument("--instance-id");
  const transport = argument("--transport");
  const parentPid = Number.parseInt(argument("--parent-pid") ?? "", 10);
  const parentStartToken = argument("--parent-start-token");
  if (!host || !sessionId || !instanceId || transport !== "codex-deferred" && transport !== "codex-queue" && transport !== "claude-inbox" || !Number.isInteger(parentPid) || !parentStartToken) process.exitCode = 2;
  else void runSessionMessageRelay({ host, sessionId, instanceId, transport, parentPid, parentStartToken }).catch(() => {
    process.exitCode = 1;
  });
}
export {
  claudeWakeOutcome,
  codexWakeOutcome,
  relayIdentityDecision,
  runSessionMessageRelay,
  shouldReleaseWake,
  transportWakeCapabilities,
  wakeBackoffDelay,
  wakeRetryState
};
