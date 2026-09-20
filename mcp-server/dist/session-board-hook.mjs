#!/usr/bin/env node

// mcp-server/src/session-board-hook.ts
import { readFileSync } from "node:fs";
import path4 from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

// skills/session-board/scripts/board-store.mjs
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
var SUMMARY_MAX_LENGTH = 200;
var RETAIN_MS = 24 * 36e5;
var READ_ONLY_COMMANDS = /* @__PURE__ */ new Set(["ls", "cat", "pwd", "rg", "grep"]);
var READ_ONLY_GIT = /* @__PURE__ */ new Set(["status", "log", "diff", "show"]);
function openBoard(databasePath, { busyTimeoutMs = 5e3 } = {}) {
  if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });
  const db = new DatabaseSync(databasePath);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)};`);
    if (databasePath !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
    db.exec(`CREATE TABLE IF NOT EXISTS sessions (
      host TEXT NOT NULL,
      session_id TEXT NOT NULL,
      cwd TEXT NOT NULL,
      summary TEXT,
      summary_at TEXT,
      last_prompt_at TEXT,
      denied_for TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (host, session_id)
    ) STRICT;`);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
function touchSession(db, { host, sessionId, cwd, now }) {
  db.prepare(`INSERT INTO sessions (host, session_id, cwd, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (host, session_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at`).run(host, sessionId, cwd, now, now);
}
function recordPrompt(db, session) {
  touchSession(db, session);
  db.prepare("UPDATE sessions SET last_prompt_at = ? WHERE host = ? AND session_id = ?").run(session.now, session.host, session.sessionId);
}
function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line && !/[\r\n]/u.test(line) && line.length <= SUMMARY_MAX_LENGTH ? line : null;
}
function setSummary(db, session, summary) {
  const line = normalizeSummary(summary);
  if (!line) throw new Error(`summary must be one non-empty line of at most ${SUMMARY_MAX_LENGTH} characters`);
  touchSession(db, session);
  db.prepare("UPDATE sessions SET summary = ?, summary_at = ? WHERE host = ? AND session_id = ?").run(line, session.now, session.host, session.sessionId);
  return line;
}
function gateDecision(db, session) {
  touchSession(db, session);
  const row = db.prepare("SELECT summary_at, last_prompt_at, started_at FROM sessions WHERE host = ? AND session_id = ?").get(session.host, session.sessionId);
  const marker = row.last_prompt_at ?? row.started_at;
  if (row.summary_at && row.summary_at >= marker) return "allow";
  const claimed = db.prepare(`UPDATE sessions SET denied_for = ?
    WHERE host = ? AND session_id = ? AND (denied_for IS NULL OR denied_for <> ?)`).run(marker, session.host, session.sessionId, marker);
  return claimed.changes > 0 ? "deny" : "allow";
}
function pruneSessions(db, now) {
  db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
}
function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const text2 = command.trim();
  if (!text2 || /[;&|<>`$@(){}'"\\\r\n]/u.test(text2)) return false;
  const [first, second, ...rest] = text2.split(/\s+/u);
  if ([second, ...rest].some((argument) => /^--(?:output|ext-diff|pre)(?:=|$|-)/u.test(argument ?? ""))) return false;
  if (READ_ONLY_COMMANDS.has(first)) return true;
  if (first !== "git") return false;
  if (READ_ONLY_GIT.has(second)) return true;
  return second === "branch" && (rest.length === 0 || rest.length === 1 && rest[0] === "--list");
}

// mcp-server/src/runtime-config.ts
import { homedir } from "node:os";
import path2 from "node:path";
function sharedUserStateDirectory(environment, homeDirectory) {
  const configured = environment.AGENT_GOVERNANCE_SHARED_STATE_DIR?.trim();
  if (configured) {
    if (!path2.isAbsolute(configured)) {
      throw new Error("AGENT_GOVERNANCE_SHARED_STATE_DIR must be an absolute path.");
    }
    return path2.normalize(configured);
  }
  return path2.resolve(homeDirectory, ".agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(sharedUserStateDirectory(environment, homeDirectory), "session-messaging");
}
function resolveSessionBoardDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  void platform;
  const configured = environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(sharedUserStateDirectory(environment, homeDirectory), "session-board.sqlite3");
}

// mcp-server/src/session-message-client.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path3 from "node:path";
import { performance } from "node:perf_hooks";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

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
    endpoint: path3.join(stateDirectory, "endpoint.json"),
    token: path3.join(stateDirectory, "broker.token"),
    certificate: path3.join(stateDirectory, "broker-cert.pem")
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
function parseWakeMessages(value) {
  if (typeof value !== "string") return { nonces: [], wakeOnly: false };
  const lines = value.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const nonces = [];
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

// mcp-server/src/session-message-relay.ts
var IDENTITY_RECHECK_MS = 10 * 6e4;
var WAKE_BACKOFF_MAX_MS = 10 * 6e4;

// mcp-server/src/host-input-adapter.ts
function text(value) {
  return typeof value === "string" ? value : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function actorObservation(input, host) {
  if (!Object.hasOwn(input, "agent_id")) return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  if (typeof input.agent_id !== "string") return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  return {
    kind: text(input.agent_id) ? "subagent" : "main",
    observedBy: `${host}:hook-payload`,
    assurance: "observed"
  };
}
function adaptHostInput(input, host) {
  const event = text(input.hook_event_name);
  let kind = "unknown";
  let lifecycle = "none";
  let boundaryPhase;
  if (event === "SessionStart") lifecycle = "start";
  else if (event === "SessionEnd") {
    kind = "turn-end";
    lifecycle = "end";
  } else if (event === "UserPromptSubmit") kind = "user-input";
  else if (event === "PreToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "before";
  } else if (event === "PostToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "after";
  } else if (event === "Stop") kind = "turn-end";
  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor: actorObservation(input, host),
      ...boundaryPhase === void 0 ? {} : { boundaryPhase },
      ...kind === "tool-boundary" ? { toolName: text(input.tool_name), toolInput: record(input.tool_input) } : {},
      ...kind === "user-input" ? { wakeCandidates: wake.nonces, wakeOnly: wake.wakeOnly } : {},
      ...workspaceId ? { workspaceId } : {},
      ...collaborationId ? { collaborationId } : {},
      ...role ? { role } : {}
    }
  };
}

// mcp-server/src/input-observation.ts
function isObservedSubagent(observation) {
  return observation.actor.kind === "subagent" && observation.actor.assurance === "observed";
}

// mcp-server/src/session-board-hook.ts
var BOARD_TOOLS = /* @__PURE__ */ new Set(["update_session_status", "list_session_status"]);
var GATED_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "shell", "local_shell", "exec_command", "apply_patch"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "shell", "local_shell", "exec_command"]);
var GATE_REASON = '\uC138\uC158 \uD604\uD669\uD310: \uC774 \uC694\uCCAD\uC5D0\uC11C \uBB34\uC5C7\uC744 \uD558\uB294\uC9C0 \uD55C \uC904\uB85C \uBA3C\uC800 \uC801\uC5B4\uC57C \uD569\uB2C8\uB2E4. update_session_status\uB97C {"schemaVersion":"1.0.0","summary":"<\uBB34\uC5C7\uC744 \xB7 \uC5B4\uB514\uC11C(\uBE0C\uB79C\uCE58) \xB7 \uB2E4\uC74C \uC678\uBD80 \uC791\uC5C5>"}\uB85C \uD638\uCD9C\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uAC19\uC740 \uC791\uC5C5\uC774 \uC774\uC5B4\uC9C0\uBA74 \uAC19\uC740 \uBB38\uC7A5\uB3C4 \uB429\uB2C8\uB2E4. \uB3C4\uAD6C\uB97C \uC4F8 \uC218 \uC5C6\uC73C\uBA74 \uADF8\uB300\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uB2E4\uC74C \uC2DC\uB3C4\uB294 \uD5C8\uC6A9\uB429\uB2C8\uB2E4.';
function preToolUse(permissionDecision, extra) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } };
}
function handleSessionBoardHook(input, board, host, now = (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake = false) {
  const adapted = adaptHostInput(input, host);
  const observation = adapted.observation;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  const session = { host, sessionId, cwd: observation.workspaceId || process.cwd(), now };
  const subagent = isObservedSubagent(observation);
  if (adapted.lifecycle === "start") {
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (observation.kind === "user-input") {
    if (!subagent) {
      pruneSessions(board, now);
      if (verifiedInternalWake) touchSession(board, session);
      else recordPrompt(board, session);
    }
    return {};
  }
  if (observation.kind !== "tool-boundary" || observation.boundaryPhase !== "before") return {};
  const toolName = observation.toolName ?? "";
  const toolInput = observation.toolInput ?? {};
  const localTool = toolName.split("__").at(-1) ?? "";
  if (toolName.startsWith("mcp__") && BOARD_TOOLS.has(localTool)) {
    if (localTool === "update_session_status") {
      if (subagent) return preToolUse("deny", { permissionDecisionReason: "\uC138\uC158 \uD604\uD669\uD310 \uC904\uC740 \uBA54\uC778 \uC138\uC158\uB9CC \uAC31\uC2E0\uD569\uB2C8\uB2E4. \uC11C\uBE0C\uC5D0\uC774\uC804\uD2B8\uB294 update_session_status\uB97C \uD638\uCD9C\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4." });
      if (!normalizeSummary(toolInput.summary)) {
        return preToolUse("deny", { permissionDecisionReason: `summary\uB294 ${SUMMARY_MAX_LENGTH}\uC790 \uC774\uD558\uC758 \uD55C \uC904\uC774\uC5B4\uC57C \uD569\uB2C8\uB2E4.` });
      }
      setSummary(board, session, toolInput.summary);
    }
    return preToolUse("allow", { updatedInput: { ...toolInput, _sessionBinding: { host, sessionId } } });
  }
  if (subagent || !GATED_TOOLS.has(toolName)) return {};
  if (SHELL_TOOLS.has(toolName) && isReadOnlyCommand(toolInput.command)) return {};
  return gateDecision(board, session) === "deny" ? preToolUse("deny", { permissionDecisionReason: GATE_REASON }) : {};
}
async function runSessionBoardHook(host, raw) {
  let board = null;
  try {
    const input = JSON.parse(raw);
    const observation = adaptHostInput(input, host).observation;
    let verifiedInternalWake = false;
    if (observation.kind === "user-input") {
      const nonces = observation.wakeCandidates ?? [];
      const sessionId = observation.sessionId;
      let allRecognized = nonces.length > 0;
      if (sessionId) {
        for (const nonce of nonces) {
          try {
            const result = await sessionMessageRequest("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result.consumed;
          } catch {
            allRecognized = false;
          }
        }
      } else allRecognized = false;
      verifiedInternalWake = observation.wakeOnly === true && allRecognized;
    }
    board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    const output = handleSessionBoardHook(input, board, host, (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake);
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch {
    return "";
  } finally {
    try {
      board?.close();
    } catch {
    }
  }
}
if (path4.resolve(process.argv[1] ?? "") === fileURLToPath2(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  void runSessionBoardHook("codex", raw).then((output) => {
    if (output) process.stdout.write(output);
  });
}
export {
  GATE_REASON,
  handleSessionBoardHook,
  runSessionBoardHook
};
