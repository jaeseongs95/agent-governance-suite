import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SharedModuleContext, SqlDatabase } from "../../runtime/unified-state/shared-connection.mjs";

import {
  CONTRACT_VERSION,
  type AttemptLeaseV1,
  type AttemptOutcomeV1,
  type AttemptProposalV1,
  type ConvergenceReviewV1,
  type ConvergenceRootV1,
  type StateCleanupPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";
import { msg, type MessageRef } from "./i18n.js";
import {
  mergePluginUpdateState,
  type PluginUpdateStore,
  type StoredPluginUpdateState,
} from "./plugin-update-store.js";
import { failureContext, failureReason, retainCleanupFailure, retainFailureCause } from "./failure-diagnostics.js";
import { compareStableVersionNumbers } from "./plugin-version.js";
import { externalInputs, stageUnverifiedClaims, unique } from "./unverified-claims.js";
import {
  activeRootIdentity,
  convergenceDigest,
  failureFingerprint,
  normalizeWorkspaceLocator,
  planRootInsertion,
  type IdentifiedRoot,
  type ReplacementMatch,
  type RootConflict,
  type StoredIdentity,
} from "./convergence-logic.js";
import { type RootIdentityV1 } from "./workspace-identity.js";
import {
  type CallAdmission,
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

type WorkflowCleanupCandidates = StateCleanupPlanV1["candidates"];

export interface WorkflowCleanupPreview {
  roots: WorkflowCleanupCandidates["workflowRoots"];
  standaloneRuns: WorkflowCleanupCandidates["standaloneWorkflowRuns"];
  protectedActiveRoots: number;
  rootProtection: Omit<NonNullable<StateCleanupPlanV1["rootProtection"]>, "previewCreatedAt">;
  linkedRuns: Array<{ rootId: string; runs: WorkflowCleanupCandidates["standaloneWorkflowRuns"] }>;
}

interface ConvergenceRootRow {
  root_json: string;
  revision: number;
}

interface ActiveRootRow extends ConvergenceRootRow {
  root_id: string;
  identity_json: string | null;
  surface_digest: string | null;
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

const SCHEMA_VERSION = 6;
/** Marks runs that v6 closed because they started under pre-3.0 gate rules. */
export const PRE_V6_BLOCKER = "pre-3.0-gate-contract";

export class SqliteWorkflowStore implements WorkflowStore, PluginUpdateStore {
  private readonly database: SqlDatabase;
  private readonly shared: SharedModuleContext | undefined;
  readonly databasePath: string;
  private closed = false;
  private transactionDepth = 0;

  constructor(input: string | SharedModuleContext) {
    this.shared = typeof input === "string" ? undefined : input;
    this.databasePath = typeof input === "string" ? input : input.databasePath;
    const databasePath = this.databasePath;
    if (this.shared) {
      this.database = this.shared.database;
      this.shared.initialize(() => this.initializeSchema());
      return;
    }
    if (!databasePath.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.store.workflowDatabasePathEmpty", {}));
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
      throw this.storageError(msg("workflow.store.initializeWorkflowDatabase", {}), cause);
    }
  }

  currentTimeMilliseconds(): number {
    // Read the native VFS UTC clock on both processes; Date.now can use process-local calibration.
    // This is wall time; the original strict proof timestamp comparisons still apply.
    return this.guard(msg("workflow.store.readWorkflowClock", {}), {}, () => {
      const row = this.database.prepare("SELECT CAST(round(unixepoch('subsec') * 1000) AS INTEGER) AS now_ms").get();
      const now = row?.now_ms;
      if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) {
        throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.store.workflowClockDidReturnValid", {}));
      }
      return now;
    });
  }

  getOrCreateSecret(name: string, create: () => string): string {
    return this.guard(msg("workflow.store.readCreateWorkflowMetadata", {}), { key: name }, () => this.transaction(() => {
      const existing = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = ?").get(name) as MetadataRow | undefined;
      if (existing) return existing.value;
      const value = create();
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES (?, ?, ?)
      `).run(name, value, new Date().toISOString());
      return value;
    }));
  }

  claimExecutionObservation(observationId: string, consumedAt: string): boolean {
    return this.guard(msg("workflow.store.claimTrustedExecutionObservation", {}), { observationId }, () => this.transaction(() => {
      // Claims never expire; the legacy expires_at column keeps an empty value.
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO execution_observation_claims(observation_id, expires_at, consumed_at)
        VALUES (?, '', ?)
      `).run(observationId, consumedAt);
      return Number(result.changes) === 1;
    }));
  }

  recordCallAdmission(admission: CallAdmission): void {
    this.guard(msg("workflow.store.recordHostCallAdmission", {}), {}, () => this.transaction(() => {
      const now = new Date(this.currentTimeMilliseconds());
      // ponytail: day-old unclaimed rows are pruned on the next write; no background sweeper.
      this.database.prepare("DELETE FROM call_admissions WHERE created_at < ?").run(new Date(now.getTime() - 86_400_000).toISOString());
      this.database.prepare(`
        INSERT OR REPLACE INTO call_admissions(host, call_id, admission_json, created_at) VALUES (?, ?, ?, ?)
      `).run(admission.host, admission.callId, JSON.stringify(admission), now.toISOString());
    }));
  }

  claimCallAdmission(host: string, callId: string): CallAdmission | null {
    return this.guard(msg("workflow.store.claimHostCallAdmission", {}), {}, () => this.transaction(() => {
      const row = this.database.prepare(`
        DELETE FROM call_admissions WHERE host = ? AND call_id = ? RETURNING admission_json
      `).get(host, callId) as { admission_json: string } | undefined;
      return row ? JSON.parse(row.admission_json) as CallAdmission : null;
    }));
  }

  claimLatestCallAdmission(host: string, callPrefix: string, callerPrefix: string): { admission: CallAdmission | null; callerRows: number } {
    return this.guard(msg("workflow.store.claimHostCallAdmission", {}), {}, () => this.transaction(() => {
      const under = "host = ? AND substr(call_id, 1, length(?)) = ?";
      const { count } = this.database.prepare(`SELECT count(*) AS count FROM call_admissions WHERE ${under}`)
        .get(host, callerPrefix, callerPrefix) as { count: number };
      const row = this.database.prepare(`SELECT admission_json FROM call_admissions WHERE ${under} ORDER BY created_at DESC, rowid DESC LIMIT 1`)
        .get(host, callPrefix, callPrefix) as { admission_json: string } | undefined;
      this.database.prepare(`DELETE FROM call_admissions WHERE ${under}`).run(host, callPrefix, callPrefix);
      return { admission: row ? JSON.parse(row.admission_json) as CallAdmission : null, callerRows: Number(count) };
    }));
  }

  nextRunSequence(): number {
    return this.guard(msg("workflow.store.reserveNextWorkflowRunSequence", {}), {}, () => this.transaction(() => {
      const row = this.database.prepare("SELECT value FROM workflow_metadata WHERE key = 'run-sequence'").get() as MetadataRow | undefined;
      const valid = !row || /^(0|[1-9][0-9]*)$/.test(row.value);
      const current = row && valid ? Number.parseInt(row.value, 10) : 0;
      if (!valid || !Number.isSafeInteger(current) || current < 0) {
        throw new WorkflowContractError("INTEGRITY_FAILED", msg("workflow.store.workflowRunSequenceInvalid", {}), { reason: "RUN_SEQUENCE_INVALID" });
      }
      const next = current + 1;
      if (!Number.isSafeInteger(next)) {
        throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.store.workflowRunSequenceExhausted", {}), { reason: "RUN_SEQUENCE_EXHAUSTED" });
      }
      this.database.prepare(`
        INSERT INTO workflow_metadata (key, value, updated_at)
        VALUES ('run-sequence', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `).run(String(next), new Date().toISOString());
      return next;
    }));
  }

  insertRun(receipt: WorkflowReceiptV1): void {
    const now = new Date().toISOString();
    this.guard(msg("workflow.store.persistWorkflowRun", {}), { runId: receipt.runId }, () => this.insertRunRow(receipt, now));
  }

  getRun(runId: string): WorkflowReceiptV1 | null {
    return this.guard(msg("workflow.store.readWorkflowRun", {}), { runId }, () => {
      const row = this.database.prepare(`
        SELECT revision, receipt_json
        FROM workflow_runs
        WHERE run_id = ?
      `).get(runId) as RunRow | undefined;
      if (!row) return null;
      const receipt = JSON.parse(row.receipt_json) as WorkflowReceiptV1;
      if (receipt.runId !== runId || receipt.revision !== row.revision) {
        throw new WorkflowContractError("INTEGRITY_FAILED", msg("workflow.store.storedWorkflowReceiptMetadataMatch", {}), {
          reason: "RECEIPT_METADATA_MISMATCH",
          runId,
          storedRevision: row.revision,
          receiptRunId: receipt.runId,
          receiptRevision: receipt.revision,
        });
      }
      return receipt;
    });
  }

  updateRun(
    receipt: WorkflowReceiptV1,
    expectedRevision: number,
    convergence?: { root: ConvergenceRootV1; expectedRootRevision: number; outcome: AttemptOutcomeV1 },
  ): boolean {
    return this.guard(msg("workflow.store.updateWorkflowRun", {}), { runId: receipt.runId }, () => this.transaction(() => {
      const result = this.database.prepare(`
        UPDATE workflow_runs
        SET revision = ?, state = ?, receipt_json = ?, updated_at = ?
        WHERE run_id = ? AND revision = ?
      `).run(
        receipt.revision,
        receipt.state,
        JSON.stringify(receipt),
        new Date().toISOString(),
        receipt.runId,
        expectedRevision,
      );
      if (Number(result.changes) !== 1) return false;
      if (!convergence) return true;
      if (!this.casRoot(convergence.root, convergence.expectedRootRevision)) throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.convergenceRootChangedWhileRecording", {}));
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
      if (Number(attemptUpdate.changes) !== 1) throw new WorkflowContractError("LEASE_CONFLICT", msg("workflow.store.guardedAttemptOutcomeRecordedMissing", {}), { runId: receipt.runId });
      return true;
    }));
  }

  insertConvergenceRoot(root: ConvergenceRootV1): RootConflict | null {
    return this.guard(msg("workflow.store.persistConvergenceRoot", {}), { rootId: root.rootId }, () => this.transaction(() => {
      const parentRow = root.parentRootId ? this.rootRow(root.parentRootId) : undefined;
      if (root.parentRootId && !parentRow) {
        throw new WorkflowContractError("INVALID_INPUT", msg("workflow.store.parentConvergenceRootFound", {}), { rootId: root.parentRootId });
      }
      const plan = planRootInsertion(root, this.readActiveRoots(root.createdAt));
      if (plan.conflict) return plan.conflict;
      if (parentRow) {
        const parent = JSON.parse(parentRow.root_json) as ConvergenceRootV1;
        parent.state = "abandoned";
        parent.revision += 1;
        parent.updatedAt = root.createdAt;
        this.casRoot(parent, parentRow.revision);
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
        root.updatedAt,
      );
      this.insertEpoch(root, root.createdAt);
      this.saveRootIdentity(root.rootId, plan.identity, plan.inferred, plan.surfaceDigest, plan.match, root.createdAt);
      return null;
    }));
  }

  activeRootIdentities(): IdentifiedRoot[] {
    return this.guard(msg("workflow.store.readConvergenceState", {}), {}, () => this.transaction(() => this.readActiveRoots(null), "BEGIN;"));
  }

  /**
   * Every active root with its identity; `persistAt` saves fresh identities (a root insert), null only reads (the edit
   * gate). ponytail: every active root is compared in process, on each insert and each gated edit (3.4.0 C9); index the
   * derived identity if a ledger ever holds thousands.
   */
  private readActiveRoots(persistAt: string | null): IdentifiedRoot[] {
    const rows = this.database.prepare(`
      SELECT roots.root_id, roots.root_json, roots.revision, identities.identity_json, identities.surface_digest
      FROM convergence_roots AS roots
      LEFT JOIN convergence_root_identities AS identities ON identities.root_id = roots.root_id
      WHERE roots.state NOT IN ('completed', 'abandoned')
    `).all() as unknown as ActiveRootRow[];
    return rows.map((row) => {
      const active = activeRootIdentity(
        JSON.parse(row.root_json) as ConvergenceRootV1,
        row.identity_json && row.surface_digest ? this.storedIdentity(row.identity_json, row.surface_digest) : null,
      );
      if (active.fresh && persistAt) this.saveRootIdentity(row.root_id, active.identity, active.inferred, active.surfaceDigest, null, persistAt);
      return active;
    });
  }

  getConvergenceSnapshot(rootId: string): ConvergenceSnapshot | null {
    return this.guard(msg("workflow.store.readConvergenceState", {}), { rootId },
      () => this.transaction(() => this.readConvergenceSnapshot(rootId), "BEGIN;"));
  }

  withWorkflowTransaction<T>(operation: () => T): T {
    let callbackFailed = false;
    try {
      return this.transaction(() => {
        try {
          const result = operation();
          if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
            throw new WorkflowContractError("INVALID_INPUT", msg("workflow.store.workflowTransactionCallbacksSynchronous", {}));
          }
          return result;
        } catch (cause) {
          callbackFailed = true;
          throw cause;
        }
      });
    } catch (cause) {
      if (callbackFailed || cause instanceof WorkflowContractError) throw cause;
      throw this.storageError(msg("workflow.store.executeWorkflowTransaction", {}), cause);
    }
  }

  private readConvergenceSnapshot(rootId: string): ConvergenceSnapshot | null {
    const rootRow = this.rootRow(rootId);
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
  }

  updateConvergenceRoot(root: ConvergenceRootV1, expectedRevision: number, review?: ConvergenceReviewV1): boolean {
    return this.guard(msg("workflow.store.updateConvergenceRoot", {}), { rootId: root.rootId }, () => this.transaction(() => {
      const current = this.rootRow(root.rootId);
      if (!current || current.revision !== expectedRevision) return false;
      const previous = JSON.parse(current.root_json) as ConvergenceRootV1;
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

  insertAttemptLease(
    root: ConvergenceRootV1,
    expectedRevision: number,
    proposal: AttemptProposalV1,
    lease: AttemptLeaseV1,
  ): boolean {
    return this.guard(msg("workflow.store.claimConvergenceAttemptLease", {}), { rootId: root.rootId }, () => this.transaction(() => {
      // No write before the CAS: transaction() commits whatever ran before a false return.
      if (!this.casRoot(root, expectedRevision)) return false;
      // Leases do not expire by time. A newer claim on the current root supersedes an unstarted one.
      const issued = this.database.prepare(`
        SELECT lease_id, lease_json FROM convergence_leases WHERE root_id = ? AND state = 'issued'
      `).all(root.rootId) as Array<{ lease_id: string; lease_json: string }>;
      for (const row of issued) {
        const superseded = JSON.parse(row.lease_json) as AttemptLeaseV1;
        superseded.state = "expired";
        this.database.prepare(`
          UPDATE convergence_leases SET state = 'expired', lease_json = ? WHERE lease_id = ? AND state = 'issued'
        `).run(JSON.stringify(superseded), row.lease_id);
      }
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
    }), msg("workflow.store.convergenceDatabaseBusyReadStatus", {}));
  }

  getAttemptLease(leaseId: string): Omit<GuardedRunBinding, "outcome"> | null {
    return this.guard(msg("workflow.store.readConvergenceAttemptLease", {}), { leaseId }, () => {
      const row = this.leaseRow(leaseId);
      if (!row) return null;
      const lease = JSON.parse(row.lease_json) as AttemptLeaseV1;
      const proposal = JSON.parse(row.proposal_json) as AttemptProposalV1;
      const rootRow = this.rootRow(lease.rootId);
      if (!rootRow) return null;
      return { root: JSON.parse(rootRow.root_json) as ConvergenceRootV1, proposal, lease };
    });
  }

  insertGuardedRun(
    receipt: WorkflowReceiptV1,
    leaseId: string,
    expectedRootRevision: number,
    consumedAt: string,
  ): GuardedRunBinding | null {
    return this.guard(msg("workflow.store.startGuardedWorkflowRun", {}), { leaseId }, () => this.transaction(() => {
      const leaseRow = this.leaseRow(leaseId);
      if (!leaseRow) return null;
      const lease = JSON.parse(leaseRow.lease_json) as AttemptLeaseV1;
      const proposal = JSON.parse(leaseRow.proposal_json) as AttemptProposalV1;
      if (lease.state !== "issued" || lease.rootRevision !== expectedRootRevision) return null;
      const rootRow = this.rootRow(lease.rootId);
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
    }), msg("workflow.store.convergenceDatabaseBusyLeaseConsumed", {}));
  }

  getGuardedRunBinding(runId: string): GuardedRunBinding | null {
    return this.guard(msg("workflow.store.readGuardedWorkflowBinding", {}), { runId }, () => {
      const link = this.database.prepare(`SELECT root_id, lease_id FROM workflow_attempt_links WHERE run_id = ?`).get(runId) as WorkflowAttemptLinkRow | undefined;
      if (!link) return null;
      const rootRow = this.rootRow(link.root_id);
      const leaseRow = this.leaseRow(link.lease_id);
      const outcomeRow = this.database.prepare(`SELECT outcome_json FROM convergence_attempts WHERE run_id = ?`).get(runId) as ConvergenceOutcomeRow | undefined;
      if (!rootRow || !leaseRow) return null;
      return {
        root: JSON.parse(rootRow.root_json) as ConvergenceRootV1,
        proposal: JSON.parse(leaseRow.proposal_json) as AttemptProposalV1,
        lease: JSON.parse(leaseRow.lease_json) as AttemptLeaseV1,
        outcome: outcomeRow?.outcome_json ? JSON.parse(outcomeRow.outcome_json) as AttemptOutcomeV1 : null,
      };
    });
  }

  getPluginUpdateState(targetId: string): StoredPluginUpdateState | null {
    return this.guard(msg("workflow.store.readPluginUpdateState", {}), { targetId }, () => this.readPluginUpdateStateRow(targetId));
  }

  putPluginUpdateState(state: StoredPluginUpdateState): void {
    this.guard(msg("workflow.store.persistPluginUpdateState", {}), { targetId: state.targetId }, () => this.transaction(() => {
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
    }));
  }

  claimPluginUpdateNotice(targetId: string, latestVersion: string, notifiedAt: string): boolean {
    return this.guard(msg("workflow.store.claimPluginUpdateNotice", {}), { targetId, latestVersion }, () => this.transaction(() => {
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
    }));
  }

  getSchemaVersion(): number {
    return this.shared?.getSchemaVersion() ?? (this.database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  }

  isConvergenceRootActive(rootId: string): boolean {
    const row = this.database.prepare(`
      SELECT 1 AS active FROM convergence_roots
      WHERE root_id = ? AND state IN ('open', 'needs-review', 'needs-user')
    `).get(rootId) as { active: number } | undefined;
    return Boolean(row);
  }

  withInactiveRootGuard<T>(rootIds: string[], operation: () => T): T {
    return this.transaction(() => {
      const readState = this.database.prepare("SELECT state FROM convergence_roots WHERE root_id = ?");
      for (const rootId of [...new Set(rootIds)].sort()) {
        const row = readState.get(rootId) as { state: string } | undefined;
        if (row && ["open", "needs-review", "needs-user"].includes(row.state)) {
          throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.continuityCleanupRootBecameActive", {}), { rootId });
        }
      }
      return operation();
    });
  }

  previewCleanup(cutoff: string): WorkflowCleanupPreview {
    return this.guard(msg("workflow.store.previewWorkflowStateCleanup", {}), {}, () => this.transaction(() => {
    const roots = this.database.prepare(`
      SELECT root_id, revision, state, updated_at
      FROM convergence_roots
      WHERE state IN ('completed', 'abandoned') AND updated_at <= ?
      ORDER BY root_id
    `).all(cutoff) as unknown as Array<{ root_id: string; revision: number; state: string; updated_at: string }>;
    const linkedRuns = this.database.prepare(`
      SELECT links.run_id, runs.revision, runs.state, runs.updated_at
      FROM workflow_attempt_links links LEFT JOIN workflow_runs runs ON runs.run_id = links.run_id
      WHERE links.root_id = ? ORDER BY links.run_id
    `);
    const linkedSnapshots: WorkflowCleanupPreview["linkedRuns"] = [];
    const rootCandidates: WorkflowCleanupPreview["roots"] = [];
    let linkedNonTerminalRoots = 0;
    let linkedRecentRoots = 0;
    let linkedMissingReceiptRoots = 0;
    let protectedLinkedRoots = 0;
    for (const root of roots) {
      const rows = linkedRuns.all(root.root_id) as unknown as Array<{ run_id: string; revision: number | null; state: string | null; updated_at: string | null }>;
      // A terminal root cannot authorize deletion of an active, recent or missing linked receipt.
      const reasons = new Set<"missing" | "non-terminal" | "recent">();
      for (const row of rows) {
        if (row.revision === null || row.state === null || row.updated_at === null) {
          reasons.add("missing");
          continue;
        }
        if (!["failed", "passed", "blocked"].includes(row.state)) reasons.add("non-terminal");
        if (row.updated_at > cutoff) reasons.add("recent");
      }
      if (reasons.size > 0) {
        if (reasons.has("non-terminal")) linkedNonTerminalRoots++;
        if (reasons.has("recent")) linkedRecentRoots++;
        if (reasons.has("missing")) linkedMissingReceiptRoots++;
        protectedLinkedRoots++;
        continue;
      }
      const runs = rows.map(row => ({ runId: row.run_id, revision: row.revision!, state: row.state!, updatedAt: row.updated_at! }));
      rootCandidates.push({ rootId: root.root_id, revision: root.revision, state: root.state,
        updatedAt: root.updated_at, runIds: runs.map(run => run.runId) });
      linkedSnapshots.push({ rootId: root.root_id, runs });
    }
    const runs = this.database.prepare(`
      SELECT run_id, revision, state, updated_at
      FROM workflow_runs
      WHERE state IN ('failed', 'passed', 'blocked')
        AND updated_at <= ?
        AND NOT EXISTS (SELECT 1 FROM workflow_attempt_links links WHERE links.run_id = workflow_runs.run_id)
      ORDER BY run_id
    `).all(cutoff) as unknown as Array<{ run_id: string; revision: number; state: string; updated_at: string }>;
    const protectedRow = this.database.prepare(`
      SELECT COUNT(*) AS count FROM convergence_roots
      WHERE state IN ('open', 'needs-review', 'needs-user')
    `).get() as { count: number };
    return {
      roots: rootCandidates,
      standaloneRuns: runs.map((run) => ({
        runId: run.run_id,
        revision: run.revision,
        state: run.state,
        updatedAt: run.updated_at,
      })),
      protectedActiveRoots: protectedRow.count,
      rootProtection: {
        activeRoots: protectedRow.count, linkedNonTerminalRoots, linkedRecentRoots, linkedMissingReceiptRoots,
        totalProtectedRoots: protectedRow.count + protectedLinkedRoots,
      },
      linkedRuns: linkedSnapshots,
    };
    }));
  }

  claimCleanupPlan(planId: string, planDigest: string, claimedAt: string): boolean {
    return this.guard(msg("workflow.store.claimStateCleanupPlan", {}), { planId }, () => {
      const result = this.database.prepare(`
        INSERT OR IGNORE INTO state_cleanup_claims(plan_id, plan_digest, claimed_at)
        VALUES (?, ?, ?)
      `).run(planId, planDigest, claimedAt);
      return Number(result.changes) === 1;
    });
  }

  backupTo(targetPath: string): void {
    if (this.shared) throw new Error("SHARED_BACKUP_OWNER_REQUIRED: a shared database backup requires an explicit owner contract.");
    if (this.databasePath === ":memory:") {
      throw new WorkflowContractError("INVALID_INPUT", msg("workflow.store.memoryWorkflowDatabaseCleanedDestructively", {}));
    }
    this.guard(msg("workflow.store.createVerifiedWorkflowCleanupBackup", {}), { targetPath }, () => {
      this.database.prepare("VACUUM INTO ?").run(targetPath);
      const backup = new DatabaseSync(targetPath, { readOnly: true });
      try {
        const result = backup.prepare("PRAGMA integrity_check").get() as { integrity_check: string };
        if (result.integrity_check !== "ok") throw new Error(`integrity_check returned ${result.integrity_check}`);
      } finally {
        backup.close();
      }
    });
  }

  executeCleanup(preview: WorkflowCleanupPreview): { roots: number; runs: number } {
    return this.guard(msg("workflow.store.executeWorkflowStateCleanup", {}), {}, () => this.transaction(() => {
      const verifyRoot = this.database.prepare(`
        SELECT state, revision, updated_at FROM convergence_roots WHERE root_id = ?
      `);
      const verifyRun = this.database.prepare(`
        SELECT state, revision, updated_at FROM workflow_runs WHERE run_id = ?
      `);
      for (const root of preview.roots) {
        const row = verifyRoot.get(root.rootId) as { state: string; revision: number; updated_at: string } | undefined;
        if (!row || row.state !== root.state || row.revision !== root.revision || row.updated_at !== root.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.cleanupRootChangedAfterPreview", {}), { rootId: root.rootId });
        }
        const actualRunIds = (this.database.prepare(`
          SELECT run_id FROM workflow_attempt_links WHERE root_id = ? ORDER BY run_id
        `).all(root.rootId) as unknown as Array<{ run_id: string }>).map((item) => item.run_id);
        if (JSON.stringify(actualRunIds) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.cleanupRootLinkedRunsChanged", {}), { rootId: root.rootId });
        }
        const expected = preview.linkedRuns.find(item => item.rootId === root.rootId);
        if (!expected || JSON.stringify(expected.runs.map(run => run.runId)) !== JSON.stringify(root.runIds)) {
          throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.cleanupRootLinkedReceiptMissing", {}), { rootId: root.rootId });
        }
        for (const run of expected.runs) {
          const row = verifyRun.get(run.runId) as { state: string; revision: number; updated_at: string } | undefined;
          if (!row || row.state !== run.state || row.revision !== run.revision || row.updated_at !== run.updatedAt) {
            throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.cleanupLinkedWorkflowRunChanged", {}), { rootId: root.rootId, runId: run.runId });
          }
        }
      }
      for (const run of preview.standaloneRuns) {
        const row = verifyRun.get(run.runId) as { state: string; revision: number; updated_at: string } | undefined;
        if (!row || row.state !== run.state || row.revision !== run.revision || row.updated_at !== run.updatedAt) {
          throw new WorkflowContractError("STALE_REVISION", msg("workflow.store.cleanupWorkflowRunChangedAfter", {}), { runId: run.runId });
        }
      }

      const deleteLinks = this.database.prepare("DELETE FROM workflow_attempt_links WHERE root_id = ?");
      const deleteAttempts = this.database.prepare("DELETE FROM convergence_attempts WHERE root_id = ?");
      const deleteReviews = this.database.prepare("DELETE FROM convergence_reviews WHERE root_id = ?");
      const deleteLeases = this.database.prepare("DELETE FROM convergence_leases WHERE root_id = ?");
      const deleteEpochs = this.database.prepare("DELETE FROM convergence_epochs WHERE root_id = ?");
      const deleteIdentity = this.database.prepare("DELETE FROM convergence_root_identities WHERE root_id = ?");
      const deleteRoot = this.database.prepare("DELETE FROM convergence_roots WHERE root_id = ?");
      const deleteRun = this.database.prepare("DELETE FROM workflow_runs WHERE run_id = ?");
      let deletedRuns = 0;
      for (const root of preview.roots) {
        deleteLinks.run(root.rootId);
        deleteAttempts.run(root.rootId);
        deleteReviews.run(root.rootId);
        deleteLeases.run(root.rootId);
        deleteEpochs.run(root.rootId);
        deleteIdentity.run(root.rootId);
        deleteRoot.run(root.rootId);
        for (const runId of root.runIds) {
          deletedRuns += Number(deleteRun.run(runId).changes);
        }
      }
      for (const run of preview.standaloneRuns) deletedRuns += Number(deleteRun.run(run.runId).changes);
      return { roots: preview.roots.length, runs: deletedRuns };
    }));
  }

  close(): void {
    if (this.closed) return;
    this.database.close();
    this.closed = true;
  }

  private initializeSchema(): void {
    this.transaction(() => {
      // Read the migration version only after the writer lock is acquired.
      const row = { user_version: this.getSchemaVersion() };
      if (row.user_version > SCHEMA_VERSION) {
        throw new WorkflowContractError("MCP_UNAVAILABLE", msg("workflow.store.workflowDatabaseSchemaNewerThan", {}), {
          reason: "SCHEMA_NEWER",
          supportedVersion: SCHEMA_VERSION,
          actualVersion: row.user_version,
        });
      }
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
        CREATE TABLE IF NOT EXISTS convergence_root_identities (
          root_id TEXT PRIMARY KEY,
          identity_json TEXT NOT NULL,
          surface_digest TEXT NOT NULL,
          replacement_match TEXT CHECK (replacement_match IS NULL OR replacement_match IN ('physical', 'lineage', 'legacy-locator')),
          created_at TEXT NOT NULL
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
        CREATE TABLE IF NOT EXISTS call_admissions (
          host TEXT NOT NULL,
          call_id TEXT NOT NULL,
          admission_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (host, call_id)
        ) STRICT;

      `);
      if (row.user_version > 0 && row.user_version < 6) this.migrateToV6();
      if (this.shared) this.shared.setSchemaVersion(SCHEMA_VERSION);
      else this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    });
  }

  /**
   * v6 (AGS 3.0 gates): caller declarations stop counting as verification. Rewrites stored JSON in place and
   * deletes nothing. Runs that were still open under declared-equals-verified rules close as blocked, and their
   * guarded attempts close as aborted so the convergence root can continue.
   */
  private migrateToV6(): void {
    const now = new Date().toISOString();
    for (const row of this.database.prepare(`SELECT lease_id, lease_json, proposal_json FROM convergence_leases`).all() as unknown as Array<ConvergenceLeaseRow & { lease_id: string }>) {
      const proposal = JSON.parse(row.proposal_json) as AttemptProposalV1 & { actorId?: unknown };
      const lease = JSON.parse(row.lease_json) as AttemptLeaseV1;
      delete proposal.actorId;
      // Pre-v6 actor IDs and evidence were declared by the caller, never observed.
      lease.actorId = null;
      lease.priorEvidenceDigests = [];
      lease.proposalDigest = convergenceDigest(proposal);
      this.database.prepare(`UPDATE convergence_leases SET lease_json = ?, proposal_json = ? WHERE lease_id = ?`)
        .run(JSON.stringify(lease), JSON.stringify(proposal), row.lease_id);
    }
    for (const row of this.database.prepare(`SELECT review_id, review_json FROM convergence_reviews`).all() as unknown as Array<ConvergenceReviewRow & { review_id: string }>) {
      const review = JSON.parse(row.review_json) as ConvergenceReviewV1 & { implementationActorIds?: unknown };
      delete review.implementationActorIds;
      this.database.prepare(`UPDATE convergence_reviews SET review_json = ? WHERE review_id = ?`).run(JSON.stringify(review), row.review_id);
    }
    for (const row of this.database.prepare(`SELECT root_id, root_json FROM convergence_roots`).all() as unknown as Array<{ root_id: string; root_json: string }>) {
      const root = JSON.parse(row.root_json) as ConvergenceRootV1;
      if (!root.retryRejections?.some((item) => item.actorId !== undefined)) continue;
      for (const item of root.retryRejections) delete item.actorId;
      this.database.prepare(`UPDATE convergence_roots SET root_json = ? WHERE root_id = ?`).run(JSON.stringify(root), row.root_id);
    }
    for (const row of this.database.prepare(`SELECT run_id, receipt_json FROM workflow_runs`).all() as unknown as Array<{ run_id: string; receipt_json: string }>) {
      const receipt = JSON.parse(row.receipt_json) as WorkflowReceiptV1;
      // A row too old to carry a receipt shape is left as stored; reading it reports its own contract error.
      if (!receipt.plan || !Array.isArray(receipt.stageResults)) continue;
      receipt.unverifiedClaims = unique(receipt.stageResults.flatMap((result) => {
        const stage = receipt.plan.stages.find((item) => item.stageId === result.stageId);
        return stage ? stageUnverifiedClaims(stage, result, false, externalInputs(receipt.plan, stage)) : [];
      }));
      const open = !["passed", "failed", "blocked"].includes(receipt.state);
      if (open) {
        receipt.state = "blocked";
        receipt.plan.state = "blocked";
        receipt.plan.currentStageId = null;
        receipt.plan.nextStageId = null;
        for (const list of [receipt.blockers, receipt.unresolved]) {
          if (!list.includes(PRE_V6_BLOCKER)) list.push(PRE_V6_BLOCKER);
        }
        receipt.error = null;
        receipt.revision += 1;
      }
      this.database.prepare(`UPDATE workflow_runs SET revision = ?, state = ?, receipt_json = ?, updated_at = ? WHERE run_id = ?`)
        .run(receipt.revision, receipt.state, JSON.stringify(receipt), open ? now : this.runUpdatedAt(row.run_id), row.run_id);
      if (open) this.closePreV6Attempt(receipt, now);
    }
  }

  private runUpdatedAt(runId: string): string {
    return (this.database.prepare(`SELECT updated_at FROM workflow_runs WHERE run_id = ?`).get(runId) as { updated_at: string }).updated_at;
  }

  /** Closes the guarded attempt of a run v6 blocked, the way abort_workflow would. */
  private closePreV6Attempt(receipt: WorkflowReceiptV1, recordedAt: string): void {
    const attempt = this.database.prepare(`
      SELECT root_id, lease_id, epoch, ordinal FROM convergence_attempts WHERE run_id = ? AND outcome_json IS NULL
    `).get(receipt.runId) as { root_id: string; lease_id: string; epoch: number; ordinal: number } | undefined;
    if (!attempt) return;
    const rootRow = this.rootRow(attempt.root_id);
    if (!rootRow) return;
    const root = JSON.parse(rootRow.root_json) as ConvergenceRootV1;
    root.revision += 1;
    root.updatedAt = recordedAt;
    const used = Number((this.database.prepare(`
      SELECT COUNT(*) AS used FROM convergence_leases WHERE root_id = ? AND epoch = ? AND state = 'consumed'
    `).get(root.rootId, root.currentEpoch) as { used: number }).used);
    if (root.state === "open" && used >= root.frame.operationalSettings.maxAttemptsPerEpoch) root.state = "needs-review";
    const outcome: AttemptOutcomeV1 = {
      schemaVersion: CONTRACT_VERSION,
      outcomeId: `outcome-${randomUUID()}`,
      rootId: root.rootId,
      rootRevision: root.revision,
      leaseId: attempt.lease_id,
      epoch: attempt.epoch,
      ordinal: attempt.ordinal,
      workflowRunId: receipt.runId,
      state: "aborted",
      receiptDigest: convergenceDigest(receipt),
      failureFingerprint: failureFingerprint(receipt),
      evidenceRefs: [],
      recordedAt,
    };
    this.database.prepare(`UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ? WHERE root_id = ?`)
      .run(root.revision, root.state, JSON.stringify(root), recordedAt, root.rootId);
    this.database.prepare(`UPDATE convergence_attempts SET state = 'aborted', outcome_json = ?, updated_at = ? WHERE run_id = ?`)
      .run(JSON.stringify(outcome), recordedAt, receipt.runId);
  }

  private rootRow(rootId: string): ConvergenceRootRow | undefined {
    return this.database.prepare(`SELECT root_json, revision FROM convergence_roots WHERE root_id = ?`).get(rootId) as ConvergenceRootRow | undefined;
  }

  private leaseRow(leaseId: string): ConvergenceLeaseRow | undefined {
    return this.database.prepare(`SELECT lease_json, proposal_json FROM convergence_leases WHERE lease_id = ?`).get(leaseId) as ConvergenceLeaseRow | undefined;
  }

  /** Writes the root only if it is still at expectedRevision; true when exactly one row changed. */
  private casRoot(root: ConvergenceRootV1, expectedRevision: number): boolean {
    const result = this.database.prepare(`
      UPDATE convergence_roots SET revision = ?, state = ?, root_json = ?, updated_at = ?
      WHERE root_id = ? AND revision = ?
    `).run(root.revision, root.state, JSON.stringify(root), root.updatedAt, root.rootId, expectedRevision);
    return Number(result.changes) === 1;
  }

  /**
   * Derived from root_json, which is never rewritten. No foreign key and no schema version bump:
   * a server without this table keeps opening and cleaning the same database, and rows it
   * leaves behind are recomputed or ignored. A refreshed identity replaces the stored one; how
   * the root was bound to its parent is kept.
   */
  private saveRootIdentity(
    rootId: string,
    identity: RootIdentityV1,
    inferred: boolean[],
    surfaceDigest: string,
    match: ReplacementMatch | null,
    createdAt: string,
  ): void {
    this.database.prepare(`
      INSERT INTO convergence_root_identities (root_id, identity_json, surface_digest, replacement_match, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_id) DO UPDATE SET identity_json = excluded.identity_json, surface_digest = excluded.surface_digest
    `).run(rootId, JSON.stringify({ ...identity, inferred }), surfaceDigest, match, createdAt);
  }

  /** `inferred` travels inside identity_json; rows written without it hold observed surfaces only. */
  private storedIdentity(identityJson: string, surfaceDigest: string): StoredIdentity {
    const { inferred = [], ...identity } = JSON.parse(identityJson) as RootIdentityV1 & { inferred?: boolean[] };
    return { identity, surfaceDigest, inferred };
  }

  private insertEpoch(root: ConvergenceRootV1, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO convergence_epochs (root_id, epoch, frame_digest, created_at)
      VALUES (?, ?, ?, ?)
    `).run(root.rootId, root.currentEpoch, root.frameDigest, createdAt);
  }

  private insertRunRow(receipt: WorkflowReceiptV1, createdAt: string): void {
    this.database.prepare(`
      INSERT INTO workflow_runs (run_id, revision, state, receipt_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(receipt.runId, receipt.revision, receipt.state, JSON.stringify(receipt), createdAt, createdAt);
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

  /** Writers take the lock up front with BEGIN IMMEDIATE; snapshot reads pass "BEGIN;". */
  private transaction<T>(operation: () => T, begin = "BEGIN IMMEDIATE;"): T {
    if (this.shared) return this.shared.transaction(operation);
    const savepoint = this.transactionDepth > 0 ? `workflow_nested_${this.transactionDepth}` : null;
    this.database.exec(savepoint ? `SAVEPOINT ${savepoint};` : begin);
    this.transactionDepth += 1;
    try {
      const result = operation();
      this.database.exec(savepoint ? `RELEASE ${savepoint};` : "COMMIT;");
      return result;
    } catch (cause) {
      // The original failure wins; a failed ROLLBACK is kept only as a tagged secondary diagnostic.
      retainCleanupFailure(cause, "WORKFLOW_ROLLBACK_FAILED",
        () => this.database.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint};` : "ROLLBACK;"));
      throw cause;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  /**
   * Keeps contract errors as they are and wraps any other failure as a storage
   * error; with contentionMessage, a busy database or a duplicate issued lease
   * becomes LEASE_CONFLICT instead.
   */
  private guard<T>(message: MessageRef, details: Record<string, unknown>, operation: () => T, contentionMessage?: MessageRef): T {
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

  private isLeaseContention(cause: unknown): boolean {
    const message = cause instanceof Error ? cause.message : String(cause);
    return /database is locked|SQLITE_BUSY|UNIQUE constraint failed: convergence_leases/iu.test(message);
  }

  /**
   * A storage or driver failure means the workflow persistence layer is unavailable, never that the
   * caller's input was invalid. A contract error raised inside the failed step keeps its own code and
   * reason. Details carry a fixed-vocabulary reason, a redacted cause and the SQLite result code, never
   * the database path or the driver message; the actual error stays a private cause link.
   */
  private storageError(message: MessageRef, cause: unknown, details: Record<string, unknown> = {}): WorkflowContractError {
    const errcode = typeof cause === "object" && cause !== null ? (cause as { errcode?: unknown }).errcode : undefined;
    const ownReason = cause instanceof WorkflowContractError ? cause.details?.reason : undefined;
    return retainFailureCause(new WorkflowContractError(cause instanceof WorkflowContractError ? cause.code : "MCP_UNAVAILABLE", message, {
      ...details,
      reason: typeof ownReason === "string" ? ownReason : failureReason(cause).reason ?? "WORKFLOW_STORAGE_FAILED",
      cause: failureContext(cause),
      ...(typeof errcode === "number" ? { sqliteErrcode: errcode } : {}),
    }), cause);
  }
}
