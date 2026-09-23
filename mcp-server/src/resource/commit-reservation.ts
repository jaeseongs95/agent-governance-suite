import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError, type ArtifactRefV1, type ResourcePolicyV1 } from "../../../contracts/types.js";
import { ArtifactRetentionStore } from "../artifacts/retention.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import type { CurrentResourceLeaseV1 } from "./reservation-receipt.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const validator = new ContractValidator();

type Reference = { referenceId: string; ref: ArtifactRefV1 };
/** Resolved from the owning workflow's durable plan, never from MCP request JSON. */
export type ReservationCommitBindingV1 = {
  taskId: string; runId: string; slotId: string; attemptId: string;
  planRevision: number; leaseEpoch: number; requestDigest: string;
  references: Reference[];
};
export type ReservationCommitRequestV1 = { reservationId: string; intentId: string };
export type ReservationCommitResultV1 = { kind: "committed"; reservationId: string;
  intentId: string; replayed: boolean };

type ReservationRow = { reservation_id: string; request_key: string; request_digest: string;
  task_id: string; run_id: string; slot_id: string; attempt_id: string;
  plan_revision: number; lease_epoch: number; state: string; expires_at: string };
type AdmissionRow = { request_digest: string; request_json: string; state: string;
  reservation_id: string | null };
type IntentRow = { intent_id: string; reservation_id: string; request_digest: string; state: string };
type PolicyDigest = { accountScope: string; resourcePoolId: string; digest: string };

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }
const key = (scope: { accountScope: string; resourcePoolId: string }) =>
  `${scope.accountScope}\0${scope.resourcePoolId}`;

function validateBinding(value: ReservationCommitBindingV1): ReservationCommitBindingV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || [value.taskId, value.runId, value.slotId, value.attemptId]
      .some(id => typeof id !== "string" || !idPattern.test(id))
    || !Number.isSafeInteger(value.planRevision) || value.planRevision < 0
    || !Number.isSafeInteger(value.leaseEpoch) || value.leaseEpoch < 0
    || typeof value.requestDigest !== "string" || !digestPattern.test(value.requestDigest)
    || !Array.isArray(value.references) || value.references.length < 1
    || value.references.length > 64) invalid("Invalid trusted reservation binding.");
  const references = value.references.map(item => {
    if (!item || typeof item !== "object" || typeof item.referenceId !== "string"
      || !idPattern.test(item.referenceId)) invalid("Invalid retention reference ID.");
    return { referenceId: item.referenceId, ref: validator.artifactRef(item.ref) };
  });
  if (references.length < 2 || !references.some(item => item.referenceId === "binding")
    || new Set(references.map(item => item.referenceId)).size !== references.length
    || references.some(item => item.ref.hashDomain !== "raw-bytes")) {
    invalid("Trusted binding needs a unique raw-byte binding reference.");
  }
  const normalized = { taskId: value.taskId, runId: value.runId, slotId: value.slotId,
    attemptId: value.attemptId, planRevision: value.planRevision, leaseEpoch: value.leaseEpoch,
    requestDigest: value.requestDigest, references: references.sort((a, b) =>
      a.referenceId < b.referenceId ? -1 : a.referenceId > b.referenceId ? 1 : 0) };
  const bindingRef = normalized.references.find(item => item.referenceId === "binding")!.ref;
  const bindingBytes = Buffer.from(canonicalJson({ domain: "resource-commit-binding-v1",
    taskId: normalized.taskId, runId: normalized.runId, slotId: normalized.slotId,
    attemptId: normalized.attemptId, planRevision: normalized.planRevision,
    leaseEpoch: normalized.leaseEpoch, requestDigest: normalized.requestDigest,
    references: normalized.references.filter(item => item.referenceId !== "binding") }));
  if (bindingRef.namespace !== "task" || bindingRef.mediaType !== "application/json"
    || bindingRef.size !== bindingBytes.byteLength
    || bindingRef.digest !== `sha256:${createHash("sha256").update(bindingBytes).digest("hex")}`) {
    conflict("Immutable binding reference does not match the complete commit binding.");
  }
  return normalized;
}

/** Pins in A10 before publishing one local resource intent. No worker is launched here. */
export class ResourceReservationCommitStore {
  constructor(private readonly database: DatabaseSync, private readonly authority: ResourceAuthorityConfig,
    private readonly retention: ArtifactRetentionStore,
    private readonly resolveBinding: (reservationId: string) => ReservationCommitBindingV1,
    private readonly currentPolicies: () => readonly ResourcePolicyV1[],
    private readonly currentLease: () => CurrentResourceLeaseV1 | null,
    private readonly clock: () => string = () => new Date().toISOString()) {
    initializeResourceStoreSchema(database, authority);
  }

  commit(request: ReservationCommitRequestV1): ReservationCommitResultV1 {
    if (!request || typeof request !== "object" || Array.isArray(request)
      || Object.keys(request).length !== 2
      || typeof request.reservationId !== "string" || !idPattern.test(request.reservationId)
      || typeof request.intentId !== "string" || !idPattern.test(request.intentId)) {
      invalid("Invalid reservation commit request.");
    }
    const binding = validateBinding(this.resolveBinding(request.reservationId));
    // Preflight avoids orphan pins on ordinary invalid/expired inputs. Recheck under the write lock.
    this.assertCurrent(request, binding);
    const owner = `resource-intent:sha256:${createHash("sha256")
      .update(canonicalJson({ domain: "resource-retention-owner-v1",
        realmId: this.authority.realmId, intentId: request.intentId })).digest("hex")}`;
    for (const item of binding.references) this.retention.pin(item.ref, owner, item.referenceId);

    this.database.exec("BEGIN IMMEDIATE;");
    let replayed: boolean;
    try {
      const freshBinding = validateBinding(this.resolveBinding(request.reservationId));
      if (canonicalJson(freshBinding) !== canonicalJson(binding)) {
        conflict("Trusted reservation binding changed during commit.");
      }
      const { reservation, intent } = this.assertCurrent(request, binding);
      if (intent) {
        if (intent.state !== "committed" || reservation.state !== "committed") {
          conflict("Existing dispatch intent is not a replayable commit.");
        }
        replayed = true;
      } else {
        if (reservation.state !== "held") conflict("Reservation is no longer held.");
        const changed = this.database.prepare(`UPDATE resource_reservations SET state = 'committed'
          WHERE reservation_id = ? AND state = 'held'`).run(request.reservationId);
        if (changed.changes !== 1) conflict("Reservation changed during commit.");
        const now = this.clock();
        this.database.prepare(`INSERT INTO resource_intents
          (intent_id,reservation_id,request_digest,state,created_at,updated_at)
          VALUES (?,?,?,'committed',?,?)`).run(request.intentId, request.reservationId,
          binding.requestDigest, now, now);
        replayed = false;
      }
      this.database.exec("COMMIT;");
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Keep the original failure. */ }
      throw error;
    }
    // A failure here leaves committed intent plus pending pins. Same-intent retry finishes publication.
    for (const item of binding.references) this.retention.referencePublished(owner, item.referenceId);
    return { kind: "committed", reservationId: request.reservationId,
      intentId: request.intentId, replayed };
  }

  private assertCurrent(request: ReservationCommitRequestV1, binding: ReservationCommitBindingV1):
    { reservation: ReservationRow; intent: IntentRow | undefined } {
    const marker = this.database.prepare(`SELECT realm_id,authority_id,owner_mode
      FROM resource_authority WHERE id = 1`).get() as
      { realm_id: string; authority_id: string; owner_mode: string } | undefined;
    if (!marker || marker.realm_id !== this.authority.realmId
      || marker.authority_id !== this.authority.authorityId || marker.owner_mode !== "single-broker") {
      corrupt("Resource ledger authority marker changed.");
    }
    const nowMs = Date.parse(this.clock());
    if (!Number.isFinite(nowMs)) invalid("Trusted resource clock is invalid.");
    const reservation = this.database.prepare(`SELECT reservation_id,request_key,request_digest,
      task_id,run_id,slot_id,attempt_id,plan_revision,lease_epoch,state,expires_at
      FROM resource_reservations WHERE reservation_id = ?`).get(request.reservationId) as
      ReservationRow | undefined;
    const reservationExpiryMs = Date.parse(reservation?.expires_at ?? "");
    if (!reservation || !["held", "committed"].includes(reservation.state)
      || reservation.request_digest !== binding.requestDigest
      || reservation.task_id !== binding.taskId || reservation.run_id !== binding.runId
      || reservation.slot_id !== binding.slotId || reservation.attempt_id !== binding.attemptId
      || reservation.plan_revision !== binding.planRevision || reservation.lease_epoch !== binding.leaseEpoch
      || !Number.isFinite(reservationExpiryMs)) {
      conflict("Reservation is expired or differs from the trusted binding.");
    }
    const admission = this.database.prepare(`SELECT request_digest,request_json,state,reservation_id
      FROM resource_admission_requests WHERE request_key = ?`).get(reservation.request_key) as
      AdmissionRow | undefined;
    if (!admission || admission.state !== "admitted"
      || admission.reservation_id !== request.reservationId
      || admission.request_digest !== reservation.request_digest) {
      corrupt("Reservation admission journal is missing or differs.");
    }
    this.assertPolicy(admission.request_json, admission.request_digest, reservation);
    const intent = this.database.prepare(`SELECT intent_id,reservation_id,request_digest,state
      FROM resource_intents WHERE reservation_id = ? OR intent_id = ?`).get(
      request.reservationId, request.intentId) as IntentRow | undefined;
    if (intent && (intent.intent_id !== request.intentId
      || intent.reservation_id !== request.reservationId
      || intent.request_digest !== binding.requestDigest)) {
      conflict("A different intent already owns the reservation or intent ID.");
    }
    // An existing durable commit only finishes retention publication; it cannot launch work.
    if (reservation.state !== "committed" || intent?.state !== "committed") {
      const lease = this.currentLease();
      const leaseExpiryMs = typeof lease?.expiresAt === "string" ? Date.parse(lease.expiresAt) : NaN;
      if (!lease || lease.authorityId !== this.authority.authorityId || lease.realmId !== this.authority.realmId
        || typeof lease.ownerId !== "string" || !idPattern.test(lease.ownerId)
        || typeof lease.leaseId !== "string" || !idPattern.test(lease.leaseId)
        || !Number.isSafeInteger(lease.epoch) || lease.epoch !== binding.leaseEpoch
        || typeof lease.expiresAt !== "string" || !Number.isFinite(leaseExpiryMs)
        || leaseExpiryMs <= nowMs) {
        conflict("Current resource authority lease is stale or changed.");
      }
      if (reservationExpiryMs <= nowMs) conflict("Reservation is expired.");
    }
    return { reservation, intent };
  }

  private assertPolicy(requestJson: string, requestDigest: string, reservation: ReservationRow): void {
    let bound: Record<string, unknown>;
    try { bound = JSON.parse(requestJson) as Record<string, unknown>; }
    catch { corrupt("Admission request journal is not JSON."); }
    if (!bound || typeof bound !== "object" || Array.isArray(bound)) corrupt("Admission request journal is invalid.");
    if (canonicalJson(bound) !== requestJson
      || `sha256:${createHash("sha256").update(requestJson).digest("hex")}` !== requestDigest
      || bound.requestKey !== reservation.request_key || bound.taskId !== reservation.task_id
      || bound.runId !== reservation.run_id || bound.slotId !== reservation.slot_id
      || bound.attemptId !== reservation.attempt_id
      || bound.planRevision !== reservation.plan_revision || bound.leaseEpoch !== reservation.lease_epoch
      || bound.expiresAt !== reservation.expires_at) {
      corrupt("Admission request journal diverged from its reservation.");
    }
    let stored: PolicyDigest[];
    if (Array.isArray(bound.policyDigests)) {
      stored = bound.policyDigests as PolicyDigest[];
    } else if (typeof bound.policyDigest === "string") {
      stored = [{ accountScope: bound.accountScope as string,
        resourcePoolId: bound.resourcePoolId as string, digest: bound.policyDigest }];
    } else {
      corrupt("Admission request has no policy binding.");
    }
    if (!stored.length || stored.some(item => !item || typeof item.accountScope !== "string"
      || typeof item.resourcePoolId !== "string" || typeof item.digest !== "string"
      || !digestPattern.test(item.digest))
      || new Set(stored.map(key)).size !== stored.length) corrupt("Admission policy digests are invalid.");
    const policies = new Map<string, string>();
    for (const raw of this.currentPolicies()) {
      const policy = validator.resourcePolicyV1(raw);
      const scope = key(policy);
      if (policies.has(scope)) invalid("Duplicate current resource policy.");
      policies.set(scope, `sha256:${createHash("sha256").update(canonicalJson(policy)).digest("hex")}`);
    }
    if (stored.some(item => policies.get(key(item)) !== item.digest)) {
      conflict("Approved resource policy changed after admission.");
    }
  }
}
