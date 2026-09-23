/** Historical v3 replay and current dispatch safety are separate, read-only checks. */
import type { ModelSelectionRequestV2 } from "../../../contracts/model-routing-types.js";
import type { SemanticDecisionPolicyV1 } from "../../../contracts/types.js";
import {
  assert, canonical, collectEligibleCandidatesV2, digest, instant, verifySeal,
  type RoutingEnvironmentV2,
} from "../../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { replaySemanticDecisionV1, SEMANTIC_REDUCER_VERSION_V1 } from "../../../skills/coordinate-subagents/scripts/semantic/replay.mjs";
import { ContractValidator } from "../schema-validator.js";
import { SemanticAdviceAdmissionStore } from "../semantic/advice-admission.js";
import { SemanticEvaluationIntentStore } from "../semantic/evaluation-intent.js";
import { readDecision } from "./decision-codec.js";

type ReferenceRow = {
  evaluation_id: string; registration_id: string; advice_digest: string;
  baseline_decision_digest: string;
};

/** The caller must read these values from its owning workflow and host adapters immediately before dispatch. */
export interface CurrentSemanticDispatch {
  environment: RoutingEnvironmentV2;
  semanticPolicy: SemanticDecisionPolicyV1;
  authorization: {
    allowed: boolean;
    binding: ModelSelectionRequestV2["binding"];
    leaseState: string;
  };
  presence: {
    host: string; sessionId: string; instanceId: string;
    state: string; leaseUntil: string;
  };
}

export function revalidateStoredSemanticDispatch(
  store: ModelRoutingStore,
  journal: Pick<SemanticEvaluationIntentStore, "get">,
  admission: Pick<SemanticAdviceAdmissionStore, "get">,
  decisionDigest: string,
  historicalPolicyValue: unknown,
  readCurrent: () => CurrentSemanticDispatch,
): { decisionDigest: string; preflight: "current"; executionAuthorized: false } {
  const validator = new ContractValidator();
  const entry = readDecision(store, decisionDigest, validator);
  assert(entry?.decision.schemaVersion === "3.0.0", "STORED_V3_REQUIRED");
  const { decision, request, environment } = entry;
  const reference = store.database.prepare(`SELECT evaluation_id,registration_id,advice_digest,
    baseline_decision_digest FROM ags_model_decision_refs_v3 WHERE decision_digest=?`)
    .get(decisionDigest) as ReferenceRow | undefined;
  assert(reference && reference.baseline_decision_digest === decision.semantic.baselineDecisionDigest
    && reference.advice_digest === decision.semantic.adviceDigest, "SEMANTIC_REFERENCE_MISMATCH");
  const baseline = readDecision(store, reference.baseline_decision_digest, validator);
  assert(baseline?.decision.schemaVersion === "2.0.0", "BASELINE_MISMATCH");
  verifySeal(baseline.decision, "decisionDigest");
  assert(baseline.decision.decisionDigest === reference.baseline_decision_digest
    && canonical(baseline.request) === canonical(request)
    && canonical(baseline.environment) === canonical(environment), "BASELINE_MISMATCH");
  const intent = journal.get(reference.evaluation_id);
  const registered = admission.get(reference.evaluation_id);
  assert(intent?.state === "recorded" && registered
    && registered.registrationId === reference.registration_id
    && registered.advice.adviceDigest === reference.advice_digest
    && intent.evaluation.request.requestDigest === decision.semantic.semanticRequestDigest,
  "SEMANTIC_REFERENCE_MISMATCH");
  const policy = validator.semanticDecisionPolicyV1(historicalPolicyValue);
  assert(policy.mode === "assist" && policy.adoption.status === "validated"
    && digest(policy) === decision.semantic.semanticPolicyDigest
    && digest(policy) === intent.evaluation.request.semanticPolicyDigest,
  "HISTORICAL_POLICY_MISMATCH");
  assert(decision.semantic.reducerVersion === SEMANTIC_REDUCER_VERSION_V1, "UNSUPPORTED_REDUCER");
  const replayed = replaySemanticDecisionV1({
    routingRequest: request, environment: { ...environment, now: entry.resolvedAt },
    prepared: intent.evaluation.request, advice: registered.advice,
    adoption: { status: "eligible", evidenceDigest: policy.adoption.evidenceDigest },
    decisionTime: entry.resolvedAt, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
  });
  assert(replayed.decisionDigest === decisionDigest && canonical(replayed) === canonical(decision),
    "HISTORICAL_REPLAY_MISMATCH");

  const current = readCurrent();
  assert(current?.environment && current.authorization && current.presence, "DISPATCH_CONTEXT_UNAVAILABLE");
  const { authorization, presence } = current;
  const now = instant(current.environment.now, "now");
  assert(now >= instant(entry.resolvedAt, "decision time"), "DISPATCH_TIME_REGRESSION");
  assert(authorization.allowed === true, "DISPATCH_AUTHORIZATION_STALE");
  assert(authorization.binding.revision === decision.binding.revision, "DISPATCH_REVISION_STALE");
  assert(authorization.leaseState === "consumed"
    && canonical(authorization.binding) === canonical(decision.binding), "DISPATCH_LEASE_STALE");
  assert(current.environment.catalog.catalogDigest === decision.catalogDigest
    && digest(current.environment.policy) === decision.policyDigest, "DISPATCH_POLICY_STALE");
  const semanticPolicy = validator.semanticDecisionPolicyV1(current.semanticPolicy);
  assert(semanticPolicy.mode === "assist" && semanticPolicy.adoption.status === "validated"
    && digest(semanticPolicy) === decision.semantic.semanticPolicyDigest,
  "DISPATCH_SEMANTIC_POLICY_STALE");
  const pool = collectEligibleCandidatesV2(request, current.environment);
  assert(pool.capabilitySetDigest === decision.capabilitySetDigest, "DISPATCH_CAPABILITY_STALE");
  assert(pool.candidates.some(candidate => candidate.snapshot.snapshotDigest === decision.capabilitySnapshotDigest
    && canonical({ actorId: candidate.snapshot.actorId, host: candidate.snapshot.host,
      sessionId: candidate.snapshot.sessionId, instanceId: candidate.snapshot.instanceId }) === canonical(decision.target)
    && canonical({ model: candidate.binding.model, resolvedModel: candidate.binding.resolvedModel,
      modelOrigin: candidate.binding.modelOrigin, servingProvider: candidate.binding.servingProvider,
      accessPath: candidate.binding.accessPath, nativeReasoning: candidate.binding.nativeReasoning,
      runtimeMode: candidate.binding.runtimeMode }) === canonical(decision.selected)
    && candidate.binding.invocationSurface === decision.invocationSurface), "DISPATCH_SELECTION_STALE");
  assert(presence.host === decision.target.host && presence.sessionId === decision.target.sessionId
    && presence.instanceId === decision.target.instanceId && presence.state === "online", "PRESENCE_NOT_CURRENT");
  assert(instant(presence.leaseUntil, "presence leaseUntil") > now, "PRESENCE_EXPIRED");
  return { decisionDigest, preflight: "current", executionAuthorized: false };
}
