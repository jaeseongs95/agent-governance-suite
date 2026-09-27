/** Reproduce an adopted decision from archived inputs only; never re-admit or dispatch it. */
import {
  assert, collectEligibleCandidatesV2, digestValue, instant, resolveV2, verifySeal,
} from '../model-routing-core.mjs';
import { assertPreparedSemanticInputV1 } from './prepared-input-check.mjs';
import { reduceSemanticDecisionV1 } from './reducer.mjs';

export const SEMANTIC_REDUCER_VERSION_V1 = 'semantic-reducer-v1';

export function replaySemanticDecisionV1({
  routingRequest, environment, prepared, advice, adoption, decisionTime, reducerVersion,
} = {}) {
  assert(routingRequest && environment && prepared && advice && adoption && decisionTime && reducerVersion,
    'REPLAY_INPUT_MISSING');
  assert(reducerVersion === SEMANTIC_REDUCER_VERSION_V1
    && prepared.reducerVersion === reducerVersion
    && advice.reducerVersion === reducerVersion, 'UNSUPPORTED_REDUCER');
  assert(adoption.status === 'eligible', 'ADOPTION_NOT_ELIGIBLE');
  digestValue(adoption.evidenceDigest, 'adoption evidenceDigest');
  assert(environment.now === decisionTime, 'REPLAY_TIME_MISMATCH');
  const at = instant(decisionTime, 'decisionTime');
  verifySeal(advice, 'adviceDigest');
  assert(advice.schemaVersion === '1.0.0'
    && advice.expiresAt === prepared.expiresAt
    && instant(prepared.requestedAt, 'requestedAt') <= instant(advice.evaluatedAt, 'evaluatedAt')
    && instant(advice.evaluatedAt, 'evaluatedAt') <= at
    && at < instant(advice.expiresAt, 'advice expiresAt'), 'REPLAY_TIME_MISMATCH');
  assertPreparedSemanticInputV1(prepared, routingRequest, environment, decisionTime);
  const { candidates } = collectEligibleCandidatesV2(routingRequest, environment);
  const baselineDecision = resolveV2(routingRequest, environment);
  return reduceSemanticDecisionV1({ prepared, advice, adoption, baselineDecision, candidates });
}
