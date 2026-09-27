/** Report projection only. Server admission must establish trusted provenance separately. */
import { assert, keys } from '../model-routing-core.mjs';
import { validateMetricValueV1 } from './metric-units.mjs';

const AVAILABILITY = ['available', 'unavailable', 'unknown'];
const SOURCES = ['provider-reported', 'operator-configured', 'estimated', 'unknown'];

/** Keep model availability independent from the observability of a claimed budget value. */
export function projectResourceObservabilityV1(input) {
  keys(input, ['modelAvailability', 'usageClaim']);
  assert(AVAILABILITY.includes(input.modelAvailability), 'INVALID_INPUT', 'Invalid model availability');
  keys(input.usageClaim, ['source', 'metric']);
  assert(SOURCES.includes(input.usageClaim.source), 'INVALID_INPUT', 'Invalid usage source claim');
  validateMetricValueV1(input.usageClaim.metric);
  assert(input.usageClaim.source !== 'unknown' || input.usageClaim.metric.amount === null,
    'INVALID_INPUT', 'Unknown usage cannot carry a quantity');

  return {
    modelAvailability: input.modelAvailability,
    budgetObservability: input.usageClaim.metric.amount === null ? 'unknown' : 'unadmitted',
    usageSourceClaim: input.usageClaim.source,
    claimedMetric: structuredClone(input.usageClaim.metric),
    budgetRemaining: null,
    observationAdmitted: false,
  };
}
