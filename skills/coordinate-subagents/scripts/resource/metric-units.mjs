/** Tagged arithmetic only. No price lookup, unit conversion, or billing authority. */
import { assert, keys, text } from '../model-routing-core.mjs';

const COUNTS = ['token', 'request', 'concurrency'];
const BASES = ['actualBilling', 'apiPriceEstimate', 'subscriptionUsage', 'unknown'];

export function validateMetricValueV1(value) {
  if (value?.kind === 'cost') {
    keys(value, ['kind', 'basis', 'amount', 'currency', 'unit']);
    assert(BASES.includes(value.basis), 'INVALID_INPUT', 'Invalid accounting basis');
    if (value.basis === 'unknown') {
      assert(value.amount === null && value.currency === null && value.unit === null,
        'INVALID_INPUT', 'Unknown cost cannot contain a quantity or conversion unit');
    } else {
      assert(typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0,
        'INVALID_INPUT', 'Invalid cost amount');
      if (value.basis === 'subscriptionUsage') {
        assert(value.currency === null, 'INVALID_INPUT', 'Subscription usage is not currency');
        text(value.unit, 'subscription usage unit');
      } else {
        assert(typeof value.currency === 'string' && /^[A-Z]{3}$/u.test(value.currency) && value.unit === null,
          'INVALID_INPUT', 'Billing and API estimates require a currency and no usage unit');
      }
    }
  } else {
    keys(value, ['kind', 'amount']);
    assert(COUNTS.includes(value.kind) || value.kind === 'native-percent', 'INVALID_INPUT', 'Invalid metric kind');
    if (value.amount !== null) {
      assert(typeof value.amount === 'number' && Number.isFinite(value.amount) && value.amount >= 0,
        'INVALID_INPUT', 'Invalid metric amount');
      if (COUNTS.includes(value.kind)) {
        assert(Number.isSafeInteger(value.amount), 'INVALID_INPUT', 'Count must be a safe integer');
      } else {
        assert(value.amount <= 100, 'INVALID_INPUT', 'Native percent exceeds 100');
      }
    }
  }
  return value;
}

/** Preserve the existing ModelEvaluationRecord.v1 cost distinctions without claiming a new observation. */
export function tagEvaluationCostV1(cost) {
  keys(cost, ['basis', 'amount', 'currency', 'unit', 'sourceReference']);
  if (cost.basis !== 'unknown') text(cost.sourceReference, 'cost source');
  else if (cost.sourceReference !== null) text(cost.sourceReference, 'cost source');
  const tagged = {
    kind: 'cost', basis: cost.basis, amount: cost.amount, currency: cost.currency, unit: cost.unit,
  };
  validateMetricValueV1(tagged);
  return tagged;
}

// Treat each finite input's shortest decimal spelling as its value. Never silently round a result.
function decimalParts(amount) {
  const [mantissa, exponent = '0'] = String(amount).split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const power = Number(exponent) - fraction.length;
  const coefficient = BigInt(whole + fraction);
  return power >= 0
    ? { coefficient: coefficient * 10n ** BigInt(power), scale: 0 }
    : { coefficient, scale: -power };
}

function exactDecimalArithmetic(left, right, sign) {
  const a = decimalParts(left), b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const coefficient = a.coefficient * 10n ** BigInt(scale - a.scale)
    + BigInt(sign) * b.coefficient * 10n ** BigInt(scale - b.scale);
  assert(coefficient >= 0n, 'INVALID_INPUT', 'Result cannot be negative');
  const digits = coefficient.toString().padStart(scale + 1, '0');
  const decimal = scale === 0 ? digits : `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
  const result = Number(decimal);
  assert(Number.isFinite(result), 'INVALID_INPUT', 'Result is not finite');
  const roundTrip = decimalParts(result);
  const aligned = Math.max(scale, roundTrip.scale);
  assert(coefficient * 10n ** BigInt(aligned - scale)
    === roundTrip.coefficient * 10n ** BigInt(aligned - roundTrip.scale),
  'PRECISION_LOSS', 'Result cannot be represented without decimal rounding');
  return result;
}

function combine(left, right, sign) {
  validateMetricValueV1(left); validateMetricValueV1(right);
  assert(left.kind === right.kind && (left.kind !== 'cost'
    || left.basis === right.basis && left.currency === right.currency && left.unit === right.unit),
  'UNIT_MISMATCH', 'Metric unit or accounting basis differs');
  assert(left.amount !== null && right.amount !== null, 'UNKNOWN_AMOUNT', 'Unknown amount cannot be calculated');
  const result = { ...left, amount: exactDecimalArithmetic(left.amount, right.amount, sign) };
  validateMetricValueV1(result);
  return result;
}

export function addMetricValuesV1(left, right) { return combine(left, right, 1); }
export function subtractMetricValuesV1(left, right) { return combine(left, right, -1); }
