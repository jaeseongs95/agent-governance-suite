/** Additive journal in the workflow database. Provider execution and advice admission live elsewhere. */
import type { DatabaseSync } from "node:sqlite";
import { WorkflowContractError, type SemanticDecisionRequestV1 } from "../../../contracts/types.js";
import { canonical, digest } from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ContractValidator } from "../schema-validator.js";

export interface StoredSemanticEvaluation {
  evaluationId: string;
  idempotencyKey: string;
  state: "prepared" | "recorded";
  request: SemanticDecisionRequestV1;
  /** Raw JSON only. A stored result is not admitted semantic advice. */
  result: unknown | null;
}

type EvaluationRow = { evaluation_id: string; idempotency_key: string; request_digest: string;
  request_json: string; result_request_digest: string | null;
  result_digest: string | null; result_json: string | null };

function conflict(message: string): never {
  throw new WorkflowContractError("GATE_FAILED", message);
}

function json(value: unknown): string {
  try { return canonical(value); }
  catch { throw new WorkflowContractError("INVALID_INPUT", "Evaluation journal requires finite, plain JSON."); }
}

export class SemanticEvaluationStore {
  private readonly validator = new ContractValidator();

  /** The caller owns and closes this connection to the existing workflow database. */
  constructor(private readonly database: DatabaseSync) {
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS ags_semantic_evaluations_v1 (
        evaluation_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        request_digest TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_semantic_requests_v1 (
        evaluation_id TEXT PRIMARY KEY REFERENCES ags_semantic_evaluations_v1(evaluation_id),
        request_json TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS ags_semantic_results_v1 (
        evaluation_id TEXT PRIMARY KEY REFERENCES ags_semantic_evaluations_v1(evaluation_id),
        request_digest TEXT NOT NULL, result_digest TEXT NOT NULL, result_json TEXT NOT NULL
      ) STRICT;`);
    });
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private row(where: "evaluation_id" | "idempotency_key", value: string): EvaluationRow | null {
    return this.database.prepare(`SELECT e.evaluation_id, e.idempotency_key, e.request_digest,
      q.request_json, r.request_digest AS result_request_digest, r.result_digest, r.result_json
      FROM ags_semantic_evaluations_v1 e
      JOIN ags_semantic_requests_v1 q ON q.evaluation_id = e.evaluation_id
      LEFT JOIN ags_semantic_results_v1 r ON r.evaluation_id = e.evaluation_id
      WHERE e.${where} = ?`).get(value) as EvaluationRow | undefined ?? null;
  }

  private read(row: EvaluationRow): StoredSemanticEvaluation {
    const request: SemanticDecisionRequestV1 = this.validator.semanticDecisionRequestV1(JSON.parse(row.request_json));
    if (request.evaluationId !== row.evaluation_id || request.requestDigest !== row.request_digest
      || json(request) !== row.request_json) conflict("Stored semantic request binding is corrupt.");
    const result = row.result_json === null ? null : JSON.parse(row.result_json) as unknown;
    if (row.result_json !== null && (row.result_request_digest !== row.request_digest
      || row.result_digest !== digest(result) || row.result_json !== json(result))) {
      conflict("Stored semantic result digest is corrupt.");
    }
    return { evaluationId: row.evaluation_id, idempotencyKey: row.idempotency_key,
      state: row.result_json === null ? "prepared" : "recorded", request, result };
  }

  get(evaluationId: string): StoredSemanticEvaluation | null {
    const row = this.row("evaluation_id", evaluationId);
    return row === null ? null : this.read(row);
  }

  getByIdempotencyKey(key: string): StoredSemanticEvaluation | null {
    const row = this.row("idempotency_key", key);
    return row === null ? null : this.read(row);
  }

  putRequest(key: string, value: unknown): StoredSemanticEvaluation {
    if (!key.trim()) throw new WorkflowContractError("INVALID_INPUT", "Idempotency key is required.");
    const request = this.validator.semanticDecisionRequestV1(value);
    const requestJson = json(request);
    return this.transaction(() => {
      const byId = this.row("evaluation_id", request.evaluationId);
      const byKey = this.row("idempotency_key", key);
      if (byId || byKey) {
        if (!byId || !byKey || byId.evaluation_id !== byKey.evaluation_id
          || byId.idempotency_key !== key || byId.request_digest !== request.requestDigest
          || byId.request_json !== requestJson) conflict("Semantic evaluation ID or idempotency key conflicts with its immutable request.");
        return this.read(byId);
      }
      this.database.prepare("INSERT INTO ags_semantic_evaluations_v1 VALUES (?,?,?)")
        .run(request.evaluationId, key, request.requestDigest);
      this.database.prepare("INSERT INTO ags_semantic_requests_v1 VALUES (?,?)")
        .run(request.evaluationId, requestJson);
      return this.read(this.row("evaluation_id", request.evaluationId)!);
    });
  }

  putResult(evaluationId: string, requestDigest: string, value: unknown): StoredSemanticEvaluation {
    const resultJson = json(value);
    const resultDigest = digest(value);
    return this.transaction(() => {
      const prior = this.row("evaluation_id", evaluationId);
      if (!prior || prior.request_digest !== requestDigest) conflict("Semantic result is not bound to a stored request.");
      if (prior.result_json !== null) {
        if (prior.result_digest !== resultDigest || prior.result_json !== resultJson) {
          conflict("Semantic result conflicts with the immutable recorded result.");
        }
        return this.read(prior);
      }
      this.database.prepare("INSERT INTO ags_semantic_results_v1 VALUES (?,?,?,?)")
        .run(evaluationId, requestDigest, resultDigest, resultJson);
      return this.read(this.row("evaluation_id", evaluationId)!);
    });
  }
}
