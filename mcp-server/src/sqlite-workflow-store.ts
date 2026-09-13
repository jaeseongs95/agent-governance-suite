import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  type AttemptProposalV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import {
  mergePluginUpdateState,
  type PluginUpdateStore,
  type StoredPluginUpdateState,
} from "./plugin-update-store.js";
import { compareStableVersionNumbers } from "./plugin-version.js";
import { rootsOverlap } from "./convergence-logic.js";
import {
  type ConvergenceSnapshot,
  type GuardedRunBinding,
  type WorkflowStore,
} from "./workflow-store.js";

interface MetadataRow {
  value: string;
}

interface RunRow {
  receipt_json: string;
  revision: number;
}

interface ConvergenceRootRow {
  root_json: string;
  revision: number;
}

interface ConvergenceLeaseRow {
  lease_json: string;
  proposal_json: string;
}

interface ConvergenceOutcomeRow {
  outcome_json: string;
}

interface ConvergenceReviewRow {
  review_json: string;
}

interface WorkflowAttemptLinkRow {
  root_id: string;
  lease_id: string;
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

const SCHEMA_VERSION = 3;

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

  updateRun(
    receipt: WorkflowReceiptV1,
    expectedRevision: number,
    convergence?: { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 },
  ): boolean {
    try {
      return this.transaction(() => {
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
        if (Number(result.changes) !== 1) return false;
        if (!convergence) return true;
        const rootUpdate = this.database.prepare(`
          UPDATE convergence_roots
          SET revision = ?, state = ?, root_json = ?, updated_at = ?
          WHERE root_id = ? AND revision = ?
        `).run(
          convergence.root.revision,
          convergence.root.state,
          JSON.stringify(convergence.root),
          convergence.root.updatedAt,
          convergence.root.rootId,
          convergence.expectedRootRevision,
        );
        if (Number(rootUpdate.changes) !== 1) throw new WorkflowContractError("STALE_REVISION", "Convergence root changed while recording the workflow outcome.");
        const attemptUpdate = this.database.prepare(`
          UPDATE convergence_attempts
          SET state = ?, outcome_json = ?, updated_at = ?
          WHERE run_id = ? AND outcome_json IS NULL
        `).run(
          convergence.outcome.state,
          JSON.stringify(convergence.outcome),
          convergence.outcome.recordedAt,
          receipt.runId,
        );
        if (Number(attemptUpdate.changes) !== 1) throw new WorkflowContractError("LEASE_CONFLICT", "Guarded attempt outcome was already recorded or is missing.", { runId: receipt.runId });
        return true;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot update the workflow run.", cause, { runId: receipt.runId });
    }
  }

  insertConvergenceRoot(root: ConvergenceRootV1): ConvergenceRootV1 | null {
    try {
      return this.transaction(() => {
        const rows = this.database.prepare(`
          SELECT root_json, revision FROM convergence_roots
          WHERE state NOT IN ('completed', 'abandoned')
        `).all() as unknown as ConvergenceRootRow[];
        for (const row of rows) {
          const existing = JSON.parse(row.root_json) as ConvergenceRootV1;
          if (root.parentRootId === existing.rootId) continue;
          if (rootsOverlap(root, existing)) return existing;
        }
        if (root.parentRootId) {
          const row = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(root.parentRootId) as ConvergenceRootRow | undefined;
          if (!row) throw new WorkflowContractError("INVALID_INPUT", "Parent convergence root was not found.", { rootId: root.parentRootId });
          const parent = JSON.parse(row.root_json) as ConvergenceRootV1;
          parent.state = "abandoned";
          parent.revision += 1;
          parent.updatedAt = root.createdAt;
          this.database.prepare(`
            UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
            WHERE root_id = ? AND revision = ?
          `).run(parent.revision, parent.state, JSON.stringify(parent), parent.updatedAt, parent.rootId, row.revision);
        }
        this.database.prepare(`
          INSERT INTO convergence_roots (root_id, revision, state, workspace_id, root_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(root.rootId, root.revision, root.state, root.frame.workspace.workspaceId, JSON.stringify(root), root.createdAt, root.updatedAt);
        this.database.prepare(`
          INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
          VALUES (?, ?, ?, ?)
        `).run(root.rootId, root.currentEpoch, root.frameDigest, root.createdAt);
        return null;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot persist the convergence root.", cause, { rootId: root.rootId });
    }
  }

  getConvergenceSnapshot(rootId: string): ConvergenceSnapshot | null {
    try {
      const rootRow = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(rootId) as ConvergenceRootRow | undefined;
      if (!rootRow) return null;
      const leases = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE root_id = ? ORDER BY epoch, ordinal, issued_at`).all(rootId) as unknown as ConvergenceLeaseRow[];
      const outcomes = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE root_id = ? AND outcome_json IS NOT NULL ORDER BY epoch, ordinal`).all(rootId) as unknown as ConvergenceOutcomeRow[];
      const reviews = this.database.prepare(`SELECT review_json FROM convergence_reviews WHERE root_id = ? ORDER BY reviewed_at, review_id`).all(rootId) as unknown as ConvergenceReviewRow[];
      const links = this.database.prepare(`SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY epoch, ordinal`).all(rootId) as unknown as Array<{ run_id: string }>;
      return {
        root: JSON.parse(rootRow.root_json) as ConvergenceRootV1,
        proposals: leases.map((row) => JSON.parse(row.proposal_json) as AttemptProposalV1),
        leases: leases.map((row) => JSON.parse(row.lease_json) as AttemptLeaseV1),
        outcomes: outcomes.map((row) => JSON.parse(row.outcome_json) as AttemptOutcomeV1),
        reviews: reviews.map((row) => JSON.parse(row.review_json) as ConvergenceReviewV1),
        workflowRunIds: links.map((row) => row.run_id),
      };
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot read convergence state.", cause, { rootId });
    }
  }

  updateConvergenceRoot(root: ConvergenceRootV1, expectedRevision: number, review?: ConvergenceReviewV1): boolean {
    try {
      return this.transaction(() => {
        const current = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(root.rootId) as ConvergenceRootRow | undefined;
        if (!current || current.revision !== expectedRevision) return false;
        const previous = JSON.parse(current.root_json) as ConvergenceRootV1;
        const result = this.database.prepare(`
          UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
          WHERE root_id = ? AND revision = ?
        `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
        if (Number(result.changes) !== 1) return false;
        if (root.currentEpoch !== previous.currentEpoch) {
          this.database.prepare(`
            INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
            VALUES (?, ?, ?, ?)
          `).run(root.rootId, root.currentEpoch, root.frameDigest, root.updatedAt);
        }
        if (review) {
          this.database.prepare(`
            INSERT INTO convergence_reviews (review_id, root_id, epoch, review_json, reviewed_at)
            VALUES (?, ?, ?, ?, ?)
          `).run(review.reviewId, review.rootId, review.epoch, JSON.stringify(review), review.reviewedAt);
        }
        return true;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot update the convergence root.", cause, { rootId: root.rootId });
    }
  }

  insertAttemptLease(
    root: ConvergenceRootV1,
    expectedRevision: number,
    proposal: AttemptProposalV1,
    lease: AttemptLeaseV1,
  ): boolean {
    try {
      return this.transaction(() => {
        const result = this.database.prepare(`
          UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
          WHERE root_id = ? AND revision = ?
        `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
        if (Number(result.changes) !== 1) return false;
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
          lease.expiresAt,
        );
        return true;
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot claim the convergence attempt lease.", cause, { rootId: root.rootId });
    }
  }

  expireAttemptLease(leaseId: string): boolean {
    try {
      return this.transaction(() => {
        const row = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId) as ConvergenceLeaseRow | undefined;
        if (!row) return false;
        const lease = JSON.parse(row.lease_json) as AttemptLeaseV1;
        if (lease.state !== "issued") return false;
        lease.state = "expired";
        const result = this.database.prepare(`
          UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
        `).run(JSON.stringify(lease), leaseId);
        return Number(result.changes) === 1;
      });
    } catch (cause) {
      throw this.storageError("Cannot expire the convergence attempt lease.", cause, { leaseId });
    }
  }

  getAttemptLease(leaseId: string): Omit<GuardedRunBinding, "outcome"> | null {
    try {
      const row = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId) as ConvergenceLeaseRow | undefined;
      if (!row) return null;
      const lease = JSON.parse(row.lease_json) as AttemptLeaseV1;
      const proposal = JSON.parse(row.proposal_json) as AttemptProposalV1;
      const rootRow = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(lease.rootId) as ConvergenceRootRow | undefined;
      if (!rootRow) return null;
      return { root: JSON.parse(rootRow.root_json) as ConvergenceRootV1, proposal, lease };
    } catch (cause) {
      throw this.storageError("Cannot read the convergence attempt lease.", cause, { leaseId });
    }
  }

  insertGuardedRun(
    receipt: WorkflowReceiptV1,
    leaseId: string,
    expectedRootRevision: number,
    consumedAt: string,
  ): GuardedRunBinding | null {
    try {
      return this.transaction(() => {
        const leaseRow = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId) as ConvergenceLeaseRow | undefined;
        if (!leaseRow) return null;
        const lease = JSON.parse(leaseRow.lease_json) as AttemptLeaseV1;
        const proposal = JSON.parse(leaseRow.proposal_json) as AttemptProposalV1;
        if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision || Date.parse(lease.expiresAt) <= Date.parse(consumedAt)) return null;
        const rootRow = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(lease.rootId) as ConvergenceRootRow | undefined;
        if (!rootRow || rootRow.revision !== expectedRootRevision) return null;
        const root = JSON.parse(rootRow.root_json) as ConvergenceRootV1;
        lease.state = "consumed";
        const leaseUpdate = this.database.prepare(`
          UPDATE convergence_leases SET state = 'consumed', lease_json = ?
          WHERE lease_id = ? AND state = 'issued'
        `).run(JSON.stringify(lease), leaseId);
        if (Number(leaseUpdate.changes) !== 1) return null;
        root.revision += 1;
        root.updatedAt = consumedAt;
        const rootUpdate = this.database.prepare(`
          UPDATE convergence_roots SET revision = ?, root_json = ?, updated_at = ?
          WHERE root_id = ? AND revision = ?
        `).run(root.revision, JSON.stringify(root), root.updatedAt, root.rootId, expectedRootRevision);
        if (Number(rootUpdate.changes) !== 1) return null;
        this.database.prepare(`
          INSERT INTO workflow_runs (run_id, revision, receipt_json, updated_at) VALUES (?, ?, ?, ?)
        `).run(receipt.runId, receipt.revision, JSON.stringify(receipt), consumedAt);
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
      });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) throw cause;
      throw this.storageError("Cannot start the guarded workflow run.", cause, { leaseId });
    }
  }

  getGuardedRunBinding(runId: string): GuardedRunBinding | null {
    try {
      const link = this.database.prepare(`SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?`).get(runId) as WorkflowAttemptLinkRow | undefined;
      if (!link) return null;
      const rootRow = this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(link.root_id) as ConvergenceRootRow | undefined;
      const leaseRow = this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(link.lease_id) as ConvergenceLeaseRow | undefined;
      const outcomeRow = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE run_id = ?`).get(runId) as ConvergenceOutcomeRow | undefined;
      if (!rootRow || !leaseRow) return null;
      return {
        root: JSON.parse(rootRow.root_json) as ConvergenceRootV1,
        proposal: JSON.parse(leaseRow.proposal_json) as AttemptProposalV1,
        lease: JSON.parse(leaseRow.lease_json) as AttemptLeaseV1,
        outcome: outcomeRow?.outcome_json ? JSON.parse(outcomeRow.outcome_json) as AttemptOutcomeV1 : null,
      };
    } catch (cause) {
      throw this.storageError("Cannot read the guarded workflow binding.", cause, { runId });
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
        CREATE TABLE IF NOT EXISTS convergence_roots (
          root_id TEXT PRIMARY KEY,
          revision INTEGER NOT NULL CHECK (revision >= 0),
          state TEXT NOT NULL CHECK (state IN ('open', 'needs-review', 'needs-user', 'completed', 'abandoned')),
          workspace_id TEXT NOT NULL,
          root_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
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
