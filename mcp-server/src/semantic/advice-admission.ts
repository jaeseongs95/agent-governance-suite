/** Server-owned registration of a runner-recorded result. This does not authorize adoption or execution. */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { WorkflowContractError, type SemanticDecisionAdviceV1 } from "../../../contracts/types.js";
import { canonical, digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { normalizeSemanticProviderResult, validateSemanticAdviceForRequest } from "./advice-validator.js";
import { SemanticEvaluationIntentStore, type SemanticEvaluationIntent } from "./evaluation-intent.js";

export interface RegisteredSemanticAdvice {
  registrationId: string;
  evaluationId: string;
  requestDigest: string;
  resultDigest: string;
  advice: SemanticDecisionAdviceV1;
}

type AdviceRow = { registration_id: string; evaluation_id: string; request_digest: string;
  result_digest: string; advice_digest: string; registered_at: string; advice_json: string };

function deny(message: string): never { throw new WorkflowContractError("GATE_FAILED", message); }

export class SemanticAdviceAdmissionStore {
  private readonly intents: SemanticEvaluationIntentStore;

  /** The owning server supplies the workflow connection and clock; no MCP advice-registration input exists. */
  constructor(private readonly database: DatabaseSync, private readonly now: () => string = () => new Date().toISOString()) {
    this.intents = new SemanticEvaluationIntentStore(database);
    this.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS ags_semantic_advice_v1 (
        evaluation_id TEXT PRIMARY KEY REFERENCES ags_semantic_evaluations_v1(evaluation_id),
        registration_id TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL, result_digest TEXT NOT NULL,
        advice_digest TEXT NOT NULL UNIQUE, registered_at TEXT NOT NULL,
        advice_json TEXT NOT NULL
      ) STRICT;`);
    });
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private row(evaluationId: string): AdviceRow | null {
    return this.database.prepare("SELECT * FROM ags_semantic_advice_v1 WHERE evaluation_id=?")
      .get(evaluationId) as AdviceRow | undefined ?? null;
  }

  private recorded(evaluationId: string): SemanticEvaluationIntent {
    const intent = this.intents.get(evaluationId);
    if (!intent || intent.state !== "recorded" || !intent.claimId || !intent.runnerId
      || intent.evaluation.state !== "recorded" || intent.evaluation.result === null) {
      deny("Advice requires a runner-recorded evaluation and result.");
    }
    return intent;
  }

  private read(row: AdviceRow, intent: SemanticEvaluationIntent): RegisteredSemanticAdvice {
    const { request, result } = intent.evaluation;
    if (row.request_digest !== request.requestDigest || row.result_digest !== digest(result)) {
      deny("Advice registration does not match the runner journal.");
    }
    const advice = validateSemanticAdviceForRequest({ prepared: request,
      advice: JSON.parse(row.advice_json) as unknown, now: row.registered_at });
    const expected = normalizeSemanticProviderResult({ prepared: request, rawResult: result, now: row.registered_at });
    if (row.advice_json !== canonical(advice) || row.advice_digest !== advice.adviceDigest
      || canonical(advice) !== canonical(expected)
      || advice.evaluatedAt !== row.registered_at || advice.evaluationId !== row.evaluation_id) {
      deny("Stored advice registration is inconsistent.");
    }
    return { registrationId: row.registration_id, evaluationId: row.evaluation_id,
      requestDigest: row.request_digest, resultDigest: row.result_digest, advice };
  }

  /** Historical readback is not a current-expiry or admission decision. */
  get(evaluationId: string): RegisteredSemanticAdvice | null {
    const row = this.row(evaluationId);
    return row === null ? null : this.read(row, this.recorded(evaluationId));
  }

  /** Replays the same immutable registration; never accepts a caller-provided advice or flag. */
  register(evaluationId: string): RegisteredSemanticAdvice {
    if (typeof evaluationId !== "string" || !evaluationId.trim()) {
      throw new WorkflowContractError("INVALID_INPUT", "Evaluation ID is required.");
    }
    return this.transaction(() => {
      const intent = this.recorded(evaluationId);
      const previous = this.row(evaluationId);
      const { request, result } = intent.evaluation;
      const registeredAt = this.now();
      if (previous) {
        const stored = this.read(previous, intent);
        validateSemanticAdviceForRequest({ prepared: request, advice: stored.advice, now: registeredAt });
        return stored;
      }
      const advice = normalizeSemanticProviderResult({ prepared: request, rawResult: result, now: registeredAt });
      const registrationId = randomUUID();
      this.database.prepare("INSERT INTO ags_semantic_advice_v1 VALUES (?,?,?,?,?,?,?)")
        .run(evaluationId, registrationId, request.requestDigest, digest(result),
          advice.adviceDigest, registeredAt, canonical(advice));
      return this.read(this.row(evaluationId)!, intent);
    });
  }
}
