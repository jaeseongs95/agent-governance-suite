import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type WorkflowReceiptV1, WorkflowContractError } from "../../contracts/types.js";
import { type WorkflowStore } from "./workflow-store.js";

interface MetadataRow {
  value: string;
}

interface RunRow {
  receipt_json: string;
  revision: number;
}

const SCHEMA_VERSION = 1;

export class SqliteWorkflowStore implements WorkflowStore {
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
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
    });
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
