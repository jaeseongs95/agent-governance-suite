/** Internal v3 writer. The service supplies an admitted adoption; callers never supply a decision artifact. */
import {
  WorkflowContractError, type ModelRoutingDecisionV3,
} from "../../../contracts/types.js";
import type { SemanticAdoptionAssessmentV1 } from "../../../skills/coordinate-subagents/scripts/semantic/adoption-guard.mjs";
import {
  assert, canonical, digest, instant, validateBinding, verifySeal,
} from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import {
  replaySemanticDecisionV1, SEMANTIC_REDUCER_VERSION_V1,
} from "../../../skills/coordinate-subagents/scripts/semantic/replay.mjs";
import { SemanticAdviceAdmissionStore } from "../semantic/advice-admission.js";
import { SemanticEvaluationIntentStore } from "../semantic/evaluation-intent.js";
import { ContractValidator } from "../schema-validator.js";
import { readDecision } from "./decision-codec.js";

export interface RegisteredDecisionWrite {
  evaluationId: string;
  registrationId: string;
  baselineDecisionDigest: string;
  decisionTime: string;
}
export interface RegisteredAdoptionReader {
  read(evaluationId: string, registrationId: string, adviceDigest: string):
    Extract<SemanticAdoptionAssessmentV1, { status: "eligible" }> | null;
}

function deny(message: string): never { throw new WorkflowContractError("GATE_FAILED", message); }
type DecisionRow = { request_json: string; environment_json: string; payload: string };
type RegistrationRow = {
  request_json: string; advice_json: string; request_digest: string; advice_digest: string;
};
type ReferenceRow = {
  decision_digest: string; baseline_decision_digest: string; evaluation_id: string;
  registration_id: string; advice_digest: string;
};

export class RegisteredDecisionWriter {
  private readonly admission: SemanticAdviceAdmissionStore;
  private readonly intents: SemanticEvaluationIntentStore;
  private readonly validator = new ContractValidator();

  constructor(private readonly store: ModelRoutingStore,
    private readonly adoptionReader: RegisteredAdoptionReader | null = null) {
    this.admission = new SemanticAdviceAdmissionStore(store.database);
    this.intents = new SemanticEvaluationIntentStore(store.database);
  }

  write(input: RegisteredDecisionWrite): ModelRoutingDecisionV3 {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).sort().join(",") !== "baselineDecisionDigest,decisionTime,evaluationId,registrationId") {
      deny("Only registered decision references may be supplied.");
    }
    const registered = this.admission.get(input.evaluationId);
    const intent = this.intents.get(input.evaluationId);
    if (!registered || registered.registrationId !== input.registrationId || intent?.state !== "recorded"
      || registered.requestDigest !== intent.evaluation.request.requestDigest) {
      deny("Decision requires the exact registered runner advice.");
    }
    const adoption = this.adoptionReader?.read(input.evaluationId, input.registrationId,
      registered.advice.adviceDigest);
    if (!adoption || adoption.status !== "eligible"
      || Object.keys(adoption).sort().join(",") !== "evidenceDigest,status") {
      deny("Decision requires service-admitted adoption evidence.");
    }
    const baseline = readDecision(this.store, input.baselineDecisionDigest, this.validator);
    if (!baseline || baseline.decision.schemaVersion !== "2.0.0") {
      deny("Decision requires an immutable stored v2 baseline.");
    }
    instant(input.decisionTime, "decisionTime");
    const { request, environment } = baseline;
    const prepared = intent.evaluation.request;
    const advice = registered.advice;
    const requestJson = canonical(request), environmentJson = canonical(environment);
    const preparedJson = canonical(prepared), adviceJson = canonical(advice);
    const db = this.store.database;
    db.exec("BEGIN IMMEDIATE");
    try {
      const stored = db.prepare("SELECT * FROM ags_model_decisions_v2 WHERE decision_digest=?")
        .get(input.baselineDecisionDigest) as DecisionRow | undefined;
      assert(stored?.request_json === requestJson && stored?.environment_json === environmentJson,
        "BASELINE_MISMATCH");
      const baselineDecision = this.validator.modelRoutingDecisionV2(JSON.parse(stored.payload));
      verifySeal(baselineDecision, "decisionDigest");
      assert(baselineDecision.decisionDigest === input.baselineDecisionDigest, "BASELINE_MISMATCH");
      const registration = db.prepare(`SELECT a.*,q.request_json
        FROM ags_semantic_advice_v1 a JOIN ags_semantic_requests_v1 q USING (evaluation_id)
        JOIN ags_semantic_intents_v1 i USING (evaluation_id)
        WHERE a.evaluation_id=? AND a.registration_id=? AND i.state='recorded'`)
        .get(input.evaluationId, input.registrationId) as RegistrationRow | undefined;
      const current = this.admission.get(input.evaluationId);
      assert(current && canonical(current) === canonical(registered)
        && registration?.request_json === preparedJson && registration?.advice_json === adviceJson
        && registration?.request_digest === prepared.requestDigest
        && registration?.advice_digest === advice.adviceDigest, "ADVICE_REGISTRATION_MISMATCH");
      const decision = this.validator.modelRoutingDecisionV3(replaySemanticDecisionV1({
        routingRequest: request, environment: { ...environment, now: input.decisionTime },
        prepared, advice, adoption, decisionTime: input.decisionTime,
        reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
      }));
      verifySeal(decision, "decisionDigest");
      validateBinding(decision.binding);
      assert(decision.semantic.adviceDigest === advice.adviceDigest
        && decision.semantic.semanticRequestDigest === prepared.requestDigest
        && decision.semantic.baselineDecisionDigest === input.baselineDecisionDigest
        && decision.requestDigest === baselineDecision.requestDigest, "ADVICE_REGISTRATION_MISMATCH");
      const decisionJson = canonical(decision);
      const reference: ReferenceRow = {
        decision_digest: decision.decisionDigest, baseline_decision_digest: input.baselineDecisionDigest,
        evaluation_id: input.evaluationId, registration_id: input.registrationId,
        advice_digest: advice.adviceDigest,
      };
      const existing = db.prepare(`SELECT * FROM ags_model_decision_refs_v3
        WHERE evaluation_id=? OR registration_id=? OR decision_digest=?`)
        .all(input.evaluationId, input.registrationId, decision.decisionDigest) as ReferenceRow[];
      assert(existing.every(row => canonical({ ...row }) === canonical(reference)), "DECISION_CONFLICT");
      const old = db.prepare("SELECT * FROM ags_model_decisions_v2 WHERE decision_digest=?")
        .get(decision.decisionDigest) as DecisionRow | undefined;
      assert(!old || old.request_json === requestJson && old.environment_json === environmentJson
        && old.payload === decisionJson, "DECISION_CONFLICT");
      if (old) {
        assert(existing.length === 1, "DECISION_REFERENCE_MISSING");
      } else {
        db.prepare("INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)")
          .run(decision.decisionDigest, digest(decision.binding), requestJson, environmentJson,
            decisionJson, input.decisionTime);
        db.prepare("INSERT INTO ags_model_decision_refs_v3 VALUES (?,?,?,?,?)")
          .run(decision.decisionDigest, input.baselineDecisionDigest, input.evaluationId,
            input.registrationId, advice.adviceDigest);
      }
      db.exec("COMMIT");
      return decision;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
