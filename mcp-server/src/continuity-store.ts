import { chmodSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { types } from "node:util";
import type { SharedModuleContext, SqlDatabase } from "../../runtime/unified-state/shared-connection.mjs";
import { retainCleanupFailure } from "./failure-diagnostics.js";

import type { ContinuityMemoryBodyV1, ContinuitySnapshotV1, LegacyContinuitySnapshotV1, StateCleanupPlanV1 } from "../../contracts/types.js";
import { WorkflowContractError } from "../../contracts/types.js";
import { convergenceDigest } from "./convergence-logic.js";
import { serializeContinuityMemory } from "./continuity-memory.js";
export { serializeContinuityMemory, CURRENT_MEMORY_MAX_BYTES } from "./continuity-memory.js";
import { msg, render, ROOT_LOCALE, type MessageRef } from "./i18n.js";

export interface ContinuityTaskRecord {
  taskCorrelation: string;
  currentEpoch: number;
  rootId: string | null;
  suppressed: boolean;
  lastAutoInjectedRevision: number | null;
  pendingSource: "direct" | "workflow" | null;
  pendingRevision: number | null;
  pendingStateToken: string | null;
  pendingDigest: string | null;
  pendingRootId: string | null;
  pendingConsumed: boolean;
  updatedAt: string;
}

export interface StoredRequest {
  commandDigest: string;
  resultJson: string;
}

export type ContinuityCurrentRead<T> =
  | { kind: "available"; task: ContinuityTaskRecord; value: T }
  | { kind: "epoch-mismatch" }
  | { kind: "source-conflict" }
  | { kind: "suppressed" };

export interface ContinuityTombstoneRecord {
  stateToken: string;
  emptyStateToken: string;
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
  pending_state_token: string | null;
  pending_digest: string | null;
  pending_root_id: string | null;
  pending_consumed: number;
  updated_at: string;
}

interface CurrentRow {
  task_correlation: string; epoch: number; state_token: string; memory_json: string | null;
  memory_digest: `sha256:${string}` | null; created_at: string; updated_at: string;
}
interface MetadataRow { value: string }
interface RequestRow { command_digest: string; result_json: string }
interface TombstoneRow { state_token: string; empty_state_token: string; payload_digest: string; purged_at: string }

export interface ContinuityMemoryMigration {
  taskCorrelation: string;
  expectedSnapshotDigest: string;
  memory: ContinuityMemoryBodyV1;
}

export interface ContinuityCleanupPreview {
  snapshots: StateCleanupPlanV1["candidates"]["continuitySnapshots"];
  tasks: StateCleanupPlanV1["candidates"]["continuityTasks"];
  protectedActiveTasks: number;
}

const SCHEMA_VERSION = 4;
const LINEAGE_ANCHOR_EVENT = "memory-anchor:";
/** One row per (task, epoch, root) a workflow start or open bound; see bindRoot. */
const ROOT_BOUND_EVENT = "workflow-root:";
const MAX_COMPATIBLE_SCHEMA_VERSION = 4;
/**
 * Exact-event lookups (ownedElsewhere across tasks; the per-task event reads of the edit gate) would otherwise scan every
 * observation. Prefix reads (substr) still scan, bounded by observation cleanup.
 */
const OBSERVATION_EVENT_INDEX = "CREATE INDEX IF NOT EXISTS continuity_observations_event ON continuity_observations(event, task_correlation, epoch);";
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/u;

// Column/type/nullability/key/default signatures of the shared v2 tables and the additive v3 receiver table.
const LEGACY_TABLE_SIGNATURES: Record<string, string> = {
  continuity_metadata: "key:TEXT:0:1 value:TEXT:1:0",
  continuity_tasks: "task_correlation:TEXT:0:1 current_epoch:INTEGER:1:0 root_id:TEXT:0:0 suppressed:INTEGER:1:0:0 last_auto_injected_revision:INTEGER:0:0 pending_source:TEXT:0:0 pending_revision:INTEGER:0:0 pending_digest:TEXT:0:0 pending_root_id:TEXT:0:0 pending_consumed:INTEGER:1:0:0 updated_at:TEXT:1:0",
  continuity_snapshots: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 revision:INTEGER:1:0 snapshot_digest:TEXT:1:0 snapshot_json:TEXT:1:0 updated_at:TEXT:1:0",
  continuity_requests: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 request_hash:TEXT:1:3 command_digest:TEXT:1:0 result_json:TEXT:1:0 created_at:TEXT:1:0",
  continuity_tombstones: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 revision:INTEGER:1:0 payload_digest:TEXT:1:0 purged_at:TEXT:1:0",
  continuity_observations: "observation_id:INTEGER:0:1 task_correlation:TEXT:1:0 epoch:INTEGER:1:0 event:TEXT:1:0 turn_hash:TEXT:0:0 success:INTEGER:1:0 observed_at:TEXT:1:0",
  continuity_delta_state: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 receiver_host:TEXT:1:0 receiver_session:TEXT:1:0 receiver_instance:TEXT:1:0 context_generation:INTEGER:1:0 sequence:INTEGER:1:0 origin_digest:TEXT:1:0 checkpoint_digest:TEXT:1:0 checkpoint_json:TEXT:1:0 last_delta_digest:TEXT:0:0 state_ack_json:TEXT:0:0",
};

const TABLE_SIGNATURES: Record<string, string> = {
  ...LEGACY_TABLE_SIGNATURES,
  continuity_tasks: LEGACY_TABLE_SIGNATURES.continuity_tasks + " pending_state_token:TEXT:0:0",
  continuity_current_memory: "task_correlation:TEXT:0:1 epoch:INTEGER:1:0 state_token:TEXT:1:0 memory_json:TEXT:0:0 memory_digest:TEXT:0:0 created_at:TEXT:1:0 updated_at:TEXT:1:0",
  continuity_memory_history: "task_correlation:TEXT:1:1 state_token:TEXT:1:2 epoch:INTEGER:1:0 memory_json:TEXT:1:0 memory_digest:TEXT:1:0 created_at:TEXT:1:0 updated_at:TEXT:1:0 archived_at:TEXT:1:0 reason:TEXT:1:0 format:TEXT:1:0",
  continuity_tombstones: "task_correlation:TEXT:1:1 epoch:INTEGER:1:2 state_token:TEXT:1:0 empty_state_token:TEXT:1:0 payload_digest:TEXT:1:0 purged_at:TEXT:1:0",
};
delete TABLE_SIGNATURES.continuity_snapshots;

const CURRENT_MEMORY_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS continuity_current_memory (
  task_correlation TEXT PRIMARY KEY, epoch INTEGER NOT NULL CHECK(epoch>=1), state_token TEXT NOT NULL,
  memory_json TEXT, memory_digest TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  CHECK ((memory_json IS NULL) = (memory_digest IS NULL)),
  CHECK (memory_json IS NULL OR (json_valid(memory_json) AND length(CAST(memory_json AS BLOB)) <= 2000))
);`;

export type ContinuityUnavailableReason = "STORE_UNAVAILABLE" | "UNSUPPORTED_SCHEMA" | "INCOMPATIBLE_SCHEMA"
  | "CORRUPT_DATABASE" | "RECEIVER_STATE_UNSUPPORTED" | "DATABASE_PATH_CONFLICT" | "MIGRATION_INCOMPLETE";

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

export function isBodyFreeRequestReceipt(value: Record<string, unknown> | null): boolean {
  if (!value || value.schemaVersion !== "1.0.0") return false;
  if (value.kind === "checkpoint") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "stateToken", "memoryDigest"])
      && Number.isInteger(value.epoch) && typeof value.stateToken === "string"
      && typeof value.memoryDigest === "string" && SHA256_DIGEST.test(value.memoryDigest);
  }
  if (value.kind === "purged-request") {
    return hasExactKeys(value, ["schemaVersion", "kind", "epoch", "stateToken", "tombstoneDigest", "purgedAt"])
      && Number.isInteger(value.epoch) && typeof value.stateToken === "string"
      && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest)
      && typeof value.purgedAt === "string";
  }
  return value.purged === true
    && hasExactKeys(value, ["schemaVersion", "purged", "epoch", "stateToken", "emptyStateToken", "tombstoneDigest", "purgedAt"])
    && Number.isInteger(value.epoch) && typeof value.stateToken === "string" && typeof value.emptyStateToken === "string"
    && typeof value.tombstoneDigest === "string" && SHA256_DIGEST.test(value.tombstoneDigest)
    && typeof value.purgedAt === "string";
}

export class ContinuityStoreError extends Error {
  /** `message` is the root-locale text; callers render `ref` in their own locale (docs/contributing/i18n.md 3). */
  constructor(readonly ref: MessageRef, readonly causeValue?: unknown, readonly reason: ContinuityUnavailableReason = "STORE_UNAVAILABLE") {
    super(render(ref, ROOT_LOCALE));
    this.name = "ContinuityStoreError";
  }
}

/** A store error raised by this module; a proxy or another object is never trusted by its prototype (D0057). */
function ownStoreError(error: unknown): ContinuityStoreError | null {
  try {
    return error !== null && typeof error === "object" && !types.isProxy(error) && error instanceof ContinuityStoreError ? error : null;
  } catch {
    return null;
  }
}

/** Domain validation is distinct from a failed SQLite operation; retain its public code after rollback. */
function ownOperationError(error: unknown): ContinuityStoreError | WorkflowContractError | null {
  try {
    if (error !== null && typeof error === "object" && !types.isProxy(error) && error instanceof WorkflowContractError) return error;
  } catch { /* Opaque failures are handled as storage failures. */ }
  return ownStoreError(error);
}

/**
 * Only stable reason codes cross the optional-store boundary; never raw SQL, keys or checkpoint data. A SQLite
 * CORRUPT (11, with its extended codes) or NOTADB (26) result is CORRUPT_DATABASE wherever it was wrapped (D0057).
 */
export function continuityUnavailableReason(error: unknown): ContinuityUnavailableReason {
  const storeError = ownStoreError(error);
  if (storeError) return storeError.reason;
  let code: unknown = null;
  try {
    if (error !== null && typeof error === "object" && !types.isProxy(error)) code = Object.getOwnPropertyDescriptor(error, "errcode")?.value;
  } catch { /* An opaque failure stays STORE_UNAVAILABLE. */ }
  return Number.isInteger(code) && ((code as number) & 0xff) === 11 || code === 26 ? "CORRUPT_DATABASE" : "STORE_UNAVAILABLE";
}

function purgedRequestJson(epoch: number, stateToken: string, tombstoneDigest: string, purgedAt: string): string {
  return JSON.stringify({ schemaVersion: "1.0.0", kind: "purged-request", epoch, stateToken, tombstoneDigest, purgedAt });
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
    pendingStateToken: row.pending_state_token,
    pendingDigest: row.pending_digest,
    pendingRootId: row.pending_root_id,
    pendingConsumed: row.pending_consumed === 1,
    updatedAt: row.updated_at,
  };
}

export class SqliteContinuityStore {
  private readonly database: SqlDatabase;
  private readonly shared: SharedModuleContext | undefined;
  readonly databasePath: string;
  private closed = false;
  private transactionDepth = 0;
  private savepointSequence = 0;

  /**
   * `trustCurrentSchema` is for a hook process, which opens this file on every event of every session: a schema change
   * commits its version in the same transaction, so a current version means a complete schema and the open needs neither
   * the writer lock nor the whole-file quick_check. Context starts and the MCP server still run both.
   */
  constructor(input: string | SharedModuleContext, migrations: readonly ContinuityMemoryMigration[] = [], options: { trustCurrentSchema?: boolean } = {}) {
    this.shared = typeof input === "string" ? undefined : input;
    this.databasePath = typeof input === "string" ? input : input.databasePath;
    const databasePath = this.databasePath;
    if (this.shared) {
      this.database = this.shared.database;
      this.shared.initialize(() => this.initializeSchema(migrations));
      return;
    }
    if (!databasePath.trim()) throw new ContinuityStoreError(msg("continuity.store.pathEmpty", {}));
    if (databasePath !== ":memory:") mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    let opened: DatabaseSync | null = null;
    try {
      opened = new DatabaseSync(databasePath);
      this.database = opened;
      this.database.exec("PRAGMA busy_timeout = 5000;");
      this.database.exec("PRAGMA synchronous = FULL;");
      if (options.trustCurrentSchema !== true || this.getSchemaVersion() !== SCHEMA_VERSION) {
        this.transaction(msg("continuity.store.initDatabase", {}), () => this.initializeSchema(migrations));
      }
      if (databasePath !== ":memory:") this.database.exec("PRAGMA journal_mode = WAL;");
      if (databasePath !== ":memory:" && process.platform !== "win32") chmodSync(path.resolve(databasePath), 0o600);
    } catch (cause) {
      try { opened?.close(); } catch { /* Preserve the initialization failure. */ }
      throw new ContinuityStoreError(msg("continuity.store.initDatabase", {}), cause, continuityUnavailableReason(cause));
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
    if (!stored) throw new ContinuityStoreError(msg("continuity.store.initSecret", {}));
    return stored.value;
  }

  ensureTask(taskCorrelation: string, now: string): ContinuityTaskRecord {
    // Existing metadata is enough to bind a tool request that will report an unsupported receiver task.
    // Issuing that binding must not modify the task or expose its checkpoint body.
    this.assertSupportedSchema();
    const existing = this.readTask(taskCorrelation);
    if (existing) return existing;
    return this.transaction(msg("continuity.store.initTask", {}), () => {
      this.database.prepare(`
        INSERT INTO continuity_tasks(task_correlation, current_epoch, updated_at)
        VALUES (?, 1, ?)
        ON CONFLICT(task_correlation) DO NOTHING
      `).run(taskCorrelation, now);
      this.insertEmptyCurrent(taskCorrelation, 1, now);
      return this.getTask(taskCorrelation)!;
    }, taskCorrelation);
  }

  getTask(taskCorrelation: string): ContinuityTaskRecord | null {
    this.assertCompatibleTask(taskCorrelation);
    return this.readTask(taskCorrelation);
  }

  private readTask(taskCorrelation: string): ContinuityTaskRecord | null {
    const row = this.database.prepare("SELECT * FROM continuity_tasks WHERE task_correlation = ?").get(taskCorrelation) as TaskRow | undefined;
    return row ? taskRecord(row) : null;
  }

  rotateEpoch(taskCorrelation: string, now: string, expected?: {
    epoch: number;
    rootId: string;
    isTerminal: () => boolean;
    /** The settled epoch's session record re-based on the next epoch; it moves with the session, the workflow does not. */
    carry?: (snapshot: ContinuitySnapshotV1, nextEpoch: number) => ContinuitySnapshotV1;
  }): ContinuityTaskRecord {
    this.ensureTask(taskCorrelation, now);
    return this.transaction(msg("continuity.store.rotateEpoch", {}), () => {
      const current = this.getTask(taskCorrelation)!;
      if (expected && (current.currentEpoch !== expected.epoch || current.rootId !== expected.rootId
        || expected.isTerminal() !== true)) return current;
      const previous = this.getCurrent(taskCorrelation, current.currentEpoch);
      const rotated = this.database.prepare(`
        UPDATE continuity_tasks
        SET current_epoch = current_epoch + 1, root_id = NULL, suppressed = 0,
            last_auto_injected_revision = NULL, pending_source = NULL,
            pending_revision = NULL, pending_state_token = NULL, pending_digest = NULL, pending_root_id = NULL,
            pending_consumed = 0, updated_at = ?
        WHERE task_correlation = ? AND current_epoch = ? AND root_id IS ?
      `).run(now, taskCorrelation, current.currentEpoch, current.rootId);
      if (previous && rotated.changes === 1) {
        this.archiveCurrent(previous, now, expected?.carry ? "epoch-carry" : "clear");
        const carried = expected?.carry && previous.memory ? expected.carry(previous, current.currentEpoch + 1) : null;
        this.writeCurrent(taskCorrelation, current.currentEpoch + 1, carried?.memory ?? null, now, carried?.createdAt ?? now);
      }
      return this.getTask(taskCorrelation)!;
    }, taskCorrelation);
  }

  /**
   * Binds one more root to the task's epoch (compare-and-set on the epoch only). root_id stays the primary, the newest
   * bound root, which the restore card and the pending marker read. Every bound root is one ROOT_BOUND_EVENT row of
   * that epoch; the rows outlive a rotation, so ownership does not depend on the epoch. They are observation rows, not
   * a new table, like the fork pins: the shared-state module inventory then needs no change.
   */
  bindRoot(taskCorrelation: string, epoch: number, rootId: string, now: string): boolean {
    return this.transaction(msg("continuity.store.bindRoot", {}), () => {
      const result = this.database.prepare(`
        UPDATE continuity_tasks SET root_id = ?, suppressed = 0, updated_at = ?
        WHERE task_correlation = ? AND current_epoch = ?
      `).run(rootId, now, taskCorrelation, epoch);
      if (result.changes !== 1) return false;
      this.database.prepare(`
        INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
        SELECT ?, ?, ?, NULL, 1, ? WHERE NOT EXISTS (
          SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND epoch = ? AND event = ?
        )
      `).run(taskCorrelation, epoch, ROOT_BOUND_EVENT + rootId, now, taskCorrelation, epoch, ROOT_BOUND_EVENT + rootId);
      return true;
    }, taskCorrelation);
  }

  /** Every root bound to this epoch, oldest first; a primary bound by an older version without its row is included. */
  boundRoots(taskCorrelation: string, epoch: number): string[] {
    const task = this.getTask(taskCorrelation);
    const rows = this.observationEventsAfter(taskCorrelation, epoch, ROOT_BOUND_EVENT, 0).map(event => event.slice(ROOT_BOUND_EVENT.length));
    const primary = task?.currentEpoch === epoch ? task.rootId : null;
    return [...new Set(primary ? [...rows, primary] : rows)];
  }

  /** Whether another task ever bound the root, in any epoch. */
  ownedElsewhere(taskCorrelation: string, rootId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM continuity_observations WHERE event = ? AND task_correlation <> ?
      UNION ALL SELECT 1 FROM continuity_tasks WHERE root_id = ? AND task_correlation <> ?
      LIMIT 1
    `).get(ROOT_BOUND_EVENT + rootId, taskCorrelation, rootId, taskCorrelation));
  }

  /** Whether any task ever bound the root, in any epoch: a root no session bound has no owner. */
  rootBound(rootId: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM continuity_observations WHERE event = ?
      UNION ALL SELECT 1 FROM continuity_tasks WHERE root_id = ?
      LIMIT 1
    `).get(ROOT_BOUND_EVENT + rootId, rootId));
  }

  /** Every root the task ever bound, in any epoch, with its primary: what state cleanup must not take from it. */
  allBoundRoots(taskCorrelation: string): string[] {
    const rows = this.database.prepare(`
      SELECT DISTINCT substr(event, ?) AS root_id FROM continuity_observations
      WHERE task_correlation = ? AND substr(event, 1, ?) = ?
    `).all(ROOT_BOUND_EVENT.length + 1, taskCorrelation, ROOT_BOUND_EVENT.length, ROOT_BOUND_EVENT) as Array<{ root_id: string }>;
    const primary = this.readTask(taskCorrelation)?.rootId ?? null;
    return [...new Set([...rows.map(row => row.root_id), ...(primary ? [primary] : [])])];
  }

  /** Whether this task ever bound the root, in any epoch. */
  ownsRoot(taskCorrelation: string, rootId: string): boolean {
    if (this.getTask(taskCorrelation)?.rootId === rootId) return true;
    return Boolean(this.database.prepare(`
      SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND event = ? LIMIT 1
    `).get(taskCorrelation, ROOT_BOUND_EVENT + rootId));
  }

  setSuppressed(taskCorrelation: string, epoch: number, now: string): boolean {
    return this.transaction(msg("continuity.store.suppress", {}), () => {
      const result = this.database.prepare(`
        UPDATE continuity_tasks SET suppressed = 1, updated_at = ?
        WHERE task_correlation = ? AND current_epoch = ?
      `).run(now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }

  /** Synchronous critical read; clear/root changes cannot commit between guard and body. */
  readCurrentState<T>(
    taskCorrelation: string, epoch: number, source: "direct" | "workflow" | "either",
    read: (task: ContinuityTaskRecord) => T, allowSuppressed = false,
  ): ContinuityCurrentRead<T> {
    return this.transaction<ContinuityCurrentRead<T>>(msg("continuity.store.readCurrentState", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch) return { kind: "epoch-mismatch" };
      // A direct snapshot is the session's own record (corrections, decisions, remaining work); it stays readable and
      // writable while workflow roots are bound. Only a workflow read needs a bound root.
      if (source === "workflow" && task.rootId === null) return { kind: "source-conflict" };
      if (task.suppressed && !allowSuppressed) return { kind: "suppressed" };
      return { kind: "available", task, value: read(task) };
    }, taskCorrelation);
  }

  /** Current only: an old epoch never selects history. */
  getCurrent(taskCorrelation: string, epoch?: number): ContinuitySnapshotV1 | null {
    const row = this.database.prepare(`
      SELECT * FROM continuity_current_memory WHERE task_correlation = ?
    `).get(taskCorrelation) as CurrentRow | undefined;
    this.assertCompatibleTask(taskCorrelation);
    if (!row || epoch !== undefined && row.epoch !== epoch) return null;
    let memory: ContinuityMemoryBodyV1 | null;
    try {
      memory = row.memory_json === null ? null : JSON.parse(row.memory_json) as ContinuityMemoryBodyV1;
      if ((memory === null) !== (row.memory_digest === null)) {
        throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.snapshot.digestInvalid", {}), {reasonCode: "CONTINUITY_MEMORY_NULL_MISMATCH"});
      }
      if (memory !== null && serializeContinuityMemory(memory).digest !== row.memory_digest) {
        throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.snapshot.digestInvalid", {}), {reasonCode: "CONTINUITY_MEMORY_DIGEST_MISMATCH"});
      }
    } catch (cause) {
      const failure = ownOperationError(cause);
      if (failure instanceof WorkflowContractError && failure.code === "INTEGRITY_FAILED") throw failure;
      // No row, body, raw parser message or history content is attached to this public failure.
      throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.snapshot.digestInvalid", {}), {reasonCode: "CONTINUITY_MEMORY_INVALID"});
    }
    return { schemaVersion: "1.0.0", source: "direct", taskCorrelation: row.task_correlation, epoch: row.epoch,
      stateToken: row.state_token, memory,
      memoryDigest: row.memory_digest, createdAt: row.created_at, updatedAt: row.updated_at };
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
      SELECT state_token, empty_state_token, payload_digest, purged_at FROM continuity_tombstones
      WHERE task_correlation = ? AND epoch = ?
    `).get(taskCorrelation, epoch) as TombstoneRow | undefined;
    return row ? { stateToken: row.state_token, emptyStateToken: row.empty_state_token, payloadDigest: row.payload_digest, purgedAt: row.purged_at } : null;
  }

  checkpoint(
    taskCorrelation: string,
    epoch: number,
    expectedStateToken: string,
    requestHash: string,
    commandDigest: string,
    memory: ContinuityMemoryBodyV1,
    now: string,
    lineageAnchors: readonly string[] = [],
  ): { kind: "stored"; snapshot: ContinuitySnapshotV1 } | { kind: "stale"; actualStateToken: string | null } | { kind: "replay"; request: StoredRequest } | { kind: "conflict" } | { kind: "epoch-mismatch" } {
    const serialized = serializeContinuityMemory(memory);
    return this.transaction(msg("continuity.store.checkpoint", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch) return { kind: "epoch-mismatch" };
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getCurrent(taskCorrelation, epoch);
      if (!current || current.stateToken !== expectedStateToken) return { kind: "stale", actualStateToken: current?.stateToken ?? null };
      let snapshot = current;
      if (current.memory === null || serializeContinuityMemory(current.memory).json !== serialized.json) {
        this.archiveCurrent(current, now, "update");
        snapshot = this.writeCurrent(taskCorrelation, epoch, memory, now, current.memory ? current.createdAt : now);
        // Follow an unconsumed pre-compact marker through this exact current replacement only.
        if (!task.suppressed && task.pendingSource === "direct" && !task.pendingConsumed
          && current.memoryDigest !== null && task.pendingStateToken === current.stateToken && task.pendingDigest === current.memoryDigest) {
          this.database.prepare(`UPDATE continuity_tasks SET pending_state_token=?,pending_digest=?,updated_at=?
            WHERE task_correlation=? AND current_epoch=? AND suppressed=0 AND pending_source='direct' AND pending_consumed=0
              AND pending_state_token=? AND pending_digest=?`)
            .run(snapshot.stateToken, snapshot.memoryDigest, now, taskCorrelation, epoch, current.stateToken, current.memoryDigest);
        }
      }
      const resultJson = JSON.stringify({
        schemaVersion: "1.0.0",
        kind: "checkpoint",
        epoch,
        stateToken: snapshot.stateToken,
        memoryDigest: snapshot.memoryDigest,
      });
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      this.insertLineageAnchors(taskCorrelation, epoch, snapshot.stateToken, snapshot.memoryDigest!, lineageAnchors, now);
      return { kind: "stored", snapshot };
    }, taskCorrelation);
  }

  /** Each anchor names exactly one stored revision; a later fork child may select it, never write it. */
  private insertLineageAnchors(taskCorrelation: string, epoch: number, stateToken: string, digest: string, anchors: readonly string[], now: string): void {
    const event = `${LINEAGE_ANCHOR_EVENT}${stateToken}:${digest}`;
    const insert = this.database.prepare(`
      INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
      SELECT ?, ?, ?, ?, 1, ? WHERE NOT EXISTS (
        SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND epoch = ? AND event = ? AND turn_hash = ?
      )
    `);
    for (const anchor of anchors) insert.run(taskCorrelation, epoch, event, anchor, now, taskCorrelation, epoch, event, anchor);
  }

  /** Re-anchors the current direct snapshot (after compaction) only while it is still that exact revision. */
  reanchorCurrent(taskCorrelation: string, epoch: number, stateToken: string, digest: string, anchors: readonly string[], now: string): boolean {
    return this.transaction(msg("continuity.store.lineageAnchors", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch || task.rootId !== null) return false;
      const current = this.getCurrent(taskCorrelation, epoch);
      if (!current?.memory || current.stateToken !== stateToken || current.memoryDigest !== digest) return false;
      this.insertLineageAnchors(taskCorrelation, epoch, stateToken, digest, anchors, now);
      return true;
    }, taskCorrelation);
  }

  /** The oldest event with this prefix: a fork's pinned parent is decided once and never replaced. */
  firstObservationEvent(taskCorrelation: string, epoch: number, prefix: string): string | null {
    const row = this.database.prepare(`
      SELECT event FROM continuity_observations
      WHERE task_correlation = ? AND epoch = ? AND substr(event, 1, ?) = ?
      ORDER BY observation_id ASC LIMIT 1
    `).get(taskCorrelation, epoch, prefix.length, prefix) as { event: string } | undefined;
    return row?.event ?? null;
  }

  /**
   * Whether the task's current epoch holds `event` and no row starting with a closing prefix. Observation rows only, so a
   * per-tool-boundary probe does not reach receiver state; a caller that acts on true reads the task through getTask.
   */
  hasOpenCurrentEpochEvent(taskCorrelation: string, event: string, closingPrefixes: readonly string[]): boolean {
    this.assertSupportedSchema();
    const closed = closingPrefixes.map(() => "substr(closing.event, 1, ?) = ?").join(" OR ") || "0";
    return Boolean(this.database.prepare(`
      SELECT 1 FROM continuity_tasks task
      JOIN continuity_observations pending ON pending.task_correlation = task.task_correlation AND pending.epoch = task.current_epoch AND pending.event = ?
      WHERE task.task_correlation = ? AND NOT EXISTS (
        SELECT 1 FROM continuity_observations closing
        WHERE closing.task_correlation = task.task_correlation AND closing.epoch = task.current_epoch AND (${closed}))
      LIMIT 1
    `).get(event, taskCorrelation, ...closingPrefixes.flatMap(prefix => [prefix.length, prefix])));
  }

  hasObservation(taskCorrelation: string, epoch: number, event: string): boolean {
    return Boolean(this.database.prepare(`
      SELECT 1 FROM continuity_observations WHERE task_correlation = ? AND epoch = ? AND event = ? LIMIT 1
    `).get(taskCorrelation, epoch, event));
  }

  /** Every other task's anchors in one read, newest kept per anchor. ceiling: full scan bounded by observation cleanup. */
  /**
   * Every anchor row of other tasks recorded before `beforeObservationId` (the child's own fork record), in store order.
   * The store's insertion order, not a clock, separates revisions saved before the fork from later ones.
   */
  lineageAnchorRows(excludeTaskCorrelation: string, beforeObservationId: number): Array<{ anchor: string; parent: { c: string; e: number; t: string; d: string; o: number } }> {
    const rows = this.database.prepare(`
      SELECT task_correlation, epoch, event, turn_hash,
        MIN(observation_id) OVER (PARTITION BY task_correlation, epoch, event) AS saved_order
      FROM continuity_observations
      WHERE task_correlation <> ? AND observation_id < ? AND turn_hash IS NOT NULL AND substr(event, 1, ?) = ?
      ORDER BY observation_id ASC
    `).all(excludeTaskCorrelation, beforeObservationId, LINEAGE_ANCHOR_EVENT.length, LINEAGE_ANCHOR_EVENT) as
      Array<{ task_correlation: string; epoch: number; event: string; turn_hash: string; saved_order: number }>;
    return rows.flatMap(row => {
      const match = /^([a-f0-9]{48}):(sha256:[0-9a-f]{64})$/u.exec(row.event.slice(LINEAGE_ANCHOR_EVENT.length));
      return match ? [{ anchor: row.turn_hash, parent: { c: row.task_correlation, e: row.epoch, t: match[1]!, d: match[2]!, o: row.saved_order } }] : [];
    });
  }

  /** The store position and time of the first observation of this exact event, or null. */
  firstObservation(taskCorrelation: string, epoch: number, event: string): { id: number; at: string } | null {
    const row = this.database.prepare(`
      SELECT observation_id, observed_at FROM continuity_observations WHERE task_correlation = ? AND epoch = ? AND event = ?
      ORDER BY observation_id ASC LIMIT 1
    `).get(taskCorrelation, epoch, event) as { observation_id: number; observed_at: string } | undefined;
    return row ? { id: row.observation_id, at: row.observed_at } : null;
  }

  /** The store position of the newest observation of this exact event, or null. */
  lastObservationId(taskCorrelation: string, epoch: number, event: string, beforeId = Number.MAX_SAFE_INTEGER): number | null {
    const row = this.database.prepare(`
      SELECT MAX(observation_id) AS id FROM continuity_observations
      WHERE task_correlation = ? AND epoch = ? AND event = ? AND observation_id < ?
    `).get(taskCorrelation, epoch, event, beforeId) as { id: number | null } | undefined;
    return row?.id ?? null;
  }

  firstObservationIdAfter(taskCorrelation: string, epoch: number, event: string, afterId: number): number | null {
    const row = this.database.prepare(`
      SELECT MIN(observation_id) AS id FROM continuity_observations
      WHERE task_correlation = ? AND epoch = ? AND event = ? AND observation_id > ?
    `).get(taskCorrelation, epoch, event, afterId) as { id: number | null } | undefined;
    return row?.id ?? null;
  }

  /** The turn_hash values of this exact event recorded after `afterId`, in store order. */
  observationHashesAfter(taskCorrelation: string, epoch: number, event: string, afterId: number): string[] {
    return (this.database.prepare(`
      SELECT turn_hash FROM continuity_observations
      WHERE task_correlation = ? AND epoch = ? AND event = ? AND observation_id > ? AND turn_hash IS NOT NULL
      ORDER BY observation_id ASC
    `).all(taskCorrelation, epoch, event, afterId) as Array<{ turn_hash: string }>).map(row => row.turn_hash);
  }

  /** The events starting with `prefix` recorded after `afterId`, in store order. */
  observationEventsAfter(taskCorrelation: string, epoch: number, prefix: string, afterId: number): string[] {
    return (this.database.prepare(`
      SELECT event FROM continuity_observations
      WHERE task_correlation = ? AND epoch = ? AND substr(event, 1, ?) = ? AND observation_id > ?
      ORDER BY observation_id ASC
    `).all(taskCorrelation, epoch, prefix.length, prefix, afterId) as Array<{ event: string }>).map(row => row.event);
  }

  /** Copies a selected parent snapshot into an empty child epoch only; existing child state is never replaced. */
  adoptCurrent(taskCorrelation: string, epoch: number, snapshot: ContinuitySnapshotV1, now: string): ContinuitySnapshotV1 | null {
    return this.transaction(msg("continuity.store.adoptSnapshot", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch || task.rootId !== null || task.suppressed || !snapshot.memory) return null;
      const current = this.getCurrent(taskCorrelation, epoch);
      if (!current || current.memory || this.getTombstone(taskCorrelation, epoch)) return null;
      return this.writeCurrent(taskCorrelation, epoch, snapshot.memory, now, now);
    }, taskCorrelation);
  }

  purge(
    taskCorrelation: string,
    epoch: number,
    expectedStateToken: string,
    requestHash: string,
    commandDigest: string,
    tombstoneDigest: string,
    now: string,
  ): { kind: "purged"; snapshot: ContinuitySnapshotV1 } | { kind: "stale"; actualStateToken: string | null } | { kind: "replay"; request: StoredRequest } | { kind: "conflict" } | { kind: "epoch-mismatch" } {
    return this.transaction(msg("continuity.store.purge", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch) return { kind: "epoch-mismatch" };
      const replay = this.getRequest(taskCorrelation, epoch, requestHash);
      if (replay) return replay.commandDigest === commandDigest ? { kind: "replay", request: replay } : { kind: "conflict" };
      const current = this.getCurrent(taskCorrelation, epoch);
      if (!current?.memory || current.stateToken !== expectedStateToken) return { kind: "stale", actualStateToken: current?.stateToken ?? null };
      const snapshot = this.tombstone(current, tombstoneDigest, now);
      this.scrubRequests(taskCorrelation, epoch, purgedRequestJson(epoch, expectedStateToken, tombstoneDigest, now));
      const resultJson = JSON.stringify({ schemaVersion: "1.0.0", purged: true, epoch, stateToken: expectedStateToken,
        emptyStateToken: snapshot.stateToken, tombstoneDigest, purgedAt: now });
      this.database.prepare(`
        INSERT INTO continuity_requests(task_correlation, epoch, request_hash, command_digest, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, requestHash, commandDigest, resultJson, now);
      return { kind: "purged", snapshot };
    }, taskCorrelation);
  }

  setPendingMarker(
    taskCorrelation: string,
    epoch: number,
    source: "workflow",
    revision: number,
    digest: string,
    rootId: string | null,
    now: string,
  ): boolean {
    return this.transaction(msg("continuity.store.markPending", {}), () => {
      const task = this.readTask(taskCorrelation);
      if (!task || task.currentEpoch !== epoch || task.suppressed) return false;
      if (!rootId || task.rootId !== rootId) return false;
      const result = this.database.prepare(`
        UPDATE continuity_tasks SET pending_source = ?, pending_revision = ?, pending_state_token = NULL, pending_digest = ?,
          pending_root_id = ?, pending_consumed = 0, updated_at = ?
        WHERE task_correlation = ? AND current_epoch = ?
      `).run(source, revision, digest, rootId, now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }

  setDirectPendingMarker(taskCorrelation: string, epoch: number, stateToken: string, digest: string, now: string): boolean {
    return this.transaction(msg("continuity.store.markPending", {}), () => {
      const task = this.readTask(taskCorrelation);
      const current = this.getCurrent(taskCorrelation, epoch);
      if (!task || task.currentEpoch !== epoch || task.suppressed || current?.stateToken !== stateToken || current.memoryDigest !== digest) return false;
      const result = this.database.prepare(`UPDATE continuity_tasks SET pending_source='direct', pending_revision=NULL,
        pending_state_token=?, pending_digest=?, pending_root_id=NULL, pending_consumed=0, updated_at=?
        WHERE task_correlation=? AND current_epoch=?`).run(stateToken, digest, now, taskCorrelation, epoch);
      return result.changes === 1;
    }, taskCorrelation);
  }

  consumeDirectMarker(taskCorrelation: string, epoch: number, stateToken: string, digest: string, now: string): boolean {
    return this.transaction(msg("continuity.store.consumeRestore", {}), () => {
      const result = this.database.prepare(`UPDATE continuity_tasks SET pending_consumed=1,updated_at=?
        WHERE task_correlation=? AND current_epoch=? AND suppressed=0 AND pending_source='direct'
          AND pending_state_token=? AND pending_digest=? AND pending_consumed=0
          AND EXISTS(SELECT 1 FROM continuity_current_memory current WHERE current.task_correlation=continuity_tasks.task_correlation
            AND current.epoch=continuity_tasks.current_epoch AND current.state_token=? AND current.memory_digest=? AND current.memory_json IS NOT NULL)`)
        .run(now, taskCorrelation, epoch, stateToken, digest, stateToken, digest);
      return result.changes === 1;
    }, taskCorrelation);
  }

  consumeWorkflowMarker(taskCorrelation: string, epoch: number, rootId: string, revision: number, digest: string, now: string): boolean {
    return this.transaction(msg("continuity.store.consumeRestore", {}), () => {
      const result = this.database.prepare(`
        UPDATE continuity_tasks SET pending_consumed = 1, last_auto_injected_revision = ?, updated_at = ?
        WHERE task_correlation = ? AND current_epoch = ? AND suppressed = 0
          AND root_id = ? AND pending_root_id = ? AND pending_source = 'workflow'
          AND pending_revision = ? AND pending_digest = ? AND pending_consumed = 0
      `).run(revision, now, taskCorrelation, epoch, rootId, rootId, revision, digest);
      return result.changes === 1;
    }, taskCorrelation);
  }

  recordObservation(taskCorrelation: string, epoch: number, event: string, turnHash: string | null, success: boolean, now: string): void {
    this.transaction(msg("continuity.store.recordObservation", {}), () => {
      this.database.prepare(`
        INSERT INTO continuity_observations(task_correlation, epoch, event, turn_hash, success, observed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(taskCorrelation, epoch, event, turnHash, success ? 1 : 0, now);
    }, taskCorrelation);
  }

  getSchemaVersion(): number {
    return this.shared?.getSchemaVersion() ?? (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  previewCleanup(payloadCutoff: string, recordCutoff: string): ContinuityCleanupPreview {
    this.assertSupportedSchema();
    const rows = this.database.prepare(`SELECT current.*, tasks.root_id FROM continuity_current_memory current
      JOIN continuity_tasks tasks USING(task_correlation) ORDER BY current.task_correlation`).all() as unknown as Array<CurrentRow & {root_id: string | null}>;
    const snapshots: ContinuityCleanupPreview["snapshots"] = [];
    const tasks: ContinuityCleanupPreview["tasks"] = [];
    let protectedActiveTasks = 0;
    for (const row of rows) {
      const memory = row.memory_json === null ? null : JSON.parse(row.memory_json) as ContinuityMemoryBodyV1;
      if (this.hasReceiverState(row.task_correlation) || memory?.status === "active") {
        protectedActiveTasks += 1;
        continue;
      }
      const task = this.readTask(row.task_correlation)!;
      if (task.updatedAt <= recordCutoff && !this.taskHasRecentState(task.taskCorrelation, recordCutoff)) {
        tasks.push({ taskCorrelation: task.taskCorrelation, currentEpoch: task.currentEpoch, rootId: task.rootId, updatedAt: task.updatedAt });
      } else if (memory && row.updated_at <= payloadCutoff) {
        snapshots.push({ kind: "current", taskCorrelation: row.task_correlation, rootId: row.root_id, epoch: row.epoch,
          stateToken: row.state_token, memoryDigest: row.memory_digest!, updatedAt: row.updated_at });
      }
    }
    return { snapshots, tasks, protectedActiveTasks };
  }

  private taskHasRecentState(taskCorrelation: string, cutoff: string): boolean {
    const row = this.database.prepare(`SELECT
      EXISTS(SELECT 1 FROM continuity_current_memory WHERE task_correlation=? AND
        (updated_at>? OR json_extract(memory_json,'$.status')='active')) AS current_recent,
      EXISTS(SELECT 1 FROM continuity_memory_history WHERE task_correlation=? AND archived_at>?) AS history_recent,
      EXISTS(SELECT 1 FROM continuity_requests WHERE task_correlation=? AND created_at>?) AS request_recent,
      EXISTS(SELECT 1 FROM continuity_tombstones WHERE task_correlation=? AND purged_at>?) AS tombstone_recent,
      EXISTS(SELECT 1 FROM continuity_observations WHERE task_correlation=? AND observed_at>?) AS observation_recent
    `).get(taskCorrelation, cutoff, taskCorrelation, cutoff, taskCorrelation, cutoff, taskCorrelation, cutoff, taskCorrelation, cutoff) as Record<string, number>;
    return Object.values(row).some(value => value !== 0);
  }

  backupTo(targetPath: string): void {
    if (this.shared) throw new Error("SHARED_BACKUP_OWNER_REQUIRED: a shared database backup requires an explicit owner contract.");
    if (this.databasePath === ":memory:") throw new ContinuityStoreError(msg("continuity.store.inMemoryCleanup", {}));
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
      throw new ContinuityStoreError(msg("continuity.store.cleanupBackup", {}), cause, continuityUnavailableReason(cause));
    }
  }

  executeCleanup(
    preview: ContinuityCleanupPreview,
    now: string,
    payloadCutoff: string,
    recordCutoff: string,
  ): { snapshots: number; tasks: number } {
    return this.transaction(msg("continuity.store.executeCleanup", {}), () => {
      for (const candidate of preview.snapshots) {
        this.assertCompatibleTask(candidate.taskCorrelation);
        const task = this.readTask(candidate.taskCorrelation);
        const current = this.getCurrent(candidate.taskCorrelation, candidate.epoch);
        if (!task || !current?.memory || current.memory.status === "active" || current.updatedAt > payloadCutoff
          || task.rootId !== candidate.rootId || current.stateToken !== candidate.stateToken
          || current.memoryDigest !== candidate.memoryDigest || current.updatedAt !== candidate.updatedAt) {
          throw new ContinuityStoreError(msg("continuity.store.snapshotChanged", {task: candidate.taskCorrelation, epoch: candidate.epoch}));
        }
      }
      for (const candidate of preview.tasks) {
        this.assertCompatibleTask(candidate.taskCorrelation);
        const task = this.readTask(candidate.taskCorrelation);
        if (!task || task.currentEpoch !== candidate.currentEpoch || task.rootId !== candidate.rootId || task.updatedAt !== candidate.updatedAt
          || this.taskHasRecentState(candidate.taskCorrelation, recordCutoff)) {
          throw new ContinuityStoreError(msg("continuity.store.taskChanged", {task: candidate.taskCorrelation}));
        }
      }
      for (const candidate of preview.snapshots) {
        const current = this.getCurrent(candidate.taskCorrelation, candidate.epoch)!;
        this.tombstone(current, candidate.memoryDigest, now);
        this.scrubRequests(candidate.taskCorrelation, candidate.epoch,
          purgedRequestJson(candidate.epoch, candidate.stateToken, candidate.memoryDigest, now));
      }
      const deleteByTask = ["continuity_current_memory", "continuity_memory_history", "continuity_requests", "continuity_tombstones", "continuity_observations"]
        .map(table => this.database.prepare(`DELETE FROM ${table} WHERE task_correlation=?`));
      for (const candidate of preview.tasks) {
        for (const statement of deleteByTask) statement.run(candidate.taskCorrelation);
        this.database.prepare("DELETE FROM continuity_tasks WHERE task_correlation=?").run(candidate.taskCorrelation);
      }
      return {snapshots: preview.snapshots.length, tasks: preview.tasks.length};
    });
  }

  private tombstone(current: ContinuitySnapshotV1, payloadDigest: string, now: string): ContinuitySnapshotV1 {
    // Explicit erasure is not an update: do not archive the payload being removed.
    const empty = this.writeCurrent(current.taskCorrelation, current.epoch, null, now, now);
    this.database.prepare(`INSERT INTO continuity_tombstones(task_correlation,epoch,state_token,empty_state_token,payload_digest,purged_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(task_correlation,epoch) DO UPDATE SET state_token=excluded.state_token,
      empty_state_token=excluded.empty_state_token,payload_digest=excluded.payload_digest,purged_at=excluded.purged_at`)
      .run(current.taskCorrelation, current.epoch, current.stateToken, empty.stateToken, payloadDigest, now);
    return empty;
  }

  private scrubRequests(taskCorrelation: string, epoch: number, replacement: string): void {
    const rows = this.database.prepare("SELECT request_hash,result_json FROM continuity_requests WHERE task_correlation=? AND epoch=?")
      .all(taskCorrelation, epoch) as Array<{request_hash: string; result_json: string}>;
    for (const row of rows) {
      let value: Record<string, unknown> | null = null;
      try { value = JSON.parse(row.result_json) as Record<string, unknown>; } catch { /* Legacy opaque content is erased below. */ }
      if (!isBodyFreeRequestReceipt(value)) this.database.prepare(`UPDATE continuity_requests SET result_json=?
        WHERE task_correlation=? AND epoch=? AND request_hash=?`).run(replacement, taskCorrelation, epoch, row.request_hash);
    }
  }

  private insertEmptyCurrent(taskCorrelation: string, epoch: number, now: string): void {
    this.database.prepare(`INSERT OR IGNORE INTO continuity_current_memory(task_correlation,epoch,state_token,memory_json,memory_digest,created_at,updated_at)
      VALUES(?,?,?,NULL,NULL,?,?)`).run(taskCorrelation, epoch, randomBytes(24).toString("hex"), now, now);
  }

  private writeCurrent(taskCorrelation: string, epoch: number, memory: ContinuityMemoryBodyV1 | null, now: string, createdAt: string): ContinuitySnapshotV1 {
    const body = memory === null ? null : serializeContinuityMemory(memory);
    const stateToken = randomBytes(24).toString("hex");
    this.database.prepare(`INSERT INTO continuity_current_memory(task_correlation,epoch,state_token,memory_json,memory_digest,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_correlation) DO UPDATE SET epoch=excluded.epoch,state_token=excluded.state_token,
      memory_json=excluded.memory_json,memory_digest=excluded.memory_digest,created_at=excluded.created_at,updated_at=excluded.updated_at`)
      .run(taskCorrelation, epoch, stateToken, body?.json ?? null, body?.digest ?? null, createdAt, now);
    this.database.prepare("UPDATE continuity_tasks SET updated_at=? WHERE task_correlation=?").run(now, taskCorrelation);
    return {schemaVersion: "1.0.0", source: "direct", taskCorrelation, epoch, stateToken, memory,
      memoryDigest: body?.digest ?? null, createdAt, updatedAt: now};
  }

  private archiveCurrent(current: ContinuitySnapshotV1, now: string, reason: string): void {
    if (current.memory === null) return;
    const body = serializeContinuityMemory(current.memory);
    if (body.digest !== current.memoryDigest) throw new WorkflowContractError("INTEGRITY_FAILED", msg("continuity.snapshot.digestInvalid", {}), {reasonCode: "CONTINUITY_MEMORY_DIGEST_MISMATCH"});
    this.database.prepare(`INSERT INTO continuity_memory_history(task_correlation,state_token,epoch,memory_json,memory_digest,
      created_at,updated_at,archived_at,reason,format) VALUES(?,?,?,?,?,?,?,?,?,'memory-v1')`)
      .run(current.taskCorrelation, current.stateToken, current.epoch, body.json, body.digest, current.createdAt, current.updatedAt, now, reason);
  }

  /**
   * Runs a write transaction. Early returns commit without having written;
   * failures roll back and surface as ContinuityStoreError.
   */
  private transaction<T>(message: MessageRef, operation: () => T, taskCorrelation?: string): T {
    if (this.shared) {
      try {
        return this.shared.transaction(() => {
          if (taskCorrelation !== undefined) this.assertCompatibleTask(taskCorrelation);
          return operation();
        });
      } catch (cause) {
        throw ownOperationError(cause) ?? new ContinuityStoreError(message, cause, continuityUnavailableReason(cause));
      }
    }
    // Fork adoption runs under the parent's read barrier on this same connection.
    if (this.transactionDepth > 0) {
      const savepoint = `continuity_${++this.savepointSequence}`;
      this.database.exec(`SAVEPOINT ${savepoint}`);
      try {
        if (taskCorrelation !== undefined) this.assertCompatibleTask(taskCorrelation);
        const result = operation();
        this.database.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (cause) {
        const failure = ownOperationError(cause) ?? new ContinuityStoreError(message, cause, continuityUnavailableReason(cause));
        retainCleanupFailure(failure, "CONTINUITY_SAVEPOINT_ROLLBACK_FAILED", () => this.database.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint};`));
        throw failure;
      }
    }
    this.database.exec("BEGIN IMMEDIATE;");
    this.transactionDepth += 1;
    try {
      if (taskCorrelation !== undefined) this.assertCompatibleTask(taskCorrelation);
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (cause) {
      // The wrapped failure keeps its stable reason (CORRUPT_DATABASE), not only the default (D0057).
      const failure = ownOperationError(cause) ?? new ContinuityStoreError(message, cause, continuityUnavailableReason(cause));
      // The primary failure wins; a failed ROLLBACK is kept only as a tagged secondary diagnostic.
      retainCleanupFailure(failure, "CONTINUITY_ROLLBACK_FAILED", () => this.database.exec("ROLLBACK;"));
      throw failure;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  private assertSupportedSchema(): number {
    const version = this.getSchemaVersion();
    if (version < 0 || version > MAX_COMPATIBLE_SCHEMA_VERSION) {
      throw new ContinuityStoreError(msg("continuity.store.unsupportedSchema", { version }), undefined, "UNSUPPORTED_SCHEMA");
    }
    return version;
  }

  private hasReceiverState(taskCorrelation: string): boolean {
    // Detect a concurrent v2 -> v3 migration too; an open connection must not cache the absence of this table.
    const table = this.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'continuity_delta_state'").get();
    return Boolean(table && this.database.prepare("SELECT 1 FROM continuity_delta_state WHERE task_correlation = ? LIMIT 1").get(taskCorrelation));
  }

  private assertCompatibleTask(taskCorrelation: string): void {
    this.assertSupportedSchema();
    if (this.hasReceiverState(taskCorrelation)) {
      throw new ContinuityStoreError(msg("continuity.store.receiverStateUnsupported", {}),
        undefined, "RECEIVER_STATE_UNSUPPORTED");
    }
  }

  private validateExistingSchema(version: number): void {
    const signatures = version === SCHEMA_VERSION ? TABLE_SIGNATURES : LEGACY_TABLE_SIGNATURES;
    for (const [table, expected] of Object.entries(signatures)) {
      if (table === "continuity_delta_state" && (version < 3 || version === SCHEMA_VERSION
        && !this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))) continue;
      const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string; type: string; notnull: number; pk: number; dflt_value: string | null;
      }>;
      const actual = columns.map(column => `${column.name}:${column.type}:${column.notnull}:${column.pk}`
        + (column.dflt_value === null ? "" : `:${column.dflt_value}`)).join(" ");
      if (actual !== expected) throw new ContinuityStoreError(msg("continuity.store.incompatibleSchema", {}), undefined, "INCOMPATIBLE_SCHEMA");
    }
    if (version === SCHEMA_VERSION) {
      const sql = this.database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='continuity_current_memory'").get() as {sql: string};
      if (!sql.sql.replace(/\s+/gu, " ").includes("CHECK (memory_json IS NULL OR (json_valid(memory_json) AND length(CAST(memory_json AS BLOB)) <= 2000))")) {
        throw new ContinuityStoreError(msg("continuity.store.incompatibleSchema", {}), undefined, "INCOMPATIBLE_SCHEMA");
      }
    }
    const integrity = this.database.prepare("PRAGMA quick_check").all() as Array<{quick_check: string}>;
    if (integrity.length !== 1 || integrity[0]?.quick_check !== "ok") {
      throw new ContinuityStoreError(msg("continuity.store.integrityFailed", {}), undefined, "CORRUPT_DATABASE");
    }
  }

  private initializeSchema(migrations: readonly ContinuityMemoryMigration[]): void {
    const version = this.assertSupportedSchema();
    if (version === SCHEMA_VERSION) {
      this.validateExistingSchema(version);
      this.initializeIndexes();
      return;
    }
    if (version !== 0 && version !== 1 && version !== 2 && version !== 3) {
      throw new ContinuityStoreError(msg("continuity.store.unsupportedSchema", {version}), undefined, "UNSUPPORTED_SCHEMA");
    }
    if (version > 0) this.validateExistingSchema(version);
    // All preparation is checked before any schema write. No semantic summarization occurs in SQL.
    const prepared = this.prepareLegacyMigration(version, migrations);
    const migrationAt = new Date().toISOString();
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS continuity_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS continuity_tasks(
        task_correlation TEXT PRIMARY KEY, current_epoch INTEGER NOT NULL CHECK(current_epoch>=1), root_id TEXT,
        suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN(0,1)), last_auto_injected_revision INTEGER,
        pending_source TEXT CHECK(pending_source IN('direct','workflow')), pending_revision INTEGER, pending_digest TEXT,
        pending_root_id TEXT, pending_consumed INTEGER NOT NULL DEFAULT 0 CHECK(pending_consumed IN(0,1)), updated_at TEXT NOT NULL
      );
      ALTER TABLE continuity_tasks ADD COLUMN pending_state_token TEXT;
      ${CURRENT_MEMORY_SCHEMA_SQL}
      CREATE TABLE continuity_memory_history(
        task_correlation TEXT NOT NULL, state_token TEXT NOT NULL, epoch INTEGER NOT NULL,
        memory_json TEXT NOT NULL, memory_digest TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        archived_at TEXT NOT NULL, reason TEXT NOT NULL, format TEXT NOT NULL,
        PRIMARY KEY(task_correlation,state_token)
      );
      CREATE TABLE IF NOT EXISTS continuity_requests(
        task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL, request_hash TEXT NOT NULL,
        command_digest TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(task_correlation,epoch,request_hash)
      );
      CREATE TABLE IF NOT EXISTS continuity_observations(
        observation_id INTEGER PRIMARY KEY AUTOINCREMENT, task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL,
        event TEXT NOT NULL, turn_hash TEXT, success INTEGER NOT NULL CHECK(success IN(0,1)), observed_at TEXT NOT NULL
      );
    `);
    const oldTombstones = version > 0 ? this.database.prepare("SELECT * FROM continuity_tombstones").all() as Array<{
      task_correlation: string; epoch: number; revision: number; payload_digest: string; purged_at: string;
    }> : [];
    for (const erased of oldTombstones) this.database.prepare("INSERT INTO continuity_metadata(key,value) VALUES(?,?)")
      .run(`legacy-tombstone:${erased.task_correlation}:${erased.epoch}`, JSON.stringify(erased));
    if (version > 0) this.database.exec("DROP TABLE continuity_tombstones;");
    this.database.exec(`CREATE TABLE continuity_tombstones(
      task_correlation TEXT NOT NULL, epoch INTEGER NOT NULL, state_token TEXT NOT NULL, empty_state_token TEXT NOT NULL,
      payload_digest TEXT NOT NULL, purged_at TEXT NOT NULL, PRIMARY KEY(task_correlation,epoch)
    );`);
    const tasks = this.database.prepare("SELECT task_correlation,current_epoch,updated_at FROM continuity_tasks").all() as Array<{
      task_correlation: string; current_epoch: number; updated_at: string;
    }>;
    for (const row of tasks) this.insertEmptyCurrent(row.task_correlation, row.current_epoch, row.updated_at);
    for (const item of prepared) {
      const original = item.snapshot;
      this.database.prepare(`INSERT INTO continuity_memory_history(task_correlation,state_token,epoch,memory_json,memory_digest,
        created_at,updated_at,archived_at,reason,format) VALUES(?,?,?,?,?,?,?,?,?,'legacy-snapshot-v1')`)
        .run(original.taskCorrelation, item.legacyToken, original.epoch, item.raw, original.snapshotDigest,
          original.createdAt, original.updatedAt, migrationAt, "migration");
      if (item.currentMemory) {
        const current = this.writeCurrent(original.taskCorrelation, original.epoch, item.currentMemory, original.updatedAt, original.createdAt);
        this.database.prepare("UPDATE continuity_observations SET event=? WHERE task_correlation=? AND epoch=? AND event=?")
          .run(`${LINEAGE_ANCHOR_EVENT}${current.stateToken}:${current.memoryDigest}`, original.taskCorrelation, original.epoch,
            `lineage-anchor:${original.revision}:${original.snapshotDigest}`);
      }
    }
    for (const erased of oldTombstones) {
      const current = this.database.prepare("SELECT epoch,state_token,memory_json FROM continuity_current_memory WHERE task_correlation=?")
        .get(erased.task_correlation) as Pick<CurrentRow, "epoch" | "state_token" | "memory_json"> | undefined;
      // A current-epoch erasure remains attached to its actual empty current. Old epochs stay old.
      const emptyStateToken = current?.epoch === erased.epoch && current.memory_json === null
        ? current.state_token : randomBytes(24).toString("hex");
      this.database.prepare(`INSERT INTO continuity_tombstones(task_correlation,epoch,state_token,empty_state_token,payload_digest,purged_at)
        VALUES(?,?,?,?,?,?)`).run(erased.task_correlation, erased.epoch, randomBytes(24).toString("hex"),
        emptyStateToken, erased.payload_digest, erased.purged_at);
    }
    if (version > 0) {
      // Every legacy payload has been copied losslessly before its old table is removed.
      this.database.exec("DROP TABLE continuity_snapshots;");
      const requests = this.database.prepare("SELECT task_correlation,epoch,request_hash FROM continuity_requests").all() as Array<{
        task_correlation: string; epoch: number; request_hash: string;
      }>;
      for (const row of requests) this.database.prepare(`UPDATE continuity_requests SET result_json=?
        WHERE task_correlation=? AND epoch=? AND request_hash=?`)
        .run(JSON.stringify({schemaVersion:"1.0.0",kind:"legacy-receipt-unavailable"}), row.task_correlation, row.epoch, row.request_hash);
      // Old direct markers/anchors cannot name a new current token. Workflow markers retain their revisions.
      this.database.exec(`UPDATE continuity_tasks SET pending_source=NULL,pending_revision=NULL,pending_digest=NULL,
        pending_root_id=NULL,pending_consumed=0 WHERE pending_source='direct';`);
    }
    this.initializeIndexes();
    if (this.shared) this.shared.setSchemaVersion(SCHEMA_VERSION);
    else this.database.exec(`PRAGMA user_version=${SCHEMA_VERSION};`);
    this.validateExistingSchema(SCHEMA_VERSION);
  }

  /** Fresh, migrated and reopened stores share the same additive index repair. */
  private initializeIndexes(): void {
    this.database.exec(`CREATE INDEX IF NOT EXISTS continuity_current_memory_cleanup ON continuity_current_memory(updated_at,task_correlation);
      CREATE INDEX IF NOT EXISTS continuity_memory_history_cleanup ON continuity_memory_history(archived_at,task_correlation);
      CREATE INDEX IF NOT EXISTS continuity_tasks_cleanup ON continuity_tasks(updated_at,task_correlation);
      CREATE INDEX IF NOT EXISTS continuity_requests_cleanup ON continuity_requests(created_at,task_correlation,epoch);
      CREATE INDEX IF NOT EXISTS continuity_tombstones_cleanup ON continuity_tombstones(purged_at,task_correlation,epoch);
      CREATE INDEX IF NOT EXISTS continuity_observations_cleanup ON continuity_observations(observed_at,task_correlation,epoch);
      ${OBSERVATION_EVENT_INDEX}`);
  }

  private prepareLegacyMigration(version: number, migrations: readonly ContinuityMemoryMigration[]): Array<{
    snapshot: LegacyContinuitySnapshotV1; raw: string; legacyToken: string; currentMemory: ContinuityMemoryBodyV1 | null;
  }> {
    if (version === 0) return [];
    const byTask = new Map<string, ContinuityMemoryMigration>();
    for (const mapping of migrations) {
      if (byTask.has(mapping.taskCorrelation)) throw new ContinuityStoreError(msg("continuity.store.incompatibleSchema", {}), undefined, "MIGRATION_INCOMPLETE");
      // A receiver-owned task's leftover origin is not a current-memory optimization target.
      if (this.hasReceiverState(mapping.taskCorrelation)) {
        throw new ContinuityStoreError(msg("continuity.store.receiverStateUnsupported", {}), undefined, "RECEIVER_STATE_UNSUPPORTED");
      }
      try { serializeContinuityMemory(mapping.memory); }
      catch (cause) { throw new ContinuityStoreError(msg("continuity.store.initDatabase", {}), cause, "MIGRATION_INCOMPLETE"); }
      byTask.set(mapping.taskCorrelation, mapping);
    }
    const rows = this.database.prepare(`SELECT snapshots.*,tasks.current_epoch FROM continuity_snapshots snapshots
      LEFT JOIN continuity_tasks tasks USING(task_correlation) ORDER BY snapshots.task_correlation,snapshots.epoch`).all() as Array<{
        task_correlation: string; epoch: number; revision: number; snapshot_digest: string; snapshot_json: string; current_epoch: number | null;
      }>;
    const prepared = rows.map(row => {
      let snapshot: LegacyContinuitySnapshotV1;
      try { snapshot = JSON.parse(row.snapshot_json) as LegacyContinuitySnapshotV1; }
      catch (cause) { throw new ContinuityStoreError(msg("continuity.snapshot.digestInvalid", {}), cause, "CORRUPT_DATABASE"); }
      const {snapshotDigest, ...base} = snapshot;
      if (row.current_epoch === null || snapshot.taskCorrelation !== row.task_correlation || snapshot.epoch !== row.epoch || snapshot.revision !== row.revision
        || snapshotDigest !== row.snapshot_digest || convergenceDigest(base) !== snapshotDigest) {
        throw new ContinuityStoreError(msg("continuity.snapshot.digestInvalid", {}), undefined, "CORRUPT_DATABASE");
      }
      let currentMemory: ContinuityMemoryBodyV1 | null = null;
      if (row.epoch === row.current_epoch && !this.hasReceiverState(row.task_correlation)) {
        const mapping = byTask.get(row.task_correlation);
        if (mapping && mapping.expectedSnapshotDigest !== row.snapshot_digest) {
          throw new ContinuityStoreError(msg("continuity.store.snapshotChanged", {task: row.task_correlation, epoch: row.epoch}), undefined, "MIGRATION_INCOMPLETE");
        }
        currentMemory = mapping?.memory ?? {status:snapshot.status,core:snapshot.core,evidenceRefs:snapshot.evidenceRefs};
        try { serializeContinuityMemory(currentMemory); }
        catch (cause) { throw new ContinuityStoreError(msg("continuity.store.initDatabase", {}), cause, "MIGRATION_INCOMPLETE"); }
        byTask.delete(row.task_correlation);
      }
      return { snapshot, raw:row.snapshot_json,
        legacyToken:convergenceDigest({task:row.task_correlation,epoch:row.epoch,revision:row.revision,digest:row.snapshot_digest}), currentMemory };
    });
    if (byTask.size > 0) throw new ContinuityStoreError(msg("continuity.store.initDatabase", {}), undefined, "MIGRATION_INCOMPLETE");
    return prepared;
  }
}
