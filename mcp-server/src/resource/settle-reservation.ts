import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

const id = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const basis = new Set(["delta", "cumulative"]);
const coverage = new Set(["partial", "complete", "unknown"]);
const results = new Set(["completed", "failed", "cancelled"]);
const usageFields = ["kind", "eventId", "reservationId", "intentId", "jobBindingDigest",
  "accountScope", "poolId", "windowId", "amount", "unit", "basis", "coverage",
  "sequence", "sourceDigest", "occurredAt"];
const terminalFields = ["kind", "evidenceId", "reservationId", "intentId", "jobBindingDigest",
  "result", "evidenceDigest", "observedAt"];

export type VerifiedUsageEventV1 = {
  kind: "usage"; eventId: string; reservationId: string; intentId: string;
  jobBindingDigest: string; accountScope: string; poolId: string; windowId: string;
  amount: number | null; unit: string; basis: "delta" | "cumulative";
  coverage: "partial" | "complete" | "unknown";
  /** Trusted 1-based window stream order; a complete delta event marks the final sequence. */
  sequence: number | null;
  sourceDigest: string; occurredAt: string;
};
export type VerifiedTerminalEvidenceV1 = {
  kind: "terminal"; evidenceId: string; reservationId: string; intentId: string;
  jobBindingDigest: string; result: "completed" | "failed" | "cancelled";
  evidenceDigest: string; observedAt: string;
};
export type VerifiedSettlementEvidenceV1 = VerifiedUsageEventV1 | VerifiedTerminalEvidenceV1;
export type SettlementPolicyV1 = {
  terminalResults: readonly VerifiedTerminalEvidenceV1["result"][];
  onUnknown: "retain" | "settle-with-unknown";
};
export type SettlementResultV1 = {
  kind: "recorded" | "settled"; reservationId: string; replayed: boolean;
  coverage: "partial" | "complete" | "unknown";
  observed: ReadonlyArray<{ accountScope: string; poolId: string; windowId: string;
    unit: string; estimatedAmount: number; observedAmount: number | null;
    coverage: "partial" | "complete" | "unknown" }>;
};

type Reservation = { reservation_id: string; request_key: string; request_digest: string;
  task_id: string; run_id: string; slot_id: string; attempt_id: string;
  plan_revision: number; lease_epoch: number; state: string; expires_at: string };
type Hold = { account_scope: string; pool_id: string; window_id: string;
  amount: number; unit: string };
type UsageRow = { event_id: string; reservation_id: string; payload_json: string;
  amount: number | null; basis: string; coverage: string; occurred_at: string };
type CoverageRow = { coverage: string; observed_amount: number | null;
  unit: string; updated_at: string };

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }
function time(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function hash(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
/** Accepts only evidence authenticated by the owning runtime, then settles under one ledger lock. */
export class ResourceReservationSettlementStore {
  constructor(private readonly database: DatabaseSync, private readonly authority: ResourceAuthorityConfig,
    private readonly verifyEvidence: (opaque: unknown) => VerifiedSettlementEvidenceV1 | null,
    private readonly resolveJobBinding: (reservationId: string) => string | null,
    private readonly resolvePolicy: (reservationId: string) => SettlementPolicyV1 | null) {
    initializeResourceStoreSchema(database, authority);
    // Local provenance for this writer's coverage projection; external reconciliation never writes it.
    database.exec(`CREATE TABLE IF NOT EXISTS resource_settlement_projection (
      reservation_id TEXT NOT NULL, account_scope TEXT NOT NULL, pool_id TEXT NOT NULL,
      window_id TEXT NOT NULL, row_digest TEXT NOT NULL,
      PRIMARY KEY (reservation_id,account_scope,pool_id,window_id),
      FOREIGN KEY (reservation_id,account_scope,pool_id,window_id)
        REFERENCES resource_reservation_holds(reservation_id,account_scope,pool_id,window_id)
    ) STRICT;`);
  }

  record(opaque: unknown): SettlementResultV1 {
    // The verifier is a server-owned trust boundary. An arbitrary JSON object is never admitted directly.
    const evidence = this.verifyEvidence(opaque);
    this.validate(evidence);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.assertAuthority();
      const reservation = this.database.prepare(`SELECT reservation_id,request_key,request_digest,
        task_id,run_id,slot_id,attempt_id,plan_revision,lease_epoch,state,expires_at
        FROM resource_reservations WHERE reservation_id = ?`).get(evidence.reservationId) as Reservation | undefined;
      if (!reservation || !["committed", "uncertain", "settled"].includes(reservation.state)) {
        conflict("Reservation is not an admitted dispatch.");
      }
      this.assertAdmission(reservation);
      const intent = this.database.prepare(`SELECT intent_id,request_digest,state FROM resource_intents
        WHERE reservation_id = ?`).get(reservation.reservation_id) as
        { intent_id: string; request_digest: string; state: string } | undefined;
      if (!intent || intent.intent_id !== evidence.intentId || intent.state !== "committed"
        || intent.request_digest !== reservation.request_digest
        || this.resolveJobBinding(reservation.reservation_id) !== evidence.jobBindingDigest) {
        conflict("Evidence differs from the current dispatch intent or job binding.");
      }
      const policy = this.resolvePolicy(reservation.reservation_id);
      if (!policy || !Array.isArray(policy.terminalResults) || !policy.terminalResults.length
        || policy.terminalResults.some(value => !results.has(value))
        || !["retain", "settle-with-unknown"].includes(policy.onUnknown)) {
        conflict("No valid server-owned settlement policy is available.");
      }
      const payload = canonicalJson(evidence);
      const replayed = evidence.kind === "usage"
        ? this.recordUsage(evidence, payload, reservation.state)
        : this.recordTerminal(evidence, payload, reservation.state);
      const observed = this.project(reservation.reservation_id,
        policy.onUnknown === "settle-with-unknown");
      const terminal = this.database.prepare(`SELECT result FROM resource_terminal_evidence
        WHERE reservation_id = ?`).get(reservation.reservation_id) as { result: string } | undefined;
      const complete = reservation.state === "settled" || Boolean(terminal && policy.terminalResults.includes(
        terminal.result as VerifiedTerminalEvidenceV1["result"])
        && observed.every(item => item.coverage === "complete"
          || (item.coverage === "unknown" && policy.onUnknown === "settle-with-unknown")));
      if (complete && reservation.state !== "settled") {
        const changed = this.database.prepare(`UPDATE resource_reservations SET state = 'settled'
          WHERE reservation_id = ? AND state = ?`).run(reservation.reservation_id, reservation.state);
        if (changed.changes !== 1) conflict("Reservation changed during settlement.");
      }
      this.database.exec("COMMIT;");
      return { kind: complete ? "settled" : "recorded", reservationId: reservation.reservation_id,
        replayed, coverage: observed.every(item => item.coverage === "complete") ? "complete"
          : observed.some(item => item.coverage === "unknown") ? "unknown" : "partial", observed };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  private validate(value: VerifiedSettlementEvidenceV1 | null): asserts value is VerifiedSettlementEvidenceV1 {
    if (!value || typeof value !== "object" || Array.isArray(value)
      || !id.test(value.reservationId) || !id.test(value.intentId)
      || !digest.test(value.jobBindingDigest)) invalid("Invalid verified settlement evidence.");
    if (value.kind === "usage") {
      if (Object.keys(value).length !== usageFields.length
        || usageFields.some(field => !Object.hasOwn(value, field))
        || !id.test(value.eventId) || !id.test(value.accountScope) || !id.test(value.poolId)
        || !id.test(value.windowId) || !id.test(value.unit) || !digest.test(value.sourceDigest)
        || !basis.has(value.basis) || !coverage.has(value.coverage) || !time(value.occurredAt)
        || (value.basis === "delta" && (!Number.isSafeInteger(value.sequence) || value.sequence! < 1))
        || (value.basis === "cumulative" && value.sequence !== null)
        || (value.amount !== null && (!Number.isFinite(value.amount) || value.amount < 0))
        || (value.coverage === "complete" && value.amount === null)) {
        invalid("Invalid verified usage event.");
      }
    } else if (value.kind === "terminal") {
      if (Object.keys(value).length !== terminalFields.length
        || terminalFields.some(field => !Object.hasOwn(value, field))
        || !id.test(value.evidenceId) || !digest.test(value.evidenceDigest)
        || !results.has(value.result) || !time(value.observedAt)) {
        invalid("Invalid verified terminal evidence.");
      }
    } else invalid("Unknown settlement evidence kind.");
  }

  private recordUsage(e: VerifiedUsageEventV1, payload: string, state: string): boolean {
    const existing = this.database.prepare(`SELECT event_id,reservation_id,payload_json,amount,basis,coverage,occurred_at
      FROM resource_usage_events WHERE event_id = ?`).all(e.eventId) as UsageRow[];
    if (existing.length) {
      if (existing.some(row => row.reservation_id !== e.reservationId || row.payload_json !== payload)) {
        conflict("Usage event ID collides with different evidence.");
      }
      return true;
    }
    if (state === "settled") {
      const priorCoverage = this.database.prepare(`SELECT coverage FROM resource_usage_coverage
        WHERE reservation_id = ? AND account_scope = ? AND pool_id = ? AND window_id = ?`).get(
        e.reservationId, e.accountScope, e.poolId, e.windowId) as { coverage: string } | undefined;
      if (priorCoverage?.coverage !== "unknown") {
        conflict("New usage cannot change a fully observed settlement.");
      }
    }
    const hold = this.database.prepare(`SELECT unit FROM resource_reservation_holds WHERE
      reservation_id = ? AND account_scope = ? AND pool_id = ? AND window_id = ?`).get(
      e.reservationId, e.accountScope, e.poolId, e.windowId) as { unit: string } | undefined;
    if (!hold || hold.unit !== e.unit) conflict("Usage unit or held window differs.");
    const prior = this.database.prepare(`SELECT basis,amount,coverage,payload_json FROM resource_usage_events
      WHERE reservation_id = ? AND account_scope = ? AND pool_id = ? AND window_id = ?`).all(
      e.reservationId, e.accountScope, e.poolId, e.windowId) as UsageRow[];
    if (prior.some(row => row.basis !== e.basis)) conflict("Usage basis changed.");
    const priorEvidence = prior.map(row => {
      try { return JSON.parse(row.payload_json) as VerifiedUsageEventV1; }
      catch { corrupt("Stored usage event is not JSON."); }
    });
    if (e.basis === "delta") {
      if (priorEvidence.some(row => row.sequence === e.sequence)) conflict("Usage sequence already exists.");
      const final = priorEvidence.find(row => row.coverage === "complete");
      if (final && (e.sequence! >= final.sequence! || e.coverage === "complete")) {
        conflict("Usage sequence exceeds the final delta event.");
      }
      if (e.coverage === "complete" && priorEvidence.some(row => row.sequence! >= e.sequence!)) {
        conflict("Final delta sequence precedes an existing event.");
      }
    } else if (prior.some(row => row.coverage === "complete")) {
      conflict("A complete cumulative event already closed this stream.");
    }
    if (e.basis === "cumulative" && prior.length && e.amount !== null) {
      const maximum = Math.max(...prior.map(row => row.amount ?? 0));
      if (e.amount < maximum) conflict("Cumulative usage decreased.");
    }
    this.database.prepare(`INSERT INTO resource_usage_events
      (event_id,reservation_id,account_scope,pool_id,window_id,amount,unit,basis,coverage,
       job_binding_digest,source_digest,payload_json,occurred_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      e.eventId, e.reservationId, e.accountScope, e.poolId, e.windowId, e.amount, e.unit,
      e.basis, e.coverage, e.jobBindingDigest, e.sourceDigest, payload, e.occurredAt);
    return false;
  }

  private recordTerminal(e: VerifiedTerminalEvidenceV1, payload: string, state: string): boolean {
    const existing = this.database.prepare(`SELECT evidence_id,reservation_id,payload_json FROM resource_terminal_evidence
      WHERE evidence_id = ? OR reservation_id = ?`).all(e.evidenceId, e.reservationId) as
      Array<{ evidence_id: string; reservation_id: string; payload_json: string }>;
    if (existing.length) {
      if (existing.some(row => row.evidence_id !== e.evidenceId || row.reservation_id !== e.reservationId
        || row.payload_json !== payload)) conflict("Terminal evidence collides with a different result.");
      return true;
    }
    if (state === "settled") conflict("New terminal evidence cannot change settlement.");
    this.database.prepare(`INSERT INTO resource_terminal_evidence
      (evidence_id,reservation_id,job_binding_digest,result,evidence_digest,payload_json,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run(e.evidenceId, e.reservationId, e.jobBindingDigest,
      e.result, e.evidenceDigest, payload, e.observedAt);
    return false;
  }

  private project(reservationId: string, settleWithUnknown: boolean): SettlementResultV1["observed"] {
    const hasTerminal = Boolean(this.database.prepare(`SELECT 1 FROM resource_terminal_evidence
      WHERE reservation_id = ? LIMIT 1`).get(reservationId));
    const holds = this.database.prepare(`SELECT account_scope,pool_id,window_id,amount,unit
      FROM resource_reservation_holds WHERE reservation_id = ? ORDER BY account_scope,pool_id,window_id`).all(
      reservationId) as Hold[];
    if (!holds.length) corrupt("Reservation has no held resource windows.");
    const observed: Array<SettlementResultV1["observed"][number]> = [];
    for (const hold of holds) {
      const rows = this.database.prepare(`SELECT event_id,reservation_id,payload_json,amount,basis,coverage,occurred_at
        FROM resource_usage_events WHERE reservation_id = ? AND account_scope = ? AND pool_id = ?
          AND window_id = ? ORDER BY occurred_at,event_id`).all(reservationId, hold.account_scope,
        hold.pool_id, hold.window_id) as UsageRow[];
      const bases = new Set(rows.map(row => row.basis));
      if (bases.size > 1 || rows.some(row => !basis.has(row.basis) || !coverage.has(row.coverage)
        || (row.amount !== null && (!Number.isFinite(row.amount) || row.amount < 0)))) {
        corrupt("Stored usage stream is inconsistent.");
      }
      const known = rows.filter(row => row.amount !== null).map(row => row.amount as number);
      const amount = known.length ? (bases.has("delta") ? known.reduce((sum, next) => sum + next, 0)
        : Math.max(...known)) : null;
      if (amount !== null && !Number.isFinite(amount)) corrupt("Observed usage overflowed.");
      const previous = this.database.prepare(`SELECT coverage,observed_amount,unit,updated_at FROM resource_usage_coverage
        WHERE reservation_id = ? AND account_scope = ? AND pool_id = ? AND window_id = ?`).get(
        reservationId, hold.account_scope, hold.pool_id, hold.window_id) as CoverageRow | undefined;
      const origin = this.database.prepare(`SELECT row_digest FROM resource_settlement_projection
        WHERE reservation_id = ? AND account_scope = ? AND pool_id = ? AND window_id = ?`).get(
        reservationId, hold.account_scope, hold.pool_id, hold.window_id) as { row_digest: string } | undefined;
      const ownProjection = Boolean(previous && origin?.row_digest === hash(canonicalJson({
        coverage: previous.coverage, observedAmount: previous.observed_amount,
        unit: previous.unit, updatedAt: previous.updated_at })));
      if (previous && (previous.unit !== hold.unit || !coverage.has(previous.coverage)
        || (previous.observed_amount !== null && !Number.isFinite(previous.observed_amount))
        || (previous.coverage === "complete" && previous.observed_amount === null))) {
        corrupt("Stored usage coverage is inconsistent.");
      }
      const explicitUnknown = rows.some(row => row.coverage === "unknown" || row.amount === null);
      const finalRow = rows.find(row => row.coverage === "complete");
      const completeEvent = Boolean(finalRow && (bases.has("cumulative") || (() => {
        const sequences = rows.map(row => {
          try { return (JSON.parse(row.payload_json) as VerifiedUsageEventV1).sequence; }
          catch { corrupt("Stored usage event is not JSON."); }
        });
        const finalSequence = (JSON.parse(finalRow.payload_json) as VerifiedUsageEventV1).sequence;
        return Number.isSafeInteger(finalSequence) && finalSequence! > 0
          && rows.length === finalSequence && new Set(sequences).size === finalSequence
          && sequences.every(sequence => Number.isSafeInteger(sequence)
            && sequence! >= 1 && sequence! <= finalSequence!);
      })()));
      const completeConflict = previous?.coverage === "complete"
        && (!ownProjection || !rows.length || !completeEvent || explicitUnknown
          || previous.observed_amount !== amount);
      const partialConflict = previous?.coverage === "partial"
        && (!ownProjection || previous.observed_amount === null || amount === null
          || previous.observed_amount > amount);
      // An existing unknown may be a B12 reconciliation finding. Event replay cannot clear it.
      const finalStatus = previous?.coverage === "unknown" || completeConflict || partialConflict ? "unknown"
        : !rows.length || explicitUnknown || (hasTerminal && !completeEvent) ? "unknown"
            : completeEvent ? "complete" : "partial";
      const finalAmount = previous?.coverage === "unknown" || completeConflict || partialConflict
        ? previous.observed_amount === null ? amount
          : amount === null ? previous.observed_amount : Math.max(previous.observed_amount, amount)
        : amount;
      // Absence remains unknown until evidence arrives; retaining policy must not create an
      // indistinguishable B11 unknown row that would block later complete usage evidence.
      const shouldWrite = rows.length > 0 || previous !== undefined || (hasTerminal && settleWithUnknown);
      if (shouldWrite) {
        const storedStatus = hasTerminal && !settleWithUnknown && !explicitUnknown
          && rows.length > 0 && !completeEvent && !completeConflict && !partialConflict
          && previous?.coverage !== "unknown"
          ? "partial" : finalStatus;
        const updatedAt = new Date().toISOString();
        this.database.prepare(`INSERT INTO resource_usage_coverage
          (reservation_id,account_scope,pool_id,window_id,coverage,observed_amount,unit,updated_at)
          VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(reservation_id,account_scope,pool_id,window_id)
          DO UPDATE SET coverage = excluded.coverage, observed_amount = excluded.observed_amount,
            unit = excluded.unit, updated_at = excluded.updated_at`).run(
          reservationId, hold.account_scope, hold.pool_id, hold.window_id, storedStatus,
          finalAmount, hold.unit, updatedAt);
        const rowDigest = hash(canonicalJson({ coverage: storedStatus,
          observedAmount: finalAmount, unit: hold.unit, updatedAt }));
        this.database.prepare(`INSERT INTO resource_settlement_projection
          (reservation_id,account_scope,pool_id,window_id,row_digest) VALUES (?,?,?,?,?)
          ON CONFLICT(reservation_id,account_scope,pool_id,window_id)
          DO UPDATE SET row_digest = excluded.row_digest`).run(
          reservationId, hold.account_scope, hold.pool_id, hold.window_id, rowDigest);
      }
      observed.push({ accountScope: hold.account_scope, poolId: hold.pool_id, windowId: hold.window_id,
        unit: hold.unit, estimatedAmount: hold.amount,
        observedAmount: finalAmount, coverage: finalStatus });
    }
    return observed;
  }

  private assertAuthority(): void {
    const marker = this.database.prepare(`SELECT realm_id,authority_id,owner_mode FROM resource_authority
      WHERE id = 1`).get() as { realm_id: string; authority_id: string; owner_mode: string } | undefined;
    if (!marker || marker.realm_id !== this.authority.realmId || marker.authority_id !== this.authority.authorityId
      || marker.owner_mode !== "single-broker") corrupt("Resource authority marker changed.");
  }

  private assertAdmission(r: Reservation): void {
    const admission = this.database.prepare(`SELECT request_digest,request_json,state,reservation_id
      FROM resource_admission_requests WHERE request_key = ?`).get(r.request_key) as
      { request_digest: string; request_json: string; state: string; reservation_id: string } | undefined;
    if (!admission || admission.state !== "admitted" || admission.reservation_id !== r.reservation_id
      || admission.request_digest !== r.request_digest || !digest.test(r.request_digest)
      || hash(admission.request_json) !== r.request_digest) corrupt("Admission journal differs from reservation.");
    let bound: Record<string, unknown>;
    try { bound = JSON.parse(admission.request_json) as Record<string, unknown>; }
    catch { corrupt("Admission journal is not JSON."); }
    if (!bound || typeof bound !== "object" || Array.isArray(bound)
      || canonicalJson(bound) !== admission.request_json
      || bound.requestKey !== r.request_key || bound.taskId !== r.task_id || bound.runId !== r.run_id
      || bound.slotId !== r.slot_id || bound.attemptId !== r.attempt_id
      || bound.planRevision !== r.plan_revision || bound.leaseEpoch !== r.lease_epoch
      || bound.expiresAt !== r.expires_at) corrupt("Admission journal identity differs from reservation.");
  }
}
