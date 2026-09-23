import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { projectSnapshotCoverageV1, type CoverageProjectionInputV1,
  type CoverageProjectionV1 } from "./coverage-projection.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

type WindowRow = { account_scope: string; pool_id: string; window_id: string;
  observation_id: string; reset_epoch: number; revision: number; unit: string;
  remaining: number | null };
type ProjectionRow = { observation_id: string; ledger_digest: string; generation: number;
  source_digest: string; projection_digest: string; projection_json: string };
export type ReconciliationRevisionV1 = {
  accountScope: string; poolId: string; windowId: string; observationId: string;
  resetEpoch: number; revision: number; ledgerDigest: string; generation: number;
};
export type VerifiedReconciliationEvidenceV1 = {
  observationId: string; revision: number; input: CoverageProjectionInputV1;
};

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function invalid(message: string): never {
  throw new WorkflowContractError("INVALID_INPUT", message);
}
function conflict(message: string): never {
  throw new WorkflowContractError("REQUEST_CONFLICT", message);
}
function corrupt(message: string): never {
  throw new WorkflowContractError("INTEGRITY_FAILED", message);
}

/** The verifier admits producer evidence; this store only binds its pure projection to ledger revisions. */
export class ResourceUsageReconciliationStore {
  constructor(private readonly database: DatabaseSync, authority: ResourceAuthorityConfig,
    private readonly verifyEvidence: (opaque: unknown) => VerifiedReconciliationEvidenceV1 | null) {
    initializeResourceStoreSchema(database, authority);
    database.exec(`CREATE TABLE IF NOT EXISTS resource_usage_reconciliation (
      account_scope TEXT NOT NULL, pool_id TEXT NOT NULL, window_id TEXT NOT NULL,
      observation_id TEXT NOT NULL, ledger_digest TEXT NOT NULL,
      generation INTEGER NOT NULL CHECK (generation > 0), source_digest TEXT NOT NULL,
      projection_digest TEXT NOT NULL, projection_json TEXT NOT NULL,
      PRIMARY KEY (account_scope,pool_id,window_id),
      FOREIGN KEY (account_scope,pool_id,window_id)
        REFERENCES resource_window_observations(account_scope,pool_id,window_id)
    ) STRICT;`);
    database.exec(`CREATE TABLE IF NOT EXISTS resource_reconciliation_corrections (
      event_id TEXT PRIMARY KEY, event_digest TEXT NOT NULL
    ) STRICT;`);
  }

  capture(accountScope: string, poolId: string, windowId: string): ReconciliationRevisionV1 | null {
    this.database.exec("BEGIN;");
    try {
      const revision = this.current(accountScope, poolId, windowId);
      this.database.exec("COMMIT;");
      return revision;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  apply(expected: ReconciliationRevisionV1, opaqueEvidence: unknown):
    { kind: "applied" | "duplicate" | "stale"; projection: CoverageProjectionV1 | null } {
    const evidence = this.verifyEvidence(opaqueEvidence);
    if (!evidence || typeof evidence !== "object"
      || !/^sha256:[a-f0-9]{64}$/u.test(evidence.observationId)
      || !Number.isSafeInteger(evidence.revision) || evidence.revision < 0) {
      invalid("Reconciliation evidence was not admitted by its owner.");
    }
    const projection = projectSnapshotCoverageV1(evidence.input);
    const sourceDigest = digest(canonicalJson(evidence));
    const projectionJson = canonicalJson(projection);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.current(expected.accountScope, expected.poolId, expected.windowId);
      if (!current || current.observationId !== expected.observationId
        || current.resetEpoch !== expected.resetEpoch || current.revision !== expected.revision
        || current.ledgerDigest !== expected.ledgerDigest
        || evidence.observationId !== current.observationId
        || evidence.revision !== current.revision) {
        this.database.exec("COMMIT;");
        return { kind: "stale", projection: null };
      }
      const row = this.projectionRow(expected.accountScope, expected.poolId, expected.windowId);
      this.assertObservationMatches(current, evidence.input);
      if (row && row.observation_id === current.observationId
        && row.ledger_digest === current.ledgerDigest
        && row.source_digest === sourceDigest && row.projection_json === projectionJson) {
        this.database.exec("COMMIT;");
        return { kind: "duplicate", projection };
      }
      if (current.generation !== expected.generation) {
        this.database.exec("COMMIT;");
        return { kind: "stale", projection: null };
      }
      this.database.prepare(`INSERT INTO resource_usage_reconciliation
        (account_scope,pool_id,window_id,observation_id,ledger_digest,generation,
          source_digest,projection_digest,projection_json) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_scope,pool_id,window_id) DO UPDATE SET
          observation_id=excluded.observation_id, ledger_digest=excluded.ledger_digest,
          generation=excluded.generation, source_digest=excluded.source_digest,
          projection_digest=excluded.projection_digest,
          projection_json=excluded.projection_json`).run(expected.accountScope, expected.poolId,
        expected.windowId, current.observationId, current.ledgerDigest,
        current.generation + 1, sourceDigest, digest(projectionJson), projectionJson);
      this.bindEvents(evidence.input);
      this.database.exec("COMMIT;");
      return { kind: "applied", projection };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  readCurrent(accountScope: string, poolId: string, windowId: string): CoverageProjectionV1 | null {
    this.database.exec("BEGIN;");
    try {
      const current = this.current(accountScope, poolId, windowId);
      const row = this.projectionRow(accountScope, poolId, windowId);
      const result = current && row && row.observation_id === current.observationId
        && row.ledger_digest === current.ledgerDigest
        ? JSON.parse(row.projection_json) as CoverageProjectionV1 : null;
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve original error. */ }
      throw error;
    }
  }

  private current(accountScope: string, poolId: string, windowId: string): ReconciliationRevisionV1 | null {
    const row = this.database.prepare(`SELECT * FROM resource_window_observations
      WHERE account_scope=? AND pool_id=? AND window_id=?`).get(accountScope, poolId, windowId) as
      WindowRow | undefined;
    if (!row) return null;
    if (!this.windowEvidence(row)) return null;
    const holds = this.database.prepare(`SELECT h.reservation_id,h.reset_epoch,h.amount,h.unit,r.state
      FROM resource_reservation_holds h JOIN resource_reservations r USING(reservation_id)
      WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=? ORDER BY h.reservation_id`)
      .all(accountScope, poolId, windowId);
    const events = this.database.prepare(`SELECT *
      FROM resource_usage_events WHERE account_scope=? AND pool_id=? AND window_id=?
      ORDER BY event_id,reservation_id`).all(accountScope, poolId, windowId);
    const coverage = this.database.prepare(`SELECT reservation_id,coverage,observed_amount,unit,updated_at
      FROM resource_usage_coverage WHERE account_scope=? AND pool_id=? AND window_id=?
      ORDER BY reservation_id`).all(accountScope, poolId, windowId);
    const terminals = this.database.prepare(`SELECT t.*
      FROM resource_terminal_evidence t JOIN resource_reservation_holds h
        ON h.reservation_id=t.reservation_id
      WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=?
      ORDER BY t.evidence_id`).all(accountScope, poolId, windowId);
    const projection = this.projectionRow(accountScope, poolId, windowId);
    return { accountScope, poolId, windowId, observationId: row.observation_id,
      resetEpoch: row.reset_epoch, revision: row.revision,
      ledgerDigest: digest(canonicalJson({ holds, events, coverage, terminals })),
      generation: projection?.generation ?? 0 };
  }

  private projectionRow(accountScope: string, poolId: string, windowId: string): ProjectionRow | undefined {
    const row = this.database.prepare(`SELECT observation_id,ledger_digest,generation,
      source_digest,projection_digest,projection_json FROM resource_usage_reconciliation
      WHERE account_scope=? AND pool_id=? AND window_id=?`).get(accountScope, poolId, windowId) as
      ProjectionRow | undefined;
    if (row && (digest(row.projection_json) !== row.projection_digest
      || !Number.isSafeInteger(row.generation) || row.generation < 1)) {
      corrupt("Stored reconciliation projection is corrupt.");
    }
    return row;
  }

  private assertObservationMatches(current: ReconciliationRevisionV1,
    proof: CoverageProjectionInputV1): void {
    const row = this.database.prepare(`SELECT * FROM resource_window_observations
      WHERE account_scope=? AND pool_id=? AND window_id=?`).get(
      current.accountScope, current.poolId, current.windowId) as WindowRow | undefined;
    if (!row) corrupt("Current window is missing.");
    const window = this.windowEvidence(row);
    if (!window) invalid("Coverage proof refers to a removed window.");
    const snapshot = proof.snapshot;
    if (snapshot.accountScope !== current.accountScope || snapshot.poolId !== current.poolId
      || snapshot.windowId !== current.windowId || snapshot.resetEpoch !== current.resetEpoch
      || snapshot.unit !== row.unit || snapshot.metricKind !== "remaining"
      || snapshot.observedAmount !== row.remaining || snapshot.coverage !== window.coverage) {
      invalid("Coverage proof does not match the current observation.");
    }
  }

  private windowEvidence(row: WindowRow): { coverage: string } | null {
    const observation = this.database.prepare(`SELECT payload_json,payload_digest
      FROM resource_observations WHERE observation_id=? AND account_scope=? AND pool_id=?`).get(
      row.observation_id, row.account_scope, row.pool_id) as
      { payload_json: string; payload_digest: string } | undefined;
    if (!observation || digest(observation.payload_json) !== observation.payload_digest
      || observation.payload_digest !== row.observation_id) {
      corrupt("Current observation is missing or corrupt.");
    }
    let response: Record<string, unknown>;
    try { response = JSON.parse(observation.payload_json) as Record<string, unknown>; }
    catch { corrupt("Current observation is not JSON."); }
    if (response.kind === "unavailable") return null;
    const windows = response.kind === "full" && response.snapshot
      && typeof response.snapshot === "object"
      ? (response.snapshot as { windows?: unknown }).windows
      : response.kind === "delta" ? response.upsertWindows : null;
    if (!Array.isArray(windows)) corrupt("Current observation has no window list.");
    const window = windows.find(value => (value as { windowId?: string }).windowId === row.window_id) as
      { resetEpoch: number; revision: number; coverage: string;
        limitBucket: { unit: string; remaining: number | null } } | undefined;
    if (!window) return null;
    if (window.resetEpoch !== row.reset_epoch || window.revision !== row.revision
      || !window.limitBucket || window.limitBucket.unit !== row.unit
      || window.limitBucket.remaining !== row.remaining) {
      corrupt("Current window differs from its observation evidence.");
    }
    return window;
  }

  private bindEvents(proof: CoverageProjectionInputV1): void {
    const ledgerIds = this.database.prepare(`SELECT e.event_id FROM resource_usage_events e
      JOIN resource_reservation_holds h ON h.reservation_id=e.reservation_id
        AND h.account_scope=e.account_scope AND h.pool_id=e.pool_id
        AND h.window_id=e.window_id
      WHERE e.account_scope=? AND e.pool_id=? AND e.window_id=? AND h.reset_epoch=?
      ORDER BY e.event_id`).all(proof.snapshot.accountScope, proof.snapshot.poolId,
      proof.snapshot.windowId, proof.snapshot.resetEpoch) as Array<{ event_id: string }>;
    const normalIds = proof.events.filter(event => event.correctsEventId === null)
      .map(event => event.eventId).sort();
    if (ledgerIds.length !== normalIds.length
      || ledgerIds.some((row, index) => row.event_id !== normalIds[index])) {
      invalid("Projection omits or invents a B11 usage event.");
    }
    for (const event of proof.events) {
      const row = this.database.prepare(`SELECT e.*,h.reset_epoch FROM resource_usage_events e
        JOIN resource_reservation_holds h ON h.reservation_id=e.reservation_id
          AND h.account_scope=e.account_scope AND h.pool_id=e.pool_id
          AND h.window_id=e.window_id
        WHERE e.event_id=? AND e.account_scope=? AND e.pool_id=? AND e.window_id=?`).get(
        event.correctsEventId ?? event.eventId, event.accountScope,
        event.poolId, event.windowId) as
        { reset_epoch: number; job_binding_digest: string; unit: string;
          amount: number | null; basis: string; payload_json: string } | undefined;
      if (!row || row.reset_epoch !== event.resetEpoch
        || row.job_binding_digest !== event.jobBindingDigest || row.unit !== event.unit) {
        invalid("Projection event is not bound to the B11 usage ledger.");
      }
      if (event.correctsEventId === null) {
        let stored: { sequence: number | null };
        try { stored = JSON.parse(row.payload_json) as { sequence: number | null }; }
        catch { corrupt("Stored usage event is not JSON."); }
        if (row.amount !== event.amount || row.basis !== event.basis
          || stored.sequence !== event.sequence) {
          invalid("Projection event differs from the B11 usage ledger.");
        }
      } else {
        if (this.database.prepare(`SELECT 1 FROM resource_usage_events WHERE event_id=? LIMIT 1`)
          .get(event.eventId)) conflict("Correction event ID collides with B11 usage.");
        const eventDigest = digest(canonicalJson(event));
        const existing = this.database.prepare(`SELECT event_digest FROM resource_reconciliation_corrections
          WHERE event_id=?`).get(event.eventId) as { event_digest: string } | undefined;
        if (existing && existing.event_digest !== eventDigest) {
          conflict("Correction event ID collides with different evidence.");
        }
        if (!existing) this.database.prepare(`INSERT INTO resource_reconciliation_corrections
          VALUES (?,?)`).run(event.eventId, eventDigest);
      }
    }
  }
}
