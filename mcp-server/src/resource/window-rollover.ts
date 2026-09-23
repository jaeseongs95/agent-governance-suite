import type { DatabaseSync } from "node:sqlite";

import { WorkflowContractError } from "../../../contracts/types.js";
import type { ResourceAuthorityConfig } from "./authority-config.js";
import type { ResourceCollectorPortV1 } from "./collector-port.js";
import { ResourceObservationStore } from "./observation-store.js";

type WindowRow = { observation_id: string; reset_epoch: number; revision: number;
  bucket_id: string; unit: string; remaining: number | null };
type CarryoverRow = { reservation_id: string; reset_epoch: number; amount: number; unit: string;
  state: string; intent_id: string | null; coverage: string | null;
  observed_amount: number | null };

export interface WindowCarryoverV1 {
  reservationId: string;
  originalResetEpoch: number;
  state: "held" | "committed" | "uncertain" | "settled";
  intentId: string | null;
  heldAmount: number;
  unit: string;
  coverage: string | null;
  observedAmount: number | null;
  /** A settled amount has no proven inclusion in the new provider snapshot. */
  inclusion: "unknown";
}

export interface WindowRolloverV1 {
  observationId: string;
  resetEpoch: number;
  revision: number;
  carryover: WindowCarryoverV1[];
}

function corrupt(message: string): never {
  throw new WorkflowContractError("INTEGRITY_FAILED", message);
}

/** B03 owns observation writes; immutable hold and usage rows retain their original epoch. */
export class ResourceWindowRolloverStore {
  private readonly observations: ResourceObservationStore;
  private readonly scopes: Set<string>;

  constructor(private readonly database: DatabaseSync, authority: ResourceAuthorityConfig,
    collectors: readonly ResourceCollectorPortV1[]) {
    this.observations = new ResourceObservationStore(database, authority, collectors);
    this.scopes = new Set(collectors.map(port =>
      `${port.scope.accountScope}\0${port.scope.resourcePoolId}`));
  }

  /** Admit a new epoch through B03's serialized, monotonic collector journal. */
  admit(collector: ResourceCollectorPortV1): ReturnType<ResourceObservationStore["admit"]> {
    return this.observations.admit(collector);
  }

  /** Read durable cross-epoch liability; amounts here never grant reset credit. */
  readCurrent(accountScope: string, poolId: string, windowId: string): WindowRolloverV1 | null {
    if (!this.scopes.has(`${accountScope}\0${poolId}`)) {
      throw new WorkflowContractError("INVALID_INPUT", "Resource pool has no registered collector.");
    }
    this.database.exec("BEGIN;");
    try {
      const row = this.database.prepare(`SELECT observation_id,reset_epoch,revision,bucket_id,unit,remaining
        FROM resource_window_observations WHERE account_scope=? AND pool_id=? AND window_id=?`)
        .get(accountScope, poolId, windowId) as WindowRow | undefined;
      if (!row) { this.database.exec("COMMIT;"); return null; }
      const response = this.observations.getObservation(row.observation_id);
      if (!response || response.kind === "unavailable") {
        this.database.exec("COMMIT;"); return null;
      }
      const windows = response.kind === "full" ? response.snapshot.windows : response.upsertWindows;
      const window = windows.find(item => item.windowId === windowId);
      if (!window) { this.database.exec("COMMIT;"); return null; }
      if (window.resetEpoch !== row.reset_epoch || window.revision !== row.revision
        || window.limitBucket.bucketId !== row.bucket_id || window.limitBucket.unit !== row.unit
        || window.limitBucket.remaining !== row.remaining) {
        corrupt("Current rollover window differs from its collector observation.");
      }
      const rows = this.database.prepare(`SELECT h.reservation_id,h.reset_epoch,h.amount,h.unit,
        r.state,i.intent_id,c.coverage,c.observed_amount
        FROM resource_reservation_holds h
        JOIN resource_reservations r ON r.reservation_id=h.reservation_id
        LEFT JOIN resource_intents i ON i.reservation_id=h.reservation_id
        LEFT JOIN resource_usage_coverage c ON c.reservation_id=h.reservation_id
          AND c.account_scope=h.account_scope AND c.pool_id=h.pool_id AND c.window_id=h.window_id
        WHERE h.account_scope=? AND h.pool_id=? AND h.window_id=?
          AND h.reset_epoch<? AND r.state IN ('held','committed','uncertain','settled')
        ORDER BY h.reservation_id`).all(accountScope, poolId, windowId, row.reset_epoch) as CarryoverRow[];
      const carryover = rows.map(item => ({ reservationId: item.reservation_id,
        originalResetEpoch: item.reset_epoch,
        state: item.state as WindowCarryoverV1["state"], intentId: item.intent_id,
        heldAmount: item.amount, unit: item.unit, coverage: item.coverage,
        observedAmount: item.observed_amount, inclusion: "unknown" as const }));
      this.database.exec("COMMIT;");
      return { observationId: row.observation_id, resetEpoch: row.reset_epoch,
        revision: row.revision, carryover };
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* Preserve original error. */ }
      throw error;
    }
  }
}
