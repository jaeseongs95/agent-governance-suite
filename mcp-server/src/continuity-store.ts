import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ContinuitySnapshotV1, StateCleanupPlanV1 } from "../../contracts/types.js";

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

export interface ContinuityTombstoneRecord {
  revision: number;
  payloadDigest: string;
  purgedAt: string;
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
interface RequestPayloadRow { request_hash: string; result_json: string }
interface TombstoneRow { revision: number; payload_digest: string; purged_at: string }

export interface ContinuityCleanupPreview {
  snapshots: StateCleanupPlanV1["candidates"]["continuitySnapshots"];
  tasks: StateCleanupPlanV1["candidates"]["continuityTasks"];
  protectedActiveTasks: number;
}

const SCHEMA_VERSION = 2;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isBodyFreeRequestReceipt(value: Record<string, unknown> | null): boolean {
  if (!value || value.schemaVersion !== "1.0.0") return false;
  if (value.kind === "checkpoint") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "snapshotDigest"])
      && Number.isInteger(value.epoch) && Number.isInteger(value.revision)
      && typeof value.snapshotDigest === "string" && SHA256_DIGEST.test(value.snapshotDigest);
  }
  if (value.kind === "purged-request") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "tombstoneDigest", "purgedAt"])
      && Number.isInteger(value.epoch) && Number.isInteger(value.revision)
      && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest)
      && typeof value.purgedAt === "string";
  }
  return value.purged === true
    && hasExactKeys(value, ["schemaVersion", "purged", "epoch", "revision", "tombstoneDigest", "purgedAt"])
    && Number.isInteger(value.epoch) && Number.isInteger(value.revision)
    && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest)
    && typeof value.purgedAt === "string";
}

export class ContinuityStoreError extends Error {
  constructor(message: string, readonly causeValue?: unknown) {
    super(message);
    this.name = "ContinuityStoreError";
  }
}

function purgedRequestJson(epoch: number, revision: number, tombstoneDigest: string, purgedAt: string): string {
  return JSON.stringify({ schemaVersion: "1.0.0", kind: "purged-request", epoch, revision, tombstoneDigest, purgedAt });
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

  getTombstone(taskCorrelation: string, epoch: number): ContinuityTombstoneRecord | null {
    const row = this.database.prepare(`
      SELECT revision, payload_digest, purged_at FROM continuity_tombstones
      WHERE task_correlation = ? AND epoch = ?
    `).get(taskCorrelation, epoch) as TombstoneRow | undefined;
    return row ? { revision: row.revision, payloadDigest: row.payload_digest, purgedAt: row.purged_at } : null;
  }

  checkpoint(
    taskCorrelation: string,
    epoch: number,
    expectedRevision: number,
    requestHash: string,
    commandDigest: string,
    snapshot: ContinuitySnapshotV1,
  ): { kind: "stored" } | { kind: "stale"; actualRevision: number } | { kind: "replay"; request: StoredRequest } | { kind: "conflict" } {
    return this.transaction("Cannot store the continuity checkpoint.", () => {
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? this.getTombstone(taskCorrelation, epoch)?.revision ?? 0;
      if (actualRevision !== expectedRevision) return { kind: "stale", actualRevision };
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
      return { kind: "stored" };
    });
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
    return this.transaction("Cannot purge the continuity checkpoint.", () => {
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? 0;
      if (!current || actualRevision !== expectedRevision) return { kind: "stale", actualRevision };
      this.tombstone(taskCorrelation, epoch, expectedRevision, tombstoneDigest, now);
      const scrubbedRequestJson = purgedRequestJson(epoch, expectedRevision, tombstoneDigest, now);
      const storedRequests = this.database.prepare(`
        SELECT request_hash, result_json FROM continuity_requests
        WHERE task_correlation = ? AND epoch = ?
      `).all(taskCorrelation, epoch) as unknown as RequestPayloadRow[];
      const scrubRequest = this.database.prepare(`
        UPDATE continuity_requests SET result_json = ?
        WHERE task_correlation = ? AND epoch = ? AND request_hash = ?
      `);
      for (const storedRequest of storedRequests) {
        let parsed: Record<string, unknown> | null = null;
        try {
          const value = JSON.parse(storedRequest.result_json) as unknown;
          parsed = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
        } catch { /* Unknown legacy content is scrubbed below. */ }
        if (!isBodyFreeRequestReceipt(parsed)) {
          scrubRequest.run(scrubbedRequestJson, taskCorrelation, epoch, storedRequest.request_hash);
        }
      }
      const resultJson = JSON.stringify({ schemaVersion: "1.0.0", purged: true, epoch, revision: expectedRevision, tombstoneDigest, purgedAt: now });
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      return { kind: "purged" };
    });
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

  getSchemaVersion(): number {
    return (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  previewCleanup(payloadCutoff: string, recordCutoff: string): ContinuityCleanupPreview {
    const snapshotRows = this.database.prepare(`
      SELECT snapshots.task_correlation, tasks.root_id, snapshots.epoch, snapshots.revision,
             snapshots.snapshot_digest, snapshots.snapshot_json, snapshots.updated_at
      FROM continuity_snapshots snapshots
      LEFT JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation
      WHERE snapshots.updated_at <= ?
      ORDER BY snapshots.task_correlation, snapshots.epoch
    `).all(payloadCutoff) as unknown as Array<{
      task_correlation: string;
      root_id: string | null;
      epoch: number;
      revision: number;
      snapshot_digest: string;
      snapshot_json: string;
      updated_at: string;
    }>;
    let protectedActiveTasks = 0;
    const snapshots = [];
    for (const row of snapshotRows) {
      const snapshot = JSON.parse(row.snapshot_json) as ContinuitySnapshotV1;
      if (snapshot.status === "active") {
        protectedActiveTasks += 1;
        continue;
      }
      snapshots.push({
        taskCorrelation: row.task_correlation,
        rootId: row.root_id,
        epoch: row.epoch,
        revision: row.revision,
        snapshotDigest: row.snapshot_digest,
        updatedAt: row.updated_at,
      });
    }
    const taskRows = this.database.prepare(`
      SELECT task_correlation, current_epoch, root_id, updated_at
      FROM continuity_tasks tasks
      WHERE updated_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM continuity_snapshots snapshots
          WHERE snapshots.task_correlation = tasks.task_correlation AND snapshots.updated_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM continuity_requests requests
          WHERE requests.task_correlation = tasks.task_correlation AND requests.created_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM continuity_tombstones tombstones
          WHERE tombstones.task_correlation = tasks.task_correlation AND tombstones.purged_at > ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM continuity_observations observations
          WHERE observations.task_correlation = tasks.task_correlation AND observations.observed_at > ?
        )
      ORDER BY task_correlation
    `).all(recordCutoff, recordCutoff, recordCutoff, recordCutoff, recordCutoff) as unknown as Array<{
      task_correlation: string;
      current_epoch: number;
      root_id: string | null;
      updated_at: string;
    }>;
    const tasks = [];
    for (const row of taskRows) {
      const active = this.database.prepare(`
        SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ?
      `).all(row.task_correlation) as unknown as SnapshotRow[];
      if (active.some((item) => (JSON.parse(item.snapshot_json) as ContinuitySnapshotV1).status === "active")) {
        protectedActiveTasks += 1;
        continue;
      }
      tasks.push({
        taskCorrelation: row.task_correlation,
        currentEpoch: row.current_epoch,
        rootId: row.root_id,
        updatedAt: row.updated_at,
      });
    }
    const fullTaskIds = new Set(tasks.map((task) => task.taskCorrelation));
    return { snapshots: snapshots.filter((snapshot) => !fullTaskIds.has(snapshot.taskCorrelation)), tasks, protectedActiveTasks };
  }

  backupTo(targetPath: string): void {
    if (this.databasePath === ":memory:") throw new ContinuityStoreError("An in-memory continuity database cannot be cleaned destructively.");
    try {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    } catch (cause) {
      throw new ContinuityStoreError("Cannot create a verified continuity cleanup backup.", cause);
    }
  }

  executeCleanup(
    preview: ContinuityCleanupPreview,
    now: string,
    payloadCutoff: string,
    recordCutoff: string,
  ): { snapshots: number; tasks: number } {
    return this.transaction("Cannot execute continuity state cleanup.", () => {
      const verifySnapshot = this.database.prepare(`
        SELECT snapshots.revision, snapshots.snapshot_digest, snapshots.snapshot_json,
               snapshots.updated_at, tasks.root_id
        FROM continuity_snapshots snapshots
        LEFT JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation
        WHERE snapshots.task_correlation = ? AND snapshots.epoch = ?
      `);
      const verifyTask = this.database.prepare(`
        SELECT current_epoch, root_id, updated_at FROM continuity_tasks WHERE task_correlation = ?
      `);
      for (const snapshot of preview.snapshots) {
        const row = verifySnapshot.get(snapshot.taskCorrelation, snapshot.epoch) as {
          revision: number; snapshot_digest: string; snapshot_json: string; updated_at: string; root_id: string | null;
        } | undefined;
        const status = row ? (JSON.parse(row.snapshot_json) as ContinuitySnapshotV1).status : null;
        if (!row || status === "active" || row.updated_at > payloadCutoff
          || row.root_id !== snapshot.rootId || row.revision !== snapshot.revision
          || row.snapshot_digest !== snapshot.snapshotDigest || row.updated_at !== snapshot.updatedAt) {
          throw new ContinuityStoreError(`Continuity snapshot ${snapshot.taskCorrelation}/${snapshot.epoch} changed after preview.`);
        }
      }
      for (const task of preview.tasks) {
        const row = verifyTask.get(task.taskCorrelation) as { current_epoch: number; root_id: string | null; updated_at: string } | undefined;
        if (!row || row.current_epoch !== task.currentEpoch || row.root_id !== task.rootId || row.updated_at !== task.updatedAt) {
          throw new ContinuityStoreError(`Continuity task ${task.taskCorrelation} changed after preview.`);
        }
        const childState = this.database.prepare(`
          SELECT
            EXISTS(
              SELECT 1 FROM continuity_snapshots
              WHERE task_correlation = ? AND (updated_at > ? OR json_extract(snapshot_json, '$.status') = 'active')
            ) AS invalid_snapshot,
            EXISTS(SELECT 1 FROM continuity_requests WHERE task_correlation = ? AND created_at > ?) AS recent_request,
            EXISTS(SELECT 1 FROM continuity_tombstones WHERE task_correlation = ? AND purged_at > ?) AS recent_tombstone,
            EXISTS(SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND observed_at > ?) AS recent_observation
        `).get(
          task.taskCorrelation, recordCutoff,
          task.taskCorrelation, recordCutoff,
          task.taskCorrelation, recordCutoff,
          task.taskCorrelation, recordCutoff,
        ) as { invalid_snapshot: number; recent_request: number; recent_tombstone: number; recent_observation: number };
        if (childState.invalid_snapshot || childState.recent_request || childState.recent_tombstone || childState.recent_observation) {
          throw new ContinuityStoreError(`Continuity task ${task.taskCorrelation} gained active or recent child state after preview.`);
        }
      }

      const scrubbed = this.database.prepare(`
        UPDATE continuity_requests SET result_json = ?
        WHERE task_correlation = ? AND epoch = ?
      `);
      for (const snapshot of preview.snapshots) {
        this.tombstone(snapshot.taskCorrelation, snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, now);
        scrubbed.run(
          purgedRequestJson(snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, now),
          snapshot.taskCorrelation,
          snapshot.epoch,
        );
        this.database.prepare("UPDATE continuity_tasks SET updated_at = ? WHERE task_correlation = ?")
          .run(now, snapshot.taskCorrelation);
      }

      const deleteByTask = [
        "continuity_snapshots", "continuity_requests", "continuity_tombstones", "continuity_observations",
      ].map((table) => this.database.prepare(`DELETE FROM ${table} WHERE task_correlation = ?`));
      for (const task of preview.tasks) {
        for (const statement of deleteByTask) statement.run(task.taskCorrelation);
        this.database.prepare("DELETE FROM continuity_tasks WHERE task_correlation = ?").run(task.taskCorrelation);
      }
      return { snapshots: preview.snapshots.length, tasks: preview.tasks.length };
    });
  }

  /** Deletes the snapshot payload and keeps only its revision and digest. */
  private tombstone(taskCorrelation: string, epoch: number, revision: number, payloadDigest: string, purgedAt: string): void {
    this.database.prepare("DELETE FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?").run(taskCorrelation, epoch);
    this.database.prepare(`
      INSERT INTO continuity_tombstones(task_correlation, epoch, revision, payload_digest, purged_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_correlation, epoch) DO UPDATE SET
        revision = excluded.revision, payload_digest = excluded.payload_digest, purged_at = excluded.purged_at
    `).run(taskCorrelation, epoch, revision, payloadDigest, purgedAt);
  }

  /**
   * Runs a write transaction. Early returns commit without having written;
   * failures roll back and surface as ContinuityStoreError.
   */
  private transaction<T>(message: string, operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary failure. */ }
      if (cause instanceof ContinuityStoreError) throw cause;
      throw new ContinuityStoreError(message, cause);
    }
  }

  private initializeSchema(): void {
    const version = this.database.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version < 0 || version.user_version > SCHEMA_VERSION) {
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
      CREATE INDEX IF NOT EXISTS continuity_snapshots_cleanup
        ON continuity_snapshots(updated_at, task_correlation, epoch);
      CREATE INDEX IF NOT EXISTS continuity_tasks_cleanup
        ON continuity_tasks(updated_at, task_correlation);
      CREATE INDEX IF NOT EXISTS continuity_requests_cleanup
        ON continuity_requests(created_at, task_correlation, epoch);
      CREATE INDEX IF NOT EXISTS continuity_tombstones_cleanup
        ON continuity_tombstones(purged_at, task_correlation, epoch);
      CREATE INDEX IF NOT EXISTS continuity_observations_cleanup
        ON continuity_observations(observed_at, task_correlation, epoch);
    `);
    if (version.user_version < SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
  }
}
