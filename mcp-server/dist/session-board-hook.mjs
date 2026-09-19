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
function userStateDirectory(environment, platform, homeDirectory) {
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path2.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path2.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path2.join(homeDirectory, ".local", "state");
  }
  return path2.resolve(stateRoot, "agent-governance-suite");
}
function resolveSessionMessageStateDirectory(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(userStateDirectory(environment, platform, homeDirectory), "session-messaging");
}
function resolveSessionBoardDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  return path2.join(userStateDirectory(environment, platform, homeDirectory), "session-board.sqlite3");
}

// mcp-server/src/session-message-client.ts
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path3 from "node:path";
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
function statePaths(stateDirectory = resolveSessionMessageStateDirectory()) {
  return {
    stateDirectory,
    endpoint: path3.join(stateDirectory, "endpoint.json"),
    token: path3.join(stateDirectory, "broker.token"),
    certificate: path3.join(stateDirectory, "broker-cert.pem")
  };
}
function sessionMessageBrokerEnvironment(environment = process.env) {
  const sanitized = { ...environment };
  delete sanitized.CLAUDE_CODE_MESSAGING_SOCKET;
  delete sanitized.CLAUDE_CODE_MESSAGING_TOKEN;
  return sanitized;
}
async function readEndpoint(stateDirectory) {
  const paths = statePaths(stateDirectory);
  const [rawEndpoint, rawToken, certificate] = await Promise.all([
    readFile(paths.endpoint, "utf8"),
    readFile(paths.token, "utf8"),
    readFile(paths.certificate, "utf8")
  ]);
  const endpoint = JSON.parse(rawEndpoint);
  if (endpoint.protocolVersion !== SESSION_MESSAGE_PROTOCOL || endpoint.address !== "127.0.0.1" || !Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || !/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/u.test(endpoint.certificateFingerprint256) || !/^[A-Za-z0-9_-]{43}$/u.test(rawToken.trim())) {
    throw new Error("The session message broker endpoint is invalid.");
  }
  return { endpoint, token: rawToken.trim(), certificate };
}
async function requestSessionMessageOnce(operation, payload, stateDirectory) {
  const { endpoint, token, certificate } = await readEndpoint(stateDirectory);
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
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setTimeout(2500, () => finish(new Error("The session message broker timed out.")));
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
}
async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}
async function ensureSessionMessageBroker(stateDirectory = resolveSessionMessageStateDirectory()) {
  try {
    await requestSessionMessageOnce("ping", {}, stateDirectory);
    return;
  } catch {
    await mkdir(stateDirectory, { recursive: true, mode: 448 });
    try {
      await chmod(stateDirectory, 448);
    } catch {
    }
    const adjacentBroker = fileURLToPath(new URL("./session-message-broker.mjs", import.meta.url));
    const brokerPath = existsSync(adjacentBroker) ? adjacentBroker : fileURLToPath(new URL("../dist/session-message-broker.mjs", import.meta.url));
    const child = spawn(process.execPath, [brokerPath, "--state-directory", stateDirectory], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
      env: sessionMessageBrokerEnvironment()
    });
    child.unref();
  }
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(100);
    try {
      await requestSessionMessageOnce("ping", {}, stateDirectory);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("The session message broker did not start.");
}
async function sessionMessageRequest(operation, payload, stateDirectory = resolveSessionMessageStateDirectory()) {
  try {
    return await requestSessionMessageOnce(operation, payload, stateDirectory);
  } catch (error) {
    if (error instanceof BrokerRequestRejected) throw error;
    await ensureSessionMessageBroker(stateDirectory);
    return requestSessionMessageOnce(operation, payload, stateDirectory);
  }
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

// mcp-server/src/session-board-hook.ts
var BOARD_TOOLS = /* @__PURE__ */ new Set(["update_session_status", "list_session_status"]);
var GATED_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task", "shell", "local_shell", "exec_command", "apply_patch"]);
var SHELL_TOOLS = /* @__PURE__ */ new Set(["Bash", "PowerShell", "shell", "local_shell", "exec_command"]);
var GATE_REASON = '\uC138\uC158 \uD604\uD669\uD310: \uC774 \uC694\uCCAD\uC5D0\uC11C \uBB34\uC5C7\uC744 \uD558\uB294\uC9C0 \uD55C \uC904\uB85C \uBA3C\uC800 \uC801\uC5B4\uC57C \uD569\uB2C8\uB2E4. update_session_status\uB97C {"schemaVersion":"1.0.0","summary":"<\uBB34\uC5C7\uC744 \xB7 \uC5B4\uB514\uC11C(\uBE0C\uB79C\uCE58) \xB7 \uB2E4\uC74C \uC678\uBD80 \uC791\uC5C5>"}\uB85C \uD638\uCD9C\uD55C \uB4A4 \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uAC19\uC740 \uC791\uC5C5\uC774 \uC774\uC5B4\uC9C0\uBA74 \uAC19\uC740 \uBB38\uC7A5\uB3C4 \uB429\uB2C8\uB2E4. \uB3C4\uAD6C\uB97C \uC4F8 \uC218 \uC5C6\uC73C\uBA74 \uADF8\uB300\uB85C \uB2E4\uC2DC \uC2DC\uB3C4\uD558\uC138\uC694. \uB2E4\uC74C \uC2DC\uB3C4\uB294 \uD5C8\uC6A9\uB429\uB2C8\uB2E4.';
function text(value) {
  return typeof value === "string" ? value : "";
}
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function preToolUse(permissionDecision, extra) {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, ...extra } };
}
function handleSessionBoardHook(input, board, host, now = (/* @__PURE__ */ new Date()).toISOString(), verifiedInternalWake = false) {
  const sessionId = text(input.session_id);
  if (!sessionId) return {};
  const session = { host, sessionId, cwd: text(input.cwd) || process.cwd(), now };
  const event = text(input.hook_event_name);
  const subagent = text(input.agent_id) !== "";
  if (event === "SessionStart") {
    pruneSessions(board, now);
    touchSession(board, session);
    return {};
  }
  if (event === "UserPromptSubmit") {
    if (!subagent) {
      pruneSessions(board, now);
      if (verifiedInternalWake) touchSession(board, session);
      else recordPrompt(board, session);
    }
    return {};
  }
  if (event !== "PreToolUse") return {};
  const toolName = text(input.tool_name);
  const toolInput = record(input.tool_input);
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
    let verifiedInternalWake = false;
    if (text(input.hook_event_name) === "UserPromptSubmit") {
      const parsed = parseWakeMessages(input.prompt);
      const sessionId = text(input.session_id);
      let allRecognized = parsed.nonces.length > 0;
      if (sessionId) {
        for (const nonce of parsed.nonces) {
          try {
            const result = await sessionMessageRequest("consume-wake", { target: { host, sessionId }, nonce });
            allRecognized &&= result.consumed;
          } catch {
            allRecognized = false;
          }
        }
      } else allRecognized = false;
      verifiedInternalWake = parsed.wakeOnly && allRecognized;
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
