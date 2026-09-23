/** Historical application checks use the dispatch instant, never completion-time capabilities. */
import {
  assert, canonical, collectEligibleCandidatesV2, digest, instant, verifySeal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import type { ModelRoutingStore } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import type { RoutingEnvironmentV2 } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import type { ModelRoutingDecisionV3, ModelSelectionRequestV2 } from '../../../contracts/types.js';
import { ContractValidator } from '../schema-validator.js';
import { readDecision } from './decision-codec.js';
import { recordSemanticApplicationWithAdmission } from './observation-admission.js';

const selection = (binding: Record<string, unknown>) => Object.fromEntries(
  ['model', 'resolvedModel', 'modelOrigin', 'servingProvider', 'accessPath', 'nativeReasoning', 'runtimeMode']
    .map(key => [key, binding[key]]),
);

function assertHistoricalSelection(entry: {
  request: ModelSelectionRequestV2; environment: RoutingEnvironmentV2;
  resolvedAt: string; decision: ModelRoutingDecisionV3;
}, dispatchedAt: string) {
  const { decision } = entry;
  assert(canonical(entry.request.binding) === canonical(decision.binding)
    && instant(dispatchedAt, 'dispatchedAt') >= instant(entry.resolvedAt, 'resolvedAt'),
  'HISTORICAL_DISPATCH_INVALID');
  const pool = collectEligibleCandidatesV2(entry.request, { ...entry.environment, now: dispatchedAt });
  assert(pool.capabilitySetDigest === decision.capabilitySetDigest
    && pool.candidates.some(candidate => candidate.snapshot.snapshotDigest === decision.capabilitySnapshotDigest
      && canonical({ actorId: candidate.snapshot.actorId, host: candidate.snapshot.host,
        sessionId: candidate.snapshot.sessionId, instanceId: candidate.snapshot.instanceId }) === canonical(decision.target)
      && canonical(selection(candidate.binding)) === canonical(decision.selected)
      && candidate.binding.invocationSurface === decision.invocationSurface), 'HISTORICAL_DISPATCH_INVALID');
}

export function recordHistoricalSemanticApplication(
  store: ModelRoutingStore, value: unknown, observationToken: string | null, now: string,
) {
  const validator = new ContractValidator();
  const input = validator.modelApplicationRequestV3(value);
  const entry = readDecision(store, input.decisionDigest, validator);
  assert(entry?.decision.schemaVersion === '3.0.0', 'STORED_V3_REQUIRED');
  const decision = entry.decision;
  validator.modelApplicationRequestForDecisionV3(input, decision);
  assertHistoricalSelection({ ...entry, decision }, input.dispatchedAt);
  return recordSemanticApplicationWithAdmission(store, input, observationToken, now);
}

/** A stored row remains versioned; v3 semantic evidence is never projected into v2. */
export function readStoredModelApplication(store: ModelRoutingStore, recordDigest: string) {
  const raw = store.application(recordDigest);
  if (raw === null) return null;
  const validator = new ContractValidator();
  const record = (raw as { schemaVersion?: string }).schemaVersion === '3.0.0'
    ? validator.modelApplicationRecordV3(raw) : validator.modelApplicationRecordV2(raw);
  verifySeal(record, 'recordDigest');
  assert(record.recordDigest === recordDigest, 'RECORD_DIGEST_MISMATCH');
  const entry = readDecision(store, record.decisionDigest, validator);
  assert(entry && entry.decision.schemaVersion === record.schemaVersion
    && digest(entry.request) === record.requestDigest
    && canonical(entry.request.binding) === canonical(record.binding), 'RECORD_DECISION_MISMATCH');
  if (record.schemaVersion === '3.0.0') {
    assert(entry.decision.schemaVersion === '3.0.0', 'RECORD_DECISION_MISMATCH');
    const dispatch = store.dispatch(digest({ binding: record.binding }));
    assert(dispatch?.decision_digest === record.decisionDigest
      && dispatch.dispatched_at === record.dispatchedAt, 'RECORD_DISPATCH_MISMATCH');
    assertHistoricalSelection({ ...entry, decision: entry.decision }, record.dispatchedAt);
    return validator.modelApplicationRecordForDecisionV3(record, entry.decision);
  }
  for (const field of ['binding', 'target', 'requested', 'selected', 'decisionDigest',
    'requestDigest', 'catalogDigest', 'policyDigest', 'capabilitySnapshotDigest'] as const) {
    assert(canonical(record[field]) === canonical(entry.decision[field]), 'RECORD_DECISION_MISMATCH');
  }
  assert(canonical(record.dispatched) === canonical(entry.decision.selected), 'RECORD_DECISION_MISMATCH');
  return record;
}
