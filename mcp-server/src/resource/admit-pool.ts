import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError, type ResourcePolicyV1 } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { validateCollectorResponseV1, type CollectorSourceV1 } from "./collector-port.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

export interface PoolAdmissionRequestV1 {
  requestKey: string;
  taskId: string;
  runId: string;
  slotId: string;
  attemptId: string;
  planRevision: number;
  leaseEpoch: number;
  accountScope: string;
  resourcePoolId: string;
  expiresAt: string;
  windows: Array<{ windowId: string; amount: number; unit: string }>;
}

export type PoolAdmissionResultV1 =
  | { kind: "admitted"; reservationId: string }
  | { kind: "rejected" | "deferred"; reason: string };

type WindowRow = { window_id: string; observation_id: string; reset_epoch: number; revision: number;
  bucket_id: string; unit: string; remaining: number | null; observed_at: string; expires_at: string;
  payload_digest: string; payload_json: string; collector_id: string; sequence: number };
type SettledHold = { reservation_id: string; reset_epoch: number; unit: string;
  coverage: string | null; observed_amount: number | null; updated_at: string | null;
  coverage_unit: string | null };

const validator = new ContractValidator();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const accountPattern = /^acct-hmac-sha256:[a-f0-9]{64}$/u;
const unitPattern = /^[A-Za-z][A-Za-z0-9._:/@+-]{0,63}$/u;

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }

/** The owning service supplies vetted costs and a server-owned policy, never model-authored policy or clock values. */
export function validatePoolAdmissionRequestV1(value: unknown): PoolAdmissionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid pool admission request.");
  const request = value as Record<string, unknown>;
  const keys = ["requestKey", "taskId", "runId", "slotId", "attemptId", "planRevision", "leaseEpoch",
    "accountScope", "resourcePoolId", "expiresAt", "windows"];
  if (Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key))
    || ["requestKey", "taskId", "runId", "slotId", "attemptId", "resourcePoolId"]
      .some(key => typeof request[key] !== "string" || !idPattern.test(request[key] as string))
    || typeof request.accountScope !== "string" || !accountPattern.test(request.accountScope)
    || !Number.isSafeInteger(request.planRevision) || (request.planRevision as number) < 0
    || !Number.isSafeInteger(request.leaseEpoch) || (request.leaseEpoch as number) < 0
    || typeof request.expiresAt !== "string" || !Number.isFinite(Date.parse(request.expiresAt))
    || !Array.isArray(request.windows) || request.windows.length < 1 || request.windows.length > 64) {
    invalid("Invalid pool admission request fields.");
  }
  const windows = request.windows as unknown[];
  if (windows.some(value => !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3 || !["windowId", "amount", "unit"].every(key => Object.hasOwn(value, key)))) {
    invalid("Invalid pool admission window.");
  }
  const costs = windows as PoolAdmissionRequestV1["windows"];
  if (new Set(costs.map(cost => cost.windowId)).size !== costs.length
    || costs.some(cost => typeof cost.windowId !== "string" || !idPattern.test(cost.windowId)
      || typeof cost.unit !== "string" || !unitPattern.test(cost.unit)
      || typeof cost.amount !== "number" || !Number.isFinite(cost.amount) || cost.amount <= 0)) {
    invalid("Invalid or duplicate pool admission cost.");
  }
  return structuredClone(value) as PoolAdmissionRequestV1;
}

function decimal(value: number): { coefficient: bigint; scale: number } {
  if (!Number.isFinite(value) || value < 0) corrupt("Stored resource quantity is invalid.");
  const [mantissa, exponent = "0"] = String(value).split("e");
  const [whole, fraction = ""] = mantissa!.split(".");
  const power = Number(exponent) - fraction.length;
  const coefficient = BigInt(whole! + fraction);
  return power >= 0 ? { coefficient: coefficient * 10n ** BigInt(power), scale: 0 }
    : { coefficient, scale: -power };
}

function covers(remaining: number, floor: number, amount: number, held: number[]): boolean {
  const values = [remaining, floor, amount, ...held].map(decimal);
  const scale = Math.max(...values.map(value => value.scale));
  const scaled = values.map(value => value.coefficient * 10n ** BigInt(scale - value.scale));
  return scaled[0]! >= scaled.slice(1).reduce((sum, value) => sum + value, 0n);
}

function unknown(policy: ResourcePolicyV1, reason: string, stale = false): PoolAdmissionResultV1 {
  return { kind: (stale ? policy.onStale : policy.onUnknown) === "defer" ? "deferred" : "rejected", reason };
}

function evidenceWindow(row: WindowRow, accountScope: string, poolId: string) {
  let raw: unknown;
  try { raw = JSON.parse(row.payload_json); } catch { corrupt("Stored collector evidence is not JSON."); }
  const source = (raw as Record<string, unknown> | null)?.source as CollectorSourceV1;
  let response;
  try {
    response = validateCollectorResponseV1(raw, { collectorId: row.collector_id, source,
      accountScope, resourcePoolId: poolId });
  } catch { corrupt("Stored collector evidence does not satisfy its contract."); }
  const digest = `sha256:${createHash("sha256").update(canonicalJson(response)).digest("hex")}`;
  if (canonicalJson(response) !== row.payload_json || digest !== row.payload_digest
    || digest !== row.observation_id || response.sequence !== row.sequence) {
    corrupt("Stored collector evidence digest or sequence differs.");
  }
  const windows = response.kind === "full" ? response.snapshot.windows
    : response.kind === "delta" ? response.upsertWindows : [];
  const window = windows.find(item => item.windowId === row.window_id);
  if (!window) return null;
  if (window.resetEpoch !== row.reset_epoch || window.revision !== row.revision
    || window.limitBucket.bucketId !== row.bucket_id || window.limitBucket.unit !== row.unit
    || window.limitBucket.remaining !== row.remaining || window.observedAt !== row.observed_at
    || window.expiresAt !== row.expires_at) corrupt("Current window differs from its original evidence.");
  return window;
}

function reconciledRemaining(database: DatabaseSync, row: WindowRow,
  accountScope: string, poolId: string): number | null {
  const exists = database.prepare(`SELECT 1 FROM sqlite_schema
    WHERE type='table' AND name='resource_usage_reconciliation'`).get();
  if (!exists) return null;
  const stored = database.prepare(`SELECT observation_id,ledger_digest,projection_digest,projection_json
    FROM resource_usage_reconciliation WHERE account_scope=? AND pool_id=? AND window_id=?`).get(
    accountScope, poolId, row.window_id) as { observation_id: string; ledger_digest: string;
      projection_digest: string; projection_json: string } | undefined;
  if (!stored || stored.observation_id !== row.observation_id) return null;
  const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  if (hash(stored.projection_json) !== stored.projection_digest) corrupt("Reconciliation projection is corrupt.");
  const holds = database.prepare(`SELECT h.reservation_id,h.reset_epoch,h.amount,h.unit,r.state
    FROM resource_reservation_holds h JOIN resource_reservations r USING(reservation_id)
    WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=? ORDER BY h.reservation_id`)
    .all(accountScope, poolId, row.window_id);
  const events = database.prepare(`SELECT * FROM resource_usage_events
    WHERE account_scope=? AND pool_id=? AND window_id=? ORDER BY event_id,reservation_id`)
    .all(accountScope, poolId, row.window_id);
  const coverage = database.prepare(`SELECT reservation_id,coverage,observed_amount,unit,updated_at
    FROM resource_usage_coverage WHERE account_scope=? AND pool_id=? AND window_id=?
    ORDER BY reservation_id`).all(accountScope, poolId, row.window_id);
  const terminals = database.prepare(`SELECT t.* FROM resource_terminal_evidence t
    JOIN resource_reservation_holds h ON h.reservation_id=t.reservation_id
    WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=?
    ORDER BY t.evidence_id`).all(accountScope, poolId, row.window_id);
  if (hash(canonicalJson({ holds, events, coverage, terminals })) !== stored.ledger_digest) return null;
  let projection: { needsReconciliation?: boolean; providerMetric?: {
    unit?: string; metricKind?: string; coverage?: string;
    observedAmount?: number | null; projectedAmount?: number | null } };
  try { projection = JSON.parse(stored.projection_json) as typeof projection; }
  catch { corrupt("Reconciliation projection is not JSON."); }
  const metric = projection.providerMetric;
  if (projection.needsReconciliation !== false || metric?.unit !== row.unit
    || metric.metricKind !== "remaining" || metric.coverage !== "complete"
    || metric.observedAmount !== row.remaining || typeof metric.projectedAmount !== "number"
    || !Number.isFinite(metric.projectedAmount)) return null;
  return metric.projectedAmount;
}

/** Requires an existing BEGIN IMMEDIATE transaction and reservation header; does not commit or roll back. */
export function reservePoolInTransaction(database: DatabaseSync, policy: ResourcePolicyV1,
  request: PoolAdmissionRequestV1, reservationId: string, now: string): PoolAdmissionResultV1 {
  if (!database.isTransaction) invalid("Pool reservation requires the caller's write transaction.");
  const approved = validator.resourcePolicyV1(policy);
  const input = validatePoolAdmissionRequestV1(request);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs) || Date.parse(input.expiresAt) <= nowMs
    || input.accountScope !== approved.accountScope || input.resourcePoolId !== approved.resourcePoolId
    || input.windows.length !== approved.windows.length) invalid("Pool request does not match its approved policy.");
  const header = database.prepare(`SELECT request_key, task_id, run_id, slot_id, attempt_id,
    plan_revision, lease_epoch, state, expires_at
    FROM resource_reservations WHERE reservation_id = ?`).get(reservationId) as
    { request_key: string; task_id: string; run_id: string; slot_id: string; attempt_id: string;
      plan_revision: number; lease_epoch: number; state: string; expires_at: string } | undefined;
  if (!header || header.request_key !== input.requestKey || header.task_id !== input.taskId || header.run_id !== input.runId
    || header.slot_id !== input.slotId || header.attempt_id !== input.attemptId
    || header.plan_revision !== input.planRevision || header.lease_epoch !== input.leaseEpoch
    || header.expires_at !== input.expiresAt || header.state !== "held") {
    invalid("Reservation header does not bind to the pool request.");
  }
  const pool = database.prepare("SELECT access_path FROM resource_pools WHERE account_scope = ? AND pool_id = ?")
    .get(input.accountScope, input.resourcePoolId) as { access_path: string } | undefined;
  if (!pool) return unknown(approved, "OBSERVATION_MISSING");
  if (!approved.allowedAccessPaths.includes(pool.access_path as ResourcePolicyV1["allowedAccessPaths"][number])
    || (pool.access_path === "api" || pool.access_path === "enterprise") && !approved.paidAccessApproval) {
    return { kind: "rejected", reason: "ACCESS_PATH_DENIED" };
  }
  const rows = database.prepare(`SELECT w.*, o.payload_digest, o.payload_json, o.collector_id, o.sequence
    FROM resource_window_observations w JOIN resource_observations o ON o.observation_id = w.observation_id
    WHERE w.account_scope = ? AND w.pool_id = ?`).all(input.accountScope, input.resourcePoolId) as WindowRow[];
  if (rows.length !== approved.windows.length) return unknown(approved, "OBSERVATION_COVERAGE");
  const byId = new Map(rows.map(row => [row.window_id, row]));
  if (byId.size !== rows.length) corrupt("Duplicate current resource window.");
  const holds: Array<{ windowId: string; resetEpoch: number; amount: number; unit: string }> = [];
  for (const rule of approved.windows) {
    const row = byId.get(rule.windowId);
    const cost = input.windows.find(item => item.windowId === rule.windowId);
    if (!cost || cost.unit !== rule.unit) invalid("A cost in the policy's explicit local unit is required for every window.");
    if (!row || row.remaining === null) return unknown(approved, "OBSERVATION_UNKNOWN");
    const window = evidenceWindow(row, input.accountScope, input.resourcePoolId);
    if (!window) return unknown(approved, "OBSERVATION_UNAVAILABLE");
    if (window.limitBucket.kind === "subscription-percent" || window.limitBucket.bucketId !== rule.bucketId
      || window.limitBucket.unit !== rule.unit || row.unit !== rule.unit) {
      return { kind: "rejected", reason: "UNIT_UNSUPPORTED" };
    }
    if (window.coverage !== "complete" || window.source.kind === "user-declared"
      || window.source.kind === "provider-observation" && !window.source.evidenceDigest) {
      return unknown(approved, "OBSERVATION_UNTRUSTED");
    }
    if (nowMs < Date.parse(window.observedAt) || nowMs >= Date.parse(window.expiresAt)) {
      return unknown(approved, "OBSERVATION_STALE", true);
    }
    const settled = database.prepare(`SELECT h.reservation_id,h.reset_epoch,h.unit,
      c.coverage,c.observed_amount,c.updated_at,c.unit AS coverage_unit
      FROM resource_reservation_holds h
      JOIN resource_reservations r ON r.reservation_id=h.reservation_id
      LEFT JOIN resource_usage_coverage c ON c.reservation_id=h.reservation_id
        AND c.account_scope=h.account_scope AND c.pool_id=h.pool_id AND c.window_id=h.window_id
      WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=? AND r.state='settled'`)
      .all(input.accountScope, input.resourcePoolId, rule.windowId) as SettledHold[];
    if (settled.some(item => item.unit !== rule.unit
      || item.coverage_unit !== null && item.coverage_unit !== rule.unit)) {
      return { kind: "rejected", reason: "SETTLED_USAGE_UNIT_MISMATCH" };
    }
    if (settled.some(item => item.coverage !== "complete" || item.observed_amount === null
      || item.reset_epoch !== row.reset_epoch)) {
      return unknown(approved, "SETTLED_USAGE_UNKNOWN");
    }
    if (settled.length) {
      const hasOrigin = database.prepare(`SELECT 1 FROM sqlite_schema
        WHERE type='table' AND name='resource_settlement_projection'`).get();
      if (!hasOrigin) return unknown(approved, "SETTLED_USAGE_UNKNOWN");
      for (const item of settled) {
        const origin = database.prepare(`SELECT row_digest FROM resource_settlement_projection
          WHERE reservation_id=? AND account_scope=? AND pool_id=? AND window_id=?`).get(
          item.reservation_id, input.accountScope, input.resourcePoolId, rule.windowId) as
          { row_digest: string } | undefined;
        const rowDigest = `sha256:${createHash("sha256").update(canonicalJson({
          coverage: item.coverage, observedAmount: item.observed_amount,
          unit: item.coverage_unit, updatedAt: item.updated_at })).digest("hex")}`;
        if (origin?.row_digest !== rowDigest) return unknown(approved, "SETTLED_USAGE_UNKNOWN");
      }
    }
    const remaining = settled.length
      ? reconciledRemaining(database, row, input.accountScope, input.resourcePoolId) : row.remaining;
    if (remaining === null) return unknown(approved, "SNAPSHOT_COVERAGE_UNKNOWN");
    const prior = database.prepare(`SELECT h.amount, h.unit FROM resource_reservation_holds h
      JOIN resource_reservations r ON r.reservation_id = h.reservation_id
      WHERE h.account_scope = ? AND h.pool_id = ? AND h.window_id = ?
        AND r.state IN ('held','committed','uncertain')`)
      .all(input.accountScope, input.resourcePoolId, rule.windowId) as
      Array<{ amount: number; unit: string }>;
    if (prior.some(item => item.unit !== rule.unit)) {
      return { kind: "rejected", reason: "IN_FLIGHT_UNIT_MISMATCH" };
    }
    // A protected-role exception requires an authenticated slot reader; B04 applies the reserve to every request.
    const floor = Math.max(rule.hardLimit?.minimumRemaining ?? 0,
      rule.reservePolicy?.hardReserve?.minimumRemaining ?? 0);
    if (remaining < 0 || !covers(remaining, floor, cost.amount, prior.map(item => item.amount))) {
      return { kind: "rejected", reason: "INSUFFICIENT_LOCAL_CAPACITY" };
    }
    holds.push({ windowId: rule.windowId, resetEpoch: row.reset_epoch, amount: cost.amount, unit: rule.unit });
  }
  const insert = database.prepare(`INSERT INTO resource_reservation_holds
    (reservation_id,account_scope,pool_id,window_id,reset_epoch,amount,unit) VALUES (?,?,?,?,?,?,?)`);
  for (const hold of holds) insert.run(reservationId, input.accountScope, input.resourcePoolId,
    hold.windowId, hold.resetEpoch, hold.amount, hold.unit);
  return { kind: "admitted", reservationId };
}

/** The single-pool wrapper is the only transaction owner; B05 reuses reservePoolInTransaction. */
export class ResourcePoolAdmissionStore {
  private readonly policy: ResourcePolicyV1;
  private readonly policyDigest: string;

  constructor(private readonly database: DatabaseSync, authority: ResourceAuthorityConfig,
    serverOwnedPolicy: ResourcePolicyV1,
    private readonly clock: () => string = () => new Date().toISOString()) {
    initializeResourceStoreSchema(database, authority);
    this.policy = structuredClone(validator.resourcePolicyV1(serverOwnedPolicy));
    this.policyDigest = `sha256:${createHash("sha256").update(canonicalJson(this.policy)).digest("hex")}`;
  }

  admit(request: PoolAdmissionRequestV1): PoolAdmissionResultV1 {
    const input = validatePoolAdmissionRequestV1(request);
    const boundRequest = canonicalJson({ ...input, policyDigest: this.policyDigest });
    const digest = `sha256:${createHash("sha256").update(boundRequest).digest("hex")}`;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const now = this.clock(); // A synchronous local clock read after lock acquisition; never network I/O.
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) invalid("Trusted pool clock is invalid.");
      const existing = this.database.prepare(`SELECT request_digest, request_json, state, result_json, reservation_id
        FROM resource_admission_requests WHERE request_key = ?`).get(input.requestKey) as
        { request_digest: string; request_json: string; state: string;
          result_json: string | null; reservation_id: string | null } | undefined;
      if (existing) {
        if (existing.request_digest !== digest || existing.request_json !== boundRequest) {
          throw new WorkflowContractError("REQUEST_CONFLICT", "Pool admission request key has conflicting evidence.");
        }
        if (existing.state !== "admitted" || !existing.result_json || !existing.reservation_id) {
          corrupt("Stored pool admission request is incomplete.");
        }
        let result: PoolAdmissionResultV1;
        try { result = JSON.parse(existing.result_json) as PoolAdmissionResultV1; }
        catch { corrupt("Stored pool admission result is not JSON."); }
        if (result.kind !== "admitted" || result.reservationId !== existing.reservation_id
          || canonicalJson(result) !== existing.result_json) corrupt("Stored pool admission result is invalid.");
        const reservation = this.database.prepare(`SELECT request_digest, state, expires_at
          FROM resource_reservations WHERE reservation_id = ?`).get(result.reservationId) as
          { request_digest: string; state: string; expires_at: string } | undefined;
        if (!reservation || reservation.request_digest !== digest) corrupt("Stored reservation binding is invalid.");
        this.database.exec("COMMIT;");
        if (reservation.state !== "held") return { kind: "rejected", reason: "RESERVATION_NOT_ACTIVE" };
        if (Date.parse(reservation.expires_at) <= nowMs) return { kind: "rejected", reason: "RESERVATION_EXPIRED" };
        return result;
      }
      const reservationId = randomUUID();
      this.database.prepare(`INSERT INTO resource_reservations
        (reservation_id,request_key,request_digest,task_id,run_id,slot_id,attempt_id,
          plan_revision,lease_epoch,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'held',?,?)`)
        .run(reservationId, input.requestKey, digest, input.taskId, input.runId, input.slotId, input.attemptId,
          input.planRevision, input.leaseEpoch, now, input.expiresAt);
      const result = reservePoolInTransaction(this.database, this.policy, input, reservationId, now);
      if (result.kind !== "admitted") {
        this.database.exec("ROLLBACK;");
        return result;
      }
      this.database.prepare(`INSERT INTO resource_admission_requests
        (request_key,request_digest,plan_revision,request_json,state,result_json,reservation_id)
        VALUES (?,?,?,?,'admitted',?,?)`)
        .run(input.requestKey, digest, input.planRevision, boundRequest, canonicalJson(result), reservationId);
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the admission failure. */ }
      throw error;
    }
  }
}
