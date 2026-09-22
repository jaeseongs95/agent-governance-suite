/** Test-only contract payloads, not a provider adapter, eligibility collector or v3 reducer. */
import { readFileSync } from 'node:fs';
import { fixture as legacyFixture, NOW, LATER, END } from '../../model-routing-v2/fixtures.mjs';
import { digest, seal } from '../../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
const root = new URL('../../../../', import.meta.url);
const read = path => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
export const question = () => read('skills/coordinate-subagents/references/semantic-decision/questions/model-ranking.v1.json');
export const policy = () => read('skills/coordinate-subagents/references/semantic-decision/decision-policy.v1.json');
export const bindingFields = ['evaluationId', 'binding', 'effectiveRoutingRequestDigest', 'stateDigest', 'questionDigest', 'catalogDigest', 'routingPolicyDigest', 'semanticPolicyDigest', 'capabilitySetDigest', 'eligibleSetDigest', 'optionMappingDigest', 'provider', 'reducerVersion'];
export function resealRequest(request) {
  return seal({ ...request, stateDigest: digest(request.state), questionDigest: digest(request.question), eligibleSetDigest: digest(request.eligibleSet), optionMappingDigest: digest(request.options) }, 'requestDigest');
}
export function contracts(mode = 'assist') {
  const legacy = legacyFixture();
  const model = legacy.decision.selected.model;
  const state = { text: 'Fixture task: review the read-only input and choose a suitable model.', sources: [{ kind: 'task', id: legacy.req.binding.taskId, digest: digest('fixture-task-source') }], summaryDigest: null };
  const request = resealRequest({
    schemaVersion: '1.0.0', evaluationId: 'fixture-evaluation-1', binding: structuredClone(legacy.req.binding),
    effectiveRoutingRequestDigest: legacy.decision.requestDigest, stateDigest: digest(state), questionDigest: digest(question()),
    catalogDigest: legacy.decision.catalogDigest, routingPolicyDigest: legacy.decision.policyDigest,
    semanticPolicyDigest: digest(policy()), capabilitySetDigest: legacy.decision.capabilitySetDigest,
    eligibleSetDigest: digest('placeholder'), optionMappingDigest: digest('placeholder'),
    provider: { id: 'fixture-provider', model: 'fixture-choice', adapterVersion: 'fixture-v1', providerVersion: 'fixture-v1', modelVersion: 'fixture-v1' }, reducerVersion: 'fixture-reducer-v1',
    mode, state, question: question(),
    eligibleSet: [
      { candidateKey: 'fixture-candidate-a', model, preferenceGroup: 0, baselineRank: 0 },
      { candidateKey: 'fixture-candidate-b', model, preferenceGroup: 0, baselineRank: 1 },
      { candidateKey: 'fixture-candidate-c', model: 'fixture-other-model', preferenceGroup: 1, baselineRank: 2 },
    ],
    options: [
      { optionId: 'option-a', model, candidateKeys: ['fixture-candidate-a', 'fixture-candidate-b'] },
      { optionId: 'option-b', model: 'fixture-other-model', candidateKeys: ['fixture-candidate-c'] },
    ], requestedAt: NOW, expiresAt: END,
  });
  const advice = seal({
    schemaVersion: '1.0.0', ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(request[key])])),
    semanticRequestDigest: request.requestDigest,
    choice: { kind: 'Choice', selectedOptionIds: ['option-a'], confidence: 0.75 },
    evaluatedAt: LATER, expiresAt: END,
  }, 'adviceDigest');
  const semantic = {
    mode: 'assist', adviceDigest: advice.adviceDigest, semanticRequestDigest: advice.semanticRequestDigest,
    semanticPolicyDigest: advice.semanticPolicyDigest, eligibleSetDigest: advice.eligibleSetDigest,
    optionMappingDigest: advice.optionMappingDigest, reducerVersion: advice.reducerVersion,
    selectedOptionId: 'option-a', baselineDecisionDigest: legacy.decision.decisionDigest,
  };
  // Hand-authored expected v3 shape. No production v3 writer/reducer exists in S1a.
  const decision = seal({ ...structuredClone(legacy.decision), schemaVersion: '3.0.0', semantic }, 'decisionDigest');
  const application = {
    schemaVersion: '3.0.0', binding: structuredClone(decision.binding), decisionDigest: decision.decisionDigest,
    target: structuredClone(decision.target), dispatched: structuredClone(decision.selected), dispatchedAt: LATER,
    semanticAdviceDigest: advice.adviceDigest,
  };
  const record = seal({
    schemaVersion: '3.0.0', binding: structuredClone(decision.binding), target: structuredClone(decision.target),
    decisionDigest: decision.decisionDigest, requestDigest: decision.requestDigest, catalogDigest: decision.catalogDigest,
    policyDigest: decision.policyDigest, capabilitySnapshotDigest: decision.capabilitySnapshotDigest,
    requested: decision.requested, selected: structuredClone(decision.selected), dispatched: structuredClone(application.dispatched),
    dispatchedAt: application.dispatchedAt, observed: null, modelVerification: 'unverified', reasoningVerification: 'unverified',
    runtimeModeVerification: 'unverified', originVerified: false, status: 'unverified', terminalOutcome: 'unknown',
    observationAdmitted: false, trustedGateSatisfied: false, artifactOnly: true, semantic: structuredClone(semantic),
  }, 'recordDigest');
  const assignment = { schemaVersion: '1.0.0', routingRequest: structuredClone(legacy.req), taskRef: { taskId: legacy.req.binding.taskId } };
  return { legacy, request, advice, decision, application, record, assignment, policy: policy(), question: question() };
}
