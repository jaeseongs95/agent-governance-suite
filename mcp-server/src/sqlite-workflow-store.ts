import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type WorkflowReceiptV1, WorkflowContractError } from "../../contracts/types.js";
import {
  mergePluginUpdateState,
  type PluginUpdateStore,
  type StoredPluginUpdateState,
} from "./plugin-update-store.js";
import { compareStableVersionNumbers } from "./plugin-version.js";
import { type WorkflowStore } from "./workflow-store.js";

interface MetadataRow {
  value: string;
}

interface RunRow {
  receipt_json: string;
  revision: number;
}

interface PluginUpdateRow {
  target_id: string;
  current_version: string;
  latest_version: string | null;
  latest_tag: string | null;
  latest_commit: string | null;
  etag: string | null;
  comparison: StoredPluginUpdateState["comparison"];
  last_attempt_at: string | null;
  last_successful_check_at: string | null;
  next_check_at: string;
  last_notified_version: string | null;
  last_notified_at: string | null;
  last_error_code: StoredPluginUpdateState["lastErrorCode"];
}

const SCHEMA_VERSION = 2;

export class SqliteWorkflowStore implements WorkflowStore, PluginUpdateStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    if (!databasePath.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database path must not be empty.");
    }
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    }

    let openedDatabase: DatabaseSync | null = null;
    try {
      openedDatabase = new DatabaseSync(databasePath);
      this.database = openedDatabase;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") {
        chmodSync(path.resolve(databasePath), 0o600);
      }
    } catch (cause) {
      try {
        openedDatabase?.close();
      } catch {
        // Preserve the initialization failure.
      }
      throw this.storageError("Cannot initialize the workflow database.", cause);
    }
  }

  getOrCreateSecret(name: string, create: () => string): string {
    try {
      return this.transaction(() => {
        const existing = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(name) as MetadataRow | undefined;
        if (existing) return existing.value;
        const value = create();
        this.database.prepare(`
          INSERT INTO workflow_metadata (key, value, updated_at)
          VALUES (?, ?, ?)
        `).run(name, value, new Date().toISOString());
        return value;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot read or create workflow metadata.", cause, { key: name });
    }
  }

  nextRunSequence(): number {
    try {
      return this.transaction(() => {
        const row = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get() as MetadataRow | undefined;
        const current = row && /^(0|[1-9][0-9]*)$/.test(row.value) ? Number.parseInt(row.value, 10) : 0;
        if ((row && !/^(0|[1-9][0-9]*)$/.test(row.value)) || !Number.isSafeInteger(current) || current < 0) {
          throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is invalid.", { value: row?.value ?? null });
        }
        const next = current + 1;
        if (!Number.isSafeInteger(next)) {
          throw new WorkflowContractError("INVALID_INPUT", "Workflow run sequence is exhausted.", { value: row?.value ?? null });
        }
        this.database.prepare(`
          INSERT INTO workflow_metadata (key, value, updated_at)
          VALUES ('run-sequence', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        `).run(String(next), new Date().toISOString());
        return next;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot reserve the next workflow run sequence.", cause);
    }
  }

  insertRun(receipt: WorkflowReceiptV1): void {
    try {
      this.database.prepare(`
        INSERT INTO workflow_runs (run_id, revision, receipt_json, updated_at)
        VALUES (?, ?, ?, ?)
      `).run(receipt.runId, receipt.revision, JSON.stringify(receipt), new Date().toISOString());
    } catch (cause) {
      throw this.storageError("Cannot persist the workflow run.", cause, { runId: receipt.runId });
    }
  }

  getRun(runId: string): WorkflowReceiptV1 | null {
    try {
      const row = this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(runId) as RunRow | undefined;
      if (!row) return null;
      const receipt = JSON.parse(row.receipt_json) as WorkflowReceiptV1;
      if (receipt.runId !== runId || receipt.revision !== row.revision) {
        throw new WorkflowContractError("INVALID_INPUT", "Stored workflow receipt metadata does not match its payload.", {
          runId,
          storedRevision: row.revision,
          receiptRunId: receipt.runId,
          receiptRevision: receipt.revision,
        });
      }
      return receipt;
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot read the workflow run.", cause, { runId });
    }
  }

  updateRun(receipt: WorkflowReceiptV1, expectedRevision: number): boolean {
    try {
      const result = this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        receipt.revision,
        JSON.stringify(receipt),
        new Date().toISOString(),
        receipt.runId,
        expectedRevision,
      );
      return Number(result.changes) === 1;
    } catch (cause) {
      throw this.storageError("Cannot update the workflow run.", cause, { runId: receipt.runId });
    }
  }

  getPluginUpdateState(targetId: string): StoredPluginUpdateState | null {
    try {
      const row = this.database.prepare(`
        SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
               comparison, last_attempt_at, last_successful_check_at, next_check_at,
               last_notified_version, last_notified_at, last_error_code
        FROM plugin_update_state
        WHERE target_id = ?
      `).get(targetId) as PluginUpdateRow | undefined;
      return row ? {
        targetId: row.target_id,
        currentVersion: row.current_version,
        latestVersion: row.latest_version,
        latestTag: row.latest_tag,
        latestCommit: row.latest_commit,
        etag: row.etag,
        comparison: row.comparison,
        lastAttemptAt: row.last_attempt_at,
        lastSuccessfulCheckAt: row.last_successful_check_at,
        nextCheckAt: row.next_check_at,
        lastNotifiedVersion: row.last_notified_version,
        lastNotifiedAt: row.last_notified_at,
        lastErrorCode: row.last_error_code,
      } : null;
    } catch (cause) {
      throw this.storageError("Cannot read plugin update state.", cause, { targetId });
    }
  }

  putPluginUpdateState(state: StoredPluginUpdateState): void {
    try {
      this.transaction(() => {
        const merged = mergePluginUpdateState(this.readPluginUpdateStateRow(state.targetId), state);
        this.database.prepare(`
        INSERT INTO plugin_update_state (
          target_id, current_version, latest_version, latest_tag, latest_commit, etag,
          comparison, last_attempt_at, last_successful_check_at, next_check_at,
          last_notified_version, last_notified_at, last_error_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_id) DO UPDATE SET
          current_version = excluded.current_version,
          latest_version = excluded.latest_version,
          latest_tag = excluded.latest_tag,
          latest_commit = excluded.latest_commit,
          etag = excluded.etag,
          comparison = excluded.comparison,
          last_attempt_at = excluded.last_attempt_at,
          last_successful_check_at = excluded.last_successful_check_at,
          next_check_at = excluded.next_check_at,
          last_notified_version = excluded.last_notified_version,
          last_notified_at = excluded.last_notified_at,
          last_error_code = excluded.last_error_code
        `).run(
          merged.targetId,
          merged.currentVersion,
          merged.latestVersion,
          merged.latestTag,
          merged.latestCommit,
          merged.etag,
          merged.comparison,
          merged.lastAttemptAt,
          merged.lastSuccessfulCheckAt,
          merged.nextCheckAt,
          merged.lastNotifiedVersion,
          merged.lastNotifiedAt,
          merged.lastErrorCode,
        );
      });
    } catch (cause) {
      throw this.storageError("Cannot persist plugin update state.", cause, { targetId: state.targetId });
    }
  }

  claimPluginUpdateNotice(targetId: string, latestVersion: string, notifiedAt: string): boolean {
    try {
      return this.transaction(() => {
        const state = this.readPluginUpdateStateRow(targetId);
        if (
          !state
          || state.latestVersion !== latestVersion
          || (state.lastNotifiedVersion !== null
            && compareStableVersionNumbers(state.lastNotifiedVersion, latestVersion) >= 0)
        ) return false;
        const result = this.database.prepare(`
        UPDATE plugin_update_state
        SET last_notified_version = ?, last_notified_at = ?
        WHERE target_id = ?
          AND latest_version = ?
        `).run(latestVersion, notifiedAt, targetId, latestVersion);
        return Number(result.changes) === 1;
      });
    } catch (cause) {
      throw this.storageError("Cannot claim plugin update notice.", cause, { targetId, latestVersion });
    }
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private initializeSchema(): void {
    const row = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (row.user_version > SCHEMA_VERSION) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION,
        actualVersion: row.user_version,
      });
    }
    this.transaction(() => {
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          receipt_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS plugin_update_state (
          target_id TEXT PRIMARY KEY,
          current_version TEXT NOT NULL,
          latest_version TEXT,
          latest_tag TEXT,
          latest_commit TEXT,
          etag TEXT,
          comparison TEXT NOT NULL CHECK (comparison IN ('unknown', 'up-to-date', 'update-available', 'ahead-of-stable')),
          last_attempt_at TEXT,
          last_successful_check_at TEXT,
          next_check_at TEXT NOT NULL,
          last_notified_version TEXT,
          last_notified_at TEXT,
          last_error_code TEXT CHECK (
            last_error_code IS NULL
            OR last_error_code IN ('TIMEOUT', 'NETWORK', 'HTTP', 'INVALID_RESPONSE', 'NO_STABLE_TAG')
          )
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
  }

  private readPluginUpdateStateRow(targetId: string): StoredPluginUpdateState | null {
    const row = this.database.prepare(`
      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
             comparison, last_attempt_at, last_successful_check_at, next_check_at,
             last_notified_version, last_notified_at, last_error_code
      FROM plugin_update_state
      WHERE target_id = ?
    `).get(targetId) as PluginUpdateRow | undefined;
    return row ? {
      targetId: row.target_id,
      currentVersion: row.current_version,
      latestVersion: row.latest_version,
      latestTag: row.latest_tag,
      latestCommit: row.latest_commit,
      etag: row.etag,
      comparison: row.comparison,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessfulCheckAt: row.last_successful_check_at,
      nextCheckAt: row.next_check_at,
      lastNotifiedVersion: row.last_notified_version,
      lastNotifiedAt: row.last_notified_at,
      lastErrorCode: row.last_error_code,
    } : null;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // Preserve the original failure.
      }
      throw cause;
    }
  }

  private storageError(message: string, cause: unknown, details: Record<string, unknown> = {}): WorkflowContractError {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
