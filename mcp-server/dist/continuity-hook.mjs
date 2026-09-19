#!/usr/bin/env node

// mcp-server/src/continuity-hook.ts
import { readFileSync } from "node:fs";
import path5 from "node:path";
import { fileURLToPath } from "node:url";

// mcp-server/src/continuity-service.ts
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// contracts/types.ts
var WorkflowContractError = class extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
    this.name = "WorkflowContractError";
  }
  code;
  details;
  toBody() {
    return { code: this.code, message: this.message, details: this.details };
  }
};

// mcp-server/src/convergence-logic.ts
import { createHash } from "node:crypto";
import path from "node:path";
function canonicalJson(value, subject = "Convergence input") {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, subject)).join(",")}]`;
  if (value && typeof value === "object") {
    const record2 = value;
    return `{${Object.keys(record2).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record2[key], subject)}`).join(",")}}`;
  }
  throw new WorkflowContractError("INVALID_INPUT", `${subject} contains a non-serializable value.`);
}
function convergenceDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
function normalizedScope(value, workspaceLocator) {
  const normalized = path.resolve(workspaceLocator, value).replaceAll("\\", "/").replace(/\/+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
function scopeEntryOverlaps(left, leftWorkspace, right, rightWorkspace) {
  const a = normalizedScope(left, leftWorkspace);
  const b = normalizedScope(right, rightWorkspace);
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function rootsOverlap(left, right) {
  const sameWorkspace = left.frame.workspace.workspaceId === right.frame.workspace.workspaceId || normalizeWorkspaceLocator(left.frame.workspace.locator) === normalizeWorkspaceLocator(right.frame.workspace.locator);
  if (!sameWorkspace) return false;
  return left.taskEnvelope.scope.included.some((leftTarget) => right.taskEnvelope.scope.included.some((rightTarget) => scopeEntryOverlaps(
    leftTarget,
    left.frame.workspace.locator,
    rightTarget,
    right.frame.workspace.locator
  )));
}
function normalizeWorkspaceLocator(locator) {
  const resolved = path.resolve(locator);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

// mcp-server/src/continuity-store.ts
import { chmodSync, mkdirSync } from "node:fs";
import path2 from "node:path";
import { DatabaseSync } from "node:sqlite";
var SCHEMA_VERSION = 2;
var SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;
function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isBodyFreeRequestReceipt(value) {
  if (!value || value.schemaVersion !== "1.0.0") return false;
  if (value.kind === "checkpoint") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "snapshotDigest"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.snapshotDigest === "string" && SHA256_DIGEST.test(value.snapshotDigest);
  }
  if (value.kind === "purged-request") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "revision", "tombstoneDigest", "purgedAt"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest) && typeof value.purgedAt === "string";
  }
  return value.purged === true && hasExactKeys(value, ["schemaVersion", "purged", "epoch", "revision", "tombstoneDigest", "purgedAt"]) && Number.isInteger(value.epoch) && Number.isInteger(value.revision) && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest) && typeof value.purgedAt === "string";
}
var ContinuityStoreError = class extends Error {
  constructor(message, causeValue) {
    super(message);
    this.causeValue = causeValue;
    this.name = "ContinuityStoreError";
  }
  causeValue;
};
function taskRecord(row) {
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
    updatedAt: row.updated_at
  };
}
var SqliteContinuityStore = class {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (!databasePath.trim()) throw new ContinuityStoreError("Continuity database path must not be empty.");
    if (databasePath !== ":memory:") mkdirSync(path2.dirname(path2.resolve(databasePath)), { recursive: true, mode: 448 });
    let opened = null;
    try {
      opened = new DatabaseSync(databasePath);
      this.database = opened;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path2.resolve(databasePath), 384);
    } catch (cause) {
      try {
        opened?.close();
      } catch {
      }
      throw new ContinuityStoreError("Cannot initialize the continuity database.", cause);
    }
  }
  databasePath;
  database;
  closed = false;
  close() {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
  getOrCreateSecret(create) {
    const existing = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get();
    if (existing) return existing.value;
    const value = create();
    this.database.prepare("INSERT OR IGNORE INTO continuity_metadata(key, value) VALUES ('signing-secret', ?)").run(value);
    const stored = this.database.prepare("SELECT value FROM continuity_metadata WHERE key = 'signing-secret'").get();
    if (!stored) throw new ContinuityStoreError("Cannot initialize the continuity signing secret.");
    return stored.value;
  }
  ensureTask(taskCorrelation, now) {
    this.database.prepare(`
      INSERT INTO continuity_tasks(task_correlation, current_epoch, updated_at)
      VALUES (?, 1, ?)
      ON CONFLICT(task_correlation) DO NOTHING
    `).run(taskCorrelation, now);
    return this.getTask(taskCorrelation);
  }
  getTask(taskCorrelation) {
    const row = this.database.prepare("SELECT * FROM continuity_tasks WHERE task_correlation = ?").get(taskCorrelation);
    return row ? taskRecord(row) : null;
  }
  rotateEpoch(taskCorrelation, now) {
    this.ensureTask(taskCorrelation, now);
    this.database.prepare(`
      UPDATE continuity_tasks
      SET current_epoch = current_epoch + 1, root_id = NULL, suppressed = 0,
          last_auto_injected_revision = NULL, pending_source = NULL,
          pending_revision = NULL, pending_digest = NULL, pending_root_id = NULL,
          pending_consumed = 0, updated_at = ?
      WHERE task_correlation = ?
    `).run(now, taskCorrelation);
    return this.getTask(taskCorrelation);
  }
  bindRoot(taskCorrelation, epoch, rootId, now) {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET root_id = ?, suppressed = 0, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(rootId, now, taskCorrelation, epoch);
    return result.changes === 1;
  }
  setSuppressed(taskCorrelation, epoch, now) {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET suppressed = 1, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(now, taskCorrelation, epoch);
    return result.changes === 1;
  }
  getSnapshot(taskCorrelation, epoch) {
    const row = this.database.prepare(`
      SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?
    `).get(taskCorrelation, epoch);
    return row ? JSON.parse(row.snapshot_json) : null;
  }
  getRequest(taskCorrelation, epoch, requestHash) {
    const row = this.database.prepare(`
      SELECT command_digest, result_json FROM continuity_requests
      WHERE task_correlation = ? AND epoch = ? AND request_hash = ?
    `).get(taskCorrelation, epoch, requestHash);
    return row ? { commandDigest: row.command_digest, resultJson: row.result_json } : null;
  }
  getTombstone(taskCorrelation, epoch) {
    const row = this.database.prepare(`
      SELECT revision, payload_digest, purged_at FROM continuity_tombstones
      WHERE task_correlation = ? AND epoch = ?
    `).get(taskCorrelation, epoch);
    return row ? { revision: row.revision, payloadDigest: row.payload_digest, purgedAt: row.purged_at } : null;
  }
  checkpoint(taskCorrelation, epoch, expectedRevision, requestHash, commandDigest, snapshot) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) {
        this.database.exec("COMMIT;");
        return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      }
      const current = this.getSnapshot(taskCorrelation, epoch);
      const actualRevision = current?.revision ?? this.getTombstone(taskCorrelation, epoch)?.revision ?? 0;
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
        snapshotDigest: snapshot.snapshotDigest
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
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw new ContinuityStoreError("Cannot store the continuity checkpoint.", cause);
    }
  }
  purge(taskCorrelation, epoch, expectedRevision, requestHash, commandDigest, tombstoneDigest, now) {
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
        purgedAt: now
      });
      const storedRequests = this.database.prepare(`
        SELECT request_hash, result_json FROM continuity_requests
        WHERE task_correlation = ? AND epoch = ?
      `).all(taskCorrelation, epoch);
      const scrubRequest = this.database.prepare(`
        UPDATE continuity_requests SET result_json = ?
        WHERE task_correlation = ? AND epoch = ? AND request_hash = ?
      `);
      for (const storedRequest of storedRequests) {
        let parsed = null;
        try {
          const value = JSON.parse(storedRequest.result_json);
          parsed = value && typeof value === "object" && !Array.isArray(value) ? value : null;
        } catch {
        }
        if (!isBodyFreeRequestReceipt(parsed)) {
          scrubRequest.run(scrubbedRequestJson, taskCorrelation, epoch, storedRequest.request_hash);
        }
      }
      const resultJson = JSON.stringify({ schemaVersion: "1.0.0", purged: true, epoch, revision: expectedRevision, tombstoneDigest, purgedAt: now });
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      this.database.exec("COMMIT;");
      return { kind: "purged" };
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw new ContinuityStoreError("Cannot purge the continuity checkpoint.", cause);
    }
  }
  setPendingMarker(taskCorrelation, epoch, source, revision, digest, rootId, now) {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET pending_source = ?, pending_revision = ?, pending_digest = ?,
        pending_root_id = ?, pending_consumed = 0, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ?
    `).run(source, revision, digest, rootId, now, taskCorrelation, epoch);
    return result.changes === 1;
  }
  consumeWorkflowMarker(taskCorrelation, epoch, revision, digest, now) {
    const result = this.database.prepare(`
      UPDATE continuity_tasks SET pending_consumed = 1, last_auto_injected_revision = ?, updated_at = ?
      WHERE task_correlation = ? AND current_epoch = ? AND pending_source = 'workflow'
        AND pending_revision = ? AND pending_digest = ? AND pending_consumed = 0
    `).run(revision, now, taskCorrelation, epoch, revision, digest);
    return result.changes === 1;
  }
  recordObservation(taskCorrelation, epoch, event, turnHash, success, now) {
    this.database.prepare(`
      INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(taskCorrelation, epoch, event, turnHash, success ? 1 : 0, now);
  }
  getSchemaVersion() {
    return this.database.prepare("PRAGMA user_version").get().user_version;
  }
  previewCleanup(payloadCutoff, recordCutoff) {
    const snapshotRows = this.database.prepare(`
      SELECT snapshots.task_correlation, tasks.root_id, snapshots.epoch, snapshots.revision,
             snapshots.snapshot_digest, snapshots.snapshot_json, snapshots.updated_at
      FROM continuity_snapshots snapshots
      LEFT JOIN continuity_tasks tasks ON tasks.task_correlation = snapshots.task_correlation
      WHERE snapshots.updated_at <= ?
      ORDER BY snapshots.task_correlation, snapshots.epoch
    `).all(payloadCutoff);
    let protectedActiveTasks = 0;
    const snapshots = [];
    for (const row of snapshotRows) {
      const snapshot = JSON.parse(row.snapshot_json);
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
        updatedAt: row.updated_at
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
    `).all(recordCutoff, recordCutoff, recordCutoff, recordCutoff, recordCutoff);
    const tasks = [];
    for (const row of taskRows) {
      const active = this.database.prepare(`
        SELECT snapshot_json FROM continuity_snapshots WHERE task_correlation = ?
      `).all(row.task_correlation);
      if (active.some((item) => JSON.parse(item.snapshot_json).status === "active")) {
        protectedActiveTasks += 1;
        continue;
      }
      tasks.push({
        taskCorrelation: row.task_correlation,
        currentEpoch: row.current_epoch,
        rootId: row.root_id,
        updatedAt: row.updated_at
      });
    }
    const fullTaskIds = new Set(tasks.map((task) => task.taskCorrelation));
    return { snapshots: snapshots.filter((snapshot) => !fullTaskIds.has(snapshot.taskCorrelation)), tasks, protectedActiveTasks };
  }
  backupTo(targetPath) {
    if (this.databasePath === ":memory:") throw new ContinuityStoreError("An in-memory continuity database cannot be cleaned destructively.");
    try {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    } catch (cause) {
      throw new ContinuityStoreError("Cannot create a verified continuity cleanup backup.", cause);
    }
  }
  executeCleanup(preview, now, payloadCutoff, recordCutoff) {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
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
        const row = verifySnapshot.get(snapshot.taskCorrelation, snapshot.epoch);
        const status = row ? JSON.parse(row.snapshot_json).status : null;
        if (!row || status === "active" || row.updated_at > payloadCutoff || row.root_id !== snapshot.rootId || row.revision !== snapshot.revision || row.snapshot_digest !== snapshot.snapshotDigest || row.updated_at !== snapshot.updatedAt) {
          throw new ContinuityStoreError(`Continuity snapshot ${snapshot.taskCorrelation}/${snapshot.epoch} changed after preview.`);
        }
      }
      for (const task of preview.tasks) {
        const row = verifyTask.get(task.taskCorrelation);
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
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff,
          task.taskCorrelation,
          recordCutoff
        );
        if (childState.invalid_snapshot || childState.recent_request || childState.recent_tombstone || childState.recent_observation) {
          throw new ContinuityStoreError(`Continuity task ${task.taskCorrelation} gained active or recent child state after preview.`);
        }
      }
      const scrubbed = this.database.prepare(`
        UPDATE continuity_requests SET result_json = ?
        WHERE task_correlation = ? AND epoch = ?
      `);
      for (const snapshot of preview.snapshots) {
        this.database.prepare("DELETE FROM continuity_snapshots WHERE task_correlation = ? AND epoch = ?").run(snapshot.taskCorrelation, snapshot.epoch);
        this.database.prepare(`
          INSERT INTO continuity_tombstones(task_correlation, epoch, revision, payload_digest, purged_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(task_correlation, epoch) DO UPDATE SET
            revision = excluded.revision, payload_digest = excluded.payload_digest, purged_at = excluded.purged_at
        `).run(snapshot.taskCorrelation, snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, now);
        scrubbed.run(JSON.stringify({
          schemaVersion: "1.0.0",
          kind: "purged-request",
          epoch: snapshot.epoch,
          revision: snapshot.revision,
          tombstoneDigest: snapshot.snapshotDigest,
          purgedAt: now
        }), snapshot.taskCorrelation, snapshot.epoch);
        this.database.prepare("UPDATE continuity_tasks SET updated_at = ? WHERE task_correlation = ?").run(now, snapshot.taskCorrelation);
      }
      const deleteByTask = [
        "continuity_snapshots",
        "continuity_requests",
        "continuity_tombstones",
        "continuity_observations"
      ].map((table) => this.database.prepare(`DELETE FROM ${table} WHERE task_correlation = ?`));
      for (const task of preview.tasks) {
        for (const statement of deleteByTask) statement.run(task.taskCorrelation);
        this.database.prepare("DELETE FROM continuity_tasks WHERE task_correlation = ?").run(task.taskCorrelation);
      }
      this.database.exec("COMMIT;");
      return { snapshots: preview.snapshots.length, tasks: preview.tasks.length };
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      if (cause instanceof ContinuityStoreError) throw cause;
      throw new ContinuityStoreError("Cannot execute continuity state cleanup.", cause);
    }
  }
  initializeSchema() {
    const version = this.database.prepare("PRAGMA user_version").get();
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
};

// mcp-server/src/continuity-service.ts
var TOOL_TOKEN_TTL_SECONDS = 300;
var CANDIDATE_TOKEN_TTL_SECONDS = 3600;
function ok(data) {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}
function failure(code, message, details = null) {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: { code, message, details } };
}
function withoutBinding(value) {
  const result = { ...value };
  delete result._continuityBinding;
  return result;
}
function exactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function purgeReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value;
  if (!exactKeys(receipt, ["schemaVersion", "purged", "epoch", "revision", "tombstoneDigest", "purgedAt"]) || receipt.schemaVersion !== "1.0.0" || receipt.purged !== true || !Number.isInteger(receipt.epoch) || !Number.isInteger(receipt.revision) || typeof receipt.tombstoneDigest !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(receipt.tombstoneDigest) || typeof receipt.purgedAt !== "string") return null;
  return receipt;
}
function boundedText(value, maxLength) {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}\u2026`;
}
function boundedStrings(values, maxItems, maxLength) {
  return values.slice(0, maxItems).map((value) => boundedText(value, maxLength));
}
function encode(value) {
  return Buffer.from(canonicalJson(value), "utf8").toString("base64url");
}
function parseJsonToken(value) {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra) return null;
  try {
    const bodyBytes = Buffer.from(body, "base64url");
    const signatureBytes = Buffer.from(signature, "base64url");
    if (bodyBytes.toString("base64url") !== body || signatureBytes.toString("base64url") !== signature) return null;
    return {
      payload: JSON.parse(bodyBytes.toString("utf8")),
      body,
      signature: signatureBytes
    };
  } catch {
    return null;
  }
}
var ContinuityService = class {
  constructor(store, validator, workflowStore = null, now = () => /* @__PURE__ */ new Date()) {
    this.store = store;
    this.validator = validator;
    this.workflowStore = workflowStore;
    this.now = now;
    this.secret = store.getOrCreateSecret(() => randomBytes(32).toString("base64url"));
  }
  store;
  validator;
  workflowStore;
  now;
  available = true;
  secret;
  correlateSession(rawSessionId) {
    return `hmac-sha256:${this.hmac(`session\0${rawSessionId}`)}`;
  }
  hashOpaque(kind, value) {
    return `hmac-sha256:${this.hmac(`${kind}\0${value}`)}`;
  }
  ensureSession(rawSessionId) {
    return this.store.ensureTask(this.correlateSession(rawSessionId), this.now().toISOString());
  }
  clearSession(rawSessionId) {
    return this.store.rotateEpoch(this.correlateSession(rawSessionId), this.now().toISOString());
  }
  issueToolBinding(rawSessionId, toolName, input) {
    const task = this.ensureSession(rawSessionId);
    const payload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      t: toolName,
      d: convergenceDigest(withoutBinding(input)),
      x: Math.floor(this.now().getTime() / 1e3) + TOOL_TOKEN_TTL_SECONDS
    };
    return this.sign(payload);
  }
  checkpointContext(value) {
    return this.guard(() => {
      const request = this.validator.checkpointContextRequest(value);
      const binding = this.verifyToolBinding("checkpoint_context", request, request._continuityBinding);
      const task = this.currentTask(binding);
      if (task.rootId) throw new WorkflowContractError("SNAPSHOT_CONFLICT", "Direct checkpoints are disabled after a workflow root is bound.", { rootId: task.rootId });
      const now = this.now().toISOString();
      const current = this.store.getSnapshot(binding.c, binding.e);
      const base = {
        schemaVersion: "1.0.0",
        source: "direct",
        taskCorrelation: binding.c,
        epoch: binding.e,
        revision: request.expectedRevision + 1,
        status: request.status,
        core: request.core,
        evidenceRefs: request.evidenceRefs,
        createdAt: current?.createdAt ?? now,
        updatedAt: now
      };
      const snapshot = { ...base, snapshotDigest: convergenceDigest(base) };
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request));
      const stored = this.store.checkpoint(binding.c, binding.e, request.expectedRevision, requestHash, commandDigest, snapshot);
      if (stored.kind === "replay") {
        const receipt = JSON.parse(stored.request.resultJson);
        const replaySnapshot = this.store.getSnapshot(binding.c, binding.e);
        if (receipt.kind !== "checkpoint" || receipt.epoch !== binding.e || !replaySnapshot || replaySnapshot.revision !== receipt.revision || replaySnapshot.snapshotDigest !== receipt.snapshotDigest) {
          return failure("STALE_REVISION", "The idempotent checkpoint result is no longer available after replacement or purge.");
        }
        return ok(replaySnapshot);
      }
      if (stored.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for different checkpoint content.");
      if (stored.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed.", { expectedRevision: request.expectedRevision, actualRevision: stored.actualRevision });
      return ok(snapshot);
    });
  }
  inspectContext(value) {
    return this.guard(() => {
      const request = this.validator.inspectContextRequest(value);
      const binding = this.verifyToolBinding("inspect_context", request, request._continuityBinding);
      return ok(this.candidateFor(binding.c));
    });
  }
  loadContext(value) {
    return this.guard(() => {
      const request = this.validator.loadContextRequest(value);
      const binding = this.verifyToolBinding("load_context", request, request._continuityBinding);
      const candidate = this.verifyCandidate(request.candidateToken);
      if (candidate.c !== binding.c || candidate.e !== binding.e || candidate.e !== request.epoch || candidate.r !== request.revision || candidate.d !== request.digest) throw new WorkflowContractError("BINDING_INVALID", "Restore candidate does not match the current task and requested state.");
      const task = this.currentTask(binding);
      if (task.suppressed) throw new WorkflowContractError("SNAPSHOT_NOT_FOUND", "Restore is suppressed for the current epoch.");
      if (candidate.s === "direct") {
        const snapshot = this.store.getSnapshot(binding.c, binding.e);
        if (!snapshot || snapshot.revision !== candidate.r || snapshot.snapshotDigest !== candidate.d) {
          throw new WorkflowContractError("STALE_REVISION", "The direct restore candidate is stale.");
        }
        const { snapshotDigest, ...base } = snapshot;
        if (convergenceDigest(base) !== snapshotDigest) throw new WorkflowContractError("INTEGRITY_FAILED", "The direct snapshot digest is invalid.");
        return ok(snapshot);
      }
      const card = this.workflowProjection(task);
      if (!card || card.revision !== candidate.r || card.snapshotDigest !== candidate.d) {
        throw new WorkflowContractError("STALE_REVISION", "The workflow restore candidate is stale.");
      }
      return ok(card);
    });
  }
  suppressContextRestore(value) {
    return this.guard(() => {
      const request = this.validator.suppressContextRestoreRequest(value);
      const binding = this.verifyToolBinding("suppress_context_restore", request, request._continuityBinding);
      if (request.expectedEpoch !== binding.e) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.", { actualEpoch: binding.e });
      if (!this.store.setSuppressed(binding.c, binding.e, this.now().toISOString())) throw new WorkflowContractError("STALE_REVISION", "The continuity epoch changed.");
      return ok({ schemaVersion: "1.0.0", suppressed: true, epoch: binding.e });
    });
  }
  purgeDirectContext(value) {
    return this.guard(() => {
      const request = this.validator.purgeDirectContextRequest(value);
      const binding = this.verifyToolBinding("purge_direct_context", request, request._continuityBinding);
      this.currentTask(binding);
      const current = this.store.getSnapshot(binding.c, request.expectedEpoch);
      if (current && current.revision !== request.expectedRevision) {
        return failure("STALE_REVISION", "The direct checkpoint revision changed.", {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision
        });
      }
      const requestHash = this.hashOpaque("request", request.requestId);
      const commandDigest = convergenceDigest(withoutBinding(request));
      const tombstoneDigest = convergenceDigest({
        taskCorrelation: binding.c,
        epoch: request.expectedEpoch,
        revision: request.expectedRevision,
        payloadDigest: current?.snapshotDigest ?? null,
        purgeRequestHash: requestHash
      });
      const now = this.now().toISOString();
      const purged = this.store.purge(binding.c, request.expectedEpoch, request.expectedRevision, requestHash, commandDigest, tombstoneDigest, now);
      if (purged.kind === "replay") {
        let replay = null;
        try {
          replay = purgeReceipt(JSON.parse(purged.request.resultJson));
        } catch {
        }
        const tombstone = this.store.getTombstone(binding.c, request.expectedEpoch);
        if (!replay || !tombstone || replay.epoch !== request.expectedEpoch || replay.revision !== request.expectedRevision || replay.revision !== tombstone.revision || replay.tombstoneDigest !== tombstone.payloadDigest || replay.purgedAt !== tombstone.purgedAt) {
          return failure("STALE_REVISION", "The idempotent purge result is no longer available.");
        }
        return ok({
          schemaVersion: "1.0.0",
          purged: true,
          epoch: replay.epoch,
          revision: replay.revision,
          tombstoneDigest: replay.tombstoneDigest,
          purgedAt: replay.purgedAt
        });
      }
      if (purged.kind === "conflict") return failure("REQUEST_CONFLICT", "requestId was already used for a different purge request.");
      if (purged.kind === "stale") return failure("STALE_REVISION", "The direct checkpoint revision changed or no payload exists.", { expectedRevision: request.expectedRevision, actualRevision: purged.actualRevision });
      return ok({ schemaVersion: "1.0.0", purged: true, epoch: request.expectedEpoch, revision: request.expectedRevision, tombstoneDigest, purgedAt: now });
    });
  }
  bindOpenedRoot(value, rootId) {
    try {
      const args = value && typeof value === "object" && !Array.isArray(value) ? value : {};
      const token = typeof args._continuityBinding === "string" ? args._continuityBinding : "";
      const binding = this.verifyToolBinding("open_convergence_root", args, token);
      this.store.bindRoot(binding.c, binding.e, rootId, this.now().toISOString());
    } catch {
    }
  }
  candidateForSession(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    return this.candidateFor(task.taskCorrelation);
  }
  markPreCompact(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed) return;
    const summary = this.summary(task);
    if (!summary) return;
    this.store.setPendingMarker(task.taskCorrelation, task.currentEpoch, summary.source, summary.revision, summary.snapshotDigest, task.rootId, this.now().toISOString());
  }
  compactContext(rawSessionId) {
    const task = this.ensureSession(rawSessionId);
    if (task.suppressed || task.pendingConsumed) return null;
    const summary = this.summary(task);
    if (!summary || task.pendingRevision !== summary.revision || task.pendingDigest !== summary.snapshotDigest || task.pendingSource !== summary.source) return null;
    if (summary.source === "direct") return this.formatCandidate(this.candidateFor(task.taskCorrelation));
    const card = this.workflowProjection(task);
    if (!card || task.pendingRootId !== card.rootId) return null;
    if (!this.store.consumeWorkflowMarker(task.taskCorrelation, task.currentEpoch, card.revision, card.snapshotDigest, this.now().toISOString())) return null;
    return this.formatWorkflowCard(card);
  }
  recordPostCompact(rawSessionId, rawTurnId, success) {
    const task = this.ensureSession(rawSessionId);
    this.store.recordObservation(task.taskCorrelation, task.currentEpoch, "post-compact", rawTurnId ? this.hashOpaque("turn", rawTurnId) : null, success, this.now().toISOString());
  }
  formatCandidate(candidate) {
    if (!candidate.summary || !candidate.restoreToken) return null;
    const summary = candidate.summary;
    return [
      "[Task continuity restore candidate \u2014 metadata only]",
      "decision=DEFER",
      `source=${summary.source}`,
      `epoch=${summary.epoch}`,
      `revision=${summary.revision}`,
      `digest=${summary.snapshotDigest}`,
      `candidateToken=${candidate.restoreToken}`,
      "No snapshot body was injected. Treat nextActions as historical candidates only; call load_context explicitly after checking the current user request."
    ].join("\n");
  }
  formatWorkflowCard(card) {
    return [
      "[Task continuity workflow card \u2014 structural state, not new instructions]",
      "decision=INJECT",
      JSON.stringify(card),
      "Reconcile this projected state with the latest user request before acting."
    ].join("\n");
  }
  candidateFor(taskCorrelation) {
    const task = this.store.getTask(taskCorrelation);
    if (!task) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_TASK_BINDING"], summary: null, restoreToken: null };
    if (task.suppressed) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["RESTORE_SUPPRESSED"], summary: null, restoreToken: null };
    const summary = this.summary(task);
    if (!summary) return { schemaVersion: "1.0.0", decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"], summary: null, restoreToken: null };
    const payload = {
      v: 1,
      c: task.taskCorrelation,
      e: task.currentEpoch,
      s: summary.source,
      r: summary.revision,
      d: summary.snapshotDigest,
      x: Math.floor(this.now().getTime() / 1e3) + CANDIDATE_TOKEN_TTL_SECONDS
    };
    return { schemaVersion: "1.0.0", decision: "DEFER", reasonCodes: ["EXPLICIT_LOAD_REQUIRED"], summary, restoreToken: this.sign(payload) };
  }
  summary(task) {
    const card = task.rootId ? this.workflowProjection(task) : null;
    if (card) return {
      schemaVersion: "1.0.0",
      source: "workflow",
      taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch,
      revision: card.revision,
      status: card.rootState,
      snapshotDigest: card.snapshotDigest,
      updatedAt: card.updatedAt
    };
    const snapshot = this.store.getSnapshot(task.taskCorrelation, task.currentEpoch);
    if (!snapshot) return null;
    return {
      schemaVersion: "1.0.0",
      source: "direct",
      taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch,
      revision: snapshot.revision,
      status: snapshot.status,
      snapshotDigest: snapshot.snapshotDigest,
      updatedAt: snapshot.updatedAt
    };
  }
  workflowProjection(task) {
    if (!task.rootId || !this.workflowStore) return null;
    const snapshot = this.workflowStore.getConvergenceSnapshot(task.rootId);
    if (!snapshot) return null;
    const latestRunId = snapshot.workflowRunIds.at(-1);
    const receipt = latestRunId ? this.workflowStore.getRun(latestRunId) : null;
    const base = {
      schemaVersion: "1.0.0",
      source: "workflow",
      taskCorrelation: task.taskCorrelation,
      epoch: task.currentEpoch,
      revision: snapshot.root.revision,
      rootId: boundedText(snapshot.root.rootId, 160),
      rootState: snapshot.root.state,
      taskId: boundedText(snapshot.root.taskEnvelope.taskId, 160),
      objective: boundedText(snapshot.root.taskEnvelope.objective, 800),
      includedScope: boundedStrings(snapshot.root.taskEnvelope.scope.included, 4, 120),
      acceptanceCriteria: boundedStrings(snapshot.root.taskEnvelope.acceptanceCriteria, 4, 240),
      constraints: boundedStrings(snapshot.root.taskEnvelope.constraints, 4, 240),
      authorization: {
        allowedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.allowedActions, 4, 120),
        prohibitedActions: boundedStrings(snapshot.root.taskEnvelope.authorization.prohibitedActions, 4, 120),
        approvalRequired: boundedStrings(snapshot.root.taskEnvelope.authorization.approvalRequired, 4, 120)
      },
      workflowState: receipt?.state ?? null,
      currentStageId: receipt?.plan.currentStageId ?? null,
      nextStageId: receipt?.plan.nextStageId ?? null,
      blockers: boundedStrings(receipt?.blockers ?? [], 4, 200),
      unresolved: boundedStrings(receipt?.unresolved ?? [], 4, 200),
      evidenceRefs: (receipt?.stageResults ?? []).flatMap((result) => result.output.artifacts.map((item) => ({
        artifactId: boundedText(item.artifactId, 80),
        locator: boundedText(item.locator, 160),
        digest: item.digest,
        verified: item.verified
      }))).slice(0, 6),
      updatedAt: snapshot.root.updatedAt
    };
    return { ...base, snapshotDigest: convergenceDigest(base) };
  }
  currentTask(binding) {
    const task = this.store.getTask(binding.c);
    if (!task || task.currentEpoch !== binding.e) throw new WorkflowContractError("BINDING_INVALID", "Continuity task binding is stale.");
    return task;
  }
  verifyToolBinding(toolName, value, token) {
    if (!token) throw new WorkflowContractError("BINDING_REQUIRED", "A current continuity binding token is required.");
    const payload = this.verifySigned(token);
    const now = Math.floor(this.now().getTime() / 1e3);
    if (payload.v !== 1 || payload.t !== toolName || payload.x < now || payload.d !== convergenceDigest(withoutBinding(value))) {
      throw new WorkflowContractError("BINDING_INVALID", "Continuity binding token is invalid, expired, or bound to different input.");
    }
    return payload;
  }
  verifyCandidate(token) {
    const payload = this.verifySigned(token);
    if (payload.v !== 1 || payload.x < Math.floor(this.now().getTime() / 1e3) || !["direct", "workflow"].includes(payload.s)) {
      throw new WorkflowContractError("BINDING_INVALID", "Restore candidate token is invalid or expired.");
    }
    return payload;
  }
  sign(value) {
    const body = encode(value);
    const signature = createHmac("sha256", this.secret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }
  verifySigned(token) {
    const parsed = parseJsonToken(token);
    if (!parsed) throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token is malformed.");
    const expected = createHmac("sha256", this.secret).update(parsed.body).digest();
    if (expected.length !== parsed.signature.length || !timingSafeEqual(expected, parsed.signature)) {
      throw new WorkflowContractError("BINDING_INVALID", "Signed continuity token failed verification.");
    }
    return parsed.payload;
  }
  hmac(value) {
    return createHmac("sha256", this.secret).update(value, "utf8").digest("hex");
  }
  guard(action) {
    try {
      return action();
    } catch (error) {
      if (error instanceof WorkflowContractError) return failure(error.code, error.message, error.details);
      if (error instanceof ContinuityStoreError) return failure("CONTINUITY_UNAVAILABLE", error.message);
      return failure("CONTINUITY_UNAVAILABLE", "Continuity operation failed.", { cause: error instanceof Error ? error.message : String(error) });
    }
  }
};

// mcp-server/src/runtime-config.ts
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import path3 from "node:path";
function resolveWorkflowDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_DB_PATH?.trim();
  if (configured) return path3.resolve(currentWorkingDirectory, configured);
  let stateRoot;
  if (platform === "win32") {
    stateRoot = environment.LOCALAPPDATA?.trim() || path3.join(homeDirectory, "AppData", "Local");
  } else if (platform === "darwin") {
    stateRoot = path3.join(homeDirectory, "Library", "Application Support");
  } else {
    stateRoot = environment.XDG_STATE_HOME?.trim() || path3.join(homeDirectory, ".local", "state");
  }
  return path3.resolve(stateRoot, "agent-governance-suite", "workflows.sqlite3");
}
function resolveContinuityDatabasePath(environment = process.env, platform = process.platform, homeDirectory = homedir(), currentWorkingDirectory = process.cwd()) {
  const configured = environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH?.trim();
  if (configured) return path3.resolve(currentWorkingDirectory, configured);
  const workflowPath = resolveWorkflowDatabasePath(
    environment,
    platform,
    homeDirectory,
    currentWorkingDirectory
  );
  if (workflowPath === ":memory:") return ":memory:";
  return path3.join(path3.dirname(workflowPath), "continuity.sqlite3");
}
function canonicalDatabasePath(databasePath, platform) {
  if (databasePath === ":memory:") return null;
  const absolute = path3.resolve(databasePath);
  const unresolved = [];
  let cursor = absolute;
  let resolved = absolute;
  while (true) {
    try {
      resolved = path3.join(realpathSync.native(cursor), ...unresolved.reverse());
      break;
    } catch {
      const parent = path3.dirname(cursor);
      if (parent === cursor) break;
      unresolved.push(path3.basename(cursor));
      cursor = parent;
    }
  }
  const normalized = path3.normalize(resolved);
  return platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
}
function assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath, platform = process.platform) {
  const workflowIdentity = canonicalDatabasePath(workflowDatabasePath, platform);
  const continuityIdentity = canonicalDatabasePath(continuityDatabasePath, platform);
  if (workflowIdentity !== null && workflowIdentity === continuityIdentity) {
    throw new Error("Workflow and continuity databases must use different files.");
  }
}

// mcp-server/src/sqlite-workflow-store.ts
import { chmodSync as chmodSync2, mkdirSync as mkdirSync2 } from "node:fs";
import path4 from "node:path";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";

// mcp-server/src/plugin-version.ts
function parseStableVersion(version) {
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u.exec(version);
  if (!match) return null;
  const parts = match.slice(1).map((part) => Number.parseInt(part, 10));
  return parts.length === 3 && parts.every(Number.isSafeInteger) ? [parts[0], parts[1], parts[2]] : null;
}
function compareStableVersionNumbers(leftVersion, rightVersion) {
  const left = parseStableVersion(leftVersion);
  const right = parseStableVersion(rightVersion);
  if (!left || !right) throw new Error("A plugin version is not strict stable SemVer.");
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

// mcp-server/src/plugin-update-store.ts
function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
function timestamp(value) {
  if (value === null) return -1;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : -1;
}
function comparison(currentVersion, latestVersion) {
  if (!latestVersion) return "unknown";
  const order = compareStableVersionNumbers(currentVersion, latestVersion);
  return order < 0 ? "update-available" : order > 0 ? "ahead-of-stable" : "up-to-date";
}
function mergePluginUpdateState(existing, incoming) {
  if (!existing) return clone(incoming);
  const incomingSuccessTime = timestamp(incoming.lastSuccessfulCheckAt);
  const existingSuccessTime = timestamp(existing.lastSuccessfulCheckAt);
  const sameTimeVersionIsNotOlder = incoming.latestVersion !== null && (existing.latestVersion === null || compareStableVersionNumbers(incoming.latestVersion, existing.latestVersion) >= 0);
  const incomingSuccessIsNewer = incoming.lastSuccessfulCheckAt !== null && (incomingSuccessTime > existingSuccessTime || incomingSuccessTime === existingSuccessTime && sameTimeVersionIsNotOlder);
  const incomingAttemptIsNewer = timestamp(incoming.lastAttemptAt) >= timestamp(existing.lastAttemptAt);
  const latestVersion = incomingSuccessIsNewer ? incoming.latestVersion : existing.latestVersion;
  return {
    targetId: incoming.targetId,
    currentVersion: incoming.currentVersion,
    latestVersion,
    latestTag: incomingSuccessIsNewer ? incoming.latestTag : existing.latestTag,
    latestCommit: incomingSuccessIsNewer ? incoming.latestCommit : existing.latestCommit,
    etag: incomingSuccessIsNewer ? incoming.etag : existing.etag,
    comparison: comparison(incoming.currentVersion, latestVersion),
    lastAttemptAt: incomingAttemptIsNewer ? incoming.lastAttemptAt : existing.lastAttemptAt,
    lastSuccessfulCheckAt: incomingSuccessIsNewer ? incoming.lastSuccessfulCheckAt : existing.lastSuccessfulCheckAt,
    nextCheckAt: incomingAttemptIsNewer ? incoming.nextCheckAt : existing.nextCheckAt,
    lastNotifiedVersion: existing.lastNotifiedVersion,
    lastNotifiedAt: existing.lastNotifiedAt,
    lastErrorCode: incomingAttemptIsNewer ? incoming.lastErrorCode : existing.lastErrorCode
  };
}

// mcp-server/src/sqlite-workflow-store.ts
var SCHEMA_VERSION2 = 5;
var SqliteWorkflowStore = class {
  constructor(databasePath) {
    this.databasePath = databasePath;
    if (!databasePath.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database path must not be empty.");
    }
    if (databasePath !== ":memory:") {
      mkdirSync2(path4.dirname(path4.resolve(databasePath)), { recursive: true, mode: 448 });
    }
    let openedDatabase = null;
    try {
      openedDatabase = new DatabaseSync2(databasePath);
      this.database = openedDatabase;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      this.initializeSchema();
      if (databasePath !== ":memory:" && process.platform !== "win32") {
        chmodSync2(path4.resolve(databasePath), 384);
      }
    } catch (cause) {
      try {
        openedDatabase?.close();
      } catch {
      }
      throw this.storageError("Cannot initialize the workflow database.", cause);
    }
  }
  databasePath;
  database;
  closed = false;
  getOrCreateSecret(name, create) {
    return this.guard("Cannot read or create workflow metadata.", { key: name }, () => this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(name);
      if (existing) return existing.value;
      const value = create();
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(name, value, (/* @__PURE__ */ new Date()).toISOString());
      return value;
    }));
  }
  claimExecutionObservation(observationId, expiresAt, consumedAt) {
    return this.guard("Cannot claim the trusted execution observation.", { observationId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)
        VALUES (?, ?, ?)
      `).run(observationId, expiresAt, consumedAt);
      return Number(result.changes) === 1;
    }));
  }
  nextRunSequence() {
    return this.guard("Cannot reserve the next workflow run sequence.", {}, () => this.transaction(() => {
      const row = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get();
      const valid = !row || /^(0|[1-9][0-9]*)$/.test(row.value);
      const current = row && valid ? Number.parseInt(row.value, 10) : 0;
      if (!valid || !Number.isSafeInteger(current) || current < 0) {
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
      `).run(String(next), (/* @__PURE__ */ new Date()).toISOString());
      return next;
    }));
  }
  insertRun(receipt) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.guard("Cannot persist the workflow run.", { runId: receipt.runId }, () => this.insertRunRow(receipt, now));
  }
  getRun(runId) {
    return this.guard("Cannot read the workflow run.", { runId }, () => {
      const row = this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(runId);
      if (!row) return null;
      const receipt = JSON.parse(row.receipt_json);
      if (receipt.runId !== runId || receipt.revision !== row.revision) {
        throw new WorkflowContractError("INVALID_INPUT", "Stored workflow receipt metadata does not match its payload.", {
          runId,
          storedRevision: row.revision,
          receiptRunId: receipt.runId,
          receiptRevision: receipt.revision
        });
      }
      return receipt;
    });
  }
  updateRun(receipt, expectedRevision, convergence) {
    return this.guard("Cannot update the workflow run.", { runId: receipt.runId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        receipt.revision,
        receipt.state,
        JSON.stringify(receipt),
        (/* @__PURE__ */ new Date()).toISOString(),
        receipt.runId,
        expectedRevision
      );
      if (Number(result.changes) !== 1) return false;
      if (!convergence) return true;
      if (!this.casRoot(convergence.root, convergence.expectedRootRevision)) throw new WorkflowContractError("STALE_REVISION", "Convergence root changed while recording the workflow outcome.");
      const attemptUpdate = this.database.prepare(`
        UPDATE convergence_attempts
        SET state = ?, outcome_json = ?, updated_at = ?
        WHERE run_id = ? AND outcome_json IS NULL
      `).run(
        convergence.outcome.state,
        JSON.stringify(convergence.outcome),
        convergence.outcome.recordedAt,
        receipt.runId
      );
      if (Number(attemptUpdate.changes) !== 1) throw new WorkflowContractError("LEASE_CONFLICT", "Guarded attempt outcome was already recorded or is missing.", { runId: receipt.runId });
      return true;
    }));
  }
  insertConvergenceRoot(root) {
    return this.guard("Cannot persist the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const rows = this.database.prepare(`
        SELECT root_json, revision FROM convergence_roots
        WHERE state NOT IN ('completed', 'abandoned')
          AND (workspace_id = ? OR workspace_locator = ?)
      `).all(root.frame.workspace.workspaceId, normalizeWorkspaceLocator(root.frame.workspace.locator));
      for (const row of rows) {
        const existing = JSON.parse(row.root_json);
        if (root.parentRootId === existing.rootId) continue;
        if (rootsOverlap(root, existing)) return existing;
      }
      if (root.parentRootId) {
        const row = this.rootRow(root.parentRootId);
        if (!row) throw new WorkflowContractError("INVALID_INPUT", "Parent convergence root was not found.", { rootId: root.parentRootId });
        const parent = JSON.parse(row.root_json);
        parent.state = "abandoned";
        parent.revision += 1;
        parent.updatedAt = root.createdAt;
        this.casRoot(parent, row.revision);
      }
      this.database.prepare(`
        INSERT INTO convergence_roots (root_id, revision, state, workspace_id, workspace_locator, root_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        root.rootId,
        root.revision,
        root.state,
        root.frame.workspace.workspaceId,
        normalizeWorkspaceLocator(root.frame.workspace.locator),
        JSON.stringify(root),
        root.createdAt,
        root.updatedAt
      );
      this.insertEpoch(root, root.createdAt);
      return null;
    }));
  }
  getConvergenceSnapshot(rootId) {
    return this.guard("Cannot read convergence state.", { rootId }, () => this.transaction(() => {
      const rootRow = this.rootRow(rootId);
      if (!rootRow) return null;
      const leases = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at`).all(rootId);
      const outcomes = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal`).all(rootId);
      const reviews = this.database.prepare(`SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id`).all(rootId);
      const links = this.database.prepare(`SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal`).all(rootId);
      return {
        root: JSON.parse(rootRow.root_json),
        proposals: leases.map((row) => JSON.parse(row.proposal_json)),
        leases: leases.map((row) => JSON.parse(row.lease_json)),
        outcomes: outcomes.map((row) => JSON.parse(row.outcome_json)),
        reviews: reviews.map((row) => JSON.parse(row.review_json)),
        workflowRunIds: links.map((row) => row.run_id)
      };
    }, "BEGIN;"));
  }
  updateConvergenceRoot(root, expectedRevision, review) {
    return this.guard("Cannot update the convergence root.", { rootId: root.rootId }, () => this.transaction(() => {
      const current = this.rootRow(root.rootId);
      if (!current || current.revision !== expectedRevision) return false;
      const previous = JSON.parse(current.root_json);
      if (!this.casRoot(root, expectedRevision)) return false;
      if (root.currentEpoch !== previous.currentEpoch) this.insertEpoch(root, root.updatedAt);
      if (review) {
        this.database.prepare(`
          INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(review.reviewId, review.rootId, review.epoch, JSON.stringify(review), review.reviewedAt);
      }
      return true;
    }));
  }
  insertAttemptLease(root, expectedRevision, proposal, lease) {
    return this.guard("Cannot claim the convergence attempt lease.", { rootId: root.rootId }, () => this.transaction(() => {
      if (!this.casRoot(root, expectedRevision)) return false;
      this.database.prepare(`
        INSERT INTO convergence_leases (
          lease_id, root_id, root_revision, epoch, ordinal, state, lease_json, proposal_json, issued_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        lease.leaseId,
        lease.rootId,
        lease.rootRevision,
        lease.epoch,
        lease.ordinal,
        lease.state,
        JSON.stringify(lease),
        JSON.stringify(proposal),
        lease.issuedAt,
        lease.expiresAt
      );
      return true;
    }), "The convergence database is busy; read status before retrying the lease claim.");
  }
  expireAttemptLease(leaseId) {
    return this.guard("Cannot expire the convergence attempt lease.", { leaseId }, () => this.transaction(() => {
      const row = this.leaseRow(leaseId);
      if (!row) return false;
      const lease = JSON.parse(row.lease_json);
      if (lease.state !== "issued") return false;
      lease.state = "expired";
      const result = this.database.prepare(`
        UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
      return Number(result.changes) === 1;
    }));
  }
  getAttemptLease(leaseId) {
    return this.guard("Cannot read the convergence attempt lease.", { leaseId }, () => {
      const row = this.leaseRow(leaseId);
      if (!row) return null;
      const lease = JSON.parse(row.lease_json);
      const proposal = JSON.parse(row.proposal_json);
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow) return null;
      return { root: JSON.parse(rootRow.root_json), proposal, lease };
    });
  }
  insertGuardedRun(receipt, leaseId, expectedRootRevision, consumedAt) {
    return this.guard("Cannot start the guarded workflow run.", { leaseId }, () => this.transaction(() => {
      const leaseRow = this.leaseRow(leaseId);
      if (!leaseRow) return null;
      const lease = JSON.parse(leaseRow.lease_json);
      const proposal = JSON.parse(leaseRow.proposal_json);
      if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision || Date.parse(lease.expiresAt) <= Date.parse(consumedAt)) return null;
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow || rootRow.revision !== expectedRootRevision) return null;
      const root = JSON.parse(rootRow.root_json);
      lease.state = "consumed";
      const leaseUpdate = this.database.prepare(`
        UPDATE convergence_leases SET state = 'consumed', lease_json = ?
        WHERE lease_id = ? AND state = 'issued'
      `).run(JSON.stringify(lease), leaseId);
      if (Number(leaseUpdate.changes) !== 1) return null;
      root.revision += 1;
      root.updatedAt = consumedAt;
      if (!this.casRoot(root, expectedRootRevision)) return null;
      this.insertRunRow(receipt, consumedAt);
      this.database.prepare(`
        INSERT INTO convergence_attempts (
          root_id, epoch, ordinal, lease_id, run_id, state, outcome_json, started_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, ?)
      `).run(root.rootId, lease.epoch, lease.ordinal, lease.leaseId, receipt.runId, consumedAt, consumedAt);
      this.database.prepare(`
        INSERT INTO workflow_attempt_links (run_id, root_id, lease_id, epoch, ordinal)
        VALUES (?, ?, ?, ?, ?)
      `).run(receipt.runId, root.rootId, lease.leaseId, lease.epoch, lease.ordinal);
      return { root, proposal, lease, outcome: null };
    }), "The convergence database is busy or the lease was consumed concurrently.");
  }
  getGuardedRunBinding(runId) {
    return this.guard("Cannot read the guarded workflow binding.", { runId }, () => {
      const link = this.database.prepare(`SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?`).get(runId);
      if (!link) return null;
      const rootRow = this.rootRow(link.root_id);
      const leaseRow = this.leaseRow(link.lease_id);
      const outcomeRow = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE run_id = ?`).get(runId);
      if (!rootRow || !leaseRow) return null;
      return {
        root: JSON.parse(rootRow.root_json),
        proposal: JSON.parse(leaseRow.proposal_json),
        lease: JSON.parse(leaseRow.lease_json),
        outcome: outcomeRow?.outcome_json ? JSON.parse(outcomeRow.outcome_json) : null
      };
    });
  }
  getPluginUpdateState(targetId) {
    return this.guard("Cannot read plugin update state.", { targetId }, () => this.readPluginUpdateStateRow(targetId));
  }
  putPluginUpdateState(state) {
    this.guard("Cannot persist plugin update state.", { targetId: state.targetId }, () => this.transaction(() => {
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
        merged.lastErrorCode
      );
    }));
  }
  claimPluginUpdateNotice(targetId, latestVersion, notifiedAt) {
    return this.guard("Cannot claim plugin update notice.", { targetId, latestVersion }, () => this.transaction(() => {
      const state = this.readPluginUpdateStateRow(targetId);
      if (!state || state.latestVersion !== latestVersion || state.lastNotifiedVersion !== null && compareStableVersionNumbers(state.lastNotifiedVersion, latestVersion) >= 0) return false;
      const result = this.database.prepare(`
      UPDATE plugin_update_state
      SET last_notified_version = ?, last_notified_at = ?
      WHERE target_id = ?
        AND latest_version = ?
      `).run(latestVersion, notifiedAt, targetId, latestVersion);
      return Number(result.changes) === 1;
    }));
  }
  getSchemaVersion() {
    return this.database.prepare("PRAGMA user_version").get().user_version;
  }
  isConvergenceRootActive(rootId) {
    const row = this.database.prepare(`
      SELECT 1 AS active FROM convergence_roots
      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')
    `).get(rootId);
    return Boolean(row);
  }
  withInactiveRootGuard(rootIds, operation) {
    return this.transaction(() => {
      const readState = this.database.prepare("SELECT state FROM convergence_roots WHERE root_id = ?");
      for (const rootId of [...new Set(rootIds)].sort()) {
        const row = readState.get(rootId);
        if (row && ["open", "needs-review", "needs-user"].includes(row.state)) {
          throw new WorkflowContractError("STALE_REVISION", "A continuity cleanup root became active after preview.", { rootId });
        }
      }
      return operation();
    });
  }
  previewCleanup(cutoff) {
    const roots = this.database.prepare(`
      SELECT root_id, revision, state, updated_at
      FROM convergence_roots
      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?
      ORDER BY root_id
    `).all(cutoff);
    const linkedRuns = this.database.prepare(`
      SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
    `);
    const rootCandidates = roots.map((root) => ({
      rootId: root.root_id,
      revision: root.revision,
      state: root.state,
      updatedAt: root.updated_at,
      runIds: linkedRuns.all(root.root_id).map((row) => row.run_id)
    }));
    const runs = this.database.prepare(`
      SELECT run_id, revision, state, updated_at
      FROM workflow_runs
      WHERE state IN ('failed', 'passed', 'blocked')
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)
      ORDER BY run_id
    `).all(cutoff);
    const protectedRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM convergence_roots
      WHERE state IN ('open', 'needs-review', 'needs-user')
    `).get();
    return {
      roots: rootCandidates,
      standaloneRuns: runs.map((run) => ({
        runId: run.run_id,
        revision: run.revision,
        state: run.state,
        updatedAt: run.updated_at
      })),
      protectedActiveRoots: protectedRow.count
    };
  }
  claimCleanupPlan(planId, planDigest, claimedAt) {
    return this.guard("Cannot claim the state cleanup plan.", { planId }, () => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)
        VALUES (?, ?, ?)
      `).run(planId, planDigest, claimedAt);
      return Number(result.changes) === 1;
    });
  }
  backupTo(targetPath) {
    if (this.databasePath === ":memory:") {
      throw new WorkflowContractError("INVALID_INPUT", "An in-memory workflow database cannot be cleaned destructively.");
    }
    this.guard("Cannot create a verified workflow cleanup backup.", { targetPath }, () => {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync2(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get();
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    });
  }
  executeCleanup(preview) {
    return this.guard("Cannot execute workflow state cleanup.", {}, () => this.transaction(() => {
      const verifyRoot = this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `);
      const verifyRun = this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);
      for (const root of preview.roots) {
        const row = verifyRoot.get(root.rootId);
        if (!row || row.state !== root.state || row.revision !== root.revision || row.updated_at !== root.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root changed after preview.", { rootId: root.rootId });
        }
        const actualRunIds = this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(root.rootId).map((item) => item.run_id);
        if (JSON.stringify(actualRunIds) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup root's linked runs changed after preview.", { rootId: root.rootId });
        }
      }
      for (const run of preview.standaloneRuns) {
        const row = verifyRun.get(run.runId);
        if (!row || row.state !== run.state || row.revision !== run.revision || row.updated_at !== run.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", "A cleanup workflow run changed after preview.", { runId: run.runId });
        }
      }
      const deleteLinks = this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?");
      const deleteAttempts = this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?");
      const deleteReviews = this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?");
      const deleteLeases = this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?");
      const deleteEpochs = this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?");
      const deleteRoot = this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?");
      const deleteRun = this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?");
      let deletedRuns = 0;
      for (const root of preview.roots) {
        deleteLinks.run(root.rootId);
        deleteAttempts.run(root.rootId);
        deleteReviews.run(root.rootId);
        deleteLeases.run(root.rootId);
        deleteEpochs.run(root.rootId);
        deleteRoot.run(root.rootId);
        for (const runId of root.runIds) {
          deletedRuns += Number(deleteRun.run(runId).changes);
        }
      }
      for (const run of preview.standaloneRuns) deletedRuns += Number(deleteRun.run(run.runId).changes);
      return { roots: preview.roots.length, runs: deletedRuns };
    }));
  }
  close() {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }
  initializeSchema() {
    const row = this.database.prepare("PRAGMA user_version").get();
    if (row.user_version > SCHEMA_VERSION2) {
      throw new WorkflowContractError("INVALID_INPUT", "Workflow database schema is newer than this server supports.", {
        databasePath: this.databasePath,
        supportedVersion: SCHEMA_VERSION2,
        actualVersion: row.user_version
      });
    }
    this.transaction(() => {
      if (row.user_version > 0 && row.user_version < 4) {
        this.database.exec(`
          ALTER TABLE workflow_runs ADD COLUMN state TEXT;
          ALTER TABLE workflow_runs ADD COLUMN created_at TEXT;
          UPDATE workflow_runs
          SET state = COALESCE(json_extract(receipt_json, '$.state'), 'blocked'),
              created_at = updated_at;
        `);
      }
      this.database.exec(`
        CREATE TABLE IF NOT EXISTS workflow_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_runs (
          run_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('ready', 'running', 'needs-input', 'needs-approval', 'needs-redesign', 'failed', 'passed', 'blocked')),
          receipt_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS workflow_runs_cleanup
          ON workflow_runs(state, updated_at);
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
        CREATE TABLE IF NOT EXISTS convergence_roots (
          root_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),
          workspace_id TEXT NOT NULL,
          workspace_locator TEXT NOT NULL,
          root_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_workspace
          ON convergence_roots(workspace_id, state);
        CREATE INDEX IF NOT EXISTS convergence_active_roots_by_locator
          ON convergence_roots(workspace_locator, state);
        CREATE TABLE IF NOT EXISTS convergence_epochs (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          frame_digest TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_leases (
          lease_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          root_revision INTEGER NOT NULL CHECK (root_revision >= 0),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          state TEXT NOT NULL CHECK (state IN ('issued', 'consumed', 'expired')),
          lease_json TEXT NOT NULL,
          proposal_json TEXT NOT NULL,
          issued_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          UNIQUE (root_id, epoch, ordinal, lease_id)
        ) STRICT;
        CREATE UNIQUE INDEX IF NOT EXISTS convergence_one_issued_lease
          ON convergence_leases(root_id) WHERE state = 'issued';
        CREATE TABLE IF NOT EXISTS convergence_attempts (
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          run_id TEXT NOT NULL UNIQUE REFERENCES workflow_runs(run_id),
          state TEXT NOT NULL CHECK (state IN ('running', 'passed', 'failed', 'aborted')),
          outcome_json TEXT,
          started_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (root_id, epoch, ordinal)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS convergence_reviews (
          review_id TEXT PRIMARY KEY,
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          review_json TEXT NOT NULL,
          reviewed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS workflow_attempt_links (
          run_id TEXT PRIMARY KEY REFERENCES workflow_runs(run_id),
          root_id TEXT NOT NULL REFERENCES convergence_roots(root_id),
          lease_id TEXT NOT NULL UNIQUE REFERENCES convergence_leases(lease_id),
          epoch INTEGER NOT NULL CHECK (epoch >= 1 AND epoch <= 2),
          ordinal INTEGER NOT NULL CHECK (ordinal >= 1 AND ordinal <= 3)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS state_cleanup_claims (
          plan_id TEXT PRIMARY KEY,
          plan_digest TEXT NOT NULL,
          claimed_at TEXT NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS execution_observation_claims (
          observation_id TEXT PRIMARY KEY,
          expires_at TEXT NOT NULL,
          consumed_at TEXT NOT NULL
        ) STRICT;
        PRAGMA user_version = ${SCHEMA_VERSION2};
      `);
    });
  }
  rootRow(rootId) {
    return this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(rootId);
  }
  leaseRow(leaseId) {
    return this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId);
  }
  /** Writes the root only if it is still at expectedRevision; true when exactly one row changed. */
  casRoot(root, expectedRevision) {
    const result = this.database.prepare(`
      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
      WHERE root_id = ? AND revision = ?
    `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
    return Number(result.changes) === 1;
  }
  insertEpoch(root, createdAt) {
    this.database.prepare(`
      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(root.rootId, root.currentEpoch, root.frameDigest, createdAt);
  }
  insertRunRow(receipt, createdAt) {
    this.database.prepare(`
      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), createdAt, createdAt);
  }
  readPluginUpdateStateRow(targetId) {
    const row = this.database.prepare(`
      SELECT target_id, current_version, latest_version, latest_tag, latest_commit, etag,
             comparison, last_attempt_at, last_successful_check_at, next_check_at,
             last_notified_version, last_notified_at, last_error_code
      FROM plugin_update_state
      WHERE target_id = ?
    `).get(targetId);
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
      lastErrorCode: row.last_error_code
    } : null;
  }
  /** Writers take the lock up front with BEGIN IMMEDIATE; snapshot reads pass "BEGIN;". */
  transaction(operation, begin = "BEGIN IMMEDIATE;") {
    this.database.exec(begin);
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
      }
      throw cause;
    }
  }
  /**
   * Keeps contract errors as they are and wraps any other failure as a storage
   * error; with contentionMessage, a busy database or a duplicate issued lease
   * becomes LEASE_CONFLICT instead.
   */
  guard(message, details, operation, contentionMessage) {
    try {
      return operation();
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      if (contentionMessage && this.isLeaseContention(cause)) {
        throw new WorkflowContractError("LEASE_CONFLICT", contentionMessage, details);
      }
      throw this.storageError(message, cause, details);
    }
  }
  isLeaseContention(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(message);
  }
  storageError(message, cause, details = {}) {
    return new WorkflowContractError("INVALID_INPUT", message, {
      ...details,
      databasePath: this.databasePath,
      cause: cause instanceof Error ? cause.message : String(cause)
    });
  }
};

// mcp-server/src/continuity-hook.ts
var BOUND_TOOLS = /* @__PURE__ */ new Set([
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context"
]);
function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function localToolName(canonicalName) {
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1) : canonicalName;
  return BOUND_TOOLS.has(tool) ? tool : null;
}
function sessionOutput(additionalContext) {
  return additionalContext ? {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext }
  } : {};
}
function handleContinuityHook(input, service) {
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return {};
  if (event === "SessionStart") {
    const source = input.source;
    if (source === "startup") {
      service.ensureSession(sessionId);
      return {};
    }
    if (source === "clear") {
      service.clearSession(sessionId);
      return {};
    }
    if (source === "resume") return sessionOutput(service.formatCandidate(service.candidateForSession(sessionId)));
    if (source === "compact") return sessionOutput(service.compactContext(sessionId));
    return {};
  }
  if (event === "PreCompact") {
    service.markPreCompact(sessionId);
    return {};
  }
  if (event === "PostCompact") {
    const turnId = typeof input.turn_id === "string" ? input.turn_id : null;
    service.recordPostCompact(sessionId, turnId, input.error === void 0 || input.error === null);
    return {};
  }
  if (event === "PreToolUse") {
    const canonicalName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolName = localToolName(canonicalName);
    if (!toolName) return {};
    const toolInput = record(input.tool_input);
    const token = service.issueToolBinding(sessionId, toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, _continuityBinding: token }
      }
    };
  }
  return {};
}
async function main() {
  let continuity = null;
  let workflow = null;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const workflowDatabasePath = resolveWorkflowDatabasePath();
    const continuityDatabasePath = resolveContinuityDatabasePath();
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    continuity = new SqliteContinuityStore(continuityDatabasePath);
    const event = input.hook_event_name;
    const source = input.source;
    const needsWorkflowProjection = event === "PreCompact" || event === "SessionStart" && (source === "resume" || source === "compact");
    if (needsWorkflowProjection) {
      try {
        workflow = new SqliteWorkflowStore(workflowDatabasePath);
      } catch {
        workflow = null;
      }
    }
    const output = handleContinuityHook(input, new ContinuityService(continuity, null, workflow));
    if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
  } catch {
  } finally {
    try {
      workflow?.close();
    } catch {
    }
    try {
      continuity?.close();
    } catch {
    }
  }
}
if (path5.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
export {
  handleContinuityHook
};
