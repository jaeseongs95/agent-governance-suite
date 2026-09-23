/** Pure work accounting. Estimates and approval ceilings are never observations or runtime controls. */
import { assert } from '../model-routing-core.mjs';
import { addMetricValuesV1 } from './metric-units.mjs';
import { estimateClaudeApiTokenCost } from './model-cost-estimate.mjs';

const PHASES = ['work', 'judgment', 'review', 'handoff'];
const LOCAL = ['token', 'request', 'slot'];
const hasPhases = value => value && typeof value === 'object'
  && Object.keys(value).length === PHASES.length && PHASES.every(phase => Object.hasOwn(value, phase));
const quantity = (value, unit) => {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= 0
    && (!LOCAL.includes(unit) || Number.isSafeInteger(value)), 'INVALID_QUANTITY', 'Invalid work quantity');
  return value;
};

/** Plan all four call classes explicitly; null usage or unsupported prices stay unknown. */
export function estimateWorkConsumptionV1({ accessPath, unit, phaseEstimates, authorizedMaximum,
  runtimeCap, apiPricing = null }) {
  assert(['subscription', 'api', 'enterprise'].includes(accessPath)
    && [...LOCAL, 'subscription-percent', 'api-usd'].includes(unit)
    && hasPhases(phaseEstimates), 'INVALID_INPUT', 'Access path, unit, and four call classes are required');
  assert(runtimeCap && typeof runtimeCap.supported === 'boolean'
    && ['runtime-cap', 'slot', 'none'].includes(runtimeCap.mechanism), 'INVALID_INPUT', 'Runtime cap support is required');
  assert(unit !== 'subscription-percent' || accessPath === 'subscription',
    'UNIT_MISMATCH', 'Subscription percentage requires subscription access');
  assert(!runtimeCap.supported || LOCAL.includes(unit)
    && runtimeCap.mechanism === (unit === 'slot' ? 'slot' : 'runtime-cap'),
  'INVALID_INPUT', 'Runtime cap must be an enforceable local unit');
  if (unit === 'subscription-percent') assert(authorizedMaximum === null,
    'INVALID_INPUT', 'Unknown subscription depletion cannot have a quantitative ceiling');
  if (authorizedMaximum !== null) quantity(authorizedMaximum, unit);
  if (runtimeCap.supported) quantity(runtimeCap.amount, unit);
  else assert(runtimeCap.amount === null && runtimeCap.mechanism === 'none', 'INVALID_INPUT', 'Unsupported cap cannot carry a limit');

  let estimate = 0;
  let status = 'estimated';
  let unknownReason = null;
  let priceRevision = null;
  for (const phase of PHASES) {
    const entry = phaseEstimates[phase];
    assert(entry && entry.unit === unit, 'UNIT_MISMATCH', 'Phase estimate unit differs from work unit');
    assert(Object.keys(entry).length === 2 && Object.hasOwn(entry, 'unit')
      && Object.hasOwn(entry, unit === 'api-usd' ? 'usage' : 'amount'),
    'INVALID_INPUT', 'Phase must declare exactly one quantity or usage record');
    if (unit === 'subscription-percent') {
      assert(entry.amount === null, 'INVALID_INPUT', 'Unobserved subscription depletion cannot be estimated');
      status = 'unknown'; unknownReason = 'SUBSCRIPTION_DEPLETION_UNKNOWN';
    } else if (unit === 'api-usd') {
      assert(accessPath === 'api', 'UNIT_MISMATCH', 'API prices cannot value subscription usage');
      const priced = estimateClaudeApiTokenCost({ modelId: apiPricing?.modelId,
        pricingDate: apiPricing?.pricingDate, scope: apiPricing?.scope, usage: entry.usage });
      if (priced.status !== 'estimated') {
        status = 'unknown'; unknownReason ??= priced.reason;
      } else {
        priceRevision ??= priced.cost.sourceReference;
        assert(priceRevision === priced.cost.sourceReference, 'UNIT_MISMATCH', 'Price revisions differ');
        estimate = addMetricValuesV1({ kind: 'cost', basis: 'apiPriceEstimate', amount: estimate, currency: 'USD', unit: null },
          { kind: 'cost', basis: 'apiPriceEstimate', amount: priced.cost.amount, currency: 'USD', unit: null }).amount;
      }
    } else if (entry.amount === null) {
      status = 'unknown'; unknownReason ??= 'LOCAL_QUANTITY_UNKNOWN';
    } else {
      estimate = unit === 'slot' ? Math.max(estimate, quantity(entry.amount, unit))
        : estimate + quantity(entry.amount, unit);
      assert(Number.isSafeInteger(estimate), 'INVALID_QUANTITY', 'Local sum exceeds safe integer range');
    }
  }
  if (status === 'unknown') estimate = null;
  if (estimate !== null && authorizedMaximum !== null) {
    assert(estimate <= authorizedMaximum, 'ESTIMATE_EXCEEDS_AUTHORIZATION', 'Estimate exceeds approved maximum');
  }
  // A caller's capability claim is planning data, never proof that a cap was installed.
  return Object.freeze({
    kind: 'work-estimate', status, unknownReason, accessPath, unit, estimate, authorizedMaximum,
    proposedRuntimeCap: runtimeCap.supported ? runtimeCap.amount : null,
    runtimeCapSupportClaim: runtimeCap.supported, runtimeCapMechanismClaim: runtimeCap.mechanism,
    runtimeEnforceableCap: null, runtimeCapSupported: false, hardEnforced: false,
    quantitativeReservation: null, reservationBasis: null,
    priceRevision: status === 'estimated' ? priceRevision : null,
  });
}

/** Preserve actual overrun; mixed cumulative/delta or aggregate/detail reports cannot be summed. */
export function recordWorkConsumptionV1(plan, observations) {
  assert(plan?.kind === 'work-estimate' && LOCAL.includes(plan.unit)
    && Array.isArray(observations) && observations.length > 0,
  'INVALID_INPUT', 'A local plan and observations are required');
  const ids = new Set();
  const forms = new Set();
  let actual = 0;
  for (const observation of observations) {
    assert(typeof observation.id === 'string' && observation.id.length > 0 && !ids.has(observation.id),
      'DUPLICATE_OBSERVATION', 'Observation IDs must be unique');
    ids.add(observation.id);
    assert(observation.unit === plan.unit, 'UNIT_MISMATCH', 'Actual and estimated units differ');
    const form = `${observation.mode}/${observation.granularity}`;
    assert(['delta/detail', 'cumulative/aggregate'].includes(form), 'INVALID_INPUT', 'Unsupported accounting form');
    forms.add(form);
    assert(forms.size === 1, 'DOUBLE_COUNT', 'Cumulative/delta or aggregate/detail reports cannot mix');
    if (form === 'delta/detail') assert(PHASES.includes(observation.phase), 'INVALID_INPUT', 'Detail needs a call class');
    else assert(observation.phase == null && observations.length === 1,
      'DOUBLE_COUNT', 'Cumulative aggregate requires one total');
    actual = plan.unit === 'slot' ? Math.max(actual, quantity(observation.amount, plan.unit))
      : actual + quantity(observation.amount, plan.unit);
    assert(Number.isSafeInteger(actual), 'INVALID_QUANTITY', 'Actual sum exceeds safe integer range');
  }
  return {
    kind: 'work-consumption-observation', unit: plan.unit, actual,
    estimate: plan.estimate, authorizedMaximum: plan.authorizedMaximum,
    exceededEstimate: plan.estimate === null ? null : actual > plan.estimate,
    exceededAuthorizedMaximum: plan.authorizedMaximum === null ? null : actual > plan.authorizedMaximum,
    exceededProposedRuntimeCap: plan.proposedRuntimeCap === null ? null : actual > plan.proposedRuntimeCap,
    accountingForm: [...forms][0], observationIds: [...ids],
  };
}
