import ratecard from '../../references/model-catalog/pricing/anthropic-2026-09-23.json' with { type: 'json' };
import { assert } from '../model-routing-core.mjs';
import { tagEvaluationCostV1 } from './metric-units.mjs';

const SCOPE = Object.freeze(ratecard.scope);
const RATES = Object.freeze(Object.fromEntries(Object.entries(ratecard.rates)
  .map(([model, rates]) => [model, Object.freeze(rates)])));
const AS_OF_DATE = ratecard.asOfDate;
Object.freeze(ratecard.source);
Object.freeze(ratecard.rates);
Object.freeze(ratecard);
const UNKNOWN = Object.freeze({ basis: 'unknown', amount: null, currency: null, unit: null, sourceReference: null });
const unknown = reason => ({ status: 'unknown', reason, cost: UNKNOWN });

function count(value) {
  assert(Number.isSafeInteger(value) && value >= 0, 'INVALID_USAGE', 'Token count must be a nonnegative safe integer');
  return BigInt(value);
}

function cents(rate) {
  const [whole, fraction = ''] = rate.split('.');
  assert(/^\d+$/u.test(whole) && /^\d{0,2}$/u.test(fraction), 'INVALID_RATECARD');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

function decimalParts(value) {
  const [mantissa, exponent = '0'] = value.split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const power = Number(exponent) - fraction.length;
  const coefficient = BigInt(whole + fraction);
  return power >= 0 ? { coefficient: coefficient * 10n ** BigInt(power), scale: 0 }
    : { coefficient, scale: -power };
}

function exactAmount(units) {
  const fraction = (units % 100000000n).toString().padStart(8, '0').replace(/0+$/u, '');
  const decimal = `${units / 100000000n}${fraction ? `.${fraction}` : ''}`;
  const amount = Number(decimal);
  if (!Number.isFinite(amount)) return null;
  const roundTrip = decimalParts(String(amount));
  const scale = Math.max(8, roundTrip.scale);
  return units * 10n ** BigInt(scale - 8) === roundTrip.coefficient * 10n ** BigInt(scale - roundTrip.scale)
    ? amount : null;
}

/** Token-only estimate for the exact first-party standard/global API scope and ratecard date. */
export function estimateClaudeApiTokenCost({ modelId, pricingDate, scope, usage, existingCost = null }) {
  if (existingCost?.basis === 'actualBilling' || existingCost?.basis === 'subscriptionUsage') {
    tagEvaluationCostV1(existingCost);
    return { status: 'preserved', cost: existingCost };
  }
  if (pricingDate !== AS_OF_DATE || !scope || Object.keys(scope).length !== Object.keys(SCOPE).length
    || Object.entries(SCOPE).some(([key, value]) => scope[key] !== value)) return unknown('UNSUPPORTED_PRICE_SCOPE');
  if (typeof modelId !== 'string' || !Object.hasOwn(RATES, modelId)) return unknown('UNKNOWN_MODEL_RATE');
  const rates = RATES[modelId];
  if (!usage || typeof usage !== 'object') return unknown('USAGE_MISSING');
  if (usage.input_tokens == null || usage.output_tokens == null || usage.cache_read_input_tokens == null)
    return unknown('USAGE_MISSING');
  const input = count(usage.input_tokens), output = count(usage.output_tokens);
  const cacheRead = count(usage.cache_read_input_tokens);
  if (usage.output_tokens_details?.thinking_tokens != null
    && count(usage.output_tokens_details.thinking_tokens) > output) return unknown('THINKING_EXCEEDS_OUTPUT');

  const creation = usage.cache_creation;
  const total = usage.cache_creation_input_tokens;
  if (creation == null && total == null) return unknown('CACHE_TTL_UNKNOWN');
  if (total != null) count(total);
  if (creation == null && total !== 0) return unknown('CACHE_TTL_UNKNOWN');
  if (creation != null && Object.keys(creation).some(key =>
    key !== 'ephemeral_5m_input_tokens' && key !== 'ephemeral_1h_input_tokens'))
    return unknown('CACHE_TTL_UNKNOWN');
  const write5m = creation == null ? 0n : count(creation.ephemeral_5m_input_tokens);
  const write1h = creation == null ? 0n : count(creation.ephemeral_1h_input_tokens);
  if (total != null && BigInt(total) !== write5m + write1h) return unknown('CACHE_TOTAL_MISMATCH');

  // 1 unit = USD 0.00000001; a rate in cents/MTok is exactly units/token.
  const units = input * cents(rates.input) + output * cents(rates.output)
    + cacheRead * cents(rates.cacheRead) + write5m * cents(rates.cacheWrite5m)
    + write1h * cents(rates.cacheWrite1h);
  const amount = exactAmount(units);
  if (amount === null) return unknown('PRECISION_LOSS');
  const cost = { basis: 'apiPriceEstimate', amount, currency: 'USD', unit: null,
    sourceReference: `ratecard:anthropic-${AS_OF_DATE}` };
  tagEvaluationCostV1(cost);
  return { status: 'estimated', cost, toolFeesIncluded: false };
}
