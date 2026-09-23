import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { recordSemanticApplicationWithAdmission } from '../../../mcp-server/src/routing-v3/observation-admission.ts';
import { canonical, digest, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingStore, RoutingObservationSigner } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { recordSemanticApplicationV3 } from '../../../skills/coordinate-subagents/scripts/semantic/application-record.mjs';
import { observation, NOW, LATER, END } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const signer = new RoutingObservationSigner(Buffer.alloc(32, 8));
const receipt = payload => signer.issue('observation', payload, { issuedAt: NOW, expiresAt: END });

function setup() {
  const database = new DatabaseSync(':memory:');
  onTestFinished(() => database.close());
  const store = new ModelRoutingStore(database);
  const { legacy, decision, application } = contracts();
  const save = (request, selected) => database.prepare('INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)')
    .run(selected.decisionDigest, digest(selected.binding), canonical(request),
      canonical(legacy.env), canonical(selected), NOW);
  save(legacy.req, decision);
  const dispatch = selected => {
    const row = store.reserveDispatch(selected);
    store.transition(row.dispatchKey, 0, 'accepted');
    store.transition(row.dispatchKey, 1, 'running', null, LATER);
    return row.dispatchKey;
  };
  dispatch(decision);
  return { database, store, legacy, decision, application, save, dispatch };
}

test('signed host observation is admitted once for the exact v3 dispatch', () => {
  const { store, legacy, decision, application } = setup();
  const host = observation(legacy.req, decision);
  const token = store.publishObservation(receipt(host), signer, LATER);
  const result = recordSemanticApplicationWithAdmission(store, application, token, LATER);
  assert.equal(result.record.status, 'matched');
  assert.equal(result.record.observationAdmitted, true);
  assert.equal(result.record.trustedGateSatisfied, false);
  assert.equal(result.artifact.kind, 'model-application.v3');
  assert.throws(() => recordSemanticApplicationWithAdmission(store, application, token, LATER),
    { code: 'OBSERVATION_TOKEN_UNAVAILABLE' });
});

test('a valid token from another dispatch cannot be moved to this application', () => {
  const { store, legacy, decision, application, save, dispatch } = setup();
  const binding = { ...decision.binding, attemptId: 'attempt-2' };
  const request = { ...legacy.req, binding };
  const second = seal({ ...decision, binding, requestDigest: digest(request) }, 'decisionDigest');
  save(request, second);
  dispatch(second);
  const otherApplication = { ...application, binding, decisionDigest: second.decisionDigest };
  const token = store.publishObservation(receipt(observation(request, second)), signer, LATER);
  assert.throws(() => recordSemanticApplicationWithAdmission(store, application, token, LATER),
    { code: 'OBSERVATION_BINDING_MISMATCH' });
  assert.equal(recordSemanticApplicationWithAdmission(store, otherApplication, token, LATER).record.status, 'matched');
});

test('record conflict rolls back token consumption, then valid save consumes it', () => {
  const { database, store, legacy, decision, application } = setup();
  const observed = observation(legacy.req, decision);
  const token = store.publishObservation(receipt(observed), signer, LATER);
  const expected = recordSemanticApplicationV3(application, {
    request: legacy.req, decision, catalog: legacy.env.catalog,
    policy: legacy.env.policy, now: LATER, admittedObservation: observed,
  });
  database.prepare('INSERT INTO ags_model_applications_v2 VALUES (?,?,?,?,?)')
    .run(expected.recordDigest, decision.decisionDigest, digest(decision.binding), '{}', LATER);
  assert.throws(() => recordSemanticApplicationWithAdmission(store, application, token, LATER),
    { code: 'RECORD_CONFLICT' });
  assert.equal(database.prepare('SELECT consumed_at FROM ags_model_receipts_v1 WHERE nonce=?').get(token).consumed_at, null);
  database.prepare('DELETE FROM ags_model_applications_v2 WHERE record_digest=?').run(expected.recordDigest);
  assert.equal(recordSemanticApplicationWithAdmission(store, application, token, LATER).record.status, 'matched');
});

test('caller observation and signed self-report cannot become matched evidence', () => {
  const { store, legacy, decision, application } = setup();
  const claimed = observation(legacy.req, decision);
  const raw = recordSemanticApplicationWithAdmission(store, { ...application, observation: claimed }, null, LATER);
  assert.equal(raw.record.status, 'unverified');
  assert.equal(raw.record.observationAdmitted, false);
  assert.throws(() => store.publishObservation(receipt({ ...claimed, source: 'agent-self-report' }), signer, LATER),
    { code: 'OBSERVATION_BINDING_MISMATCH' });
});

test('native hook receipt binds the exact application bytes and dispatch time', () => {
  const { store, legacy, decision, application } = setup();
  const signed = receipt(observation(legacy.req, decision));
  assert.throws(() => store.bindNativeHookObservation({ ...application, dispatchedAt: NOW }, signed, signer, LATER),
    { code: 'DISPATCH_TIME_MISMATCH' });
  store.bindNativeHookObservation(application, signed, signer, LATER);
  assert.equal(recordSemanticApplicationWithAdmission(store, application, null, LATER).record.status, 'matched');
  assert.throws(() => store.bindNativeHookObservation(application, signed, signer, LATER));
});
