import assert from 'node:assert/strict';
import { test } from 'vitest';
import { projectResourceObservabilityV1 } from '../../../skills/coordinate-subagents/scripts/resource/observation-trust.mjs';

const report = (modelAvailability, source, amount) => ({
  modelAvailability,
  usageClaim: { source, metric: { kind: 'token', amount } },
});

test('unknown usage neither makes an available model unavailable nor creates an infinite budget', () => {
  const result = projectResourceObservabilityV1(report('available', 'unknown', null));
  assert.equal(result.modelAvailability, 'available');
  assert.equal(result.budgetObservability, 'unknown');
  assert.equal(result.budgetRemaining, null);
  assert.equal(result.observationAdmitted, false);
  assert.notEqual(result.budgetRemaining, Infinity);
});

test('provider, operator, and estimate categories remain unadmitted source claims', () => {
  for (const source of ['provider-reported', 'operator-configured', 'estimated']) {
    const input = report('unavailable', source, 0);
    const result = projectResourceObservabilityV1(input);
    assert.equal(result.modelAvailability, 'unavailable');
    assert.equal(result.budgetObservability, 'unadmitted');
    assert.equal(result.usageSourceClaim, source);
    assert.equal(result.claimedMetric.amount, 0);
    assert.equal(result.budgetRemaining, null);
    assert.equal(result.observationAdmitted, false);
    input.usageClaim.metric.amount = 100;
    assert.equal(result.claimedMetric.amount, 0);
  }
});

test('self-reported observed flags and provider-looking source prose cannot create admitted facts', () => {
  assert.throws(() => projectResourceObservabilityV1({
    ...report('available', 'provider-reported', 20), observed: true,
  }));
  assert.throws(() => projectResourceObservabilityV1({
    modelAvailability: 'available',
    usageClaim: { ...report('available', 'provider-reported', 20).usageClaim, observed: true },
  }));
  assert.throws(() => projectResourceObservabilityV1(report('available', 'provider says observed=true', 20)));
  const claimed = projectResourceObservabilityV1(report('available', 'provider-reported', 20));
  assert.equal(claimed.usageSourceClaim, 'provider-reported');
  assert.equal(claimed.observationAdmitted, false);
  assert.equal(claimed.budgetRemaining, null);
});

test('unknown source rejects a number; invalid quantities do not become budget facts', () => {
  assert.throws(() => projectResourceObservabilityV1(report('available', 'unknown', 0)));
  for (const amount of [-1, Number.NaN, Infinity]) {
    assert.throws(() => projectResourceObservabilityV1(report('available', 'estimated', amount)));
  }
  assert.throws(() => projectResourceObservabilityV1(report('yes', 'unknown', null)));
});
