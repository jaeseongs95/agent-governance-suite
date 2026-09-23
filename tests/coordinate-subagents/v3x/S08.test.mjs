import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, resolveV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { reduceSemanticDecisionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/reducer.mjs';
import { replaySemanticDecisionV1, SEMANTIC_REDUCER_VERSION_V1 } from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { capability, environment, LATER, END, request } from '../model-routing-v2/fixtures.mjs';
import { bindingFields, contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const GOLDEN_SHA256 = '6e6ab050a229b4ae9aeb2e767722f69498a873bed02a3854c4e351c13749d54f';
const MODELS = { terra: 'gpt-5.6-terra', sol: 'gpt-5.6-sol' };
const selection = name => ({
  model: MODELS[name], resolvedModel: MODELS[name], modelOrigin: 'openai', servingProvider: 'openai',
  accessPath: 'subscription', nativeReasoning: { kind: 'enum', value: 'high' }, runtimeMode: 'standard',
});
const target = name => ({ actorId: `actor-${name}`, host: 'openai-codex',
  sessionId: `session-${name}`, instanceId: 'instance-1' });
const candidateKey = snapshot => digest({
  snapshotDigest: snapshot.snapshotDigest, binding: snapshot.supportedBindings[0],
});

function scenario({ preferred = false, reverseCandidates = false, reverseOptions = false, chosen = ['terra'] } = {}) {
  const routingRequest = request(preferred ? { user: { strength: 'preferred', model: MODELS.sol } } : {});
  const snapshots = {
    terra: capability(target('terra')),
    sol: capability(target('sol'), { model: MODELS.sol, resolvedModel: MODELS.sol }),
  };
  const env = environment({ capabilities: reverseCandidates
    ? [snapshots.sol, snapshots.terra] : [snapshots.terra, snapshots.sol], now: LATER });
  const pool = collectEligibleCandidatesV2(routingRequest, env);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, env);
  const projection = projectSemanticCandidatesV1(reverseCandidates ? [...pool.candidates].reverse() : pool.candidates,
    reverseCandidates ? [...metadata].reverse() : metadata);
  const ranked = ['sol', 'terra']; // Hand-authored v2 balanced/code-change order for these two fixture models.
  const manualEligible = ranked.map((name, baselineRank) => ({
    candidateKey: candidateKey(snapshots[name]), model: MODELS[name],
    preferenceGroup: preferred ? baselineRank : 1, baselineRank,
  }));
  const manualOptions = ['sol', 'terra'].map(name => ({
    optionId: MODELS[name], model: MODELS[name], candidateKeys: [candidateKey(snapshots[name])],
  }));
  assert.deepEqual(projection.eligibleSet, manualEligible);
  assert.deepEqual(projection.options, manualOptions);
  const prepared = resealRequest({
    ...contracts().request, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
    binding: structuredClone(routingRequest.binding), effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: env.catalog.catalogDigest, routingPolicyDigest: digest(env.policy),
    capabilitySetDigest: pool.capabilitySetDigest, eligibleSet: projection.eligibleSet,
    options: reverseOptions ? [...projection.options].reverse() : projection.options,
  });
  const advice = seal({
    ...contracts().advice,
    ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(prepared[key])])),
    semanticRequestDigest: prepared.requestDigest,
    choice: { kind: 'Choice', selectedOptionIds: chosen.map(name => MODELS[name]), confidence: 0.75 },
  }, 'adviceDigest');
  return { routingRequest, environment: env, snapshots, prepared, advice,
    adoption: { status: 'eligible', evidenceDigest: digest('archived-admission') },
    baselineDecision: resolveV2(routingRequest, env), candidates: pool.candidates,
    decisionTime: LATER, reducerVersion: SEMANTIC_REDUCER_VERSION_V1 };
}

// Independent semantic oracle: literals above define the chosen binding and target; no S1c result builds expected.
function expectedDecision(input, name) {
  const { baselineDecision, prepared, advice, snapshots } = input;
  return seal({
    ...structuredClone(baselineDecision), schemaVersion: '3.0.0',
    capabilitySnapshotDigest: snapshots[name].snapshotDigest,
    selected: selection(name), target: target(name), invocationSurface: 'local-subagent',
    status: 'selected', selectionReasonCodes: ['SEMANTIC_ADVICE_ADOPTED'], fallbackReason: null,
    semantic: {
      mode: 'assist', adviceDigest: advice.adviceDigest, semanticRequestDigest: prepared.requestDigest,
      semanticPolicyDigest: prepared.semanticPolicyDigest, eligibleSetDigest: prepared.eligibleSetDigest,
      optionMappingDigest: prepared.optionMappingDigest, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
      selectedOptionId: MODELS[name], baselineDecisionDigest: baselineDecision.decisionDigest,
    },
  }, 'decisionDigest');
}

test('the original v2 golden bytes remain fixed', () => {
  const bytes = readFileSync(new URL('../semantic-decision/fixtures/v2-golden.json', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), GOLDEN_SHA256);
});

test('candidate and option permutations match a separately authored terra decision', () => {
  const original = scenario(), expected = expectedDecision(original, 'terra');
  for (const variant of [original, scenario({ reverseCandidates: true }),
    scenario({ reverseOptions: true }), scenario({ reverseCandidates: true, reverseOptions: true })]) {
    const actual = reduceSemanticDecisionV1(variant);
    const manual = expectedDecision(variant, 'terra');
    assert.deepEqual(actual, manual);
    assert.deepEqual(actual.selected, selection('terra'));
    assert.deepEqual(actual.target, target('terra'));
    if (variant.prepared.options[0].optionId !== original.prepared.options[0].optionId) {
      assert.notEqual(actual.decisionDigest, expected.decisionDigest);
      assert.throws(() => replaySemanticDecisionV1(variant), { code: 'PREPARED_INPUT_MISMATCH' });
    } else {
      assert.equal(actual.decisionDigest, expected.decisionDigest);
      assert.equal(replaySemanticDecisionV1(variant).decisionDigest, manual.decisionDigest);
    }
  }
});

test('preferred sol cannot be displaced by terra advice or option order', () => {
  const wrong = scenario({ preferred: true, chosen: ['terra'], reverseOptions: true });
  assert.throws(() => reduceSemanticDecisionV1(wrong), { code: 'PREFERENCE_GROUP_VIOLATION' });
  const both = scenario({ preferred: true, chosen: ['terra', 'sol'], reverseOptions: true });
  assert.deepEqual(reduceSemanticDecisionV1(both), expectedDecision(both, 'sol'));
  const canonicalOptions = scenario({ preferred: true, chosen: ['terra', 'sol'] });
  assert.deepEqual(replaySemanticDecisionV1(canonicalOptions), expectedDecision(canonicalOptions, 'sol'));
});

test('expired advice and resealed option mapping mutations fail replay', () => {
  const original = scenario();
  assert.throws(() => replaySemanticDecisionV1({
    ...original, decisionTime: END, environment: { ...original.environment, now: END },
  }), { code: 'REPLAY_TIME_MISMATCH' });
  const options = structuredClone(original.prepared.options);
  options[0].optionId = 'forged-sol-option';
  const prepared = resealRequest({ ...original.prepared, options });
  const advice = seal({ ...original.advice,
    ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(prepared[key])])),
    semanticRequestDigest: prepared.requestDigest,
    choice: { ...original.advice.choice, selectedOptionIds: ['forged-sol-option'] },
  }, 'adviceDigest');
  assert.throws(() => replaySemanticDecisionV1({ ...original, prepared, advice }),
    { code: 'PREPARED_INPUT_MISMATCH' });
});
