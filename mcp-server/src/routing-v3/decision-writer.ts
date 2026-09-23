/** Internal v3 writer. The service supplies an admitted adoption; callers never supply a decision artifact. */
import {
  WorkflowContractError, type ModelRoutingDecisionV3,
} from "../../../contracts/types.js";
import type { SemanticAdoptionAssessmentV1 } from "../../../skills/coordinate-subagents/scripts/semantic/adoption-guard.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
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
    const prepared = intent.evaluation.request;
    const decision = this.store.saveRegisteredDecisionV3({
      request: baseline.request, environment: baseline.environment, prepared,
      advice: registered.advice, adoption, evaluationId: input.evaluationId,
      registrationId: input.registrationId, baselineDecisionDigest: input.baselineDecisionDigest,
      now: input.decisionTime,
    });
    return decision;
  }
}
