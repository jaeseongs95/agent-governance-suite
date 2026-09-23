import assert from 'node:assert/strict';
import { test } from 'vitest';
import { digest, resolveV2, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { reduceSemanticDecisionOutcomeV1, reduceSemanticDecisionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/reducer.mjs';
import { environment, request } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const policy = mode => ({ ...contracts().policy, mode });
const input = (mode = 'assist', overrides = {}) => {
  const routingRequest = request(overrides), baselineDecision = resolveV2(routingRequest, environment());
  return { policy: policy(mode), routingRequest, baselineDecision };
};

test('off and shadow preserve the exact v2 decision and digest', () => {
  for (const mode of ['off', 'shadow']) {
    const value = input(mode);
    const result = reduceSemanticDecisionOutcomeV1(value);
    assert.strictEqual(result, value.baselineDecision);
    assert.equal(result.schemaVersion, '2.0.0');
    assert.equal(result.decisionDigest, resolveV2(value.routingRequest, environment()).decisionDigest);
  }
});

test('required unavailable stays blocked; preferred unavailable retains v2 fallbackReason', () => {
  const required = input('assist', { user: { strength: 'required', model: 'gpt-6-astra' } });
  assert.equal(required.baselineDecision.status, 'blocked');
  assert.equal(required.baselineDecision.selectionReasonCodes[0], 'REQUIRED_CHOICE_UNAVAILABLE');
  assert.strictEqual(reduceSemanticDecisionOutcomeV1(required), required.baselineDecision);

  const preferred = input('assist', { user: { strength: 'preferred', model: 'gpt-6-astra' } });
  assert.equal(preferred.baselineDecision.fallbackReason, 'PREFERRED_CHOICE_UNAVAILABLE');
  assert.strictEqual(reduceSemanticDecisionOutcomeV1(preferred), preferred.baselineDecision);
  assert.throws(() => reduceSemanticDecisionV1({
    prepared: { mode: 'assist' }, adoption: { status: 'eligible' },
    advice: {}, baselineDecision: preferred.baselineDecision, candidates: [],
  }), { code: 'INVALID_INPUT' });
});

test('abstention and allowed provider failure are typed non-adoption with the original v2 decision', () => {
  const value = input();
  for (const reasonCode of ['ABSTAINED', 'PROVIDER_TIMEOUT', 'PROVIDER_UNAVAILABLE']) {
    assert.deepEqual(reduceSemanticDecisionOutcomeV1({ ...value, nonAdoption: reasonCode }),
      { status: 'non-adoption', reasonCode, baselineDecision: value.baselineDecision });
  }
  assert.deepEqual(reduceSemanticDecisionOutcomeV1({
    ...value, adoption: { status: 'baseline', reasonCode: 'CONFIDENCE_BELOW_MINIMUM' },
  }), { status: 'non-adoption', reasonCode: 'CONFIDENCE_BELOW_MINIMUM', baselineDecision: value.baselineDecision });
});

test('integrity, authority and stale failures cannot masquerade as provider fallback', () => {
  const value = input();
  for (const reasonCode of ['REQUEST_BINDING_MISMATCH', 'EVIDENCE_NOT_ADMITTED', 'STALE_ADVICE', 'POLICY_OFF']) {
    assert.throws(() => reduceSemanticDecisionOutcomeV1({
      ...value, adoption: { status: 'baseline', reasonCode },
    }), { code: 'NON_ADOPTION_NOT_FALLBACK' });
    assert.throws(() => reduceSemanticDecisionOutcomeV1({ ...value, nonAdoption: reasonCode }),
      { code: 'NON_ADOPTION_NOT_FALLBACK' });
  }
  const forged = { ...value, baselineDecision: seal({
    ...value.baselineDecision, binding: { ...value.baselineDecision.binding, taskId: 'other-task' },
  }, 'decisionDigest') };
  assert.throws(() => reduceSemanticDecisionOutcomeV1({ ...forged, nonAdoption: 'PROVIDER_TIMEOUT' }),
    { code: 'BASELINE_MISMATCH' });
  const prepared = { ...contracts().request, binding: { ...value.routingRequest.binding, taskId: 'other-task' } };
  assert.throws(() => reduceSemanticDecisionOutcomeV1({
    ...value, prepared: seal(prepared, 'requestDigest'), nonAdoption: 'PROVIDER_TIMEOUT',
  }), { code: 'REQUEST_BINDING_MISMATCH' });
  assert.throws(() => reduceSemanticDecisionOutcomeV1({
    ...value, advice: contracts().advice, nonAdoption: 'PROVIDER_TIMEOUT',
  }), { code: 'ADVICE_BINDING_MISMATCH' });
  assert.throws(() => reduceSemanticDecisionOutcomeV1({
    ...value, baselineDecision: seal({ ...value.baselineDecision,
      requested: { strength: 'required', model: 'gpt-6-astra' } }, 'decisionDigest'),
    nonAdoption: 'PROVIDER_TIMEOUT',
  }), { code: 'BASELINE_MISMATCH' });
  assert.throws(() => reduceSemanticDecisionOutcomeV1({
    ...value, baselineDecision: { ...value.baselineDecision, decisionDigest: digest('forged') },
    nonAdoption: 'PROVIDER_TIMEOUT',
  }), { code: 'DIGEST_MISMATCH' });
});
