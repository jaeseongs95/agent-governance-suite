/** Pure unknown/stale advice. Claims are not admitted observations or reservation authority. */
import { assert, keys } from '../model-routing-core.mjs';
import { projectResourceObservabilityV1 } from './observation-trust.mjs';

const STRATEGIES = ['conservative-concurrency', 'defer', 'operator-refresh'];
const timestamp = value => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
  && Number.isFinite(Date.parse(value));

export function decideUnknownResourcePolicyV1({ modelAvailability, usageClaim, now, policy }) {
  keys(usageClaim, ['source', 'metric', 'observedAt', 'expiresAt']);
  keys(policy, ['mode', 'onUnknown', 'onStale', 'conservativeConcurrency']);
  const projection = projectResourceObservabilityV1({
    modelAvailability, usageClaim: { source: usageClaim.source, metric: usageClaim.metric },
  });
  assert(timestamp(now) && ['observe-only', 'recommend-only'].includes(policy.mode)
    && STRATEGIES.includes(policy.onUnknown) && STRATEGIES.includes(policy.onStale),
  'INVALID_INPUT', 'Explicit time, mode, and unknown/stale strategies are required');
  assert(policy.conservativeConcurrency === null || Number.isSafeInteger(policy.conservativeConcurrency)
    && policy.conservativeConcurrency > 0, 'INVALID_INPUT', 'Conservative concurrency must be a positive proposed limit');
  assert(![policy.onUnknown, policy.onStale].includes('conservative-concurrency')
    || policy.conservativeConcurrency !== null,
  'INVALID_INPUT', 'Conservative strategy requires an explicit proposed limit');
  const { observedAt, expiresAt } = usageClaim;
  assert(observedAt === null && expiresAt === null && usageClaim.source === 'unknown'
    || timestamp(observedAt) && timestamp(expiresAt)
      && Date.parse(observedAt) < Date.parse(expiresAt),
  'INVALID_INPUT', 'Original observation interval is required for a source claim');

  const freshness = observedAt === null ? 'unknown'
    : Date.parse(now) < Date.parse(observedAt) || Date.parse(now) >= Date.parse(expiresAt)
      ? 'stale' : 'fresh';
  const quotaKnowledge = freshness === 'stale' ? 'stale'
    : projection.budgetObservability === 'unknown' ? 'unknown' : 'unadmitted';
  // If both source and time are uncertain, choose the more restrictive explicit strategy.
  const candidates = [policy.onUnknown];
  if (freshness === 'stale') candidates.push(policy.onStale);
  const order = { 'conservative-concurrency': 0, 'operator-refresh': 1, defer: 2 };
  let recommendation = candidates.sort((a, b) => order[b] - order[a])[0];
  if (modelAvailability === 'unavailable') recommendation = 'block';
  else if (modelAvailability === 'unknown') recommendation = 'defer';

  return {
    kind: 'unknown-resource-policy-output', mode: policy.mode,
    modelAvailability, quotaKnowledge, freshness, usageSourceClaim: usageClaim.source,
    claimedMetric: projection.claimedMetric, quotaRemaining: null,
    observedAt, expiresAt, evaluatedAt: now,
    recommendation, proposedConcurrencyLimit: recommendation === 'conservative-concurrency'
      ? policy.conservativeConcurrency : null,
    observationAdmitted: false, executionAuthorized: false,
    reservationIssued: false, issuanceCount: 0, refreshRequested: false,
  };
}
