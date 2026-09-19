// Session board core: one row per host session with its working directory and a mandatory one-line
// summary of the current work. Hooks, MCP tools and any CLI are interfaces; every board rule lives here.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SUMMARY_MAX_LENGTH = 200;
const RETAIN_MS = 24 * 3600_000;
const READ_ONLY_COMMANDS = new Set(["ls", "cat", "pwd", "rg", "grep"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show"]);

export function openBoard(databasePath, { busyTimeoutMs = 5000 } = {}) {
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

/** Creates the session row or refreshes its working directory and activity time. */
export function touchSession(db, { host, sessionId, cwd, now }) {
  db.prepare(`INSERT INTO sessions (host, session_id, cwd, started_at, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (host, session_id) DO UPDATE SET cwd = excluded.cwd, updated_at = excluded.updated_at`)
    .run(host, sessionId, cwd, now, now);
}

/** Marks a new user request; the summary written before it becomes stale. Only the time is stored, never the text. */
export function recordPrompt(db, session) {
  touchSession(db, session);
  db.prepare("UPDATE sessions SET last_prompt_at = ? WHERE host = ? AND session_id = ?")
    .run(session.now, session.host, session.sessionId);
}

export function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line && !/[\r\n]/u.test(line) && line.length <= SUMMARY_MAX_LENGTH ? line : null;
}

export function setSummary(db, session, summary) {
  const line = normalizeSummary(summary);
  if (!line) throw new Error(`summary must be one non-empty line of at most ${SUMMARY_MAX_LENGTH} characters`);
  touchSession(db, session);
  db.prepare("UPDATE sessions SET summary = ?, summary_at = ? WHERE host = ? AND session_id = ?")
    .run(line, session.now, session.host, session.sessionId);
  return line;
}

/**
 * Decides one gated tool call. The first gated call of a request is denied when the summary is missing or
 * older than that request; every later call of the same request is allowed, so the gate can never deadlock.
 * Hosts without a request event use the session start as the request marker.
 */
export function gateDecision(db, session) {
  touchSession(db, session);
  const row = db.prepare("SELECT summary_at, last_prompt_at, started_at FROM sessions WHERE host = ? AND session_id = ?")
    .get(session.host, session.sessionId);
  const marker = row.last_prompt_at ?? row.started_at;
  if (row.summary_at && row.summary_at >= marker) return "allow";
  const claimed = db.prepare(`UPDATE sessions SET denied_for = ?
    WHERE host = ? AND session_id = ? AND (denied_for IS NULL OR denied_for <> ?)`)
    .run(marker, session.host, session.sessionId, marker);
  return claimed.changes > 0 ? "deny" : "allow";
}

export function pruneSessions(db, now) {
  db.prepare("DELETE FROM sessions WHERE updated_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
}

function view(row, current) {
  return {
    host: row.host,
    sessionId: row.session_id,
    cwd: row.cwd,
    summary: row.summary ?? null,
    summaryAt: row.summary_at ?? null,
    lastPromptAt: row.last_prompt_at ?? null,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    stale: !row.summary_at || row.summary_at < (row.last_prompt_at ?? row.started_at),
    current: Boolean(current && row.host === current.host && row.session_id === current.sessionId),
  };
}

export function readSession(db, host, sessionId) {
  const row = db.prepare("SELECT * FROM sessions WHERE host = ? AND session_id = ?").get(host, sessionId);
  return row ? view(row, { host, sessionId }) : null;
}

/** Lists the sessions active in the last 24 hours, newest activity first. */
export function listSessions(db, now, current = null) {
  const since = new Date(Date.parse(now) - RETAIN_MS).toISOString();
  return db.prepare("SELECT * FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC").all(since)
    .map((row) => view(row, current));
}

/**
 * True for a single read-only shell command. Operators, redirection, variables, substitution, grouping
 * (including PowerShell `(...)`, `@(...)` and script blocks), quotes and backslashes, and options that write
 * files or run programs (`--output`, `--ext-diff`, `--pre`) make the command gated.
 */
export function isReadOnlyCommand(command) {
  if (typeof command !== "string") return false;
  const text = command.trim();
  if (!text || /[;&|<>`$@(){}'"\\\r\n]/u.test(text)) return false;
  const [first, second, ...rest] = text.split(/\s+/u);
  if ([second, ...rest].some((argument) => /^--(?:output|ext-diff|pre)(?:=|$|-)/u.test(argument ?? ""))) return false;
  if (READ_ONLY_COMMANDS.has(first)) return true;
  if (first !== "git") return false;
  if (READ_ONLY_GIT.has(second)) return true;
  return second === "branch" && (rest.length === 0 || (rest.length === 1 && rest[0] === "--list"));
}
