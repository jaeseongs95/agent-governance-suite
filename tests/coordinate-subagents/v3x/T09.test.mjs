import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { onTestFinished, test } from 'vitest';

import { readStoredModelApplication, recordHistoricalSemanticApplication } from '../../../mcp-server/src/routing-v3/application-service.ts';
import { recordSemanticApplicationWithAdmission } from '../../../mcp-server/src/routing-v3/observation-admission.ts';
import { openModelRoutingService } from '../../../mcp-server/src/model-routing-service.ts';
import { canonical, collectEligibleCandidatesV2, digest, resolveV2 } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ModelRoutingServiceCore } from '../../../skills/coordinate-subagents/scripts/model-routing-service-core.mjs';
import { ModelRoutingStore, RoutingObservationSigner } from '../../../skills/coordinate-subagents/scripts/model-routing-store.mjs';
import { application as v2Application, observation, NOW, LATER, END } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const LATE = '2026-09-21T12:05:00.000Z';
const RECEIPT_END = '2026-09-21T12:08:00.000Z';
const signer = new RoutingObservationSigner(Buffer.alloc(32, 7));

function setup(dispatchedAt = LATER, suppliedDatabase = null) {
  const database = suppliedDatabase ?? new DatabaseSync(':memory:');
  if (!suppliedDatabase) onTestFinished(() => database.close());
  const store = new ModelRoutingStore(database);
  const { legacy, decision, application } = contracts();
  store.saveDecision(legacy.req, legacy.env, legacy.decision, NOW);
  database.prepare('INSERT INTO ags_model_decisions_v2 VALUES (?,?,?,?,?,?)')
    .run(decision.decisionDigest, digest(decision.binding), canonical(legacy.req),
      canonical(legacy.env), canonical(decision), NOW);
  const dispatch = store.reserveDispatch(decision);
  store.transition(dispatch.dispatchKey, 0, 'accepted');
  store.transition(dispatch.dispatchKey, 1, 'running', null, dispatchedAt);
  return { database, store, legacy, decision,
    application: { ...application, dispatchedAt } };
}

test('the MCP routing gateway wires v3 recording and versioned record reads', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-t09-'));
  const path = join(directory, 'routing.sqlite');
  const database = new DatabaseSync(path);
  let gateway;
  try {
    const { application } = setup(LATER, database);
    gateway = openModelRoutingService(path);
    const result = gateway.service.call('record_model_application', { application });
    assert.equal(result.ok, true);
    assert.equal(result.data.record.schemaVersion, '3.0.0');
    assert.deepEqual(gateway.service.application(result.data.record.recordDigest), result.data.record);
  } finally {
    gateway?.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('late completion records signed actual evidence using valid historical dispatch inputs', () => {
  const { store, legacy, decision, application } = setup();
  assert.equal(collectEligibleCandidatesV2(legacy.req, { ...legacy.env, now: LATE }).candidates.length, 0);
  const observed = observation(legacy.req, decision, { observedAt: LATE });
  const receipt = signer.issue('observation', observed, { issuedAt: END, expiresAt: RECEIPT_END });
  const token = store.publishObservation(receipt, signer, LATE);
  const service = new ModelRoutingServiceCore({ store, clock: () => LATE,
    recordV3: (input, admittedToken, now) => recordHistoricalSemanticApplication(store, input, admittedToken, now),
    readRecord: recordDigest => readStoredModelApplication(store, recordDigest) });
  const result = service.call('record_model_application', { application, observationToken: token });
  assert.equal(result.ok, true);
  assert.equal(result.data.record.schemaVersion, '3.0.0');
  assert.equal(result.data.record.status, 'matched');
  assert.equal(result.data.record.trustedGateSatisfied, false);
  assert.equal(result.data.artifact.kind, 'model-application.v3');
  assert.deepEqual(readStoredModelApplication(store, result.data.record.recordDigest), result.data.record);
  assert.deepEqual(service.application(result.data.record.recordDigest), result.data.record);
});

test('a dispatch already invalid at its own instant is refused, not repaired at completion', () => {
  const { store, application } = setup(END);
  assert.throws(() => recordHistoricalSemanticApplication(store, application, null, LATE),
    { code: 'HISTORICAL_DISPATCH_INVALID' });
  assert.equal(store.database.prepare('SELECT COUNT(*) AS n FROM ags_model_applications_v2').get().n, 0);
  const lowerRecord = recordSemanticApplicationWithAdmission(store, application, null, LATE).record;
  assert.throws(() => readStoredModelApplication(store, lowerRecord.recordDigest),
    { code: 'HISTORICAL_DISPATCH_INVALID' });
});

test('a dispatch predating its stored decision is refused', () => {
  const { database, store, decision, application } = setup();
  database.prepare('UPDATE ags_model_decisions_v2 SET resolved_at=? WHERE decision_digest=?')
    .run(END, decision.decisionDigest);
  assert.throws(() => recordHistoricalSemanticApplication(store, application, null, LATE),
    { code: 'HISTORICAL_DISPATCH_INVALID' });
});

test('v2 and v3 rows read under their own schemas without semantic downcast', () => {
  const { database, store, legacy, decision, application } = setup();
  const v3 = recordHistoricalSemanticApplication(store, application, null, LATE).record;
  assert.throws(() => new ModelRoutingServiceCore({ store }).application(v3.recordDigest),
    { code: 'V3_RECORD_READER_UNAVAILABLE' });
  const v2Request = { ...legacy.req, binding: { ...legacy.req.binding, attemptId: 'v2-attempt' } };
  const v2Decision = resolveV2(v2Request, legacy.env);
  store.saveDecision(v2Request, legacy.env, v2Decision, NOW);
  const v2Dispatch = store.reserveDispatch(v2Decision);
  store.transition(v2Dispatch.dispatchKey, 0, 'accepted');
  store.transition(v2Dispatch.dispatchKey, 1, 'running', null, NOW);
  const v2 = new ModelRoutingServiceCore({ store, clock: () => NOW })
    .record({ application: v2Application(v2Request, v2Decision) }).record;
  const readV2 = readStoredModelApplication(store, v2.recordDigest);
  const readV3 = readStoredModelApplication(store, v3.recordDigest);
  assert.equal(readV2.schemaVersion, '2.0.0');
  assert.equal(readV3.schemaVersion, '3.0.0');
  assert.deepEqual(readV3.semantic, decision.semantic);
  assert.equal(readStoredModelApplication(store, digest('missing-record')), null);
  database.prepare('UPDATE ags_model_dispatches_v2 SET dispatched_at=? WHERE decision_digest=?')
    .run(END, decision.decisionDigest);
  assert.throws(() => readStoredModelApplication(store, v3.recordDigest),
    { code: 'RECORD_DISPATCH_MISMATCH' });
  database.prepare('UPDATE ags_model_dispatches_v2 SET dispatched_at=? WHERE decision_digest=?')
    .run(LATER, decision.decisionDigest);
  database.prepare('UPDATE ags_model_applications_v2 SET payload=? WHERE record_digest=?')
    .run(canonical({ ...v3, schemaVersion: '2.0.0' }), v3.recordDigest);
  assert.throws(() => readStoredModelApplication(store, v3.recordDigest));
});
