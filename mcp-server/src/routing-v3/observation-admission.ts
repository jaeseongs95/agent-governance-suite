/** Bind signed host evidence to one stored v3 dispatch and consume it with the record write. */
import { assert, instant, RoutingError } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { recordSemanticApplicationV3 } from '../../../skills/coordinate-subagents/scripts/semantic/application-record.mjs';
import type { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { ContractValidator } from '../schema-validator.js';
import { readDecision } from './decision-codec.js';

export function recordSemanticApplicationWithAdmission(
  store: ModelRoutingStore,
  value: unknown,
  observationToken: string | null,
  now: string,
) {
  const validator = new ContractValidator();
  const input = validator.modelApplicationRequestV3(value);
  const entry = readDecision(store, input.decisionDigest, validator);
  if (entry?.decision.schemaVersion !== '3.0.0') throw new RoutingError('STORED_V3_REQUIRED', 'STORED_V3_REQUIRED');
  const decision = entry.decision;
  validator.modelApplicationRequestForDecisionV3(input, decision);
  assert(instant(input.dispatchedAt, 'dispatchedAt') <= instant(now, 'now'), 'DISPATCH_TIME_IN_FUTURE');
  const token = store.nativeHookObservationToken(input) ?? observationToken;
  if (token !== null) assert(/^[a-f0-9]{48}$/u.test(token), 'INVALID_OBSERVATION_TOKEN');
  return store.recordApplication(input, token, admittedObservation => {
    const record = recordSemanticApplicationV3(input, {
      request: entry.request, decision,
      catalog: entry.environment.catalog, policy: entry.environment.policy,
      now: input.dispatchedAt, admittedObservation,
    });
    return validator.modelApplicationRecordForDecisionV3(record, decision);
  }, now);
}
