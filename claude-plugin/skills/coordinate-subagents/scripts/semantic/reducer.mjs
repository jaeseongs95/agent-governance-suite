/** Pure assist reducer. Callers validate fresh inputs and service admission first. */
import {
  assert, canonical, digest, seal, validateCapabilities, verifySeal,
} from '../model-routing-core.mjs';

const bindingFields = [
  'evaluationId', 'binding', 'effectiveRoutingRequestDigest', 'stateDigest',
  'questionDigest', 'catalogDigest', 'routingPolicyDigest', 'semanticPolicyDigest',
  'capabilitySetDigest', 'eligibleSetDigest', 'optionMappingDigest', 'provider', 'reducerVersion',
];
const selectionFields = [
  'model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath',
  'nativeReasoning', 'runtimeMode',
];
const targetFields = ['actorId', 'host', 'sessionId', 'instanceId'];
const pick = (value, fields) => Object.fromEntries(fields.map(key => [key, structuredClone(value[key])]));

/** Preserve the v2 artifact for policy bypasses; classify only allowed assist non-adoption. */
export function reduceSemanticDecisionOutcomeV1({
  policy, routingRequest, baselineDecision, prepared = null, advice = null,
  adoption = null, candidates = [], nonAdoption = null,
}) {
  verifySeal(baselineDecision, 'decisionDigest');
  assert(baselineDecision.schemaVersion === '2.0.0'
    && baselineDecision.requestDigest === digest(routingRequest)
    && canonical(baselineDecision.binding) === canonical(routingRequest.binding)
    && canonical(baselineDecision.requested) === canonical(routingRequest.user ?? null)
    && baselineDecision.executionAuthorized === false
    && baselineDecision.trustedGateSatisfied === false, 'BASELINE_MISMATCH');
  assert(['off', 'shadow', 'assist'].includes(policy?.mode), 'INVALID_INPUT');
  if (prepared !== null) {
    verifySeal(prepared, 'requestDigest');
    assert(canonical(prepared.binding) === canonical(routingRequest.binding)
      && prepared.effectiveRoutingRequestDigest === baselineDecision.requestDigest
      && prepared.catalogDigest === baselineDecision.catalogDigest
      && prepared.routingPolicyDigest === baselineDecision.policyDigest
      && prepared.capabilitySetDigest === baselineDecision.capabilitySetDigest
      && prepared.semanticPolicyDigest === digest(policy), 'REQUEST_BINDING_MISMATCH');
  }
  if (advice !== null) {
    verifySeal(advice, 'adviceDigest');
    assert(prepared !== null
      && bindingFields.every(key => canonical(prepared[key]) === canonical(advice[key]))
      && advice.semanticRequestDigest === prepared.requestDigest, 'ADVICE_BINDING_MISMATCH');
  }
  if (policy.mode !== 'assist') return baselineDecision;
  if (adoption?.status === 'baseline') {
    const allowed = [
      'HIGH_RISK_EXCLUDED', 'INDEPENDENT_AUDIT_EXCLUDED', 'SCOPE_NOT_PRESERVED',
      'ADOPTION_UNVALIDATED', 'PROVIDER_NOT_ALLOWED', 'CONFIDENCE_UNKNOWN',
      'CONFIDENCE_BELOW_MINIMUM',
    ];
    assert(allowed.includes(adoption.reasonCode), 'NON_ADOPTION_NOT_FALLBACK');
  }
  if (nonAdoption !== null) {
    assert(adoption === null && advice === null
      && ['ABSTAINED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE'].includes(nonAdoption),
      'NON_ADOPTION_NOT_FALLBACK');
  }
  if (baselineDecision.status === 'blocked' || baselineDecision.fallbackReason !== null) return baselineDecision;
  if (adoption?.status === 'baseline') {
    return { status: 'non-adoption', reasonCode: adoption.reasonCode, baselineDecision };
  }
  if (nonAdoption !== null) {
    return { status: 'non-adoption', reasonCode: nonAdoption, baselineDecision };
  }
  assert(adoption?.status === 'eligible' && prepared !== null && advice !== null, 'ADOPTION_NOT_ELIGIBLE');
  return reduceSemanticDecisionV1({ prepared, advice, adoption, baselineDecision, candidates });
}

export function reduceSemanticDecisionV1({ prepared, advice, adoption, baselineDecision, candidates }) {
  assert(adoption?.status === 'eligible', 'ADOPTION_NOT_ELIGIBLE');
  assert(prepared?.mode === 'assist' && baselineDecision?.schemaVersion === '2.0.0'
    && baselineDecision.status === 'selected' && baselineDecision.fallbackReason === null,
  'INVALID_INPUT', 'Assist and selected v2 baseline without fallback required');
  verifySeal(prepared, 'requestDigest');
  verifySeal(advice, 'adviceDigest');
  verifySeal(baselineDecision, 'decisionDigest');
  assert(bindingFields.every(key => canonical(prepared[key]) === canonical(advice[key]))
    && advice.semanticRequestDigest === prepared.requestDigest, 'ADVICE_BINDING_MISMATCH');
  assert(canonical(prepared.binding) === canonical(baselineDecision.binding)
    && prepared.effectiveRoutingRequestDigest === baselineDecision.requestDigest
    && prepared.catalogDigest === baselineDecision.catalogDigest
    && prepared.routingPolicyDigest === baselineDecision.policyDigest
    && prepared.capabilitySetDigest === baselineDecision.capabilitySetDigest
    && baselineDecision.executionAuthorized === false
    && baselineDecision.trustedGateSatisfied === false, 'BASELINE_MISMATCH');
  assert(prepared.eligibleSetDigest === digest(prepared.eligibleSet)
    && prepared.optionMappingDigest === digest(prepared.options), 'DIGEST_MISMATCH');
  assert(Array.isArray(prepared.eligibleSet) && prepared.eligibleSet.length > 0
    && Array.isArray(prepared.options) && prepared.options.length > 0
    && Array.isArray(candidates) && candidates.length === prepared.eligibleSet.length, 'INVALID_INPUT');

  const byKey = new Map();
  for (const candidate of candidates) {
    validateCapabilities(candidate.snapshot);
    assert(candidate.key === digest({ snapshotDigest: candidate.snapshot.snapshotDigest, binding: candidate.binding })
      && candidate.model?.id === candidate.binding?.resolvedModel
      && candidate.snapshot.supportedBindings.some(binding => canonical(binding) === canonical(candidate.binding))
      && !byKey.has(candidate.key), 'CANDIDATE_MISMATCH');
    byKey.set(candidate.key, candidate);
  }
  const eligible = prepared.eligibleSet;
  const eligibleByKey = new Map();
  for (const [rank, item] of eligible.entries()) {
    assert(item.baselineRank === rank && Number.isSafeInteger(item.preferenceGroup)
      && item.preferenceGroup >= 0 && (rank === 0 || item.preferenceGroup >= eligible[rank - 1].preferenceGroup)
      && !eligibleByKey.has(item.candidateKey) && byKey.get(item.candidateKey)?.model.id === item.model, 'ELIGIBLE_SET_MISMATCH');
    eligibleByKey.set(item.candidateKey, item);
  }
  const first = byKey.get(eligible[0].candidateKey);
  assert(canonical(baselineDecision.selected) === canonical(pick(first.binding, selectionFields))
    && canonical(baselineDecision.target) === canonical(pick(first.snapshot, targetFields))
    && baselineDecision.invocationSurface === first.binding.invocationSurface
    && baselineDecision.capabilitySnapshotDigest === first.snapshot.snapshotDigest, 'BASELINE_MISMATCH');

  const optionById = new Map(), mapped = new Set();
  for (const option of prepared.options) {
    assert(!optionById.has(option.optionId) && Array.isArray(option.candidateKeys)
      && option.candidateKeys.length > 0, 'OPTION_MAPPING_MISMATCH');
    optionById.set(option.optionId, option);
    for (const key of option.candidateKeys) {
      assert(eligibleByKey.has(key) && !mapped.has(key)
        && eligibleByKey.get(key).model === option.model, 'OPTION_MAPPING_MISMATCH');
      mapped.add(key);
    }
  }
  assert(mapped.size === eligibleByKey.size && Array.isArray(advice.choice?.selectedOptionIds)
    && advice.choice.selectedOptionIds.length > 0
    && new Set(advice.choice.selectedOptionIds).size === advice.choice.selectedOptionIds.length, 'OPTION_MAPPING_MISMATCH');
  const selected = new Set();
  for (const id of advice.choice.selectedOptionIds) {
    const option = optionById.get(id);
    assert(option, 'UNKNOWN_OPTION');
    for (const key of option.candidateKeys) selected.add(key);
  }
  const winner = eligible.find(item => item.preferenceGroup === eligible[0].preferenceGroup && selected.has(item.candidateKey));
  assert(winner, 'PREFERENCE_GROUP_VIOLATION');
  const concrete = byKey.get(winner.candidateKey);
  const selectedOptionId = advice.choice.selectedOptionIds.find(id => optionById.get(id).candidateKeys.includes(winner.candidateKey));
  const semantic = {
    mode: 'assist', adviceDigest: advice.adviceDigest, semanticRequestDigest: prepared.requestDigest,
    semanticPolicyDigest: prepared.semanticPolicyDigest, eligibleSetDigest: prepared.eligibleSetDigest,
    optionMappingDigest: prepared.optionMappingDigest, reducerVersion: prepared.reducerVersion,
    selectedOptionId, baselineDecisionDigest: baselineDecision.decisionDigest,
  };
  return seal({
    ...structuredClone(baselineDecision), schemaVersion: '3.0.0',
    capabilitySnapshotDigest: concrete.snapshot.snapshotDigest,
    selected: pick(concrete.binding, selectionFields), target: pick(concrete.snapshot, targetFields),
    invocationSurface: concrete.binding.invocationSurface, status: 'selected',
    executionAuthorized: false, trustedGateSatisfied: false,
    selectionReasonCodes: [...new Set([
      ...baselineDecision.selectionReasonCodes.filter(code => code === 'PREFERRED_CHOICE_UNAVAILABLE'),
      'SEMANTIC_ADVICE_ADOPTED',
    ])],
    fallbackReason: null, semantic,
  }, 'decisionDigest');
}
