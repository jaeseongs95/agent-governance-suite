import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import {
  canonical, collectEligibleCandidatesV2, getBaselineCandidateMetadataV2,
  rankBaselineCandidatesV2, resolveV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { capability, environment, request } from '../model-routing-v2/fixtures.mjs';

const golden = JSON.parse(readFileSync(new URL('../semantic-decision/fixtures/v2-golden.json', import.meta.url)));
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
}

test('S01 keeps every fixed v2 payload, canonical string, and digest', () => {
  for (const entry of golden.cases) {
    const req = freeze(structuredClone(entry.request));
    const env = freeze({ ...structuredClone(golden.environment), ...structuredClone(entry.environmentPatch) });
    const pool = collectEligibleCandidatesV2(req, env);
    const ranked = rankBaselineCandidatesV2(pool.candidates, req, env);
    const metadata = getBaselineCandidateMetadataV2(pool.candidates, req, env);
    assert.deepEqual(metadata, ranked.map((candidate, baselineRank) => ({
      candidateKey: candidate.key,
      preferenceGroup: metadata[baselineRank].preferenceGroup,
      baselineRank,
    })), entry.name);
    const decision = resolveV2(req, env);
    assert.equal(JSON.stringify(decision), JSON.stringify(entry.expected), entry.name);
    assert.equal(canonical(decision), entry.expectedCanonical, entry.name);
    assert.equal(decision.decisionDigest, entry.expected.decisionDigest, entry.name);
  }
});

test('required and preferred aliases retain the existing preference groups', () => {
  const env = environment({ capabilities: [
    capability({ sessionId: 'sol' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
    capability({ host: 'anthropic-claude-code', sessionId: 'sonnet' }, {
      model: 'claude-sonnet-5', resolvedModel: 'claude-sonnet-5', modelOrigin: 'anthropic', servingProvider: 'anthropic',
    }),
  ] });
  for (const strength of ['required', 'preferred']) {
    const req = request({ user: { strength, model: 'sonnet' } });
    const candidates = collectEligibleCandidatesV2(req, env).candidates;
    const metadata = getBaselineCandidateMetadataV2(candidates, req, env);
    assert.equal(metadata.length, strength === 'required' ? 1 : 2);
    assert.equal(metadata[0].preferenceGroup, 0);
    assert.equal(candidates.find(c => c.key === metadata[0].candidateKey).model.id, 'claude-sonnet-5');
    if (strength === 'preferred') assert.equal(metadata[1].preferenceGroup, 1);
  }
});

test('native control order and input/output separation are preserved', () => {
  const cap = capability();
  cap.supportedBindings.push({ ...cap.supportedBindings[0], nativeReasoning: { kind: 'enum', value: 'medium' } });
  const env = freeze(environment({ capabilities: [seal(cap, 'snapshotDigest')] }));
  const req = freeze(request());
  const candidates = freeze(collectEligibleCandidatesV2(req, env).candidates);
  const before = canonical({ req, env, candidates });
  const metadata = getBaselineCandidateMetadataV2(candidates, req, env);
  const ranked = rankBaselineCandidatesV2(candidates, req, env);
  assert.deepEqual(metadata.map(item => item.candidateKey), ranked.map(item => item.key));
  assert.equal(ranked[0].binding.nativeReasoning.value, 'high');
  assert.deepEqual(metadata.map(item => item.baselineRank), [0, 1]);
  assert.deepEqual(metadata.map(item => item.preferenceGroup), [1, 1]);
  metadata[0].candidateKey = 'changed';
  metadata[0].baselineRank = 100;
  ranked[0].binding.nativeReasoning.value = 'changed';
  assert.equal(canonical({ req, env, candidates }), before);
  assert.deepEqual(getBaselineCandidateMetadataV2(candidates, req, env), [
    { candidateKey: candidates.find(c => c.binding.nativeReasoning.value === 'high').key, preferenceGroup: 1, baselineRank: 0 },
    { candidateKey: candidates.find(c => c.binding.nativeReasoning.value === 'medium').key, preferenceGroup: 1, baselineRank: 1 },
  ]);
});
