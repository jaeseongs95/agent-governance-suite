import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError, type ResourcePolicyV1 } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";
import { type PoolAdmissionRequestV1, reservePoolInTransaction,
  validatePoolAdmissionRequestV1 } from "./admit-pool.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { reservationIdempotencyKeyV1 } from "./reservation-idempotency.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

type Pool = Pick<PoolAdmissionRequestV1, "accountScope" | "resourcePoolId" | "windows">;
export type MultiPoolAdmissionRequestV1 = Omit<PoolAdmissionRequestV1,
  "accountScope" | "resourcePoolId" | "windows"> & { pools: Pool[] };
export type MultiPoolAdmissionResultV1 =
  | { kind: "admitted"; reservationId: string; poolCount: number }
  | { kind: "rejected" | "deferred"; reason: string;
      failedPool: { accountScope: string; resourcePoolId: string } | null };

const validator = new ContractValidator();
const key = (scope: { accountScope: string; resourcePoolId: string }) =>
  `${scope.accountScope}\0${scope.resourcePoolId}`;
const compare = (left: Pool, right: Pool) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0;
function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("REQUEST_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }

export function validateMultiPoolAdmissionRequestV1(value: unknown): MultiPoolAdmissionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid multi-pool admission request.");
  const input = value as Record<string, unknown>;
  const fields = ["requestKey", "taskId", "runId", "slotId", "attemptId", "planRevision",
    "leaseEpoch", "expiresAt", "pools"];
  if (Object.keys(input).length !== fields.length || fields.some(field => !Object.hasOwn(input, field))
    || !Array.isArray(input.pools) || input.pools.length < 2 || input.pools.length > 64) {
    invalid("A multi-pool request requires two to 64 distinct pools.");
  }
  const common = Object.fromEntries(Object.entries(input).filter(([field]) => field !== "pools"));
  const pools = (input.pools as unknown[]).map(pool => {
    if (!pool || typeof pool !== "object" || Array.isArray(pool)
      || Object.keys(pool).length !== 3
      || !["accountScope", "resourcePoolId", "windows"].every(field => Object.hasOwn(pool, field))) {
      invalid("Invalid multi-pool scope.");
    }
    return validatePoolAdmissionRequestV1({ ...common, ...pool as object });
  });
  if (new Set(pools.map(key)).size !== pools.length) invalid("Duplicate resource pool in one request.");
  return { requestKey: pools[0]!.requestKey, taskId: pools[0]!.taskId, runId: pools[0]!.runId,
    slotId: pools[0]!.slotId, attemptId: pools[0]!.attemptId, planRevision: pools[0]!.planRevision,
    leaseEpoch: pools[0]!.leaseEpoch, expiresAt: pools[0]!.expiresAt,
    pools: pools.map(({ accountScope, resourcePoolId, windows }) => ({ accountScope, resourcePoolId, windows })) };
}

/** One local SQLite write transaction owns every pool hold; no B04 wrapper is called. */
export class ResourcePoolsAdmissionStore {
  private readonly policies = new Map<string, ResourcePolicyV1>();

  constructor(private readonly database: DatabaseSync, authority: ResourceAuthorityConfig,
    serverOwnedPolicies: readonly ResourcePolicyV1[],
    private readonly clock: () => string = () => new Date().toISOString()) {
    initializeResourceStoreSchema(database, authority);
    if (serverOwnedPolicies.length < 2 || serverOwnedPolicies.length > 64) {
      invalid("Multi-pool admission requires two to 64 server-owned policies.");
    }
    for (const policy of serverOwnedPolicies) {
      const approved = structuredClone(validator.resourcePolicyV1(policy));
      const scope = key(approved);
      if (this.policies.has(scope)) invalid("Duplicate approved resource pool policy.");
      this.policies.set(scope, approved);
    }
  }

  admitIdempotent(request: Omit<MultiPoolAdmissionRequestV1, "requestKey">): MultiPoolAdmissionResultV1 {
    if (!request || typeof request !== "object" || Object.hasOwn(request, "requestKey")) {
      invalid("An idempotent admission request must not supply a request key.");
    }
    const input = validateMultiPoolAdmissionRequestV1({ ...request, requestKey: "pending-key" });
    const body = { taskId: input.taskId, runId: input.runId, slotId: input.slotId,
      attemptId: input.attemptId, planRevision: input.planRevision, leaseEpoch: input.leaseEpoch,
      expiresAt: input.expiresAt };
    const requestDigest = `sha256:${createHash("sha256")
      .update(canonicalJson({ ...body, pools: [...input.pools].sort(compare) })).digest("hex")}`;
    const key = reservationIdempotencyKeyV1({ taskId: input.taskId, runId: input.runId,
      slotId: input.slotId, attemptId: input.attemptId, planRevision: input.planRevision, requestDigest });
    return this.admit({ ...input, requestKey: key });
  }

  admit(request: MultiPoolAdmissionRequestV1): MultiPoolAdmissionResultV1 {
    const input = validateMultiPoolAdmissionRequestV1(request);
    const sorted = [...input.pools].sort(compare);
    const prepared = sorted.map(pool => {
      const policy = this.policies.get(key(pool));
      if (!policy) invalid("A requested pool has no server-owned approved policy.");
      const poolRequest: PoolAdmissionRequestV1 = {
        requestKey: input.requestKey, taskId: input.taskId, runId: input.runId,
        slotId: input.slotId, attemptId: input.attemptId, planRevision: input.planRevision,
        leaseEpoch: input.leaseEpoch, expiresAt: input.expiresAt, ...pool,
      };
      return { policy, pool, poolRequest };
    });
    const boundRequest = canonicalJson({ ...input, pools: sorted, policyDigests: prepared.map(item => ({
      accountScope: item.pool.accountScope, resourcePoolId: item.pool.resourcePoolId,
      digest: `sha256:${createHash("sha256").update(canonicalJson(item.policy)).digest("hex")}`,
    })) });
    const digest = `sha256:${createHash("sha256").update(boundRequest).digest("hex")}`;
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const now = this.clock(); // Synchronous local clock after acquiring the lock; no network I/O.
      const nowMs = Date.parse(now);
      if (!Number.isFinite(nowMs)) invalid("Trusted resource clock is invalid.");
      const existing = this.database.prepare(`SELECT request_digest, request_json, state, result_json, reservation_id
        FROM resource_admission_requests WHERE request_key = ?`).get(input.requestKey) as
        { request_digest: string; request_json: string; state: string;
          result_json: string | null; reservation_id: string | null } | undefined;
      if (existing) {
        if (existing.request_digest !== digest || existing.request_json !== boundRequest) {
          conflict("Multi-pool request key has conflicting evidence.");
        }
        if (!existing.result_json) {
          corrupt("Stored multi-pool admission request is incomplete.");
        }
        let result: MultiPoolAdmissionResultV1;
        try { result = JSON.parse(existing.result_json) as MultiPoolAdmissionResultV1; }
        catch { corrupt("Stored multi-pool result is not JSON."); }
        if (!result || typeof result !== "object" || Array.isArray(result)
          || canonicalJson(result) !== existing.result_json) {
          corrupt("Stored multi-pool admission result is invalid.");
        }
        if (existing.state === "rejected" || existing.state === "deferred") {
          if (existing.reservation_id !== null || result.kind !== existing.state
            || typeof result.reason !== "string" || !result.failedPool) {
            corrupt("Stored multi-pool refusal is invalid.");
          }
          this.database.exec("COMMIT;");
          return result;
        }
        if (existing.state !== "admitted" || !existing.reservation_id
          || result.kind !== "admitted" || result.reservationId !== existing.reservation_id
          || result.poolCount !== sorted.length || canonicalJson(result) !== existing.result_json) {
          corrupt("Stored multi-pool admission result is invalid.");
        }
        const reservation = this.database.prepare(`SELECT request_digest, state, expires_at
          FROM resource_reservations WHERE reservation_id = ?`).get(result.reservationId) as
          { request_digest: string; state: string; expires_at: string } | undefined;
        if (!reservation || reservation.request_digest !== digest) corrupt("Stored reservation binding is invalid.");
        this.database.exec("COMMIT;");
        if (reservation.state !== "held") {
          return { kind: "rejected", reason: "RESERVATION_NOT_ACTIVE", failedPool: null };
        }
        if (Date.parse(reservation.expires_at) <= nowMs) {
          return { kind: "rejected", reason: "RESERVATION_EXPIRED", failedPool: null };
        }
        return result;
      }
      const other = this.database.prepare(`SELECT request_key FROM resource_admission_requests
        WHERE plan_revision = ? AND json_extract(request_json, '$.taskId') = ?
          AND json_extract(request_json, '$.runId') = ?
          AND json_extract(request_json, '$.slotId') = ?
          AND json_extract(request_json, '$.attemptId') = ? LIMIT 1`).get(
        input.planRevision, input.taskId, input.runId, input.slotId, input.attemptId) as
        { request_key: string } | undefined;
      if (other) conflict("Admission identity has a different request key or payload.");
      this.database.exec("SAVEPOINT resource_admission_candidate;");
      const reservationId = randomUUID();
      this.database.prepare(`INSERT INTO resource_reservations
        (reservation_id,request_key,request_digest,task_id,run_id,slot_id,attempt_id,
          plan_revision,lease_epoch,state,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,'held',?,?)`)
        .run(reservationId, input.requestKey, digest, input.taskId, input.runId, input.slotId,
          input.attemptId, input.planRevision, input.leaseEpoch, now, input.expiresAt);
      for (const item of prepared) {
        const outcome = reservePoolInTransaction(this.database, item.policy, item.poolRequest, reservationId, now);
        if (outcome.kind !== "admitted") {
          const result: MultiPoolAdmissionResultV1 = { ...outcome,
            failedPool: { accountScope: item.pool.accountScope, resourcePoolId: item.pool.resourcePoolId } };
          this.database.exec("ROLLBACK TO resource_admission_candidate; RELEASE resource_admission_candidate;");
          this.database.prepare(`INSERT INTO resource_admission_requests
            (request_key,request_digest,plan_revision,request_json,state,result_json,reservation_id)
            VALUES (?,?,?,?,?,?,NULL)`).run(input.requestKey, digest, input.planRevision,
            boundRequest, result.kind, canonicalJson(result));
          this.database.exec("COMMIT;");
          return result;
        }
      }
      this.database.exec("RELEASE resource_admission_candidate;");
      const result: MultiPoolAdmissionResultV1 = { kind: "admitted", reservationId, poolCount: sorted.length };
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
