import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  addMetricValuesV1, subtractMetricValuesV1, tagEvaluationCostV1, validateMetricValueV1,
} from '../../../skills/coordinate-subagents/scripts/resource/metric-units.mjs';

const count = (kind, amount) => ({ kind, amount });
const cost = (basis, amount, currency, unit) => ({
  basis, amount, currency, unit, sourceReference: basis === 'unknown' ? null : 'fixture:cost',
});

test('same tagged units add and subtract while zero stays distinct from unknown', () => {
  assert.deepEqual(addMetricValuesV1(count('token', 0), count('token', 2)), count('token', 2));
  assert.deepEqual(subtractMetricValuesV1(count('request', 3), count('request', 3)), count('request', 0));
  assert.deepEqual(validateMetricValueV1(count('concurrency', null)), count('concurrency', null));
  assert.throws(() => addMetricValuesV1(count('token', null), count('token', 0)), { code: 'UNKNOWN_AMOUNT' });
  assert.throws(() => subtractMetricValuesV1(count('token', 0), count('token', 1)));
});

test('USD, token, and native subscription percent never mix in arithmetic', () => {
  const billed = tagEvaluationCostV1(cost('actualBilling', 3, 'USD', null));
  const estimate = tagEvaluationCostV1(cost('apiPriceEstimate', 2, 'USD', null));
  const usage = tagEvaluationCostV1(cost('subscriptionUsage', 20, null, 'percent'));
  for (const [left, right] of [
    [billed, count('token', 3)], [billed, count('native-percent', 3)],
    [count('token', 3), count('native-percent', 3)], [billed, estimate],
    [usage, count('native-percent', 20)],
    [billed, tagEvaluationCostV1(cost('actualBilling', 3, 'EUR', null))],
    [usage, tagEvaluationCostV1(cost('subscriptionUsage', 20, null, 'token'))],
  ]) {
    assert.throws(() => addMetricValuesV1(left, right), { code: 'UNIT_MISMATCH' });
    assert.throws(() => subtractMetricValuesV1(left, right), { code: 'UNIT_MISMATCH' });
  }
  assert.equal(addMetricValuesV1(billed, billed).amount, 6);
  const dime = tagEvaluationCostV1(cost('actualBilling', 0.1, 'USD', null));
  const twoDimes = tagEvaluationCostV1(cost('actualBilling', 0.2, 'USD', null));
  const threeDimes = tagEvaluationCostV1(cost('actualBilling', 0.3, 'USD', null));
  assert.equal(addMetricValuesV1(dime, twoDimes).amount, 0.3);
  assert.equal(subtractMetricValuesV1(threeDimes, twoDimes).amount, 0.1);
  assert.equal(addMetricValuesV1(count('native-percent', 0.1), count('native-percent', 0.2)).amount, 0.3);
  assert.throws(() => addMetricValuesV1(dime,
    tagEvaluationCostV1(cost('actualBilling', 0.00000000000000001, 'USD', null))),
  { code: 'PRECISION_LOSS' });
});

test('evaluation cost bases remain separate and unknown never acquires a number', () => {
  assert.deepEqual(tagEvaluationCostV1(cost('unknown', null, null, null)), {
    kind: 'cost', basis: 'unknown', amount: null, currency: null, unit: null,
  });
  assert.equal(tagEvaluationCostV1(cost('actualBilling', 0, 'USD', null)).amount, 0);
  assert.throws(() => tagEvaluationCostV1(cost('unknown', 0, null, null)));
  assert.throws(() => tagEvaluationCostV1(cost('subscriptionUsage', 2, 'USD', 'percent')));
  assert.throws(() => tagEvaluationCostV1(cost('apiPriceEstimate', 2, null, null)));
  assert.throws(() => addMetricValuesV1(tagEvaluationCostV1(cost('unknown', null, null, null)),
    tagEvaluationCostV1(cost('unknown', null, null, null))), { code: 'UNKNOWN_AMOUNT' });
});

test('negative, non-finite, fractional counts, and hidden conversion fields are rejected', () => {
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.throws(() => validateMetricValueV1(count('token', amount)));
    assert.throws(() => tagEvaluationCostV1(cost('actualBilling', amount, 'USD', null)));
  }
  assert.throws(() => validateMetricValueV1(count('request', 1.5)));
  assert.throws(() => addMetricValuesV1(count('token', Number.MAX_SAFE_INTEGER), count('token', 1)));
  assert.throws(() => addMetricValuesV1(
    tagEvaluationCostV1(cost('actualBilling', Number.MAX_VALUE, 'USD', null)),
    tagEvaluationCostV1(cost('actualBilling', Number.MAX_VALUE, 'USD', null))));
  assert.throws(() => validateMetricValueV1(count('native-percent', 101)));
  assert.throws(() => validateMetricValueV1({ ...count('token', 1), conversionFactor: 1 }));
  assert.throws(() => tagEvaluationCostV1({ ...cost('actualBilling', 1, 'USD', null), pricePerToken: 0.01 }));
});
