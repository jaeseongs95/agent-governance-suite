/** Durable local claim boundary. Only a runner holding the returned claim may invoke a provider. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowContractError } from "../../../contracts/types.js";
import { canonical, digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { SemanticEvaluationStore, type StoredSemanticEvaluation } from "./evaluation-store.js";

export type SemanticIntentState = "pending" | "running" | "uncertain" | "recorded";
export interface SemanticEvaluationIntent {
  evaluation: StoredSemanticEvaluation;
  state: SemanticIntentState;
  claimId: string | null;
  runnerId: string | null;
}

type IntentRow = { evaluation_id: string; request_digest: string;
  state: SemanticIntentState; claim_id: string | null; runner_id: string | null };

function deny(message: string): never { throw new WorkflowContractError("GATE_FAILED", message); }
function rawJson(value: unknown): string {
  try { return canonical(value); }
  catch { throw new WorkflowContractError("INVALID_INPUT", "Evaluation result requires finite, plain JSON."); }
}

export class SemanticEvaluationIntentStore {
  private readonly journal: SemanticEvaluationStore;

  /** Pass a connection to the existing workflow DB. The caller retains ownership. */
  constructor(private readonly database: DatabaseSync) {
    this.journal = new SemanticEvaluationStore(database);
    this.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS ags_semantic_intents_v1 (
        evaluation_id TEXT PRIMARY KEY REFERENCES ags_semantic_evaluations_v1(evaluation_id),
        request_digest TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','running','uncertain','recorded')),
        claim_id TEXT UNIQUE, runner_id TEXT,
        CHECK ((state='pending' AND claim_id IS NULL AND runner_id IS NULL)
          OR (state<>'pending' AND claim_id IS NOT NULL AND runner_id IS NOT NULL))
      ) STRICT;`);
    });
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private row(evaluationId: string): IntentRow | null {
    return this.database.prepare("SELECT evaluation_id,request_digest,state,claim_id,runner_id FROM ags_semantic_intents_v1 WHERE evaluation_id=?")
      .get(evaluationId) as IntentRow | undefined ?? null;
  }

  private read(row: IntentRow): SemanticEvaluationIntent {
    const evaluation = this.journal.get(row.evaluation_id);
    const hasClaim = !!row.claim_id && !!row.runner_id;
    if (!evaluation || evaluation.request.requestDigest !== row.request_digest
      || (row.state === "recorded") !== (evaluation.state === "recorded")
      || (row.state === "pending" ? row.claim_id !== null || row.runner_id !== null : !hasClaim)) {
      deny("Semantic intent and immutable evaluation journal diverged.");
    }
    return { evaluation, state: row.state, claimId: row.claim_id, runnerId: row.runner_id };
  }

  get(evaluationId: string): SemanticEvaluationIntent | null {
    const row = this.row(evaluationId);
    return row === null ? null : this.read(row);
  }

  /** Crash after request persistence is safe: the same key/request recreates only the missing intent. */
  begin(idempotencyKey: string, preparedRequest: unknown): SemanticEvaluationIntent {
    const stored = this.journal.putRequest(idempotencyKey, preparedRequest);
    return this.transaction(() => {
      const prior = this.row(stored.evaluationId);
      if (prior) return this.read(prior);
      if (stored.state !== "prepared") deny("An unclaimed evaluation already has a result.");
      this.database.prepare("INSERT INTO ags_semantic_intents_v1 VALUES (?,?,'pending',NULL,NULL)")
        .run(stored.evaluationId, stored.request.requestDigest);
      return this.read(this.row(stored.evaluationId)!);
    });
  }

  /** Exactly one local runner receives a durable claim. Repeated calls never reissue it. */
  claim(evaluationId: string, requestDigest: string, runnerId: string): SemanticEvaluationIntent {
    if (!runnerId.trim()) throw new WorkflowContractError("INVALID_INPUT", "Runner ID is required.");
    return this.transaction(() => {
      const row = this.row(evaluationId);
      if (!row || row.request_digest !== requestDigest) deny("Runner claim is not bound to the prepared request.");
      const current = this.read(row);
      if (current.state !== "pending") deny("Evaluation already has a claim or result; no new provider call is allowed.");
      const claimId = randomUUID();
      const changed = this.database.prepare("UPDATE ags_semantic_intents_v1 SET state='running',claim_id=?,runner_id=? WHERE evaluation_id=? AND request_digest=? AND state='pending'")
        .run(claimId, runnerId, evaluationId, requestDigest).changes;
      if (changed !== 1) deny("Concurrent evaluation claim lost.");
      return this.read(this.row(evaluationId)!);
    });
  }

  /** At restart, a running claim may have reached the provider; absence of result proves nothing. */
  resume(evaluationId: string, requestDigest: string): SemanticEvaluationIntent {
    return this.transaction(() => {
      const row = this.row(evaluationId);
      if (!row || row.request_digest !== requestDigest) deny("Resume is not bound to the prepared request.");
      this.read(row);
      if (row.state === "running") {
        this.database.prepare("UPDATE ags_semantic_intents_v1 SET state='uncertain' WHERE evaluation_id=? AND state='running'")
          .run(evaluationId);
      }
      return this.read(this.row(evaluationId)!);
    });
  }

  /** Records only an existing runner claim's raw result. An uncertain claim may settle late. */
  recordResult(evaluationId: string, requestDigest: string, claimId: string, result: unknown): SemanticEvaluationIntent {
    const resultJson = rawJson(result);
    const resultDigest = digest(result);
    return this.transaction(() => {
      const row = this.row(evaluationId);
      if (!row || row.request_digest !== requestDigest || !claimId || row.claim_id !== claimId) {
        deny("Result is not bound to the recorded runner claim and request.");
      }
      const current = this.read(row);
      if (current.state === "recorded") {
        if (rawJson(current.evaluation.result) !== resultJson) deny("Conflicting result for recorded runner claim.");
        return current;
      }
      if (current.state !== "running" && current.state !== "uncertain") deny("Result has no active runner claim.");
      this.database.prepare("INSERT INTO ags_semantic_results_v1 VALUES (?,?,?,?)")
        .run(evaluationId, requestDigest, resultDigest, resultJson);
      this.database.prepare("UPDATE ags_semantic_intents_v1 SET state='recorded' WHERE evaluation_id=?")
        .run(evaluationId);
      return this.read(this.row(evaluationId)!);
    });
  }
}
