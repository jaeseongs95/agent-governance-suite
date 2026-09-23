/** Pure recomputation check; a matching request is not an admission or execution receipt. */
import {
  assert, canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2,
  instant, verifySeal,
} from '../model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from './candidate-projection.mjs';

export function assertPreparedSemanticInputV1(prepared, routingRequest, environment, evaluationTime) {
  const at = instant(evaluationTime, 'evaluationTime');
  assert(environment.now === evaluationTime, 'EVALUATION_TIME_MISMATCH', 'Routing inputs must use the supplied evaluation time');
  assert(prepared.schemaVersion === '1.0.0', 'INVALID_INPUT', 'SemanticDecisionRequest.v1 required');
  verifySeal(prepared, 'requestDigest');
  assert(instant(prepared.requestedAt, 'requestedAt') <= at && at < instant(prepared.expiresAt, 'expiresAt'), 'EVALUATION_TIME_MISMATCH', 'Prepared request is not current at evaluation time');
  assert(canonical(prepared.binding) === canonical(routingRequest.binding), 'BINDING_MISMATCH', 'Routing binding changed');
  assert(prepared.effectiveRoutingRequestDigest === digest(routingRequest), 'BINDING_MISMATCH', 'Routing request changed');
  assert(prepared.stateDigest === digest(prepared.state) && prepared.questionDigest === digest(prepared.question), 'DIGEST_MISMATCH', 'Prepared state or question changed');
  assert(prepared.state.summaryDigest === null || prepared.state.summaryDigest === digest(prepared.state.text), 'DIGEST_MISMATCH', 'Prepared summary changed');

  const pool = collectEligibleCandidatesV2(routingRequest, environment);
  const metadata = getBaselineCandidateMetadataV2(pool.candidates, routingRequest, environment);
  const projection = projectSemanticCandidatesV1(pool.candidates, metadata);
  assert(projection !== null, 'NO_ELIGIBLE_CANDIDATE', 'Use the existing v2 blocked decision');
  assert(prepared.catalogDigest === environment.catalog.catalogDigest
    && prepared.routingPolicyDigest === digest(environment.policy)
    && prepared.capabilitySetDigest === pool.capabilitySetDigest, 'BINDING_MISMATCH', 'Routing inputs changed');
  assert(prepared.eligibleSetDigest === digest(prepared.eligibleSet)
    && prepared.optionMappingDigest === digest(prepared.options), 'DIGEST_MISMATCH', 'Prepared mapping digest differs from contents');
  assert(canonical(prepared.eligibleSet) === canonical(projection.eligibleSet)
    && canonical(prepared.options) === canonical(projection.options), 'PREPARED_INPUT_MISMATCH', 'Prepared candidates or options differ from recomputation');
  return true;
}
