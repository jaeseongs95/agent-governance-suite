import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { resolveContextLayerDatabasePath } from "./runtime-config.js";

/**
 * Which skill each host called, for the admin page. A file of its own beside the shared context file: the context file
 * refuses any table it does not know, so a host still on an older version would stop reading its contexts.
 */
export const SKILL_USAGE_RETAIN_DAYS = 90;
const DAY_MS = 24 * 3600_000;
/** A hook waits this long for another writer; a count lost to contention is reported, never a stalled tool call. */
const BUSY_TIMEOUT_MS = 2_000;

export interface SkillCall {
  host: string;
  sessionId: string;
  skillId: string;
  subagent: boolean;
  /** How the host's adapter recognized the call (host-input-adapter SkillCallObservation). */
  basis: string;
  /** The host's ID of this tool call; a redelivered hook adds nothing. Absent on a host that gives none. */
  callId?: string;
  at: Date;
}

export interface SkillUsageRow {
  skillId: string;
  host: string;
  basis: string;
  subagent: boolean;
  calls: number;
  lastAt: string;
}

export interface SkillUsageSummary {
  rows: SkillUsageRow[];
  /** When each host's oldest kept call happened, whatever the period asked for. */
  hosts: Array<{ host: string; firstAt: string }>;
}

export function resolveSkillUsageDatabasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return path.join(path.dirname(resolveContextLayerDatabasePath(environment)), "skill-usage.sqlite3");
}

function open(file: string): DatabaseSync {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true, mode: 0o700 });
  const database = new DatabaseSync(file);
  try {
    database.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    database.exec("PRAGMA journal_mode = WAL;");
    database.exec(`CREATE TABLE IF NOT EXISTS skill_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, host TEXT NOT NULL, session_id TEXT NOT NULL,
        skill_id TEXT NOT NULL, subagent INTEGER NOT NULL CHECK (subagent IN (0, 1)), basis TEXT NOT NULL, call_id TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS skill_calls_at ON skill_calls (at);
      CREATE UNIQUE INDEX IF NOT EXISTS skill_calls_call ON skill_calls (host, session_id, call_id) WHERE call_id IS NOT NULL;
      PRAGMA user_version = 1;`);
    return database;
  } catch (error) {
    try { database.close(); } catch { /* Preserve the open failure. */ }
    throw error;
  }
}

/** Skill calls are a few per turn at most, so pruning on each write costs nothing and needs no background work. */
export function recordSkillCall(file: string, call: SkillCall): void {
  const database = open(file);
  try {
    database.prepare("INSERT OR IGNORE INTO skill_calls (at, host, session_id, skill_id, subagent, basis, call_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(call.at.toISOString(), call.host, call.sessionId, call.skillId, call.subagent ? 1 : 0, call.basis, call.callId ?? null);
    database.prepare("DELETE FROM skill_calls WHERE at < ?").run(new Date(call.at.getTime() - SKILL_USAGE_RETAIN_DAYS * DAY_MS).toISOString());
  } finally {
    database.close();
  }
}

/** The skills this session was seen calling, at any time: a skill read before the workflow started still counts. */
export function skillsCalledInSession(file: string, sessionId: string): string[] {
  if (!existsSync(file)) return [];
  const database = open(file);
  try {
    const rows = database.prepare("SELECT DISTINCT skill_id FROM skill_calls WHERE session_id = ?").all(sessionId) as unknown as Array<{ skill_id: string }>;
    return rows.map(row => row.skill_id);
  } finally {
    database.close();
  }
}

/** Calls of the last `days` days. Nothing was recorded yet (no file): an empty summary, and no file is created. */
export function skillUsageSummary(file: string, days: number, now: Date = new Date()): SkillUsageSummary {
  if (!existsSync(file)) return { rows: [], hosts: [] };
  const database = open(file);
  try {
    const since = new Date(now.getTime() - days * DAY_MS).toISOString();
    const rows = database.prepare(`SELECT skill_id, host, basis, subagent, COUNT(*) AS calls, MAX(at) AS last_at FROM skill_calls WHERE at >= ?
      GROUP BY skill_id, host, basis, subagent ORDER BY skill_id, host, basis, subagent`).all(since) as unknown as Array<{ skill_id: string; host: string; basis: string; subagent: number; calls: number; last_at: string }>;
    const hosts = database.prepare("SELECT host, MIN(at) AS first_at FROM skill_calls GROUP BY host ORDER BY host").all() as unknown as Array<{ host: string; first_at: string }>;
    return {
      rows: rows.map(row => ({ skillId: row.skill_id, host: row.host, basis: row.basis, subagent: row.subagent === 1, calls: row.calls, lastAt: row.last_at })),
      hosts: hosts.map(row => ({ host: row.host, firstAt: row.first_at })),
    };
  } finally {
    database.close();
  }
}
