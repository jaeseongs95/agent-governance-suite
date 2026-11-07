import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Shared context layers (design: three contexts). One file in the user state directory every host on this computer
 * shares: the global context (one row), role contexts keyed by the bound role name, the session-to-role bindings the
 * user approved, the change history with the approval that allowed each change, and the per-actor delivery marks
 * that let a hook send a layer that changed during a session exactly once. The situational (per-session) context
 * stays in the per-host continuity store.
 */
export const CONTEXT_LAYER_SCHEMA_VERSION = 1;
const HISTORY_PER_LAYER = 50;
/** Delivery marks and bindings of sessions unseen this long are removed; a later session approves its role again. */
const RETAIN_MS = 30 * 24 * 3600_000;
const TABLES = ["context_deliveries", "context_history", "context_layers", "role_bindings"];

export type ContextLayerKind = "global" | "role";

export interface ContextLayerRecord {
  kind: ContextLayerKind;
  /** The role name of a role layer; empty for the global layer. */
  name: string;
  body: string;
  stateToken: string;
  digest: string;
  bytes: number;
  updatedAt: string;
  /** The actor that wrote it (hostActorId) or the local admin page. */
  updatedBy: string;
}

/** Where the user's decision came from: an MCP form the user answered, or the local admin page the user opened. */
export type ContextApproval =
  | { kind: "mcp-form"; connectionId: string; requestId: string; shownDigest: string }
  | { kind: "local-admin-page"; pageId: string };

export interface ContextHistoryRecord extends ContextLayerRecord {
  approval: ContextApproval | null;
}

export interface RoleBindingRecord {
  host: string;
  sessionId: string;
  role: string;
  boundAt: string;
  approval: ContextApproval;
}

export interface ContextDeliveryRecord {
  globalToken: string | null;
  role: string | null;
  roleToken: string | null;
}

export type LayerSaveResult =
  | { kind: "saved"; layer: ContextLayerRecord }
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

interface LayerRow { kind: string; name: string; body: string; state_token: string; digest: string; updated_at: string; updated_by: string }

function layer(row: LayerRow): ContextLayerRecord {
  return { kind: row.kind as ContextLayerKind, name: row.name, body: row.body, stateToken: row.state_token, digest: row.digest,
    bytes: Buffer.byteLength(row.body, "utf8"), updatedAt: row.updated_at, updatedBy: row.updated_by };
}

export class ContextLayerStore {
  private readonly database: DatabaseSync;

  /**
   * `create: false` opens only an existing file: a hook never creates the shared file, so a computer where nobody saved
   * a layer gets no new state file and no injection. Returns through `open` as null when the file is absent.
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
            CREATE TABLE context_layers (kind TEXT NOT NULL CHECK (kind IN ('global', 'role')), name TEXT NOT NULL, body TEXT NOT NULL,
              state_token TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL,
              PRIMARY KEY (kind, name)) STRICT;
            CREATE TABLE context_history (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL,
              state_token TEXT NOT NULL, digest TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, approval TEXT) STRICT;
            CREATE INDEX context_history_layer ON context_history (kind, name, id);
            CREATE TABLE role_bindings (host TEXT NOT NULL, session_id TEXT NOT NULL, role TEXT NOT NULL, bound_at TEXT NOT NULL,
              approval TEXT NOT NULL, PRIMARY KEY (host, session_id)) STRICT;
            CREATE TABLE context_deliveries (actor_id TEXT PRIMARY KEY, global_token TEXT, role TEXT, role_token TEXT,
              delivered_at TEXT NOT NULL) STRICT;
            PRAGMA user_version = ${CONTEXT_LAYER_SCHEMA_VERSION};`);
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

  private transaction<T>(operation: () => T): T {
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

  read(kind: ContextLayerKind, name = ""): ContextLayerRecord | null {
    const row = this.database.prepare("SELECT * FROM context_layers WHERE kind = ? AND name = ?").get(kind, name) as LayerRow | undefined;
    return row ? layer(row) : null;
  }

  listRoles(): ContextLayerRecord[] {
    return (this.database.prepare("SELECT * FROM context_layers WHERE kind = 'role' ORDER BY name").all() as unknown as LayerRow[]).map(layer);
  }

  /**
   * Replaces the whole body when the caller names the current state token (null: never written). The compare and the
   * write share one BEGIN IMMEDIATE transaction, so of two writers that read the same token only the first succeeds.
   */
  save(kind: ContextLayerKind, name: string, expectedStateToken: string | null, body: string, updatedBy: string,
    approval: ContextApproval | null, now: string): LayerSaveResult {
    return this.transaction(() => {
      const current = this.read(kind, name);
      if ((current?.stateToken ?? null) !== expectedStateToken) return { kind: "stale", actualStateToken: current?.stateToken ?? null } as const;
      const row: LayerRow = { kind, name, body, state_token: newStateToken(), digest: bodyDigest(body), updated_at: now, updated_by: updatedBy };
      this.database.prepare(`INSERT INTO context_layers (kind, name, body, state_token, digest, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, name) DO UPDATE SET body = excluded.body, state_token = excluded.state_token, digest = excluded.digest,
          updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
        .run(kind, name, body, row.state_token, row.digest, now, updatedBy);
      this.database.prepare(`INSERT INTO context_history (kind, name, body, state_token, digest, updated_at, updated_by, approval)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(kind, name, body, row.state_token, row.digest, now, updatedBy, approval ? JSON.stringify(approval) : null);
      this.database.prepare(`DELETE FROM context_history WHERE kind = ? AND name = ? AND id NOT IN
        (SELECT id FROM context_history WHERE kind = ? AND name = ? ORDER BY id DESC LIMIT ${HISTORY_PER_LAYER})`).run(kind, name, kind, name);
      return { kind: "saved", layer: layer(row) } as const;
    });
  }

  history(kind: ContextLayerKind, name = "", limit = HISTORY_PER_LAYER): ContextHistoryRecord[] {
    return (this.database.prepare("SELECT * FROM context_history WHERE kind = ? AND name = ? ORDER BY id DESC LIMIT ?").all(kind, name, limit) as unknown as Array<LayerRow & { approval: string | null }>)
      .map(row => ({ ...layer(row), approval: row.approval ? JSON.parse(row.approval) as ContextApproval : null }));
  }

  binding(host: string, sessionId: string): RoleBindingRecord | null {
    const row = this.database.prepare("SELECT * FROM role_bindings WHERE host = ? AND session_id = ?").get(host, sessionId) as
      { host: string; session_id: string; role: string; bound_at: string; approval: string } | undefined;
    return row ? { host: row.host, sessionId: row.session_id, role: row.role, boundAt: row.bound_at, approval: JSON.parse(row.approval) as ContextApproval } : null;
  }

  listBindings(): RoleBindingRecord[] {
    return (this.database.prepare("SELECT * FROM role_bindings ORDER BY role, host, session_id").all() as unknown as Array<{ host: string; session_id: string; role: string; bound_at: string; approval: string }>)
      .map(row => ({ host: row.host, sessionId: row.session_id, role: row.role, boundAt: row.bound_at, approval: JSON.parse(row.approval) as ContextApproval }));
  }

  /** Binds (role) or unbinds (null) one session; returns the binding now stored. */
  setBinding(host: string, sessionId: string, role: string | null, approval: ContextApproval, now: string): RoleBindingRecord | null {
    return this.transaction(() => {
      this.database.prepare("DELETE FROM role_bindings WHERE bound_at < ?").run(new Date(Date.parse(now) - RETAIN_MS).toISOString());
      if (role === null) {
        this.database.prepare("DELETE FROM role_bindings WHERE host = ? AND session_id = ?").run(host, sessionId);
        return null;
      }
      this.database.prepare(`INSERT INTO role_bindings (host, session_id, role, bound_at, approval) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (host, session_id) DO UPDATE SET role = excluded.role, bound_at = excluded.bound_at, approval = excluded.approval`)
        .run(host, sessionId, role, now, JSON.stringify(approval));
      return this.binding(host, sessionId);
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
