/** Pure v3 application record. The owning service must admit host evidence and bind the dispatch row. */
import {
  assert, canonical, digest, identifier, instant, keys, seal, text,
  validateBinding, validateCatalog, validatePolicy, validateReasoning,
  validateRequest, validateSelection, validateTarget, verifySeal,
} from '../model-routing-core.mjs';

const same = (left, right, code) => assert(canonical(left) === canonical(right), code);
const verification = (expected, actual, admitted) =>
  !admitted || actual === null || actual === undefined ? 'unverified'
    : canonical(expected) === canonical(actual) ? 'matched' : 'mismatch';

export function recordSemanticApplicationV3(input, {
  request, decision, catalog, policy, now, admittedObservation = null,
} = {}) {
  keys(input, ['schemaVersion', 'binding', 'decisionDigest', 'target', 'dispatched',
    'dispatchedAt', 'observation', 'semanticAdviceDigest'],
  ['schemaVersion', 'binding', 'decisionDigest', 'target', 'dispatched',
    'dispatchedAt', 'semanticAdviceDigest']);
  assert(input.schemaVersion === '3.0.0', 'INVALID_INPUT');
  validateBinding(input.binding); validateTarget(input.target); validateSelection(input.dispatched);
  instant(input.dispatchedAt, 'dispatchedAt');
  assert(input.dispatchedAt === now, 'DISPATCH_TIME_MISMATCH');
  validateRequest(request); validateCatalog(catalog); validatePolicy(policy);
  assert(decision?.schemaVersion === '3.0.0', 'STORED_V3_REQUIRED');
  verifySeal(decision, 'decisionDigest');
  assert(decision.status === 'selected' && decision.executionAuthorized === false
    && decision.trustedGateSatisfied === false, 'ASSIGNMENT_BLOCKED');
  same(input.binding, decision.binding, 'BINDING_MISMATCH');
  same(input.target, decision.target, 'BINDING_MISMATCH');
  assert(input.decisionDigest === decision.decisionDigest
    && input.semanticAdviceDigest === decision.semantic?.adviceDigest
    && digest(request) === decision.requestDigest
    && catalog.catalogDigest === decision.catalogDigest
    && digest(policy) === decision.policyDigest, 'BINDING_MISMATCH');
  same(input.dispatched, decision.selected, 'DISPATCH_MISMATCH');

  const observation = admittedObservation ?? input.observation ?? null;
  if (observation !== null) {
    keys(observation, ['binding', 'target', 'decisionDigest', 'source', 'reference',
      'observedAt', 'models', 'nativeReasoning', 'runtimeMode', 'terminalOutcome']);
    validateBinding(observation.binding); validateTarget(observation.target);
    same(observation.binding, input.binding, 'OBSERVATION_BINDING_MISMATCH');
    same(observation.target, input.target, 'OBSERVATION_BINDING_MISMATCH');
    assert(observation.decisionDigest === input.decisionDigest, 'OBSERVATION_BINDING_MISMATCH');
    assert(['host-event', 'tool-result', 'agent-self-report'].includes(observation.source), 'INVALID_INPUT');
    text(observation.reference, 'observation reference');
    assert(instant(observation.observedAt, 'observedAt') >= instant(now, 'now'), 'OBSERVATION_PREDATES_DISPATCH');
    assert(Array.isArray(observation.models) && observation.models.length <= 32, 'INVALID_INPUT');
    for (const model of observation.models) {
      keys(model, ['resolvedModel', 'modelOrigin']);
      identifier(model.resolvedModel, 'observed model'); identifier(model.modelOrigin, 'observed origin');
    }
    if (observation.nativeReasoning !== null) validateReasoning(observation.nativeReasoning);
    if (observation.runtimeMode !== null) identifier(observation.runtimeMode, 'runtimeMode');
    assert(['succeeded', 'failed', 'cancelled', 'unknown'].includes(observation.terminalOutcome), 'INVALID_INPUT');
  }
  const admitted = admittedObservation !== null && observation.source !== 'agent-self-report';
  const observedModels = observation?.models ?? [];
  const expectedModels = [{ resolvedModel: decision.selected.resolvedModel,
    modelOrigin: decision.selected.modelOrigin }];
  const modelVerification = verification(expectedModels, observedModels.length ? observedModels : null, admitted);
  const reasoningVerification = verification(decision.selected.nativeReasoning, observation?.nativeReasoning, admitted);
  const runtimeModeVerification = verification(decision.selected.runtimeMode, observation?.runtimeMode, admitted);
  const mismatch = [modelVerification, reasoningVerification, runtimeModeVerification].includes('mismatch');
  const originVerified = admitted && observedModels.length > 0 && observedModels.every(model =>
    policy.allowedOrigins.includes(model.modelOrigin)
      && catalog.models.some(candidate => candidate.id === model.resolvedModel
        && candidate.modelOrigin === model.modelOrigin));
  return seal({
    schemaVersion: '3.0.0', binding: structuredClone(input.binding), target: structuredClone(input.target),
    decisionDigest: decision.decisionDigest, requestDigest: decision.requestDigest,
    catalogDigest: decision.catalogDigest, policyDigest: decision.policyDigest,
    capabilitySnapshotDigest: decision.capabilitySnapshotDigest,
    requested: structuredClone(decision.requested), selected: structuredClone(decision.selected),
    dispatched: structuredClone(input.dispatched), dispatchedAt: input.dispatchedAt,
    observed: structuredClone(observation), modelVerification, reasoningVerification,
    runtimeModeVerification, originVerified,
    status: mismatch ? 'mismatch' : originVerified
      && [modelVerification, reasoningVerification, runtimeModeVerification].every(value => value === 'matched')
      ? 'matched' : 'unverified',
    terminalOutcome: admitted ? observation.terminalOutcome : 'unknown',
    observationAdmitted: admitted, trustedGateSatisfied: false, artifactOnly: true,
    semantic: structuredClone(decision.semantic),
  }, 'recordDigest');
}
