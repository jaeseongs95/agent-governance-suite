// Session board core: per host session, the main session's one-line summary of its current work and the time of
// its last user prompt. Liveness is not stored here: it comes from the session messaging presence.
import { mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const SUMMARY_MAX_LENGTH = 200;
export const BOARD_FORMAT_VERSION = 1;
const RETAIN_MS = 7 * 24 * 3600_000;
const TABLE = "board_sessions";
// 2.x board table. 3.0 does not carry it over: the new board starts empty.
const LEGACY_TABLE = "sessions";
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS ${TABLE} (
  host TEXT NOT NULL,
  session_id TEXT NOT NULL,
  cwd TEXT,
  summary TEXT,
  summary_at TEXT,
  last_prompt_at TEXT,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (host, session_id)
) STRICT;`;

export class BoardFormatError extends Error {
  constructor(code, message) { super(message); this.name = "BoardFormatError"; this.code = code; }
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_schema WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map((row) => row.name);
}

/**
 * Opens the board. A 2.x board file (user_version 0 holding only the old table) is reset to the empty 3.0 format in
 * one transaction. The old table beside the current one (a 2.x install writing the same file) is left as it is; any
 * other content is refused untouched, so a misconfigured path can never drop foreign data.
 */
export function openBoard(input, { busyTimeoutMs = 5000 } = {}) {
  if (typeof input !== "string") {
    const shared = input;
    shared.initialize(() => {
      shared.database.exec(`DROP TABLE IF EXISTS ${LEGACY_TABLE};`);
      shared.database.exec(CREATE_TABLE);
      shared.setSchemaVersion(BOARD_FORMAT_VERSION);
    });
    return shared.database;
  }
  if (input !== ":memory:") mkdirSync(path.dirname(path.resolve(input)), { recursive: true });
  const db = new DatabaseSync(input);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.trunc(busyTimeoutMs)};`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const version = db.prepare("PRAGMA user_version").get().user_version;
      const present = tables(db);
      if (version === BOARD_FORMAT_VERSION && present.includes(TABLE) && present.every((name) => name === TABLE || name === LEGACY_TABLE)) {
        // Current format. A 2.x install still running on this machine re-creates its own table beside it after the
        // reset; that table is the 2.x board's live data, so it stays untouched instead of making the file foreign.
      } else if (version === 0 && present.every((name) => name === LEGACY_TABLE)) {
        db.exec(`DROP TABLE IF EXISTS ${LEGACY_TABLE};`);
        db.exec(CREATE_TABLE);
        db.exec(`PRAGMA user_version = ${BOARD_FORMAT_VERSION};`);
      } else {
        throw new BoardFormatError("BOARD_FOREIGN_DATABASE", "The session board file holds content this board does not own.");
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
    if (input !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function inTransaction(db, operation) {
  return db.transaction && !db.inTransaction ? db.transaction(operation) : operation();
}

/**
 * Records one main-session input observed by the hook: the working directory always, the prompt time only for a
 * user prompt (a broker-verified wake bell is not a new request). The prompt text is never stored.
 */
export function recordInput(db, { host, sessionId, cwd, now }, { prompt }) {
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO ${TABLE} (host, session_id, cwd, last_prompt_at, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (host, session_id) DO UPDATE SET cwd = coalesce(excluded.cwd, cwd),
        last_prompt_at = coalesce(excluded.last_prompt_at, last_prompt_at), seen_at = excluded.seen_at`)
      .run(host, sessionId, cwd || null, prompt ? now : null, now);
  });
}

export function normalizeSummary(value) {
  if (typeof value !== "string") return null;
  const line = value.trim();
  return line && !/[\r\n]/u.test(line) && line.length <= SUMMARY_MAX_LENGTH ? line : null;
}

export function setSummary(db, { host, sessionId, now }, summary) {
  const line = normalizeSummary(summary);
  if (!line) throw new Error(`summary must be one non-empty line of at most ${SUMMARY_MAX_LENGTH} characters`);
  return inTransaction(db, () => {
    db.prepare(`INSERT INTO ${TABLE} (host, session_id, summary, summary_at, seen_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (host, session_id) DO UPDATE SET summary = excluded.summary, summary_at = excluded.summary_at,
        seen_at = excluded.seen_at`).run(host, sessionId, line, now, now);
    return { summary: line, summaryAt: now };
  });
}

/** Removes rows not seen for seven days; display never depends on these rows existing. */
export function pruneBoard(db, now) {
  inTransaction(db, () => {
    db.prepare(`DELETE FROM ${TABLE} WHERE seen_at < ?`).run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
  });
}

function view(row) {
  return {
    cwd: row.cwd ?? null,
    summary: row.summary ?? null,
    summaryAt: row.summary_at ?? null,
    lastPromptAt: row.last_prompt_at ?? null,
    // Unknown (null) when no prompt was ever observed, e.g. a host without a prompt hook.
    summaryStale: row.last_prompt_at == null ? null : row.summary_at == null || row.summary_at < row.last_prompt_at,
  };
}

export function readEntry(db, host, sessionId) {
  const row = db.prepare(`SELECT * FROM ${TABLE} WHERE host = ? AND session_id = ?`).get(host, sessionId);
  return row ? view(row) : null;
}

/** Prompt markers of every row that has one; the classification gateway matches them by actor. */
export function listPromptMarkers(db) {
  return db.prepare(`SELECT host, session_id, last_prompt_at FROM ${TABLE} WHERE last_prompt_at IS NOT NULL`).all()
    .map((row) => ({ host: row.host, sessionId: row.session_id, lastPromptAt: row.last_prompt_at }));
}

const GIT_FILE_MAX_BYTES = 4096;
const GIT_SEARCH_DEPTH = 64;

function readSmallFile(file) {
  const stat = statSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= GIT_FILE_MAX_BYTES ? readFileSync(file, "utf8") : null;
}

/**
 * Where a working directory sits in git, read from files only (no process): the top-level directory, a repository id
 * shared by every worktree of one repository (its common git directory), and the checked-out branch (null when
 * detached). Null when the directory is not inside a readable repository.
 */
export function locateRepository(cwd) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return null;
  try {
    let directory = path.resolve(cwd);
    for (let depth = 0; depth < GIT_SEARCH_DEPTH; depth++) {
      const dotGit = path.join(directory, ".git");
      const stat = statSync(dotGit, { throwIfNoEntry: false });
      if (stat) {
        let gitDirectory = dotGit;
        if (stat.isFile()) {
          const target = readSmallFile(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/mu)?.[1];
          if (!target) return null;
          gitDirectory = path.resolve(directory, target);
        } else if (!stat.isDirectory()) return null;
        const head = readSmallFile(path.join(gitDirectory, "HEAD"));
        if (head === null) return null;
        const branch = head.match(/^ref: refs\/heads\/(.+?)\s*$/u)?.[1] ?? null;
        const common = readSmallFile(path.join(gitDirectory, "commondir"))?.trim();
        return { root: directory, repoId: realpathSync(common ? path.resolve(gitDirectory, common) : gitDirectory), branch };
      }
      const parent = path.dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
  } catch {
    // Advisory location only: an unreadable repository is reported as no location, never as a board failure.
    return null;
  }
  return null;
}
