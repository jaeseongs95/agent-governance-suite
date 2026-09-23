import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const reasons = new Set(["response-timeout", "receipt-lost", "owner-restarted"]);

export type UncertainReasonV1 = "response-timeout" | "receipt-lost" | "owner-restarted";
export type MarkUncertainRequestV1 = { reservationId: string; reason: UncertainReasonV1 };
export type MarkUncertainResultV1 = { kind: "observe-required"; reservationId: string;
  intentId: string; replayed: boolean };

type ReservationRow = { reservation_id: string; request_key: string; request_digest: string;
  task_id: string; run_id: string; slot_id: string; attempt_id: string;
  plan_revision: number; lease_epoch: number; state: string; expires_at: string };
type AdmissionRow = { request_digest: string; request_json: string; state: string;
  reservation_id: string | null };
type IntentRow = { intent_id: string; request_digest: string; state: string };

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }

/** A local owning-runtime signal keeps capacity held until observation or B09 no-start release. */
export class ResourceUncertainReservationStore {
  constructor(private readonly database: DatabaseSync, private readonly authority: ResourceAuthorityConfig) {
    initializeResourceStoreSchema(database, authority);
  }

  markUncertain(request: MarkUncertainRequestV1): MarkUncertainResultV1 {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).length !== 2
      || typeof request.reservationId !== "string" || !idPattern.test(request.reservationId)
      || !reasons.has(request.reason)) invalid("Invalid trusted observation-loss signal.");
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const marker = this.database.prepare(`SELECT realm_id,authority_id,owner_mode
        FROM resource_authority WHERE id = 1`).get() as
        { realm_id: string; authority_id: string; owner_mode: string } | undefined;
      if (!marker || marker.realm_id !== this.authority.realmId
        || marker.authority_id !== this.authority.authorityId || marker.owner_mode !== "single-broker") {
        corrupt("Resource ledger authority marker changed.");
      }
      const reservation = this.database.prepare(`SELECT reservation_id,request_key,request_digest,
        task_id,run_id,slot_id,attempt_id,plan_revision,lease_epoch,state,expires_at
        FROM resource_reservations WHERE reservation_id = ?`).get(request.reservationId) as
        ReservationRow | undefined;
      if (!reservation || !["committed", "uncertain"].includes(reservation.state)) {
        conflict("Only a committed dispatch can become uncertain.");
      }
      const admission = this.database.prepare(`SELECT request_digest,request_json,state,reservation_id
        FROM resource_admission_requests WHERE request_key = ?`).get(reservation.request_key) as
        AdmissionRow | undefined;
      this.assertAdmission(admission, reservation);
      const intent = this.database.prepare(`SELECT intent_id,request_digest,state
        FROM resource_intents WHERE reservation_id = ?`).get(request.reservationId) as IntentRow | undefined;
      if (!intent || intent.request_digest !== reservation.request_digest
        || intent.state !== "committed") {
        conflict("Reservation has no matching unresolved dispatch intent.");
      }
      const replayed = reservation.state === "uncertain";
      if (!replayed) {
        const changed = this.database.prepare(`UPDATE resource_reservations SET state = 'uncertain'
          WHERE reservation_id = ? AND state = 'committed'`).run(request.reservationId);
        if (changed.changes !== 1) conflict("Reservation changed during uncertainty transition.");
      }
      this.database.exec("COMMIT;");
      return { kind: "observe-required", reservationId: request.reservationId,
        intentId: intent.intent_id, replayed };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the primary error. */ }
      throw error;
    }
  }

  private assertAdmission(admission: AdmissionRow | undefined, reservation: ReservationRow): void {
    if (!admission || admission.state !== "admitted"
      || admission.reservation_id !== reservation.reservation_id
      || admission.request_digest !== reservation.request_digest) {
      corrupt("Reservation has no matching admitted request journal.");
    }
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
      || bound.leaseEpoch !== reservation.lease_epoch || bound.expiresAt !== reservation.expires_at) {
      corrupt("Admission request journal diverged from its reservation.");
    }
  }
}
