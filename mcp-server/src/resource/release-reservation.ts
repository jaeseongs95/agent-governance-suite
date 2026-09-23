import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

/** A final no-start: the owning runtime has fenced all future starts for this invocation. */
export type VerifiedNoStartReceiptV1 = {
  kind: "no-start"; launchFenced: true;
  authorityId: string; realmId: string; ownerId: string;
  reservationId: string; intentId: string; invocationId: string;
  jobBindingDigest: string; requestDigest: string; leaseEpoch: number;
  issuedAt: string; expiresAt: string;
};

/** Current durable invocation binding supplied by a synchronous local owning-runtime reader. */
export type TrustedDispatchBindingV1 = {
  ownerId: string; invocationId: string; jobBindingDigest: string;
};

export type ReservationReleaseRequestV1 = { reservationId: string; noStartReceipt?: unknown };
export type ReservationReleaseResultV1 = { kind: "released" | "already-released"; reservationId: string };

type ReservationRow = { reservation_id: string; request_key: string; request_digest: string;
  task_id: string; run_id: string; slot_id: string; attempt_id: string;
  plan_revision: number; lease_epoch: number; state: string; expires_at: string };
type IntentRow = { intent_id: string; request_digest: string; state: string; created_at: string };
type AdmissionRow = { request_digest: string; request_json: string; state: string;
  reservation_id: string | null };

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Releases only an unlaunched hold or a runtime-proven final no-start. Never cancels a job. */
export class ResourceReservationReleaseStore {
  constructor(private readonly database: DatabaseSync, private readonly authority: ResourceAuthorityConfig,
    private readonly verifyNoStart: (opaqueReceipt: unknown) => VerifiedNoStartReceiptV1 | null,
    private readonly resolveDispatchBinding: (reservationId: string) => TrustedDispatchBindingV1 | null,
    private readonly clock: () => string = () => new Date().toISOString()) {
    initializeResourceStoreSchema(database, authority);
  }

  release(request: ReservationReleaseRequestV1): ReservationReleaseResultV1 {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || typeof request.reservationId !== "string" || !idPattern.test(request.reservationId)
      || Object.keys(request).some(key => key !== "reservationId" && key !== "noStartReceipt")) {
      invalid("Invalid reservation release request.");
    }
    // The owning runtime verifier must authenticate the opaque receipt before the ledger write lock.
    const verified = request.noStartReceipt === undefined ? null : this.verifyNoStart(request.noStartReceipt);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      this.assertAuthority();
      const reservation = this.database.prepare(`SELECT reservation_id,request_key,request_digest,
        task_id,run_id,slot_id,attempt_id,plan_revision,lease_epoch,state,expires_at
        FROM resource_reservations WHERE reservation_id = ?`).get(request.reservationId) as
        ReservationRow | undefined;
      if (!reservation) conflict("Reservation does not exist.");
      const admission = this.database.prepare(`SELECT request_digest,request_json,state,reservation_id
        FROM resource_admission_requests WHERE request_key = ?`).get(reservation.request_key) as
        AdmissionRow | undefined;
      if (!admission || admission.state !== "admitted"
        || admission.reservation_id !== reservation.reservation_id
        || admission.request_digest !== reservation.request_digest) {
        corrupt("Reservation has no matching admitted request journal.");
      }
      this.assertAdmission(admission, reservation);
      if (this.hasLaunchEvidence(request.reservationId)) {
        conflict("Observed dispatch or usage prevents pre-dispatch release.");
      }
      if (reservation.state === "released") {
        this.database.exec("COMMIT;");
        return { kind: "already-released", reservationId: request.reservationId };
      }
      const intent = this.database.prepare(`SELECT intent_id,request_digest,state,created_at
        FROM resource_intents WHERE reservation_id = ?`).get(request.reservationId) as IntentRow | undefined;
      if (reservation.state === "held" && !intent) {
        // Held TTL is not evidence of no-start. The absence of any intent is the release condition.
      } else if ((reservation.state === "committed" || reservation.state === "uncertain")
        && intent?.state === "committed") {
        const nowMs = Date.parse(this.clock());
        if (!Number.isFinite(nowMs)) invalid("Trusted resource clock is invalid.");
        this.assertNoStart(verified, reservation, intent, nowMs);
      } else {
        conflict("Reservation has an unresolved dispatch state.");
      }
      const changed = this.database.prepare(`UPDATE resource_reservations SET state = 'released'
        WHERE reservation_id = ? AND state = ?`).run(request.reservationId, reservation.state);
      if (changed.changes !== 1) conflict("Reservation changed during release.");
      this.database.exec("COMMIT;");
      return { kind: "released", reservationId: request.reservationId };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary error. */ }
      throw error;
    }
  }

  private assertAuthority(): void {
    const marker = this.database.prepare(`SELECT realm_id,authority_id,owner_mode
      FROM resource_authority WHERE id = 1`).get() as
      { realm_id: string; authority_id: string; owner_mode: string } | undefined;
    if (!marker || marker.realm_id !== this.authority.realmId
      || marker.authority_id !== this.authority.authorityId || marker.owner_mode !== "single-broker") {
      corrupt("Resource ledger authority marker changed.");
    }
  }

  private assertAdmission(admission: AdmissionRow, reservation: ReservationRow): void {
    let bound: Record<string, unknown>;
    try { bound = JSON.parse(admission.request_json) as Record<string, unknown>; }
    catch { corrupt("Admission request journal is not JSON."); }
    if (!bound || typeof bound !== "object" || Array.isArray(bound)
      || canonicalJson(bound) !== admission.request_json
      || !digestPattern.test(reservation.request_digest)
      || `sha256:${createHash("sha256").update(admission.request_json).digest("hex")}`
        !== reservation.request_digest
      || bound.requestKey !== reservation.request_key || bound.taskId !== reservation.task_id
      || bound.runId !== reservation.run_id || bound.slotId !== reservation.slot_id
      || bound.attemptId !== reservation.attempt_id || bound.planRevision !== reservation.plan_revision
      || bound.leaseEpoch !== reservation.lease_epoch || bound.expiresAt !== reservation.expires_at
      || !validTime(reservation.expires_at)) {
      corrupt("Admission request journal diverged from its reservation.");
    }
  }

  private hasLaunchEvidence(reservationId: string): boolean {
    return Boolean(this.database.prepare(`SELECT 1 FROM resource_usage_events WHERE reservation_id = ? LIMIT 1`)
      .get(reservationId) || this.database.prepare(`SELECT 1 FROM resource_terminal_evidence
        WHERE reservation_id = ? LIMIT 1`).get(reservationId)
      || this.database.prepare(`SELECT 1 FROM resource_usage_coverage
        WHERE reservation_id = ? LIMIT 1`).get(reservationId));
  }

  private assertNoStart(receipt: VerifiedNoStartReceiptV1 | null, reservation: ReservationRow,
    intent: IntentRow, nowMs: number): void {
    const binding = this.resolveDispatchBinding(reservation.reservation_id);
    if (!receipt || receipt.kind !== "no-start" || receipt.launchFenced !== true || !binding
      || receipt.authorityId !== this.authority.authorityId || receipt.realmId !== this.authority.realmId
      || receipt.reservationId !== reservation.reservation_id || receipt.intentId !== intent.intent_id
      || receipt.requestDigest !== reservation.request_digest || intent.request_digest !== reservation.request_digest
      || receipt.leaseEpoch !== reservation.lease_epoch
      || typeof binding.ownerId !== "string" || !idPattern.test(binding.ownerId)
      || typeof binding.invocationId !== "string" || !idPattern.test(binding.invocationId)
      || typeof binding.jobBindingDigest !== "string" || !digestPattern.test(binding.jobBindingDigest)
      || receipt.ownerId !== binding.ownerId || receipt.invocationId !== binding.invocationId
      || receipt.jobBindingDigest !== binding.jobBindingDigest
      || !validTime(receipt.issuedAt) || !validTime(receipt.expiresAt)
      || !validTime(intent.created_at)
      || Date.parse(receipt.issuedAt) < Date.parse(intent.created_at)
      || Date.parse(receipt.issuedAt) > nowMs || Date.parse(receipt.expiresAt) <= nowMs) {
      conflict("No valid trusted no-start receipt matches the current dispatch binding.");
    }
  }
}
