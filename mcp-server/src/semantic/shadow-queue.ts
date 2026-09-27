/** Internal delivery queue only. A queue claim/ACK grants no provider or adoption authority. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowContractError } from "../../../contracts/types.js";
import { ContractValidator } from "../schema-validator.js";
import { SemanticEvaluationStore, type StoredSemanticEvaluation } from "./evaluation-store.js";

type QueueState = "queued" | "claimed" | "acknowledged" | "dropped" | "expired";
type QueueRow = { evaluation_id: string; request_digest: string; deadline: number;
  state: QueueState; claim_id: string | null; worker_id: string | null; lease_until: number | null };
export type ShadowEnqueueResult = { status: "enqueued" | "duplicate" }
  | { status: "dropped"; reason: "saturated" | "deadline-expired" };
export interface ShadowQueueClaim {
  evaluation: StoredSemanticEvaluation;
  requestDigest: string;
  claimId: string;
  workerId: string;
  leaseUntil: number;
}
export interface ShadowQueueOptions {
  capacity: number;
  claimTimeoutMs: number;
  now?: () => number;
}

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }
function conflict(message: string): never { throw new WorkflowContractError("GATE_FAILED", message); }

export class SemanticShadowQueue {
  private readonly journal: SemanticEvaluationStore;
  private readonly validator = new ContractValidator();
  private readonly capacity: number;
  private readonly claimTimeoutMs: number;
  private readonly now: () => number;

  /** Caller owns a separate shadow DB and closes it; this class is not wired into the server root.
   * Capacity bounds queued+claimed backlog. Terminal identity records remain for durable dedup,
   * so it is not a bound on the lifetime journal's bytes. Saturation drops the newest item.
   * No provider is called, awaited or retried, and no evaluation intent/result is created. */
  constructor(private readonly database: DatabaseSync, options: ShadowQueueOptions) {
    for (const value of [options.capacity, options.claimTimeoutMs]) {
      if (!Number.isSafeInteger(value) || value <= 0) invalid("Shadow queue bounds must be positive safe integers.");
    }
    this.capacity = options.capacity;
    this.claimTimeoutMs = options.claimTimeoutMs;
    this.now = options.now ?? Date.now;
    this.journal = new SemanticEvaluationStore(database);
    // Power-loss durability, not just persistence across close/reopen.
    database.exec("PRAGMA synchronous = FULL;");
    this.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS ags_semantic_shadow_config_v1 (
        singleton INTEGER PRIMARY KEY CHECK (singleton=1), capacity INTEGER NOT NULL,
        claim_timeout_ms INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_semantic_shadow_queue_v1 (
        evaluation_id TEXT PRIMARY KEY REFERENCES ags_semantic_evaluations_v1(evaluation_id),
        request_digest TEXT NOT NULL, deadline INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued','claimed','acknowledged','dropped','expired')),
        claim_id TEXT UNIQUE, worker_id TEXT, lease_until INTEGER,
        CHECK ((state='claimed' AND claim_id IS NOT NULL AND worker_id IS NOT NULL AND lease_until IS NOT NULL)
          OR (state<>'claimed' AND claim_id IS NULL AND worker_id IS NULL AND lease_until IS NULL))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ags_semantic_shadow_pending_v1 ON ags_semantic_shadow_queue_v1(state);`);
      database.prepare("INSERT OR IGNORE INTO ags_semantic_shadow_config_v1 VALUES (1,?,?)")
        .run(this.capacity, this.claimTimeoutMs);
      const config = database.prepare("SELECT capacity,claim_timeout_ms FROM ags_semantic_shadow_config_v1 WHERE singleton=1")
        .get() as { capacity: number; claim_timeout_ms: number };
      if (config.capacity !== this.capacity || config.claim_timeout_ms !== this.claimTimeoutMs) {
        conflict("Shadow queue bounds differ from the durable configuration.");
      }
    });
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private time(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) invalid("Shadow queue clock must return finite epoch milliseconds.");
    return now;
  }

  private row(evaluationId: string): QueueRow | null {
    return this.database.prepare("SELECT * FROM ags_semantic_shadow_queue_v1 WHERE evaluation_id=?")
      .get(evaluationId) as QueueRow | undefined ?? null;
  }

  private evaluation(row: QueueRow): StoredSemanticEvaluation {
    const evaluation = this.journal.get(row.evaluation_id);
    if (!evaluation || evaluation.request.mode !== "shadow"
      || evaluation.request.requestDigest !== row.request_digest
      || Date.parse(evaluation.request.expiresAt) !== row.deadline) {
      conflict("Shadow queue and immutable evaluation identity diverged.");
    }
    return evaluation;
  }

  private reap(now: number): void {
    this.database.prepare(`UPDATE ags_semantic_shadow_queue_v1
      SET state='expired',claim_id=NULL,worker_id=NULL,lease_until=NULL
      WHERE state IN ('queued','claimed') AND deadline<=?`).run(now);
    this.database.prepare(`UPDATE ags_semantic_shadow_queue_v1
      SET state='queued',claim_id=NULL,worker_id=NULL,lease_until=NULL
      WHERE state='claimed' AND lease_until<=?`).run(now);
  }

  enqueue(idempotencyKey: string, preparedRequest: unknown): ShadowEnqueueResult {
    const request = this.validator.semanticDecisionRequestV1(preparedRequest);
    if (request.mode !== "shadow") invalid("Only prepared shadow evaluations enter this queue.");
    this.time(); // Reject an invalid clock before persisting a request.
    // An interrupted journal->queue write may recreate only the missing queue record.
    const evaluation = this.journal.putRequest(idempotencyKey, request);
    return this.transaction(() => {
      const now = this.time(); // Storage contention must not freeze the expiry check at enqueue entry.
      const prior = this.row(evaluation.evaluationId);
      if (prior) { this.evaluation(prior); return { status: "duplicate" }; }
      if (evaluation.state !== "prepared") conflict("An already recorded evaluation cannot be newly queued.");
      this.reap(now);
      const deadline = Date.parse(request.expiresAt);
      const active = (this.database.prepare("SELECT count(*) AS n FROM ags_semantic_shadow_queue_v1 WHERE state IN ('queued','claimed')")
        .get() as { n: number }).n;
      const state = deadline <= now ? "expired" : active >= this.capacity ? "dropped" : "queued";
      this.database.prepare("INSERT INTO ags_semantic_shadow_queue_v1 VALUES (?,?,?, ?,NULL,NULL,NULL)")
        .run(evaluation.evaluationId, request.requestDigest, deadline, state);
      return state === "queued" ? { status: "enqueued" }
        : { status: "dropped", reason: state === "expired" ? "deadline-expired" : "saturated" };
    });
  }

  /** Lease expiry permits delivery reassignment, never a new provider effect. J07-b retains its own gate. */
  claim(workerId: string): ShadowQueueClaim | null {
    if (typeof workerId !== "string" || !workerId.trim()) invalid("Shadow queue worker ID is required.");
    return this.transaction(() => {
      const now = this.time();
      this.reap(now);
      const row = this.database.prepare("SELECT * FROM ags_semantic_shadow_queue_v1 WHERE state='queued' ORDER BY rowid LIMIT 1")
        .get() as QueueRow | undefined;
      if (!row) return null;
      const evaluation = this.evaluation(row);
      const claimId = randomUUID();
      const leaseUntil = Math.min(row.deadline, now + this.claimTimeoutMs);
      this.database.prepare("UPDATE ags_semantic_shadow_queue_v1 SET state='claimed',claim_id=?,worker_id=?,lease_until=? WHERE evaluation_id=? AND state='queued'")
        .run(claimId, workerId, leaseUntil, row.evaluation_id);
      return { evaluation, requestDigest: row.request_digest, claimId, workerId, leaseUntil };
    });
  }

  /** Delivery acknowledgement only. It cannot write observed/completed state or a provider result. */
  acknowledge(claim: ShadowQueueClaim): boolean {
    return this.transaction(() => {
      const now = this.time();
      const row = this.row(claim.evaluation.evaluationId);
      if (!row || row.state !== "claimed" || row.request_digest !== claim.requestDigest
        || row.claim_id !== claim.claimId || row.worker_id !== claim.workerId
        || row.deadline <= now || row.lease_until! <= now) return false;
      this.evaluation(row);
      return this.database.prepare(`UPDATE ags_semantic_shadow_queue_v1
        SET state='acknowledged',claim_id=NULL,worker_id=NULL,lease_until=NULL
        WHERE evaluation_id=? AND claim_id=?`).run(row.evaluation_id, claim.claimId).changes === 1;
    });
  }

  diagnostics(): { capacity: number; active: number; queued: number; claimed: number;
    acknowledged: number; dropped: number; expired: number; saturationPolicy: "drop-newest" } {
    return this.transaction(() => {
      this.reap(this.time());
      const counts: Record<QueueState, number> = { queued: 0, claimed: 0, acknowledged: 0, dropped: 0, expired: 0 };
      for (const row of this.database.prepare("SELECT state,count(*) AS n FROM ags_semantic_shadow_queue_v1 GROUP BY state")
        .all() as { state: QueueState; n: number }[]) counts[row.state] = row.n;
      return { capacity: this.capacity, active: counts.queued + counts.claimed, ...counts, saturationPolicy: "drop-newest" };
    });
  }
}
