#!/usr/bin/env node

// mcp-server/src/session-board-hook.ts
import { readFileSync } from "node:fs";
import path3 from "node:path";
import { fileURLToPath } from "node:url";

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
  if (!text2 || /[;&|<>`$@(){}\r\n]/u.test(text2)) return false;
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
function resolveWorkflowDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_DB_PATH?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path2.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path2.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path2.join(homeDirectory, ".local", "state");
  }
  return path2.resolve(stateRoot, "agent-governance-suite", "workflows.sqlite3");
}
function besideWorkflowDatabase(variable, fileName, environment, platform, homeDirectory, currentWorkingDirectory) {
  const configured = environment[variable]?.trim();
  if (configured) return path2.resolve(currentWorkingDirectory, configured);
  const workflowPath = resolveWorkflowDatabasePath(
    environment,
    platform,
    homeDirectory,
    currentWorkingDirectory
  );
  if (workflowPath === ":memory:") return ":memory:";
  return path2.join(path2.dirname(workflowPath), fileName);
}
function resolveSessionBoardDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  return besideWorkflowDatabase("AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH", "session-board.sqlite3", environment, platform, homeDirectory, currentWorkingDirectory);
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
function handleSessionBoardHook(input, board, host, now = (/* @__PURE__ */ new Date()).toISOString()) {
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
      recordPrompt(board, session);
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
function runSessionBoardHook(host, raw) {
  let board = null;
  try {
    const input = JSON.parse(raw);
    board = openBoard(resolveSessionBoardDatabasePath(), { busyTimeoutMs: 500 });
    const output = handleSessionBoardHook(input, board, host);
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
if (path3.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
  }
  const output = runSessionBoardHook("codex", raw);
  if (output) process.stdout.write(output);
}
export {
  GATE_REASON,
  handleSessionBoardHook,
  runSessionBoardHook
};
