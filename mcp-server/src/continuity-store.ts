import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContinuitySnapshotV1 } from "../../contracts/types.js";

export interface ContinuityTaskRecord {
  taskCorrelation: string;
  currentEpoch: number;
  rootId: string | null;
  suppressed: boolean;
  lastAutoInjectedRevision: number | null;
  pendingSource: "direct" | "workflow" | null;
  pendingRevision: number | null;
  pendingDigest: string | null;
  pendingRootId: string | null;
  pendingConsumed: boolean;
  updatedAt: string;
}

export interface StoredRequest {
  commandDigest: string;
  resultJson: string;
}

interface TaskRow {
  task_correlation: string;
  current_epoch: number;
  root_id: string | null;
  suppressed: number;
  last_auto_injected_revision: number | null;
  pending_source: "direct" | "workflow" | null;
  pending_revision: number | null;
  pending_digest: string | null;
  pending_root_id: string | null;
  pending_consumed: number;
  updated_at: string;
}

interface SnapshotRow { snapshot_json: string }
interface MetadataRow { value: string }
interface RequestRow { command_digest: string; result_json: string }

const SCHEMA_VERSION = 1;

export class ContinuityStoreError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "ContinuityStoreError";
  }
}

function taskRecord(row: TaskRow): ContinuityTaskRecord {
  return {
    taskCorrelation: row.task_correlation,
    currentEpoch: row.current_epoch,
    rootId: row.root_id,
    suppressed: row.suppressed === 1,
    lastAutoInjectedRevision: row.last_auto_injected_revision,
    pendingSource: row.pending_source,
    pendingRevision: row.pending_revision,
    pendingDigest: row.pending_digest,
    pendingRootId: row.pending_root_id,
    pendingConsumed: row.pending_consumed === 1,
    updatedAt: row.updated_at,
  };
}

export class SqliteContinuityStore {
  private readonly database: DatabaseSync;
  private closed = false;

  constructor(readonly databasePath: string) {
    if (!databasePath.trim()) throw new ContinuityStoreError("Continuity database path must not be empty.");
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(databasePath);
      this.database = opened;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path.resolve(databasePath), 0o600);
    } catch (cause) {
      try { opened?.close(); } catch { /* Preserve the initialization failure. */ }
      throw new ContinuityStoreError("Cannot initialize the continuity database.", cause);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  getOrCreateSecret(create: () => string): string {
    const existing = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get() as MetadataRow | undefined;
    if (existing) return existing.value;
    const value = create();
    this.database.prepare("INSERT OR IGNORE INTO continuity_metadata(key, value) VALUES ('signing-secret', ?)").run(value);
    const stored = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get() as MetadataRow | undefined;
    if (!stored) throw new ContinuityStoreError("Cannot initialize the continuity signing secret.");
    return stored.value;
  }

  ensureTask(taskCorrelation: string, now: string): ContinuityTaskRecord {
    this.database.prepare(`
      INSERT INTO continuity_tasks(task_correlation, current_epoch, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(task_correlation) DO NOTHING
    `).run(taskCorrelation, now);
    return this.getTask(taskCorrelation)!;
  }

  getTask(taskCorrelation: string): ContinuityTaskRecord | null {
    const row = this.database.prepare("SELECT * FROM continuity_tasks WHERE task_correlation = ?").get(taskCorrelation) as TaskRow | undefined;
    return row ? taskRecord(row) : null;
  }

  rotateEpoch(taskCorrelation: string, now: string): ContinuityTaskRecord {
    this.ensureTask(taskCorrelation, now);
    this.database.prepare(`
      UPDATE continuity_tasks
      SET current_epoch = current_epoch + 1, root_id = NULL, suppressed = 0,
          last_auto_injected_revision = NULL, pending_source = NULL,
          pending_revision = NULL, pending_digest = NULL, pending_root_id = NULL,
          pending_consumed = 0, updated_at = ?
      WHERE task_correlation = ?
    `).run(now, taskCorrelation);
    return this.getTask(taskCorrelation)!;
  }

  bindRoot(taskCorrelation: string, epoch: number, rootId: string, now: string): boolean {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET root_id = ?, suppressed = 0, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(rootId, now, taskCorrelation, epoch);
    return result.changes === 1;
  }

  setSuppressed(taskCorrelation: string, epoch: number, now: string): boolean {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET suppressed = 1, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(now, taskCorrelation, epoch);
    return result.changes === 1;
  }

  getSnapshot(taskCorrelation: string, epoch: number): ContinuitySnapshotV1 | null {
    const row = this.database.prepare(`
      SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?
    `).get(taskCorrelation, epoch) as SnapshotRow | undefined;
    return row ? JSON.parse(row.snapshot_json) as ContinuitySnapshotV1 : null;
  }

  getRequest(taskCorrelation: string, epoch: number, requestHash: string): StoredRequest | null {
    const row = this.database.prepare(`
      SELECT command_digest, result_json FROM continuity_requests
      WHERE task_correlation = ? AND epoch = ? AND request_hash = ?
    `).get(taskCorrelation, epoch, requestHash) as RequestRow | undefined;
    return row ? { commandDigest: row.command_digest, resultJson: row.result_json } : null;
  }

  checkpoint(
    taskCorrelation: string,
    epoch: number,
    expectedRevision: number,
    requestHash: string,
    commandDigest: string,
    snapshot: ContinuitySnapshotV1,
  ): { kind: "stored" } | { kind: "stale"; actualRevision: number } | { kind: "replay"; request: StoredRequest } | { kind: "conflict" } {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) {
        this.database.exec("COMMIT;");
        return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      }
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? 0;
      if (actualRevision !== expectedRevision) {
        this.database.exec("ROLLBACK;");
        return { kind: "stale", actualRevision };
      }
      const json = JSON.stringify(snapshot);
      const resultJson = JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "checkpoint",
        epoch,
        revision: snapshot.revision,
        snapshotDigest: snapshot.snapshotDigest,
      });
      this.database.prepare(`
        INSERT INTO continuity_snapshots(task_correlation, epoch, revision, snapshot_digest, snapshot_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_correlation, epoch) DO UPDATE SET
          revision = excluded.revision, snapshot_digest = excluded.snapshot_digest,
          snapshot_json = excluded.snapshot_json, updated_at = excluded.updated_at
      `).run(taskCorrelation, epoch, snapshot.revision, snapshot.snapshotDigest, json, snapshot.updatedAt);
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, snapshot.updatedAt);
      this.database.exec("COMMIT;");
      return { kind: "stored" };
    } catch (cause) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary failure. */ }
      throw new ContinuityStoreError("Cannot store the continuity checkpoint.", cause);
    }
  }

  purge(
    taskCorrelation: string,
    epoch: number,
    expectedRevision: number,
    requestHash: string,
    commandDigest: string,
    tombstoneDigest: string,
    now: string,
  ): { kind: "purged" } | { kind: "stale"; actualRevision: number } | { kind: "replay"; request: StoredRequest } | { kind: "conflict" } {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) {
        this.database.exec("COMMIT;");
        return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      }
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? 0;
      if (!current || actualRevision !== expectedRevision) {
        this.database.exec("ROLLBACK;");
        return { kind: "stale", actualRevision };
      }
      this.database.prepare("DELETE FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?").run(taskCorrelation, epoch);
      this.database.prepare(`
        INSERT INTO continuity_tombstones(task_correlation, epoch, revision, payload_digest, purged_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(task_correlation, epoch) DO UPDATE SET
          revision = excluded.revision, payload_digest = excluded.payload_digest, purged_at = excluded.purged_at
      `).run(taskCorrelation, epoch, expectedRevision, tombstoneDigest, now);
      const scrubbedRequestJson = JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "purged-request",
        epoch,
        revision: expectedRevision,
        tombstoneDigest,
        purgedAt: now,
      });
      this.database.prepare(`
        UPDATE continuity_requests SET result_json = ?
        WHERE task_correlation = ? AND epoch = ?
      `).run(scrubbedRequestJson, taskCorrelation, epoch);
      const resultJson = JSON.stringify({ schemaVersion: "1.0.0", purged: true, epoch, revision: expectedRevision, tombstoneDigest, purgedAt: now });
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      this.database.exec("COMMIT;");
      return { kind: "purged" };
    } catch (cause) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary failure. */ }
      throw new ContinuityStoreError("Cannot purge the continuity checkpoint.", cause);
    }
  }

  setPendingMarker(
    taskCorrelation: string,
    epoch: number,
    source: "direct" | "workflow",
    revision: number,
    digest: string,
    rootId: string | null,
    now: string,
  ): boolean {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET pending_source = ?, pending_revision = ?, pending_digest = ?,
        pending_root_id = ?, pending_consumed = 0, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(source, revision, digest, rootId, now, taskCorrelation, epoch);
    return result.changes === 1;
  }

  consumeWorkflowMarker(taskCorrelation: string, epoch: number, revision: number, digest: string, now: string): boolean {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET pending_consumed = 1, last_auto_injected_revision = ?, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ? AND pending_source = 'workflow'
        AND pending_revision = ? AND pending_digest = ? AND pending_consumed = 0
    `).run(revision, now, taskCorrelation, epoch, revision, digest);
    return result.changes === 1;
  }

  recordObservation(taskCorrelation: string, epoch: number, event: string, turnHash: string | null, success: boolean, now: string): void {
    this.database.prepare(`
      INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskCorrelation, epoch, event, turnHash, success ? 1 : 0, now);
  }

  private initializeSchema(): void {
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version !== 0 && version.user_version !== SCHEMA_VERSION) {
      throw new ContinuityStoreError(`Unsupported continuity schema version ${version.user_version}.`);
    }
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS continuity_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuity_tasks (
        task_correlation TEXT PRIMARY KEY,
        current_epoch INTEGER NOT NULL CHECK (current_epoch >= 1),
        root_id TEXT,
        suppressed INTEGER NOT NULL DEFAULT 0 CHECK (suppressed IN (0, 1)),
        last_auto_injected_revision INTEGER,
        pending_source TEXT CHECK (pending_source IN ('direct', 'workflow')),
        pending_revision INTEGER,
        pending_digest TEXT,
        pending_root_id TEXT,
        pending_consumed INTEGER NOT NULL DEFAULT 0 CHECK (pending_consumed IN (0, 1)),
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS continuity_snapshots (
        task_correlation TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL CHECK (revision >= 1),
        snapshot_digest TEXT NOT NULL,
        snapshot_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(task_correlation, epoch)
      );
      CREATE TABLE IF NOT EXISTS continuity_requests (
        task_correlation TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        request_hash TEXT NOT NULL,
        command_digest TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(task_correlation, epoch, request_hash)
      );
      CREATE TABLE IF NOT EXISTS continuity_tombstones (
        task_correlation TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        payload_digest TEXT NOT NULL,
        purged_at TEXT NOT NULL,
        PRIMARY KEY(task_correlation, epoch)
      );
      CREATE TABLE IF NOT EXISTS continuity_observations (
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_correlation TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        event TEXT NOT NULL,
        turn_hash TEXT,
        success INTEGER NOT NULL CHECK (success IN (0, 1)),
        observed_at TEXT NOT NULL
      );
    `);
    if (version.user_version === 0) this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
}
