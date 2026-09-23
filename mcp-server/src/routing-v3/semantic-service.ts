/** Internal routing service. The model-callable boundary supplies only an assignment. */
import {
  WorkflowContractError, type ModelRoutingDecisionV2, type ModelRoutingDecisionV3,
  type SemanticDecisionPolicyV1, type SemanticDecisionProviderV1,
  type SemanticDecisionQuestionV1, type SemanticDecisionRequestV1,
  type SemanticModelAssignmentRequestV1,
} from "../../../contracts/types.js";
import {
  collectEligibleCandidatesV2, resolveV2, type RoutingEnvironmentV2,
} from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import {
  assessSemanticAdoptionV1, type ServiceAdmittedSemanticEvidenceV1,
} from "../../../skills/coordinate-subagents/scripts/semantic/adoption-guard.mjs";
import {
  reduceSemanticDecisionOutcomeV1, type SemanticNonAdoptionV1,
} from "../../../skills/coordinate-subagents/scripts/semantic/reducer.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import type { WorkflowStore } from "../workflow-store.js";
import { ContractValidator } from "../schema-validator.js";
import { SemanticAdviceAdmissionStore } from "../semantic/advice-admission.js";
import { validateSemanticAdviceForRequest } from "../semantic/advice-validator.js";
import { prepareSemanticRequest } from "../semantic/prepare-request.js";
import type { RunnerOutcome, SemanticProviderRunner } from "../semantic/provider-runner.js";
import type { TaskReferencePrincipal } from "../semantic/task-ref-resolver.js";
import { RegisteredDecisionWriter } from "./decision-writer.js";

export interface SemanticServiceContext {
  environment: RoutingEnvironmentV2;
  policy: SemanticDecisionPolicyV1;
  principal?: Readonly<TaskReferencePrincipal>;
  question?: SemanticDecisionQuestionV1;
  provider?: Omit<SemanticDecisionProviderV1, "providerVersion" | "modelVersion"> &
    Partial<Pick<SemanticDecisionProviderV1, "providerVersion" | "modelVersion">>;
  evaluationId?: string;
  idempotencyKey?: string;
  expiresAt?: string;
}

/** T18 supplies this from the server registry; a policy JSON value is never an admission. */
export interface ServerSemanticEvidenceReader {
  read(policy: SemanticDecisionPolicyV1, prepared: SemanticDecisionRequestV1):
    (ServiceAdmittedSemanticEvidenceV1 & { sufficient: true; registrationId: string }) | null;
}

export type SemanticServiceOutcome = ModelRoutingDecisionV2 | ModelRoutingDecisionV3 | SemanticNonAdoptionV1;

function fail(message: string, code: "GATE_FAILED" | "MISSING_EVIDENCE" | "INTEGRITY_FAILED" = "GATE_FAILED"): never {
  throw new WorkflowContractError(code, message);
}

export class SemanticRoutingService {
  private readonly validator = new ContractValidator();

  constructor(
    private readonly routing: ModelRoutingStore,
    private readonly workflow: Pick<WorkflowStore, "getGuardedRunSnapshot">,
    private readonly runner: Pick<SemanticProviderRunner, "run"> | null,
    private readonly contextFor: (assignment: SemanticModelAssignmentRequestV1) => SemanticServiceContext | Promise<SemanticServiceContext>,
    private readonly evidenceReader: ServerSemanticEvidenceReader | null = null,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async resolve(assignmentValue: unknown): Promise<SemanticServiceOutcome> {
    const assignment = this.validator.semanticModelAssignmentRequestV1(assignmentValue);
    const context = await this.contextFor(assignment);
    // The policy schema forbids assist without validated adoption. Treat that exact
    // inactive configuration as off while still validating the rest of the policy.
    const inactiveAssist = context.policy.mode === "assist" && context.policy.adoption.status === "unvalidated";
    const policy = this.validator.semanticDecisionPolicyV1(inactiveAssist
      ? { ...context.policy, mode: "off" } : context.policy);
    const routingRequest = assignment.routingRequest;
    const baseline = resolveV2(routingRequest, context.environment);
    this.routing.saveDecision(routingRequest, context.environment, baseline, context.environment.now);
    const reduce = (extra: object = {}) => reduceSemanticDecisionOutcomeV1({
      policy, routingRequest, baselineDecision: baseline, ...extra,
    });
    if (policy.mode !== "assist") return reduce();
    if (baseline.status === "blocked" || baseline.fallbackReason !== null) return baseline;
    if (routingRequest.highRisk) return reduce({ adoption: { status: "baseline", reasonCode: "HIGH_RISK_EXCLUDED" } });
    if (routingRequest.role === "independent-audit") {
      return reduce({ adoption: { status: "baseline", reasonCode: "INDEPENDENT_AUDIT_EXCLUDED" } });
    }
    // No operating reader means no assist attempt, even if policy JSON says validated.
    if (!this.evidenceReader || !this.runner || !policy.egress.enabled) return baseline;
    if (!context.principal || !context.question || !context.provider || !context.evaluationId
      || !context.idempotencyKey || !context.expiresAt) {
      fail("Trusted semantic context is unavailable.", "MISSING_EVIDENCE");
    }
    const prepared = prepareSemanticRequest({
      assignment, store: this.workflow, principal: context.principal,
      environment: context.environment, semanticPolicy: policy,
      question: context.question, provider: context.provider,
      evaluationId: context.evaluationId, expiresAt: context.expiresAt,
    });
    const evidence = this.evidenceReader.read(policy, prepared);
    if (!evidence || evidence.sufficient !== true || typeof evidence.registrationId !== "string"
      || !evidence.registrationId.trim()) return baseline;
    if (evidence.status !== "admitted" || evidence.evidenceDigest !== policy.adoption.evidenceDigest) {
      fail("Registered adoption evidence does not match policy.", "INTEGRITY_FAILED");
    }
    const runnerOutcome: RunnerOutcome = await this.runner.run({
      idempotencyKey: context.idempotencyKey, prepared,
    });
    if (runnerOutcome.status === "uncertain") fail("Semantic runner result is uncertain.", "MISSING_EVIDENCE");
    if (runnerOutcome.status !== "recorded") fail(`Semantic runner did not record a result: ${runnerOutcome.status}.`);
    const raw = runnerOutcome.result;
    if (raw.status === "abstained" || raw.status === "timeout" || raw.status === "unavailable") {
      const nonAdoption = raw.status === "abstained" ? "ABSTAINED"
        : raw.status === "timeout" ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE";
      return reduce({ nonAdoption });
    }
    if (raw.status !== "success") fail("Runner recorded an invalid provider outcome.", "INTEGRITY_FAILED");
    const registered = new SemanticAdviceAdmissionStore(this.routing.database, this.now)
      .register(prepared.evaluationId);
    const advice = validateSemanticAdviceForRequest({
      prepared, advice: registered.advice, now: this.now(),
    });
    const assessment = assessSemanticAdoptionV1(policy, routingRequest, prepared, advice, evidence);
    const reduced = reduce({
      prepared, advice, adoption: assessment,
      candidates: collectEligibleCandidatesV2(routingRequest, context.environment).candidates,
    });
    if (assessment.status !== "eligible") return reduced;
    if (!("schemaVersion" in reduced) || reduced.schemaVersion !== "3.0.0") {
      fail("Eligible advice did not produce a v3 decision.", "INTEGRITY_FAILED");
    }
    const reader = this.evidenceReader;
    const writer = new RegisteredDecisionWriter(this.routing, { read: (evaluationId, registrationId, adviceDigest) => {
      if (evaluationId !== prepared.evaluationId || registrationId !== registered.registrationId
        || adviceDigest !== advice.adviceDigest) return null;
      const current = reader.read(policy, prepared);
      if (!current || current.sufficient !== true || current.registrationId !== evidence.registrationId
        || current.status !== "admitted" || current.evidenceDigest !== evidence.evidenceDigest) return null;
      const currentAssessment = assessSemanticAdoptionV1(policy, routingRequest, prepared, advice, current);
      return currentAssessment.status === "eligible" ? currentAssessment : null;
    } });
    return writer.write({
      evaluationId: prepared.evaluationId, registrationId: registered.registrationId,
      baselineDecisionDigest: baseline.decisionDigest, decisionTime: this.now(),
    });
  }
}
