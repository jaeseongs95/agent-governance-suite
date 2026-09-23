import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'vitest';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { RESOURCE_ADMISSION_FEATURE, RESOURCE_BROKER_OPERATION,
  RESOURCE_BROKER_ALLOWED_OPERATIONS, negotiateResourceAdmission,
  validateResourceBrokerRequest, validateResourceBrokerResult,
} from '../../../mcp-server/src/resource/broker-protocol.ts';
import { SESSION_MESSAGE_BODY_MAX_BYTES, SESSION_MESSAGE_MAX_REQUEST_BYTES,
  SESSION_MESSAGE_PROTOCOL } from '../../../mcp-server/src/session-message-protocol.ts';

const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const digest = `sha256:${'a'.repeat(64)}`;
const oldPing = { protocolVersion: '1.0.0', capabilities: ['atomic-wake-claim'] };
const newPing = { ...oldPing, capabilities: [...oldPing.capabilities, RESOURCE_ADMISSION_FEATURE] };
const wire = (operation, args, requestId = 'request-1') => ({ schemaVersion: '1.0.0',
  feature: RESOURCE_ADMISSION_FEATURE, requestId, operation, args });
const admission = { requestKey: 'key-1', taskId: 'task-1', runId: 'run-1',
  slotId: 'slot-1', attemptId: 'attempt-1', planRevision: 1, leaseEpoch: 1,
  accountScope, resourcePoolId: 'pool-1', expiresAt: '2026-09-23T01:00:00.000Z',
  windows: [{ windowId: 'weekly', amount: 1, unit: 'request' }] };

test('B14-a old and new ping negotiate only the additive resource feature', () => {
  assert.equal(RESOURCE_ADMISSION_FEATURE, 'resource-admission.v1');
  assert.equal(RESOURCE_BROKER_OPERATION, 'resource-admission');
  assert.equal(negotiateResourceAdmission(oldPing), false);
  assert.equal(negotiateResourceAdmission(newPing), true);
  assert.throws(() => negotiateResourceAdmission({ ...newPing, protocolVersion: '2.0.0' }));
  assert.throws(() => negotiateResourceAdmission({ ...newPing, capabilities: 'resource-admission.v1' }));
  assert.equal(SESSION_MESSAGE_PROTOCOL, '1.0.0');
  assert.equal(SESSION_MESSAGE_BODY_MAX_BYTES, 4096);
  assert.equal(SESSION_MESSAGE_MAX_REQUEST_BYTES, 32 * 1024);
});

test('B14-a unnegotiated, unknown-version, unknown-operation and role claims fail closed', () => {
  const read = wire('read-rollover', { accountScope, poolId: 'pool-1', windowId: 'weekly' });
  assert.throws(() => validateResourceBrokerRequest(read, negotiateResourceAdmission(oldPing), 'reader'),
    /not negotiated/u);
  assert.deepEqual(validateResourceBrokerRequest(read, negotiateResourceAdmission(newPing), 'reader'), read);
  assert.throws(() => validateResourceBrokerRequest({ ...read, schemaVersion: '2.0.0' }, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest({ ...read, feature: 'resource-admission.v2' }, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest({ ...read, operation: 'send' }, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest({ ...read, role: 'owner' }, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest({ ...read, args: { ...read.args, remaining: 100 } }, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest(read, true, 'owner'));
  assert.throws(() => validateResourceBrokerRequest(read, true, 'admin'));
  assert.deepEqual(RESOURCE_BROKER_ALLOWED_OPERATIONS.collector, ['collect-observation']);
});

test('B14-a owner request validation accepts policy input but rejects raw evidence and forged collector access', () => {
  const reserve = wire('admit-pool', { request: admission });
  assert.deepEqual(validateResourceBrokerRequest(reserve, true, 'owner'), reserve);
  assert.throws(() => validateResourceBrokerRequest(reserve, true, 'reader'));
  assert.throws(() => validateResourceBrokerRequest(wire('admit-pool',
    { request: { ...admission, policy: { onUnknown: 'allow' } } }), true, 'owner'));
  assert.throws(() => validateResourceBrokerRequest(wire('settle-reservation',
    { evidence: { kind: 'terminal' } }), true, 'owner'));
  assert.deepEqual(validateResourceBrokerRequest(wire('settle-reservation',
    { evidenceRef: 'server-evidence-1' }), true, 'owner').operation, 'settle-reservation');
  assert.throws(() => validateResourceBrokerRequest(wire('collect-observation',
    { collectorId: 'provider-1', response: { kind: 'full' } }), true, 'collector'));
});

test('B14-a transport ACK cannot stand in for an admission result or receipt', () => {
  const reserve = wire('admit-pool', { request: admission });
  const admitted = { schemaVersion: '1.0.0', requestId: reserve.requestId,
    operation: reserve.operation, kind: 'resource-result',
    result: { kind: 'admitted', reservationId: 'reservation-1' } };
  assert.deepEqual(validateResourceBrokerResult(admitted, reserve), admitted);
  assert.throws(() => validateResourceBrokerResult({ ok: true, data: admitted }, reserve));
  assert.throws(() => validateResourceBrokerResult({ ...admitted,
    result: { ...admitted.result, mac: `hmac-sha256:${'a'.repeat(64)}` } }, reserve));
  assert.throws(() => validateResourceBrokerResult({ ...admitted, requestId: 'other' }, reserve));
  const issue = wire('issue-receipt', { reservationId: 'reservation-1' });
  const receipt = { schemaVersion: '1.0.0', authorityId: 'ags-resource-authority-v1',
    realmId: 'a'.repeat(64), ownerId: 'owner-1', leaseId: 'lease-1', leaseEpoch: 1,
    reservationId: 'reservation-1', requestDigest: digest,
    expiresAt: '2026-09-23T01:00:00.000Z', mac: `hmac-sha256:${'a'.repeat(64)}` };
  const issued = { ...admitted, operation: issue.operation, result: receipt };
  assert.deepEqual(validateResourceBrokerResult(issued, issue), issued);
  assert.throws(() => validateResourceBrokerResult({ ...issued,
    result: { acknowledged: true } }, issue));
  assert.throws(() => validateResourceBrokerResult({ ...issued,
    result: { ...receipt, reservationId: 'another' } }, issue));
  const read = wire('read-observation', { observationId: digest });
  assert.deepEqual(validateResourceBrokerResult({ schemaVersion: '1.0.0',
    requestId: read.requestId, operation: read.operation, kind: 'resource-result',
    result: null }, read).result, null);
  assert.throws(() => validateResourceBrokerResult({ schemaVersion: '1.0.0',
    requestId: read.requestId, operation: read.operation, kind: 'resource-result',
    result: { acknowledged: true } }, read));
});

test('B14-a read and settlement results reject malformed nested evidence', () => {
  const reply = (request, result) => ({ schemaVersion: '1.0.0',
    requestId: request.requestId, operation: request.operation,
    kind: 'resource-result', result });
  const observation = { schemaVersion: '1.0.0', kind: 'unavailable',
    collectorId: 'provider-1', source: 'provider-reported', accountScope,
    resourcePoolId: 'pool-1', sequence: 1, reason: 'not-exposed' };
  const observationId = `sha256:${createHash('sha256').update(canonicalJson(observation)).digest('hex')}`;
  const readObservation = wire('read-observation', { observationId });
  assert.deepEqual(validateResourceBrokerResult(reply(readObservation, observation), readObservation).result,
    observation);
  assert.throws(() => validateResourceBrokerResult(reply(readObservation,
    { ...observation, reason: 'unrecognized' }), readObservation));
  assert.throws(() => validateResourceBrokerResult(reply(readObservation,
    { ...observation, sequence: 2 }), readObservation));

  const readRollover = wire('read-rollover', { accountScope, poolId: 'pool-1', windowId: 'weekly' });
  const rollover = { observationId, resetEpoch: 2, revision: 1, carryover: [{
    reservationId: 'reservation-1', originalResetEpoch: 1, state: 'settled',
    intentId: 'intent-1', heldAmount: 2, unit: 'request', coverage: 'unknown',
    observedAmount: null, inclusion: 'unknown' }] };
  assert.deepEqual(validateResourceBrokerResult(reply(readRollover, rollover), readRollover).result,
    rollover);
  assert.throws(() => validateResourceBrokerResult(reply(readRollover, { ...rollover,
    carryover: [{ ...rollover.carryover[0], inclusion: 'included' }] }), readRollover));
  assert.throws(() => validateResourceBrokerResult(reply(readRollover, { ...rollover,
    carryover: [{ ...rollover.carryover[0], originalResetEpoch: 2 }] }), readRollover));

  const projection = { providerMetric: { unit: 'request', metricKind: 'remaining',
    observedAmount: 10, coverage: 'complete', knownExcludedDelta: 0, projectedAmount: 10 },
  internalSlotBudget: { unit: 'slot', reservedAmount: 0, observedUse: null },
  eventInclusion: [{ eventId: 'event-1', status: 'unknown' }], needsReconciliation: true };
  const readReconciliation = wire('read-reconciliation',
    { accountScope, poolId: 'pool-1', windowId: 'weekly' });
  assert.deepEqual(validateResourceBrokerResult(reply(readReconciliation, projection),
    readReconciliation).result, projection);
  assert.throws(() => validateResourceBrokerResult(reply(readReconciliation, { ...projection,
    eventInclusion: [{ eventId: 'event-1', status: 'invented' }] }), readReconciliation));
  assert.throws(() => validateResourceBrokerResult(reply(readReconciliation, { ...projection,
    providerMetric: { ...projection.providerMetric, knownExcludedDelta: '0' } }), readReconciliation));

  const settle = wire('settle-reservation', { evidenceRef: 'evidence-1' });
  const settled = { kind: 'settled', reservationId: 'reservation-1', replayed: false,
    coverage: 'unknown', observed: [{ accountScope, poolId: 'pool-1', windowId: 'weekly',
      unit: 'request', estimatedAmount: 2, observedAmount: null, coverage: 'unknown' }] };
  assert.deepEqual(validateResourceBrokerResult(reply(settle, settled), settle).result, settled);
  assert.throws(() => validateResourceBrokerResult(reply(settle, { ...settled,
    observed: [{ ...settled.observed[0], estimatedAmount: -1 }] }), settle));
  const reconcile = wire('reconcile-usage', { expected: { accountScope,
    poolId: 'pool-1', windowId: 'weekly', observationId, resetEpoch: 2, revision: 1,
    ledgerDigest: digest, generation: 0 }, evidenceRef: 'evidence-2' });
  assert.deepEqual(validateResourceBrokerResult(reply(reconcile,
    { kind: 'applied', projection }), reconcile).result.projection, projection);
  assert.throws(() => validateResourceBrokerResult(reply(reconcile,
    { kind: 'applied', projection: { ...projection, internalSlotBudget: {
      unit: 'token', reservedAmount: 0, observedUse: null } } }), reconcile));
});
