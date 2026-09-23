import assert from 'node:assert/strict';
import { test } from 'vitest';
import ratecard from '../../../skills/coordinate-subagents/references/model-catalog/pricing/anthropic-2026-09-23.json' with { type: 'json' };
import { estimateWorkConsumptionV1, recordWorkConsumptionV1 } from '../../../skills/coordinate-subagents/scripts/resource/work-estimate.mjs';

const phases = (unit, amounts) => Object.fromEntries(['work', 'judgment', 'review', 'handoff']
  .map((phase, index) => [phase, { unit, amount: amounts[index] }]));
const local = (amounts = [2, 1, 1, 1], overrides = {}) => estimateWorkConsumptionV1({
  accessPath: 'subscription', unit: 'request', phaseEstimates: phases('request', amounts),
  authorizedMaximum: 6, runtimeCap: { supported: true, amount: 6, mechanism: 'runtime-cap' }, ...overrides,
});
const zeroUsage = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
const apiPhases = () => Object.fromEntries(['work', 'judgment', 'review', 'handoff']
  .map(phase => [phase, { unit: 'api-usd', usage: zeroUsage() }]));
const api = (overrides = {}) => estimateWorkConsumptionV1({
  accessPath: 'api', unit: 'api-usd', phaseEstimates: apiPhases(), authorizedMaximum: 100,
  runtimeCap: { supported: false, amount: null, mechanism: 'none' },
  apiPricing: { modelId: 'claude-opus-5-5', pricingDate: '2026-09-23', scope: ratecard.scope }, ...overrides,
});

test('estimate 5 and actual 8 remain distinct; an overrun is recorded, not clamped', () => {
  const plan = local();
  assert.equal(plan.estimate, 5);
  assert.equal(plan.authorizedMaximum, 6);
  assert.equal(plan.proposedRuntimeCap, 6);
  assert.equal(plan.runtimeEnforceableCap, null);
  assert.equal(plan.runtimeCapSupportClaim, true);
  assert.equal(plan.runtimeCapSupported, false);
  assert.equal(plan.hardEnforced, false);
  assert.equal(plan.quantitativeReservation, null);
  const observed = recordWorkConsumptionV1(plan, [
    { id: 'a', mode: 'delta', granularity: 'detail', phase: 'work', unit: 'request', amount: 5 },
    { id: 'b', mode: 'delta', granularity: 'detail', phase: 'judgment', unit: 'request', amount: 3 },
  ]);
  assert.equal(observed.actual, 8);
  assert.equal(observed.exceededEstimate, true);
  assert.equal(observed.exceededAuthorizedMaximum, true);
  assert.equal(observed.exceededProposedRuntimeCap, true);
});

test('unsupported cap or missing authorization never claims hard enforcement or quantitative reservation', () => {
  const unsupported = local(undefined, { runtimeCap: { supported: false, amount: null, mechanism: 'none' } });
  assert.equal(unsupported.estimate, 5);
  assert.equal(unsupported.hardEnforced, false);
  assert.equal(unsupported.quantitativeReservation, null);
  const unbounded = local(undefined, { authorizedMaximum: null });
  assert.equal(unbounded.quantitativeReservation, null);
  assert.equal(unbounded.hardEnforced, false);
  assert.throws(() => local([7, 1, 1, 1]), { code: 'ESTIMATE_EXCEEDS_AUTHORIZATION' });
  assert.throws(() => api({ runtimeCap: { supported: true, amount: 6, mechanism: 'runtime-cap' } }),
    { code: 'INVALID_INPUT' });
});

test('unknown subscription depletion is not priced or quantitatively reserved', () => {
  const unknown = estimateWorkConsumptionV1({ accessPath: 'subscription', unit: 'subscription-percent',
    phaseEstimates: phases('subscription-percent', [null, null, null, null]), authorizedMaximum: null,
    runtimeCap: { supported: false, amount: null, mechanism: 'none' } });
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.estimate, null);
  assert.equal(unknown.quantitativeReservation, null);
  assert.equal(unknown.unknownReason, 'SUBSCRIPTION_DEPLETION_UNKNOWN');
  assert.throws(() => api({ accessPath: 'subscription' }), { code: 'UNIT_MISMATCH' });
});

test('a real slot cap uses peak concurrency rather than adding sequential phases', () => {
  const plan = estimateWorkConsumptionV1({ accessPath: 'subscription', unit: 'slot',
    phaseEstimates: phases('slot', [2, 1, 1, 1]), authorizedMaximum: 2,
    runtimeCap: { supported: true, amount: 2, mechanism: 'slot' } });
  assert.equal(plan.estimate, 2);
  assert.equal(plan.proposedRuntimeCap, 2);
  assert.equal(plan.runtimeEnforceableCap, null);
  assert.equal(plan.quantitativeReservation, null);
  const actual = recordWorkConsumptionV1(plan, [
    { id: 'w', mode: 'delta', granularity: 'detail', phase: 'work', unit: 'slot', amount: 2 },
    { id: 'r', mode: 'delta', granularity: 'detail', phase: 'review', unit: 'slot', amount: 1 },
  ]);
  assert.equal(actual.actual, 2);
});

test('missing judgment/handoff, mixed units, negative counts and duplicate accounting fail', () => {
  const missing = phases('request', [2, 1, 1, 1]); delete missing.judgment;
  assert.throws(() => local(undefined, { phaseEstimates: missing }), { code: 'INVALID_INPUT' });
  const mixed = phases('request', [2, 1, 1, 1]); mixed.handoff.unit = 'token';
  assert.throws(() => local(undefined, { phaseEstimates: mixed }), { code: 'UNIT_MISMATCH' });
  assert.throws(() => local([2, -1, 1, 1]), { code: 'INVALID_QUANTITY' });
  const doubled = phases('request', [2, 1, 1, 1]); doubled.work.usage = zeroUsage();
  assert.throws(() => local(undefined, { phaseEstimates: doubled }), { code: 'INVALID_INPUT' });
  const plan = local();
  assert.throws(() => recordWorkConsumptionV1(plan, [
    { id: 'a', mode: 'delta', granularity: 'detail', phase: 'work', unit: 'request', amount: 2 },
    { id: 'b', mode: 'cumulative', granularity: 'aggregate', unit: 'request', amount: 3 },
  ]), { code: 'DOUBLE_COUNT' });
  assert.throws(() => recordWorkConsumptionV1(plan, [
    { id: 'a', mode: 'delta', granularity: 'detail', phase: 'work', unit: 'request', amount: 2 },
    { id: 'a', mode: 'delta', granularity: 'detail', phase: 'review', unit: 'request', amount: 1 },
  ]), { code: 'DUPLICATE_OBSERVATION' });
});

test('API cost uses all five M07 buckets and pins the historical ratecard revision', () => {
  const entries = apiPhases();
  entries.work.usage = { input_tokens: 1000000, output_tokens: 1000000,
    cache_read_input_tokens: 1000000, cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 } };
  const plan = api({ phaseEstimates: entries });
  assert.equal(plan.status, 'estimated');
  assert.equal(plan.estimate, 37.2);
  assert.equal(plan.priceRevision, 'ratecard:anthropic-2026-09-23');
  assert.equal(plan.hardEnforced, false);
  assert.equal(plan.quantitativeReservation, null);
  assert.throws(() => { plan.priceRevision = 'ratecard:anthropic-2026-09-24'; }, TypeError);
  assert.equal(plan.priceRevision, 'ratecard:anthropic-2026-09-23');
});

test('missing TTL, quantity or rate makes API estimate unknown', () => {
  const ttl = apiPhases(); ttl.work.usage.cache_creation_input_tokens = 1;
  delete ttl.work.usage.cache_creation;
  assert.equal(api({ phaseEstimates: ttl }).status, 'unknown');
  const quantity = apiPhases(); delete quantity.judgment.usage.input_tokens;
  assert.equal(api({ phaseEstimates: quantity }).unknownReason, 'USAGE_MISSING');
  assert.equal(api({ apiPricing: { modelId: 'unknown', pricingDate: '2026-09-23', scope: ratecard.scope } }).unknownReason,
    'UNKNOWN_MODEL_RATE');
  assert.equal(api({ apiPricing: { modelId: 'claude-opus-5-5', pricingDate: '2026-09-24', scope: ratecard.scope } }).status,
    'unknown');
});
