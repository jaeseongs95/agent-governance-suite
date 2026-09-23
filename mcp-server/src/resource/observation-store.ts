import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { type CollectorProjectionV1, type CollectorScopeV1, type ResourceCollectorPortV1,
  type ResourceCollectorResponseV1, projectCollectorResponseV1, validateCollectorResponseV1,
  validateCollectorScopeV1 } from "./collector-port.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import { initializeResourceStoreSchema } from "./store-schema.js";

type EventRow = { observation_id: string; collector_id: string; sequence: number;
  payload_digest: string; payload_json: string };
type CurrentRow = { window_id: string; reset_epoch: number; revision: number };

function conflict(message: string): never { throw new WorkflowContractError("SNAPSHOT_CONFLICT", message); }
function corrupt(message: string): never { throw new WorkflowContractError("INTEGRITY_FAILED", message); }

/** A trusted owner registers collector instances; model JSON is never an admission input. */
export class ResourceObservationStore {
  private readonly scopes = new Map<ResourceCollectorPortV1, CollectorScopeV1>();

  constructor(private readonly database: DatabaseSync, authority: ResourceAuthorityConfig,
    collectors: readonly ResourceCollectorPortV1[]) {
    initializeResourceStoreSchema(database, authority);
    const pools = new Set<string>();
    for (const collector of collectors) {
      const scope = structuredClone(validateCollectorScopeV1(collector.scope));
      const key = `${scope.accountScope}\0${scope.resourcePoolId}`;
      if (pools.has(key)) conflict("Only one registered collector may own a resource pool.");
      pools.add(key);
      this.scopes.set(collector, scope);
    }
  }

  /** Collect outside the transaction, then re-read and compare under the SQLite write lock. */
  async admit(collector: ResourceCollectorPortV1): Promise<{ kind: "applied" | "duplicate" | "out-of-order" | "resync-required";
    observationId: string | null }> {
    const scope = this.scopes.get(collector);
    if (!scope || canonicalJson(scope) !== canonicalJson(collector.scope)) {
      throw new WorkflowContractError("INVALID_INPUT", "Collector is not registered with this resource authority.");
    }
    const response = validateCollectorResponseV1(await collector.collect(), scope);
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const existingCollector = this.database.prepare(`SELECT collector_id FROM resource_observations
        WHERE account_scope = ? AND pool_id = ? LIMIT 1`).get(scope.accountScope, scope.resourcePoolId) as
        { collector_id: string } | undefined;
      if (existingCollector && existingCollector.collector_id !== scope.collectorId) {
        conflict("Resource pool is already bound to another collector.");
      }
      const current = this.replay(scope);
      const projected = projectCollectorResponseV1(scope, current, response);
      if (projected.kind !== "applied") {
        this.database.exec("COMMIT;");
        return { kind: projected.kind, observationId: projected.kind === "duplicate" ? current?.responseDigest ?? null : null };
      }
      const state = projected.state!;
      const pool = this.database.prepare("SELECT access_path FROM resource_pools WHERE account_scope = ? AND pool_id = ?")
        .get(scope.accountScope, scope.resourcePoolId) as { access_path: string } | undefined;
      const accessPath = state.snapshot?.accessPath ?? "unknown";
      if (pool && accessPath !== "unknown" && pool.access_path !== "unknown" && pool.access_path !== accessPath) {
        conflict("Collector access path conflicts with the registered resource pool.");
      }
      if (!pool) this.database.prepare("INSERT INTO resource_pools VALUES (?,?,?)")
        .run(scope.accountScope, scope.resourcePoolId, accessPath);
      else if (pool.access_path === "unknown" && accessPath !== "unknown") {
        this.database.prepare("UPDATE resource_pools SET access_path = ? WHERE account_scope = ? AND pool_id = ?")
          .run(accessPath, scope.accountScope, scope.resourcePoolId);
      }
      const payload = canonicalJson(response);
      this.database.prepare("INSERT INTO resource_observations VALUES (?,?,?,?,?,?,?)")
        .run(state.responseDigest, scope.accountScope, scope.resourcePoolId, scope.collectorId,
          response.sequence, state.responseDigest, payload);
      this.updateWindows(scope, response, state.responseDigest);
      this.database.exec("COMMIT;");
      return { kind: "applied", observationId: state.responseDigest };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve the admission failure. */ }
      throw error;
    }
  }

  /** Read the immutable collector response bytes back through its registered scope. */
  getObservation(observationId: string): ResourceCollectorResponseV1 | null {
    const row = this.database.prepare(`SELECT o.observation_id, o.collector_id, o.sequence,
      o.payload_digest, o.payload_json, o.account_scope, o.pool_id
      FROM resource_observations o WHERE o.observation_id = ?`).get(observationId) as
      (EventRow & { account_scope: string; pool_id: string }) | undefined;
    if (!row) return null;
    const scope = [...this.scopes.values()].find(item => item.collectorId === row.collector_id
      && item.accountScope === row.account_scope && item.resourcePoolId === row.pool_id);
    if (!scope) corrupt("Stored observation has no registered collector.");
    const response = validateCollectorResponseV1(JSON.parse(row.payload_json), scope);
    const digest = `sha256:${createHash("sha256").update(canonicalJson(response)).digest("hex")}`;
    if (canonicalJson(response) !== row.payload_json || digest !== row.payload_digest
      || row.observation_id !== row.payload_digest || response.sequence !== row.sequence) {
      corrupt("Stored observation evidence is corrupt.");
    }
    return response;
  }

  private replay(scope: CollectorScopeV1): CollectorProjectionV1 | null {
    // ponytail: replay the per-pool journal; materialize verified projection state if it grows enough to slow admissions.
    const rows = this.database.prepare(`SELECT observation_id, collector_id, sequence, payload_digest, payload_json
      FROM resource_observations WHERE account_scope = ? AND pool_id = ? ORDER BY sequence`)
      .all(scope.accountScope, scope.resourcePoolId) as EventRow[];
    let state: CollectorProjectionV1 | null = null;
    for (const row of rows) {
      if (row.collector_id !== scope.collectorId) corrupt("Stored collector identity differs from its registry.");
      const response = validateCollectorResponseV1(JSON.parse(row.payload_json), scope);
      const projected = projectCollectorResponseV1(scope, state, response);
      if (projected.kind !== "applied" || !projected.state
        || projected.state.responseDigest !== row.payload_digest || row.observation_id !== row.payload_digest
        || response.sequence !== row.sequence || canonicalJson(response) !== row.payload_json) {
        corrupt("Stored collector sequence or evidence is corrupt.");
      }
      state = projected.state;
    }
    return state;
  }

  private updateWindows(scope: CollectorScopeV1, response: ResourceCollectorResponseV1, observationId: string): void {
    const rows = this.database.prepare(`SELECT window_id, reset_epoch, revision FROM resource_window_observations
      WHERE account_scope = ? AND pool_id = ?`).all(scope.accountScope, scope.resourcePoolId) as CurrentRow[];
    const current = new Map(rows.map(row => [row.window_id, row]));
    const windows = response.kind === "full" ? response.snapshot.windows
      : response.kind === "delta" ? response.upsertWindows : [];
    for (const window of windows) {
      const previous = current.get(window.windowId);
      if (previous && (window.resetEpoch < previous.reset_epoch
        || (window.resetEpoch === previous.reset_epoch && window.revision < previous.revision))) {
        conflict("A past window revision cannot replace the current resource state.");
      }
      this.database.prepare(`INSERT INTO resource_window_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_scope,pool_id,window_id) DO UPDATE SET
        observation_id=excluded.observation_id, reset_epoch=excluded.reset_epoch,
        revision=excluded.revision, bucket_id=excluded.bucket_id, unit=excluded.unit,
        remaining=excluded.remaining, observed_at=excluded.observed_at, expires_at=excluded.expires_at`)
        .run(scope.accountScope, scope.resourcePoolId, window.windowId, observationId,
          window.resetEpoch, window.revision, window.limitBucket.bucketId, window.limitBucket.unit,
          window.limitBucket.remaining, window.observedAt, window.expiresAt);
    }
    const missing = response.kind === "full" ? rows.filter(row => !windows.some(window => window.windowId === row.window_id))
      : response.kind === "delta" ? rows.filter(row => response.removeWindowIds.includes(row.window_id)) : rows;
    for (const row of missing) this.database.prepare(`UPDATE resource_window_observations
      SET observation_id = ?, remaining = NULL WHERE account_scope = ? AND pool_id = ? AND window_id = ?`)
      .run(observationId, scope.accountScope, scope.resourcePoolId, row.window_id);
  }
}
