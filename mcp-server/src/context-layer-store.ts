import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { AdminChange, AdminLogRecord } from "./admin-log.js";

/**
 * Shared context layers and the admin page's state (design: three contexts, AGS3-T-0024). One file in the user state
 * directory every host on this computer shares:
 * - admin_log: the append-only signed log, the only source of the passkeys, the global context, the role registry and
 *   the session bindings (admin-log.ts). Nothing else here is read to decide those.
 * - admin_log_archive / admin_resets: records set aside by the reset command after every key was lost.
 * - admin_proposals: changes an agent asked for; they apply only when the user signs them on the page.
 * - role_contexts / role_context_history: each role's body, written by the agents of a session bound to that role
 *   (not signed: an agent writes it).
 * - session_seen: when each session last used its context (bindings of sessions unused for 30 days lapse).
 * - context_deliveries: per-actor delivery marks so a layer that changed during a session is sent exactly once.
 * - jev_keys: each JEV key the user registered, encrypted (jev-key-vault.ts); the signed record holds its fingerprint.
 * The situational (per-session) context stays in the per-host continuity store.
 */
export const CONTEXT_LAYER_SCHEMA_VERSION = 2;
const HISTORY_PER_ROLE = 50;
/** Delivery marks and session use of sessions unseen this long are removed. */
export const RETAIN_MS = 30 * 24 * 3600_000;
const TABLES_V1 = ["admin_log", "admin_log_archive", "admin_proposals", "admin_resets", "context_deliveries", "role_context_history", "role_contexts", "session_seen"];
const TABLES = [...TABLES_V1, "jev_keys"].sort();
/** Version 2 adds the encrypted JEV keys; a version 1 file (3.9.0 before the settings) gains the table in place. */
const JEV_KEYS_TABLE = `CREATE TABLE jev_keys (name TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, sealed TEXT NOT NULL, stored_at TEXT NOT NULL) STRICT;`;

export interface RoleContextRecord {
  roleId: string;
  body: string;
  stateToken: string;
  digest: string;
  bytes: number;
  updatedAt: string;
  /** The actor that wrote it (hostActorId). */
  updatedBy: string;
}

export interface ContextDeliveryRecord {
  globalToken: string | null;
  role: string | null;
  roleToken: string | null;
}

export type ProposalState = "pending" | "rejected" | "applied";

export interface AdminProposalRecord {
  id: string;
  target: string;
  change: AdminChange;
  /** The target head the agent saw; the page shows what changed since. */
  baseHash: string | null;
  host: string;
  sessionId: string;
  actor: string;
  createdAt: string;
  state: ProposalState;
  decidedAt: string | null;
}

export interface AdminResetRecord {
  id: number;
  resetOf: string | null;
  archived: number;
  at: string;
}

/** One stored JEV key: `sealed` is the vault's ciphertext (never the value). */
export interface JevKeyRecord {
  name: string;
  fingerprint: string;
  sealed: string;
  storedAt: string;
}

export type RoleSaveResult =
  | { kind: "saved"; record: RoleContextRecord }
  | { kind: "stale"; actualStateToken: string | null };

export class ContextLayerFormatError extends Error {
  constructor(readonly code: "CONTEXT_LAYER_FOREIGN_DATABASE") {
    super("The context layer file holds content this store does not own.");
    this.name = "ContextLayerFormatError";
  }
}

export function bodyDigest(body: string): string {
  return `sha256:${createHash("sha256").update(body, "utf8").digest("hex")}`;
}

function newStateToken(): string {
  return `ctx-${randomBytes(18).toString("base64url")}`;
}

interface RoleRow { role_id: string; body: string; state_token: string; digest: string; updated_at: string; updated_by: string }
interface LogRow { seq: number; target: string; intent: string; credential_id: string; authenticator_data: string; client_data_json: string; signature: string; record_hash: string; created_at: string }
interface ProposalRow { id: string; target: string; change: string; base_hash: string | null; host: string; session_id: string; actor: string; created_at: string; state: string; decided_at: string | null }

function roleRecord(row: RoleRow): RoleContextRecord {
  return { roleId: row.role_id, body: row.body, stateToken: row.state_token, digest: row.digest, bytes: Buffer.byteLength(row.body, "utf8"),
    updatedAt: row.updated_at, updatedBy: row.updated_by };
}

function logRecord(row: LogRow): AdminLogRecord {
  return { seq: row.seq, target: row.target, intent: row.intent, credentialId: row.credential_id, authenticatorData: row.authenticator_data,
    clientDataJSON: row.client_data_json, signature: row.signature, recordHash: row.record_hash, createdAt: row.created_at };
}

function proposal(row: ProposalRow): AdminProposalRecord {
  return { id: row.id, target: row.target, change: JSON.parse(row.change) as AdminChange, baseHash: row.base_hash, host: row.host, sessionId: row.session_id,
    actor: row.actor, createdAt: row.created_at, state: row.state as ProposalState, decidedAt: row.decided_at };
}

const LOG_COLUMNS = `seq INTEGER PRIMARY KEY AUTOINCREMENT, target TEXT NOT NULL, intent TEXT NOT NULL, credential_id TEXT NOT NULL,
  authenticator_data TEXT NOT NULL, client_data_json TEXT NOT NULL, signature TEXT NOT NULL, record_hash TEXT NOT NULL, request_id TEXT,
  created_at TEXT NOT NULL`;

export class ContextLayerStore {
  private readonly database: DatabaseSync;

  /**
   * `create: false` opens only an existing file: a hook never creates the shared file, so a computer where nobody saved
   * anything gets no new state file and no injection. Returns null when the file is absent.
   */
  static open(databasePath: string, create: boolean): ContextLayerStore | null {
    if (!create && databasePath !== ":memory:" && !existsSync(databasePath)) return null;
    return new ContextLayerStore(databasePath);
  }

  constructor(databasePath: string) {
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 5000;");
      database.exec("BEGIN IMMEDIATE;");
      try {
        const version = (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
        const present = (database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
          .map(row => row.name);
        if (version === 0 && present.length === 0) {
          database.exec(`
            CREATE TABLE admin_log (${LOG_COLUMNS}) STRICT;
            CREATE UNIQUE INDEX admin_log_request ON admin_log (request_id) WHERE request_id IS NOT NULL;
            CREATE TABLE admin_log_archive (${LOG_COLUMNS.replace("seq INTEGER PRIMARY KEY AUTOINCREMENT", "seq INTEGER NOT NULL")},
              reset_id INTEGER NOT NULL) STRICT;
            CREATE TABLE admin_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, reset_of TEXT, archived INTEGER NOT NULL, at TEXT NOT NULL) STRICT;
            CREATE TABLE admin_proposals (id TEXT PRIMARY KEY, target TEXT NOT NULL, change TEXT NOT NULL, base_hash TEXT, host TEXT NOT NULL,
              session_id TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('pending', 'rejected', 'applied')), decided_at TEXT) STRICT;
            CREATE TABLE role_contexts (role_id TEXT PRIMARY KEY, body TEXT NOT NULL, state_token TEXT NOT NULL, digest TEXT NOT NULL,
              updated_at TEXT NOT NULL, updated_by TEXT NOT NULL) STRICT;
            CREATE TABLE role_context_history (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id TEXT NOT NULL, body TEXT NOT NULL,
              state_token TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL) STRICT;
            CREATE INDEX role_context_history_role ON role_context_history (role_id, id);
            CREATE TABLE session_seen (host TEXT NOT NULL, session_id TEXT NOT NULL, last_seen_at TEXT NOT NULL, PRIMARY KEY (host, session_id)) STRICT;
            CREATE TABLE context_deliveries (actor_id TEXT PRIMARY KEY, global_token TEXT, role TEXT, role_token TEXT,
              delivered_at TEXT NOT NULL) STRICT;
            ${JEV_KEYS_TABLE}
            PRAGMA user_version = ${CONTEXT_LAYER_SCHEMA_VERSION};`);
        } else if (version === 1 && present.join(",") === TABLES_V1.join(",")) {
          database.exec(`${JEV_KEYS_TABLE} PRAGMA user_version = ${CONTEXT_LAYER_SCHEMA_VERSION};`);
        } else if (version !== CONTEXT_LAYER_SCHEMA_VERSION || present.join(",") !== TABLES.join(",")) {
          throw new ContextLayerFormatError("CONTEXT_LAYER_FOREIGN_DATABASE");
        }
        database.exec("COMMIT;");
      } catch (error) {
        if (database.isTransaction) database.exec("ROLLBACK;");
        throw error;
      }
      if (databasePath !== ":memory:") database.exec("PRAGMA journal_mode = WAL;");
    } catch (error) {
      try { database.close(); } catch { /* Preserve the open failure. */ }
      throw error;
    }
    this.database = database;
  }

  close(): void {
    this.database.close();
  }

  /** One BEGIN IMMEDIATE transaction: a check and the write it allows cannot interleave with another writer. */
  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  // --- Signed admin log -------------------------------------------------------------------------------------------

  // ponytail: every read folds the whole log; it holds only human edits, so it stays small. Snapshot a verified prefix
  // if it ever grows to thousands of records.
  logRecords(): AdminLogRecord[] {
    return (this.database.prepare("SELECT * FROM admin_log ORDER BY seq").all() as unknown as LogRow[]).map(logRecord);
  }

  recordByRequest(requestId: string): AdminLogRecord | null {
    const row = this.database.prepare("SELECT * FROM admin_log WHERE request_id = ?").get(requestId) as LogRow | undefined;
    return row ? logRecord(row) : null;
  }

  appendRecord(record: Omit<AdminLogRecord, "seq">, requestId: string | null): AdminLogRecord {
    const result = this.database.prepare(`INSERT INTO admin_log (target, intent, credential_id, authenticator_data, client_data_json, signature,
      record_hash, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(record.target, record.intent, record.credentialId,
      record.authenticatorData, record.clientDataJSON, record.signature, record.recordHash, requestId, record.createdAt);
    return { ...record, seq: Number(result.lastInsertRowid) };
  }

  /** The reset command: every record moves to the archive; the page keeps showing that a reset happened. */
  resetLog(resetOf: string | null, now: string): AdminResetRecord {
    return this.transaction(() => {
      const archived = (this.database.prepare("SELECT COUNT(*) AS count FROM admin_log").get() as { count: number }).count;
      const id = Number(this.database.prepare("INSERT INTO admin_resets (reset_of, archived, at) VALUES (?, ?, ?)").run(resetOf, archived, now).lastInsertRowid);
      this.database.prepare(`INSERT INTO admin_log_archive (seq, target, intent, credential_id, authenticator_data, client_data_json, signature,
        record_hash, request_id, created_at, reset_id) SELECT seq, target, intent, credential_id, authenticator_data, client_data_json, signature,
        record_hash, request_id, created_at, ? FROM admin_log`).run(id);
      this.database.exec("DELETE FROM admin_log;");
      // Every signed key fingerprint went with the log, so no stored key can be used again.
      this.database.exec("DELETE FROM jev_keys;");
      this.database.prepare("UPDATE admin_proposals SET state = 'rejected', decided_at = ? WHERE state = 'pending'").run(now);
      return { id, resetOf, archived, at: now };
    });
  }

  latestResetId(): number | null {
    return (this.database.prepare("SELECT MAX(id) AS id FROM admin_resets").get() as { id: number | null }).id;
  }

  resets(): AdminResetRecord[] {
    return (this.database.prepare("SELECT id, reset_of, archived, at FROM admin_resets ORDER BY id DESC").all() as Array<{ id: number; reset_of: string | null; archived: number; at: string }>)
      .map(row => ({ id: row.id, resetOf: row.reset_of, archived: row.archived, at: row.at }));
  }

  // --- JEV keys (encrypted; written in the transaction of their signed record) -------------------------------------

  jevKey(name: string): JevKeyRecord | null {
    const row = this.database.prepare("SELECT name, fingerprint, sealed, stored_at FROM jev_keys WHERE name = ?").get(name) as
      { name: string; fingerprint: string; sealed: string; stored_at: string } | undefined;
    return row ? { name: row.name, fingerprint: row.fingerprint, sealed: row.sealed, storedAt: row.stored_at } : null;
  }

  putJevKey(record: JevKeyRecord): void {
    this.database.prepare(`INSERT INTO jev_keys (name, fingerprint, sealed, stored_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (name) DO UPDATE SET fingerprint = excluded.fingerprint, sealed = excluded.sealed, stored_at = excluded.stored_at`)
      .run(record.name, record.fingerprint, record.sealed, record.storedAt);
  }

  deleteJevKey(name: string): void {
    this.database.prepare("DELETE FROM jev_keys WHERE name = ?").run(name);
  }

  // --- Agent proposals -------------------------------------------------------------------------------------------

  addProposal(record: Omit<AdminProposalRecord, "state" | "decidedAt">): AdminProposalRecord {
    return this.transaction(() => {
      // Decided requests are kept 30 days for the page's history, then dropped.
      this.database.prepare("DELETE FROM admin_proposals WHERE state <> 'pending' AND decided_at < ?").run(new Date(Date.parse(record.createdAt) - RETAIN_MS).toISOString());
      // One pending request per session and target: a newer request replaces the older one.
      this.database.prepare("UPDATE admin_proposals SET state = 'rejected', decided_at = ? WHERE state = 'pending' AND target = ? AND host = ? AND session_id = ?")
        .run(record.createdAt, record.target, record.host, record.sessionId);
      this.database.prepare(`INSERT INTO admin_proposals (id, target, change, base_hash, host, session_id, actor, created_at, state)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(record.id, record.target, JSON.stringify(record.change), record.baseHash, record.host,
        record.sessionId, record.actor, record.createdAt);
      return { ...record, state: "pending" as const, decidedAt: null };
    });
  }

  proposal(id: string): AdminProposalRecord | null {
    const row = this.database.prepare("SELECT * FROM admin_proposals WHERE id = ?").get(id) as ProposalRow | undefined;
    return row ? proposal(row) : null;
  }

  pendingProposals(): AdminProposalRecord[] {
    return (this.database.prepare("SELECT * FROM admin_proposals WHERE state = 'pending' ORDER BY created_at").all() as unknown as ProposalRow[]).map(proposal);
  }

  decideProposal(id: string, state: "rejected" | "applied", now: string): boolean {
    return this.database.prepare("UPDATE admin_proposals SET state = ?, decided_at = ? WHERE id = ? AND state = 'pending'").run(state, now, id).changes === 1;
  }

  // --- Role bodies (agent-written) -------------------------------------------------------------------------------

  readRole(roleId: string): RoleContextRecord | null {
    const row = this.database.prepare("SELECT * FROM role_contexts WHERE role_id = ?").get(roleId) as RoleRow | undefined;
    return row ? roleRecord(row) : null;
  }

  listRoleBodies(): RoleContextRecord[] {
    return (this.database.prepare("SELECT * FROM role_contexts ORDER BY role_id").all() as unknown as RoleRow[]).map(roleRecord);
  }

  /**
   * Replaces the whole body when the caller names the current state token (null: never written). Runs inside the
   * caller's transaction (the binding check and this write must not interleave with a role deletion).
   */
  saveRole(roleId: string, expectedStateToken: string | null, body: string, updatedBy: string, now: string): RoleSaveResult {
    if (!this.database.isTransaction) throw new Error("saveRole runs inside a transaction");
    {
      const current = this.readRole(roleId);
      if ((current?.stateToken ?? null) !== expectedStateToken) return { kind: "stale", actualStateToken: current?.stateToken ?? null } as const;
      const row: RoleRow = { role_id: roleId, body, state_token: newStateToken(), digest: bodyDigest(body), updated_at: now, updated_by: updatedBy };
      this.database.prepare(`INSERT INTO role_contexts (role_id, body, state_token, digest, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (role_id) DO UPDATE SET body = excluded.body, state_token = excluded.state_token, digest = excluded.digest,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(roleId, body, row.state_token, row.digest, now, updatedBy);
      this.database.prepare(`INSERT INTO role_context_history (role_id, body, state_token, digest, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(roleId, body, row.state_token, row.digest, now, updatedBy);
      this.database.prepare(`DELETE FROM role_context_history WHERE role_id = ? AND id NOT IN
        (SELECT id FROM role_context_history WHERE role_id = ? ORDER BY id DESC LIMIT ${HISTORY_PER_ROLE})`).run(roleId, roleId);
      return { kind: "saved", record: roleRecord(row) } as const;
    }
  }

  /** Deletes a role's body and history; called inside the transaction that appends the signed role deletion. */
  deleteRoleBody(roleId: string): void {
    this.database.prepare("DELETE FROM role_contexts WHERE role_id = ?").run(roleId);
    this.database.prepare("DELETE FROM role_context_history WHERE role_id = ?").run(roleId);
  }

  // --- Session use and deliveries --------------------------------------------------------------------------------

  sessionSeen(host: string, sessionId: string): string | null {
    return (this.database.prepare("SELECT last_seen_at FROM session_seen WHERE host = ? AND session_id = ?").get(host, sessionId) as { last_seen_at: string } | undefined)?.last_seen_at ?? null;
  }

  allSessionSeen(): Map<string, string> {
    return new Map((this.database.prepare("SELECT host, session_id, last_seen_at FROM session_seen").all() as Array<{ host: string; session_id: string; last_seen_at: string }>)
      .map(row => [`${row.host}\u0000${row.session_id}`, row.last_seen_at]));
  }

  touchSession(host: string, sessionId: string, now: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM session_seen WHERE last_seen_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
      this.database.prepare(`INSERT INTO session_seen (host, session_id, last_seen_at) VALUES (?, ?, ?)
        ON CONFLICT (host, session_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`).run(host, sessionId, now);
    });
  }

  delivered(actorId: string): ContextDeliveryRecord | null {
    const row = this.database.prepare("SELECT global_token, role, role_token FROM context_deliveries WHERE actor_id = ?").get(actorId) as
      { global_token: string | null; role: string | null; role_token: string | null } | undefined;
    return row ? { globalToken: row.global_token, role: row.role, roleToken: row.role_token } : null;
  }

  recordDelivery(actorId: string, delivery: ContextDeliveryRecord, now: string): void {
    this.transaction(() => {
      this.database.prepare("DELETE FROM context_deliveries WHERE delivered_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
      this.database.prepare(`INSERT INTO context_deliveries (actor_id, global_token, role, role_token, delivered_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (actor_id) DO UPDATE SET global_token = excluded.global_token, role = excluded.role, role_token = excluded.role_token,
          delivered_at = excluded.delivered_at`).run(actorId, delivery.globalToken, delivery.role, delivery.roleToken, now);
    });
  }
}
