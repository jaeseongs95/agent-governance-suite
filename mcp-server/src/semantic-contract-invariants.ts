/** Contract integrity only. No provider call, reducer, admission, clock read, or execution gate. */
import {
  canonical,
  digest,
  instant,
  verifySeal,
} from "../../skills/coordinate-subagents/scripts/model-routing-core.mjs";
import {
  WorkflowContractError,
  type SemanticDecisionRequestV1,
  type SemanticDecisionAdviceV1,
  type SemanticDecisionPolicyV1,
  type SemanticModelAssignmentRequestV1,
  type ModelRoutingDecisionV3,
  type ModelApplicationRequestV3,
  type ModelApplicationRecordV3,
} from "../../contracts/types.js";

function requireContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new WorkflowContractError("INVALID_INPUT", message);
}

/** Reject non-JSON/non-finite inputs before Ajv without changing legacy v2 validators. */
export function assertSemanticJson(value: unknown): void {
  try {
    canonical(value);
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "Semantic contracts require finite, plain JSON values.");
  }
}

function same(a: unknown, b: unknown, name: string): void {
  requireContract(canonical(a) === canonical(b), `Semantic contract binding mismatch: ${name}.`);
}

function seal(value: unknown, field: string): void {
  try {
    verifySeal(value, field);
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", `Semantic contract digest mismatch: ${field}.`);
  }
}

function time(value: string): number {
  try {
    return instant(value, "semantic timestamp");
  } catch {
    throw new WorkflowContractError("INVALID_INPUT", "Canonical UTC semantic timestamp required.");
  }
}

export function assertSemanticRequestIntegrity(request: SemanticDecisionRequestV1): void {
  seal(request, "requestDigest");
  same(request.stateDigest, digest(request.state), "stateDigest");
  same(request.questionDigest, digest(request.question), "questionDigest");
  same(request.eligibleSetDigest, digest(request.eligibleSet), "eligibleSetDigest");
  same(request.optionMappingDigest, digest(request.options), "optionMappingDigest");
  if (request.state.summaryDigest !== null) {
    same(request.state.summaryDigest, digest(request.state.text), "summaryDigest");
  }
  requireContract(request.state.sources.some(source => source.kind === "task" && source.id === request.binding.taskId), "Task source must match the routing binding.");
  requireContract(time(request.expiresAt) > time(request.requestedAt), "Semantic request expiry must follow requestedAt.");

  const candidates = new Map(request.eligibleSet.map(candidate => [candidate.candidateKey, candidate]));
  requireContract(candidates.size === request.eligibleSet.length, "Duplicate eligible candidate key.");
  const ranked = [...request.eligibleSet].sort((a, b) => a.baselineRank - b.baselineRank);
  requireContract(ranked.every((candidate, index) => candidate.baselineRank === index), "Baseline ranks must be unique and contiguous from zero.");
  requireContract(ranked.every((candidate, index) => index === 0 || candidate.preferenceGroup >= ranked[index - 1]!.preferenceGroup), "Baseline preference groups must be ordered.");
  const ids = new Set<string>();
  const models = new Set<string>();
  const mapped = new Set<string>();
  for (const option of request.options) {
    requireContract(!ids.has(option.optionId) && !models.has(option.model), "Each model must have one unique option ID.");
    ids.add(option.optionId);
    models.add(option.model);
    for (const key of option.candidateKeys) {
      const candidate = candidates.get(key);
      requireContract(candidate && candidate.model === option.model && !mapped.has(key), "Option mapping must reference distinct eligible candidates of the same model.");
      mapped.add(key);
    }
  }
  requireContract(mapped.size === candidates.size, "Option mapping must cover the eligible set exactly.");
}

export function assertSemanticAdviceIntegrity(advice: SemanticDecisionAdviceV1): void {
  seal(advice, "adviceDigest");
  requireContract(time(advice.expiresAt) > time(advice.evaluatedAt), "Advice expiry must follow evaluatedAt.");
}

/** Shape-valid bytes are not proof of local admission or permission. S2 owns that boundary. */
export function assertSemanticAdviceBinding(advice: SemanticDecisionAdviceV1, request: SemanticDecisionRequestV1): void {
  const fields = ["evaluationId", "binding", "effectiveRoutingRequestDigest", "stateDigest", "questionDigest", "catalogDigest", "routingPolicyDigest", "semanticPolicyDigest", "capabilitySetDigest", "eligibleSetDigest", "optionMappingDigest", "provider", "reducerVersion", "expiresAt"] as const;
  for (const field of fields) same(advice[field], request[field], field);
  same(advice.semanticRequestDigest, request.requestDigest, "semanticRequestDigest");
  requireContract(time(advice.evaluatedAt) >= time(request.requestedAt), "Advice cannot precede its evaluation request.");
  const optionIds = new Set(request.options.map(option => option.optionId));
  requireContract(advice.choice.selectedOptionIds.every(id => optionIds.has(id)), "Advice selected an option outside the prepared request.");
}

export function assertSemanticPolicyConsistency(policy: SemanticDecisionPolicyV1): void {
  if (policy.mode === "assist" && policy.adoption.status === "validated") {
    requireContract(policy.egress.allowedProviders.includes(policy.adoption.provider.id), "Validated provider must be explicitly allowed for assist.");
  }
}

export function assertSemanticAssignmentBinding(request: SemanticModelAssignmentRequestV1): void {
  same(request.taskRef.taskId, request.routingRequest.binding.taskId, "taskRef.taskId");
}

export function assertSemanticDecisionIntegrity(decision: ModelRoutingDecisionV3): void {
  seal(decision, "decisionDigest");
}

export function assertSemanticDecisionBinding(decision: ModelRoutingDecisionV3, advice: SemanticDecisionAdviceV1, request: SemanticDecisionRequestV1): void {
  requireContract(request.mode === "assist", "Only an adopted assist evaluation can produce a v3 decision.");
  same(decision.binding, advice.binding, "decision.binding");
  same(decision.requestDigest, advice.effectiveRoutingRequestDigest, "decision.requestDigest");
  same(decision.catalogDigest, advice.catalogDigest, "decision.catalogDigest");
  same(decision.policyDigest, advice.routingPolicyDigest, "decision.policyDigest");
  same(decision.capabilitySetDigest, advice.capabilitySetDigest, "decision.capabilitySetDigest");
  const fields = ["adviceDigest", "semanticRequestDigest", "semanticPolicyDigest", "eligibleSetDigest", "optionMappingDigest", "reducerVersion"] as const;
  for (const field of fields) same(decision.semantic[field], advice[field], `decision.semantic.${field}`);
  const option = request.options.find(item => item.optionId === decision.semantic.selectedOptionId);
  requireContract(option && advice.choice.selectedOptionIds.includes(option.optionId) && option.model === decision.selected.model, "Selected model must match an advised prepared option.");
}

export function assertSemanticApplicationBinding(application: ModelApplicationRequestV3, decision: ModelRoutingDecisionV3): void {
  same(application.binding, decision.binding, "application.binding");
  same(application.target, decision.target, "application.target");
  same(application.decisionDigest, decision.decisionDigest, "application.decisionDigest");
  same(application.semanticAdviceDigest, decision.semantic.adviceDigest, "application.semanticAdviceDigest");
  same(application.dispatched, decision.selected, "application.dispatched");
  time(application.dispatchedAt);
  // These are references only; no observation is admitted and no field becomes 'matched'.
  if (application.observation) {
    requireContract(time(application.observation.observedAt) >= time(application.dispatchedAt), "Observation cannot precede dispatch.");
    same(application.observation.binding, application.binding, "observation.binding");
    same(application.observation.target, application.target, "observation.target");
    same(application.observation.decisionDigest, application.decisionDigest, "observation.decisionDigest");
  }
}

export function assertSemanticRecordIntegrity(record: ModelApplicationRecordV3): void {
  seal(record, "recordDigest");
  time(record.dispatchedAt);
  if (record.observed) {
    requireContract(time(record.observed.observedAt) >= time(record.dispatchedAt), "Observation cannot precede dispatch.");
    same(record.observed.binding, record.binding, "record.observed.binding");
    same(record.observed.target, record.target, "record.observed.target");
    same(record.observed.decisionDigest, record.decisionDigest, "record.observed.decisionDigest");
  }
}

/** Referential integrity only; host receipt admission and historical replay remain S2 responsibilities. */
export function assertSemanticRecordBinding(record: ModelApplicationRecordV3, decision: ModelRoutingDecisionV3): void {
  const fields = ["binding", "target", "decisionDigest", "requestDigest", "catalogDigest", "policyDigest", "capabilitySnapshotDigest", "requested", "selected", "semantic"] as const;
  for (const field of fields) same(record[field], decision[field], `record.${field}`);
  same(record.dispatched, decision.selected, "record.dispatched");
}
