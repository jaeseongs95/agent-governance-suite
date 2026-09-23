import { createHash } from "node:crypto";

import { canonicalJson } from "../convergence-logic.js";
import type { PoolAdmissionRequestV1, PoolAdmissionResultV1 } from "./admit-pool.js";
import { validatePoolAdmissionRequestV1 } from "./admit-pool.js";
import type { MultiPoolAdmissionRequestV1, MultiPoolAdmissionResultV1 } from "./admit-pools.js";
import { validateMultiPoolAdmissionRequestV1 } from "./admit-pools.js";
import { validateCollectorResponseV1, type CollectorSourceV1,
  type ResourceCollectorResponseV1 } from "./collector-port.js";
import type { CoverageProjectionV1 } from "./coverage-projection.js";
import type { ReservationCommitResultV1 } from "./commit-reservation.js";
import type { ReservationReleaseResultV1 } from "./release-reservation.js";
import type { ReconciliationRevisionV1, ResourceUsageReconciliationStore } from "./reconcile-usage.js";
import type { ReservationReceiptV1 } from "./reservation-receipt.js";
import type { SettlementResultV1 } from "./settle-reservation.js";
import type { MarkUncertainResultV1 } from "./uncertain-reservation.js";
import type { WindowRolloverV1 } from "./window-rollover.js";
import { SESSION_MESSAGE_PROTOCOL } from "../session-message-protocol.js";

export const RESOURCE_ADMISSION_FEATURE = "resource-admission.v1";
export const RESOURCE_BROKER_OPERATION = "resource-admission";
export type ResourceBrokerRole = "reader" | "owner" | "collector";

export interface ResourceBrokerOperations {
  "read-observation": { request: { observationId: string }; result: ResourceCollectorResponseV1 | null };
  "read-rollover": { request: { accountScope: string; poolId: string; windowId: string }; result: WindowRolloverV1 | null };
  "read-reconciliation": { request: { accountScope: string; poolId: string; windowId: string }; result: CoverageProjectionV1 | null };
  "collect-observation": { request: { collectorId: string }; result: { kind: "applied" | "duplicate" | "out-of-order" | "resync-required"; observationId: string | null } };
  "admit-pool": { request: { request: PoolAdmissionRequestV1 }; result: PoolAdmissionResultV1 };
  "admit-pools": { request: { request: MultiPoolAdmissionRequestV1 }; result: MultiPoolAdmissionResultV1 };
  "issue-receipt": { request: { reservationId: string }; result: ReservationReceiptV1 };
  "commit-reservation": { request: { reservationId: string; intentId: string }; result: ReservationCommitResultV1 };
  "release-reservation": { request: { reservationId: string; evidenceRef?: string }; result: ReservationReleaseResultV1 };
  "mark-uncertain": { request: { reservationId: string; reason: "response-timeout" | "receipt-lost" | "owner-restarted" }; result: MarkUncertainResultV1 };
  "settle-reservation": { request: { evidenceRef: string }; result: SettlementResultV1 };
  "reconcile-usage": { request: { expected: ReconciliationRevisionV1; evidenceRef: string }; result: ReturnType<ResourceUsageReconciliationStore["apply"]> };
}
export type ResourceBrokerOperation = keyof ResourceBrokerOperations;
export type ResourceBrokerRequestV1<O extends ResourceBrokerOperation = ResourceBrokerOperation> = { [K in O]: {
  schemaVersion: "1.0.0";
  feature: typeof RESOURCE_ADMISSION_FEATURE;
  requestId: string;
  operation: K;
  args: ResourceBrokerOperations[K]["request"];
} }[O];
export type ResourceBrokerResultV1<O extends ResourceBrokerOperation = ResourceBrokerOperation> = { [K in O]: {
  schemaVersion: "1.0.0";
  requestId: string;
  operation: K;
  kind: "resource-result";
  result: ResourceBrokerOperations[K]["result"];
} }[O];

/** Server-owned role binding; a caller role claim is never a wire field. */
export const RESOURCE_BROKER_ALLOWED_OPERATIONS: Readonly<Record<ResourceBrokerRole, readonly ResourceBrokerOperation[]>> = {
  reader: ["read-observation", "read-rollover", "read-reconciliation"],
  owner: ["admit-pool", "admit-pools", "issue-receipt", "commit-reservation",
    "release-reservation", "mark-uncertain", "settle-reservation", "reconcile-usage"],
  collector: ["collect-observation"],
};

const id = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const account = /^acct-hmac-sha256:[a-f0-9]{64}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
const operations = new Set<ResourceBrokerOperation>(Object.values(RESOURCE_BROKER_ALLOWED_OPERATIONS).flat());

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(raw: unknown): Record<string, unknown> {
  check(raw && typeof raw === "object" && !Array.isArray(raw), "Expected a resource broker object.");
  return raw as Record<string, unknown>;
}
function exact(raw: Record<string, unknown>, keys: readonly string[]): void {
  check(Object.keys(raw).length === keys.length && keys.every(key => Object.hasOwn(raw, key)),
    "Invalid resource broker fields.");
}
function key(value: unknown): value is string { return typeof value === "string" && id.test(value); }
function amount(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function optionalAmount(value: unknown): boolean { return value === null || amount(value); }

function validateRolloverResult(result: Record<string, unknown>): void {
  exact(result, ["observationId", "resetEpoch", "revision", "carryover"]);
  check(typeof result.observationId === "string" && digest.test(result.observationId)
    && Number.isSafeInteger(result.resetEpoch) && Number(result.resetEpoch) >= 0
    && Number.isSafeInteger(result.revision) && Number(result.revision) >= 0
    && Array.isArray(result.carryover), "Invalid rollover result.");
  const seen = new Set<string>();
  for (const raw of result.carryover) {
    const item = object(raw);
    exact(item, ["reservationId", "originalResetEpoch", "state", "intentId", "heldAmount",
      "unit", "coverage", "observedAmount", "inclusion"]);
    check(key(item.reservationId) && !seen.has(item.reservationId)
      && Number.isSafeInteger(item.originalResetEpoch) && Number(item.originalResetEpoch) >= 0
      && Number(item.originalResetEpoch) < Number(result.resetEpoch)
      && ["held", "committed", "uncertain", "settled"].includes(String(item.state))
      && (item.intentId === null || key(item.intentId)) && amount(item.heldAmount)
      && key(item.unit) && (item.coverage === null
        || ["partial", "complete", "unknown"].includes(String(item.coverage)))
      && optionalAmount(item.observedAmount) && item.inclusion === "unknown",
    "Invalid rollover carryover.");
    seen.add(item.reservationId);
  }
}

function validateReconciliationResult(result: Record<string, unknown>): void {
  exact(result, ["providerMetric", "internalSlotBudget", "eventInclusion", "needsReconciliation"]);
  const metric = object(result.providerMetric), budget = object(result.internalSlotBudget);
  exact(metric, ["unit", "metricKind", "observedAmount", "coverage", "knownExcludedDelta", "projectedAmount"]);
  exact(budget, ["unit", "reservedAmount", "observedUse"]);
  check(key(metric.unit) && ["used", "remaining"].includes(String(metric.metricKind))
    && optionalAmount(metric.observedAmount)
    && ["partial", "complete", "unknown"].includes(String(metric.coverage))
    && amount(metric.knownExcludedDelta)
    && (metric.projectedAmount === null || typeof metric.projectedAmount === "number"
      && Number.isFinite(metric.projectedAmount))
    && budget.unit === "slot" && amount(budget.reservedAmount)
    && optionalAmount(budget.observedUse)
    && typeof result.needsReconciliation === "boolean" && Array.isArray(result.eventInclusion),
  "Invalid reconciliation projection.");
  const seen = new Set<string>();
  for (const raw of result.eventInclusion) {
    const item = object(raw);
    exact(item, ["eventId", "status"]);
    check(key(item.eventId) && !seen.has(item.eventId)
      && ["included", "excluded", "unknown", "different-unit"].includes(String(item.status)),
    "Invalid reconciliation event inclusion.");
    seen.add(item.eventId);
  }
}

/** Old brokers return unsupported; an unknown transport version is a protocol error. */
export function negotiateResourceAdmission(rawPing: unknown): boolean {
  const ping = object(rawPing);
  check(ping.protocolVersion === SESSION_MESSAGE_PROTOCOL && Array.isArray(ping.capabilities)
    && ping.capabilities.every(value => typeof value === "string"),
  "Invalid resource broker negotiation response.");
  return ping.capabilities.includes(RESOURCE_ADMISSION_FEATURE);
}

/** Decode only after a successful ping and a trusted server-side role lookup.
 * Evidence refs are resolved by the owner; no caller JSON becomes verified evidence. */
export function validateResourceBrokerRequest(raw: unknown, featureAvailable: boolean,
  role: ResourceBrokerRole): ResourceBrokerRequestV1 {
  check(featureAvailable, "Resource admission was not negotiated.");
  check(Object.hasOwn(RESOURCE_BROKER_ALLOWED_OPERATIONS, role), "Unknown resource broker role.");
  const request = object(raw);
  exact(request, ["schemaVersion", "feature", "requestId", "operation", "args"]);
  check(request.schemaVersion === "1.0.0" && request.feature === RESOURCE_ADMISSION_FEATURE,
    "Unsupported resource admission version.");
  check(key(request.requestId), "Invalid resource request ID.");
  check(typeof request.operation === "string" && operations.has(request.operation as ResourceBrokerOperation),
    "Unknown resource broker operation.");
  const operation = request.operation as ResourceBrokerOperation;
  check(RESOURCE_BROKER_ALLOWED_OPERATIONS[role].includes(operation), "Resource operation is not allowed for this role.");
  const args = object(request.args);
  switch (operation) {
    case "read-observation": exact(args, ["observationId"]); check(typeof args.observationId === "string" && digest.test(args.observationId), "Invalid observation ID."); break;
    case "read-rollover": case "read-reconciliation":
      exact(args, ["accountScope", "poolId", "windowId"]);
      check(typeof args.accountScope === "string" && account.test(args.accountScope)
        && key(args.poolId) && key(args.windowId), "Invalid resource window scope."); break;
    case "collect-observation": exact(args, ["collectorId"]); check(key(args.collectorId), "Invalid collector ID."); break;
    case "admit-pool": exact(args, ["request"]); validatePoolAdmissionRequestV1(args.request); break;
    case "admit-pools": exact(args, ["request"]); validateMultiPoolAdmissionRequestV1(args.request); break;
    case "issue-receipt": exact(args, ["reservationId"]); check(key(args.reservationId), "Invalid reservation ID."); break;
    case "commit-reservation": exact(args, ["reservationId", "intentId"]);
      check(key(args.reservationId) && key(args.intentId), "Invalid commit identifiers."); break;
    case "release-reservation":
      check(Object.keys(args).every(field => field === "reservationId" || field === "evidenceRef")
        && Object.hasOwn(args, "reservationId") && key(args.reservationId)
        && (!Object.hasOwn(args, "evidenceRef") || key(args.evidenceRef)), "Invalid release reference."); break;
    case "mark-uncertain": exact(args, ["reservationId", "reason"]);
      check(key(args.reservationId) && ["response-timeout", "receipt-lost", "owner-restarted"].includes(String(args.reason)),
        "Invalid uncertainty signal."); break;
    case "settle-reservation": exact(args, ["evidenceRef"]); check(key(args.evidenceRef), "Invalid settlement reference."); break;
    case "reconcile-usage": {
      exact(args, ["expected", "evidenceRef"]);
      check(key(args.evidenceRef), "Invalid reconciliation reference.");
      const expected = object(args.expected);
      exact(expected, ["accountScope", "poolId", "windowId", "observationId", "resetEpoch", "revision", "ledgerDigest", "generation"]);
      check(typeof expected.accountScope === "string" && account.test(expected.accountScope)
        && key(expected.poolId) && key(expected.windowId)
        && typeof expected.observationId === "string" && digest.test(expected.observationId)
        && typeof expected.ledgerDigest === "string" && digest.test(expected.ledgerDigest)
        && [expected.resetEpoch, expected.revision, expected.generation].every(value =>
          Number.isSafeInteger(value) && Number(value) >= 0), "Invalid reconciliation revision.");
      break;
    }
  }
  return request as unknown as ResourceBrokerRequestV1;
}

/** A TLS `{ok:true}` transport ACK is not a ledger result or a launch receipt. */
export function validateResourceBrokerResult(raw: unknown,
  request: ResourceBrokerRequestV1): ResourceBrokerResultV1 {
  const reply = object(raw);
  exact(reply, ["schemaVersion", "requestId", "operation", "kind", "result"]);
  check(reply.schemaVersion === "1.0.0" && reply.requestId === request.requestId
    && reply.operation === request.operation && reply.kind === "resource-result",
  "Resource result is not bound to its request.");
  if (request.operation.startsWith("read-") && reply.result === null) return reply as unknown as ResourceBrokerResultV1;
  const result = object(reply.result);
  if (request.operation === "read-observation") {
    const response = validateCollectorResponseV1(result, {
      collectorId: String(result.collectorId), source: result.source as CollectorSourceV1,
      accountScope: String(result.accountScope), resourcePoolId: String(result.resourcePoolId),
    });
    check(`sha256:${createHash("sha256").update(canonicalJson(response)).digest("hex")}`
      === request.args.observationId, "Observation result digest differs from the request.");
  } else if (request.operation === "read-rollover") {
    validateRolloverResult(result);
  } else if (request.operation === "read-reconciliation") {
    validateReconciliationResult(result);
  } else if (request.operation === "admit-pool" || request.operation === "admit-pools") {
    check(["admitted", "rejected", "deferred"].includes(String(result.kind)), "Invalid admission result.");
    if (result.kind === "admitted") {
      exact(result, request.operation === "admit-pool" ? ["kind", "reservationId"]
        : ["kind", "reservationId", "poolCount"]);
      check(key(result.reservationId) && (request.operation === "admit-pool"
        || Number.isSafeInteger(result.poolCount) && Number(result.poolCount) >= 2),
      "Invalid admitted reservation.");
    } else {
      exact(result, request.operation === "admit-pool" ? ["kind", "reason"]
        : ["kind", "reason", "failedPool"]);
      check(typeof result.reason === "string" && result.reason.length > 0, "Invalid rejection reason.");
      if (request.operation === "admit-pools" && result.failedPool !== null) {
        const failed = object(result.failedPool);
        exact(failed, ["accountScope", "resourcePoolId"]);
        check(typeof failed.accountScope === "string" && account.test(failed.accountScope)
          && key(failed.resourcePoolId), "Invalid failed pool.");
      }
    }
  } else if (request.operation === "issue-receipt") {
    exact(result, ["schemaVersion", "authorityId", "realmId", "ownerId", "leaseId",
      "leaseEpoch", "reservationId", "requestDigest", "expiresAt", "mac"]);
    check(result.schemaVersion === "1.0.0" && result.authorityId === "ags-resource-authority-v1"
      && result.reservationId === request.args.reservationId
      && typeof result.realmId === "string" && /^[a-f0-9]{64}$/u.test(result.realmId)
      && key(result.ownerId) && key(result.leaseId)
      && Number.isSafeInteger(result.leaseEpoch) && Number(result.leaseEpoch) >= 0
      && typeof result.requestDigest === "string" && digest.test(result.requestDigest)
      && typeof result.expiresAt === "string" && Number.isFinite(Date.parse(result.expiresAt))
      && typeof result.mac === "string" && /^hmac-sha256:[a-f0-9]{64}$/u.test(result.mac),
    "Resource receipt is missing or mismatched.");
  } else if (request.operation === "collect-observation") {
    exact(result, ["kind", "observationId"]);
    check(["applied", "duplicate", "out-of-order", "resync-required"].includes(String(result.kind))
      && (result.observationId === null || typeof result.observationId === "string"
        && digest.test(result.observationId)), "Invalid collector result.");
  } else if (request.operation === "reconcile-usage") {
    exact(result, ["kind", "projection"]);
    check(["applied", "duplicate", "stale"].includes(String(result.kind))
      && (result.kind === "stale" ? result.projection === null : result.projection !== null),
    "Invalid reconciliation result.");
    if (result.projection !== null) validateReconciliationResult(object(result.projection));
  } else if (request.operation === "commit-reservation") {
    exact(result, ["kind", "reservationId", "intentId", "replayed"]);
    check(result.kind === "committed" && result.reservationId === request.args.reservationId
      && result.intentId === request.args.intentId && typeof result.replayed === "boolean",
    "Invalid commit result.");
  } else if (request.operation === "release-reservation") {
    exact(result, ["kind", "reservationId"]);
    check(["released", "already-released"].includes(String(result.kind))
      && result.reservationId === request.args.reservationId, "Invalid release result.");
  } else if (request.operation === "mark-uncertain") {
    exact(result, ["kind", "reservationId", "intentId", "replayed"]);
    check(result.kind === "observe-required" && result.reservationId === request.args.reservationId
      && key(result.intentId) && typeof result.replayed === "boolean",
    "Invalid uncertainty result.");
  } else if (request.operation === "settle-reservation") {
    exact(result, ["kind", "reservationId", "replayed", "coverage", "observed"]);
    check(["recorded", "settled"].includes(String(result.kind)) && key(result.reservationId)
      && typeof result.replayed === "boolean"
      && ["partial", "complete", "unknown"].includes(String(result.coverage))
      && Array.isArray(result.observed), "Invalid settlement result.");
    for (const raw of result.observed) {
      const item = object(raw);
      exact(item, ["accountScope", "poolId", "windowId", "unit", "estimatedAmount",
        "observedAmount", "coverage"]);
      check(typeof item.accountScope === "string" && account.test(item.accountScope)
        && key(item.poolId) && key(item.windowId) && key(item.unit)
        && amount(item.estimatedAmount) && optionalAmount(item.observedAmount)
        && ["partial", "complete", "unknown"].includes(String(item.coverage)),
      "Invalid settled usage observation.");
    }
  }
  return reply as unknown as ResourceBrokerResultV1;
}
