import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { estimateClaudeApiTokenCost } from '../../../skills/coordinate-subagents/scripts/resource/model-cost-estimate.mjs';
import sharedRatecard from '../../../skills/coordinate-subagents/references/model-catalog/pricing/anthropic-2026-09-23.json' with { type: 'json' };

const card = JSON.parse(readFileSync(new URL('../../../skills/coordinate-subagents/references/model-catalog/pricing/anthropic-2026-09-23.json', import.meta.url)));
const scope = card.scope;
const zero = () => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
const estimate = (modelId, usage = zero(), overrides = {}) =>
  estimateClaudeApiTokenCost({ modelId, pricingDate: '2026-09-23', scope, usage, ...overrides });

test('M07 applies each of five official per-million rates for each exact model ID', () => {
  const prices = {
    'claude-opus-5-5': [4, 20, 0.20, 5, 8],
    'claude-opus-5': [5, 25, 0.50, 6.25, 10],
    'claude-fable-5-1': [10, 50, 0.25, 12.50, 20],
  };
  const categories = [
    usage => { usage.input_tokens = 1000000; },
    usage => { usage.output_tokens = 1000000; },
    usage => { usage.cache_read_input_tokens = 1000000; },
    usage => { usage.cache_creation_input_tokens = 1000000; usage.cache_creation.ephemeral_5m_input_tokens = 1000000; },
    usage => { usage.cache_creation_input_tokens = 1000000; usage.cache_creation.ephemeral_1h_input_tokens = 1000000; },
  ];
  for (const [model, expected] of Object.entries(prices)) {
    categories.forEach((set, index) => {
      const usage = zero(); set(usage);
      const result = estimate(model, usage);
      assert.equal(result.status, 'estimated');
      assert.equal(result.cost.amount, expected[index], `${model} category ${index}`);
      assert.deepEqual([result.cost.basis, result.cost.currency, result.cost.unit], ['apiPriceEstimate', 'USD', null]);
      assert.equal(result.toolFeesIncluded, false);
    });
  }
  assert.equal(estimate('claude-opus-5-5', { ...zero(), cache_read_input_tokens: 1000000 }).cost.amount, 0.20);
});

test('M07 uses TTL detail once and treats thinking as an output breakdown', () => {
  const usage = { input_tokens: 1000000, output_tokens: 1000000, cache_read_input_tokens: 1000000,
    cache_creation_input_tokens: 2000000,
    cache_creation: { ephemeral_5m_input_tokens: 1000000, ephemeral_1h_input_tokens: 1000000 },
    output_tokens_details: { thinking_tokens: 500000 } };
  assert.equal(estimate('claude-opus-5-5', usage).cost.amount, 37.2);
  assert.equal(estimate('claude-opus-5-5', { ...usage, cache_creation_input_tokens: 1000000 }).reason,
    'CACHE_TOTAL_MISMATCH');
  assert.equal(estimate('claude-opus-5-5', { ...usage, cache_creation: undefined }).reason,
    'CACHE_TTL_UNKNOWN');
  const unknownTtl = { ...zero(), cache_creation_input_tokens: undefined,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0,
      ephemeral_2h_input_tokens: 1000000 } };
  assert.equal(estimate('claude-opus-5-5', unknownTtl).reason, 'CACHE_TTL_UNKNOWN');
  assert.equal(estimate('claude-opus-5-5', { ...unknownTtl, cache_creation_input_tokens: 1000000 }).reason,
    'CACHE_TTL_UNKNOWN');
  assert.equal(estimate('claude-opus-5-5', { ...usage, output_tokens_details: { thinking_tokens: 1000001 } }).reason,
    'THINKING_EXCEEDS_OUTPUT');
});

test('M07 cannot invent a standard API price for another scope, date, or model', () => {
  assert.throws(() => { sharedRatecard.asOfDate = '2026-09-24'; }, TypeError);
  assert.throws(() => { sharedRatecard.rates['claude-opus-5-5'].cacheRead = '0.40'; }, TypeError);
  assert.equal(estimate('claude-opus-5-5').cost.sourceReference, 'ratecard:anthropic-2026-09-23');
  for (const changed of [
    { scope: { ...scope, servingProvider: 'bedrock' } },
    { scope: { ...scope, accessPath: 'subscription' } },
    { scope: { ...scope, speed: 'fast' } },
    { scope: { ...scope, geography: 'us' } },
    { scope: { ...scope, batch: true } },
    { pricingDate: '2026-09-24' },
  ]) assert.deepEqual(estimate('claude-opus-5-5', zero(), changed), {
    status: 'unknown', reason: 'UNSUPPORTED_PRICE_SCOPE',
    cost: { basis: 'unknown', amount: null, currency: null, unit: null, sourceReference: null },
  });
  assert.equal(estimate('claude-sonnet-5').reason, 'UNKNOWN_MODEL_RATE');
  for (const modelId of ['constructor', '__proto__']) {
    assert.deepEqual(estimate(modelId), {
      status: 'unknown', reason: 'UNKNOWN_MODEL_RATE',
      cost: { basis: 'unknown', amount: null, currency: null, unit: null, sourceReference: null },
    });
  }
});

test('M07 rejects bad quantities and preserves actual billing or subscription observations', () => {
  for (const value of [-1, 0.5, NaN, Infinity]) {
    assert.throws(() => estimate('claude-opus-5-5', { ...zero(), input_tokens: value }), { code: 'INVALID_USAGE' });
  }
  assert.equal(estimate('claude-opus-5-5', { ...zero(), input_tokens: null }).reason, 'USAGE_MISSING');
  const actual = { basis: 'actualBilling', amount: 42, currency: 'USD', unit: null, sourceReference: 'invoice:fixture' };
  const subscription = { basis: 'subscriptionUsage', amount: 12, currency: null, unit: 'percent', sourceReference: 'host:fixture' };
  assert.strictEqual(estimate('claude-opus-5-5', zero(), { existingCost: actual }).cost, actual);
  assert.strictEqual(estimate('claude-opus-5-5', zero(), { existingCost: subscription }).cost, subscription);
  assert.equal(estimate('claude-opus-5-5', { ...zero(), input_tokens: Number.MAX_SAFE_INTEGER }).reason,
    'PRECISION_LOSS');
});
