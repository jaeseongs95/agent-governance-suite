import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const macPattern = /^hmac-sha256:[a-f0-9]{64}$/u;

/** Supplied only by the owning authority, never from an MCP request or a receipt. */
export type CurrentResourceLeaseV1 = {
  authorityId: ResourceAuthorityConfig["authorityId"];
  realmId: string;
  ownerId: string;
  leaseId: string;
  epoch: number;
  expiresAt: string;
};

export type ReservationReceiptV1 = {
  schemaVersion: "1.0.0";
  authorityId: ResourceAuthorityConfig["authorityId"];
  realmId: string;
  ownerId: string;
  leaseId: string;
  leaseEpoch: number;
  reservationId: string;
  requestDigest: string;
  expiresAt: string;
  mac: string;
};

type ReservationRow = { request_key: string; request_digest: string; lease_epoch: number;
  state: string; expires_at: string };
type AdmissionRow = { request_digest: string; state: string; reservation_id: string | null };
type IntentRow = { intent_id: string; request_digest: string; state: string };

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }
function validTime(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validateReceipt(value: unknown): ReservationReceiptV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid reservation receipt.");
  const receipt = value as Record<string, unknown>;
  const fields = ["schemaVersion", "authorityId", "realmId", "ownerId", "leaseId", "leaseEpoch",
    "reservationId", "requestDigest", "expiresAt", "mac"];
  if (Object.keys(receipt).length !== fields.length || fields.some(field => !Object.hasOwn(receipt, field))
    || receipt.schemaVersion !== "1.0.0" || receipt.authorityId !== "ags-resource-authority-v1"
    || typeof receipt.realmId !== "string" || !digestPattern.test(`sha256:${receipt.realmId}`)
    || [receipt.ownerId, receipt.leaseId, receipt.reservationId]
      .some(id => typeof id !== "string" || !idPattern.test(id))
    || !Number.isSafeInteger(receipt.leaseEpoch) || (receipt.leaseEpoch as number) < 0
    || typeof receipt.requestDigest !== "string" || !digestPattern.test(receipt.requestDigest)
    || !validTime(receipt.expiresAt) || typeof receipt.mac !== "string" || !macPattern.test(receipt.mac)) {
    invalid("Invalid reservation receipt fields.");
  }
  return receipt as ReservationReceiptV1;
}

/** Ledger-backed proof of a hold. Launch eligibility must be checked again by the owning runtime. */
export class ResourceReservationReceiptStore {
  private readonly signingKey: Buffer;

  constructor(private readonly database: DatabaseSync, private readonly authority: ResourceAuthorityConfig,
    private readonly currentLease: () => CurrentResourceLeaseV1 | null,
    signingKey: Uint8Array,
    private readonly clock: () => string = () => new Date().toISOString()) {
    initializeResourceStoreSchema(database, authority);
    if (!(signingKey instanceof Uint8Array) || signingKey.byteLength < 32) {
      invalid("A server-owned receipt signing key of at least 32 bytes is required.");
    }
    this.signingKey = Buffer.from(signingKey);
  }

  /** Issue only for a live held reservation with no existing dispatch intent. */
  issue(reservationId: string): ReservationReceiptV1 {
    if (typeof reservationId !== "string" || !idPattern.test(reservationId)) invalid("Invalid reservation ID.");
    const { nowMs, lease } = this.liveLease();
    this.database.exec("BEGIN;");
    try {
      this.assertLedgerAuthority();
      const reservation = this.reservation(reservationId);
      if (!reservation || reservation.state !== "held" || reservation.lease_epoch !== lease.epoch
        || Date.parse(reservation.expires_at) <= nowMs) conflict("Reservation is not a live hold for the current lease.");
      this.assertAdmission(reservationId, reservation);
      if (this.intent(reservationId)) conflict("A dispatch intent already exists; receipt reissue is forbidden.");
      const body = { schemaVersion: "1.0.0" as const, authorityId: this.authority.authorityId,
        realmId: this.authority.realmId, ownerId: lease.ownerId, leaseId: lease.leaseId,
        leaseEpoch: lease.epoch, reservationId, requestDigest: reservation.request_digest,
        expiresAt: reservation.expires_at };
      const receipt = { ...body, mac: this.mac(body) };
      this.database.exec("COMMIT;");
      return receipt;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Keep the original failure. */ }
      throw error;
    }
  }

  /** Called by the owning runtime immediately before start; never by an untrusted caller as authorization. */
  verifyForLaunch(value: unknown): { reservationId: string; intentId: string; requestDigest: string } {
    const receipt = validateReceipt(value);
    const { mac, ...body } = receipt;
    const expected = Buffer.from(this.mac(body).slice("hmac-sha256:".length), "hex");
    const actual = Buffer.from(mac.slice("hmac-sha256:".length), "hex");
    if (!timingSafeEqual(actual, expected)) conflict("Reservation receipt authentication failed.");
    const { nowMs, lease } = this.liveLease();
    if (receipt.authorityId !== this.authority.authorityId || receipt.realmId !== this.authority.realmId
      || receipt.ownerId !== lease.ownerId || receipt.leaseId !== lease.leaseId
      || receipt.leaseEpoch !== lease.epoch || Date.parse(receipt.expiresAt) <= nowMs) {
      conflict("Reservation receipt belongs to a stale authority lease.");
    }
    this.database.exec("BEGIN;");
    try {
      this.assertLedgerAuthority();
      const reservation = this.reservation(receipt.reservationId);
      if (!reservation || reservation.state !== "committed"
        || reservation.lease_epoch !== lease.epoch
        || reservation.request_digest !== receipt.requestDigest
        || reservation.expires_at !== receipt.expiresAt
        || Date.parse(reservation.expires_at) <= nowMs) {
        conflict("Reservation receipt does not match a live committed reservation.");
      }
      this.assertAdmission(receipt.reservationId, reservation);
      const intent = this.intent(receipt.reservationId);
      if (!intent || intent.state !== "committed" || intent.request_digest !== receipt.requestDigest) {
        conflict("Reservation has no matching committed dispatch intent.");
      }
      this.database.exec("COMMIT;");
      return { reservationId: receipt.reservationId, intentId: intent.intent_id,
        requestDigest: receipt.requestDigest };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Keep the original failure. */ }
      throw error;
    }
  }

  private mac(body: Omit<ReservationReceiptV1, "mac">): string {
    return `hmac-sha256:${createHmac("sha256", this.signingKey)
      .update(canonicalJson({ domain: "resource-reservation-receipt-v1", ...body })).digest("hex")}`;
  }

  private liveLease(): { nowMs: number; lease: CurrentResourceLeaseV1 } {
    const nowMs = Date.parse(this.clock());
    if (!Number.isFinite(nowMs)) invalid("Trusted resource clock is invalid.");
    const lease = this.currentLease();
    if (!lease || lease.authorityId !== this.authority.authorityId || lease.realmId !== this.authority.realmId
      || typeof lease.ownerId !== "string" || !idPattern.test(lease.ownerId)
      || typeof lease.leaseId !== "string" || !idPattern.test(lease.leaseId)
      || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0
      || !validTime(lease.expiresAt) || Date.parse(lease.expiresAt) <= nowMs) {
      conflict("No current resource authority lease is available.");
    }
    return { nowMs, lease };
  }

  private assertLedgerAuthority(): void {
    const marker = this.database.prepare(`SELECT realm_id, authority_id, owner_mode
      FROM resource_authority WHERE id = 1`).get() as
      { realm_id: string; authority_id: string; owner_mode: string } | undefined;
    if (!marker || marker.realm_id !== this.authority.realmId
      || marker.authority_id !== this.authority.authorityId || marker.owner_mode !== "single-broker") {
      corrupt("Resource ledger authority marker changed.");
    }
  }

  private reservation(reservationId: string): ReservationRow | undefined {
    return this.database.prepare(`SELECT request_key, request_digest, lease_epoch, state, expires_at
      FROM resource_reservations WHERE reservation_id = ?`).get(reservationId) as ReservationRow | undefined;
  }

  private assertAdmission(reservationId: string, reservation: ReservationRow): void {
    const admission = this.database.prepare(`SELECT request_digest, state, reservation_id
      FROM resource_admission_requests WHERE request_key = ?`).get(reservation.request_key) as
      AdmissionRow | undefined;
    if (!admission || admission.state !== "admitted" || admission.reservation_id !== reservationId
      || admission.request_digest !== reservation.request_digest) {
      corrupt("Reservation has no matching admitted request journal.");
    }
  }

  private intent(reservationId: string): IntentRow | undefined {
    return this.database.prepare(`SELECT intent_id, request_digest, state
      FROM resource_intents WHERE reservation_id = ?`).get(reservationId) as IntentRow | undefined;
  }
}
