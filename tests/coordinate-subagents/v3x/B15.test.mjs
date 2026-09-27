import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { afterEach, test, vi } from 'vitest';

import { requestResourceOperation } from '../../../mcp-server/src/resource/client.ts';
import { RESOURCE_ADMISSION_FEATURE, RESOURCE_BROKER_OPERATION }
  from '../../../mcp-server/src/resource/broker-protocol.ts';
import { SESSION_MESSAGE_PROTOCOL } from '../../../mcp-server/src/session-message-protocol.ts';

const now = Date.parse('2026-09-27T07:50:00.000Z');
const ping = { protocolVersion: SESSION_MESSAGE_PROTOCOL, capabilities: [RESOURCE_ADMISSION_FEATURE] };
const read = { observationId: `sha256:${'a'.repeat(64)}` };
const commit = { reservationId: 'reservation-1', intentId: 'intent-1' };
const receipt = { schemaVersion: '1.0.0', authorityId: 'ags-resource-authority-v1',
  realmId: 'a'.repeat(64), ownerId: 'owner-1', leaseId: 'lease-1', leaseEpoch: 1,
  reservationId: 'reservation-1', requestDigest: `sha256:${'b'.repeat(64)}`,
  expiresAt: new Date(now + 1).toISOString(), mac: `hmac-sha256:${'c'.repeat(64)}` };
const reply = (wire, result) => ({ schemaVersion: '1.0.0', requestId: wire.requestId,
  operation: wire.operation, kind: 'resource-result', result });

function harness(operationReply = wire => reply(wire, null), pingReply = async () => ping) {
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const calls = [];
  const request = async (operation, payload, directory, remainingMs, signal) => {
    calls.push({ operation, payload: structuredClone(payload), directory, remainingMs, signal });
    return operation === 'ping' ? pingReply() : operationReply(payload, signal);
  };
  return { calls, options: { request, stateDirectory: 'fixture-only', timeoutMs: 100 } };
}
function countOperations(h, expected) {
  assert.equal(h.calls.filter(c => c.operation === RESOURCE_BROKER_OPERATION).length, expected);
  assert.ok(h.calls.every(c => c.operation === 'ping' || c.operation === RESOURCE_BROKER_OPERATION));
  assert.equal(h.calls.filter(c => c.operation === 'ping').length, h.calls.length === 0 ? 0 : 1);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

function fakeTime() {
  let elapsed = 0;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  // The client imports node:perf_hooks; replacing global performance does not control it.
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  return { elapse: ms => { elapsed += ms; }, advance: async ms => {
    elapsed += ms;
    await vi.advanceTimersByTimeAsync(ms);
  } };
}

test('B15 negotiated reads and owner transitions preserve the bound wire result without role/source fields', async () => {
  for (const [operation, args, value] of [['read-observation', read, null],
    ['commit-reservation', commit, { kind: 'committed', ...commit, replayed: false }]]) {
    const h = harness(wire => reply(wire, value));
    const result = await requestResourceOperation(operation, args, h.options);
    assert.equal(result.kind, 'resource-result');
    assert.deepEqual(result.result, value);
    assert.deepEqual(Object.keys(h.calls[1].payload).sort(), ['args', 'feature', 'operation', 'requestId', 'schemaVersion']);
    assert.deepEqual(h.calls[1].payload.args, args);
    assert.equal(h.calls[0].signal, h.calls[1].signal);
    assert.ok(h.calls[1].remainingMs <= h.calls[0].remainingMs);
    assert.equal(h.calls[1].directory, 'fixture-only');
    countOperations(h, 1);
  }
});

test('B15 old broker is unsupported and receives no resource operation', async () => {
  const h = harness(undefined, async () => ({ ...ping, capabilities: [] }));
  const result = await requestResourceOperation('read-observation', read, h.options);
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.effect, 'not-invoked');
  countOperations(h, 0);
});

test.each([null, { ...ping, protocolVersion: '2.0.0' }, { ...ping, capabilities: 'resource-admission.v1' }])('B15 malformed/unknown ping cannot grant access: %j', async bad => {
  const h = harness(undefined, async () => bad);
  const result = await requestResourceOperation('read-observation', read, h.options);
  assert.equal(result.kind, 'protocol-failure');
  assert.equal(result.phase, 'negotiation');
  assert.equal(result.effect, 'not-invoked');
  countOperations(h, 0);
});

test('B15 negotiation transport failure preserves its cause and never invokes an operation', async () => {
  const error = new Error('connection lost before ping response');
  const h = harness(undefined, async () => { throw error; });
  const result = await requestResourceOperation('read-observation', read, h.options);
  assert.equal(result.kind, 'transport-failure');
  assert.equal(result.phase, 'negotiation');
  assert.equal(result.effect, 'not-invoked');
  assert.equal(result.error, error);
  countOperations(h, 0);
});

test.each([
  ['collector access', 'collect-observation', { collectorId: 'collector-1' }],
  ['authority injection', 'read-observation', { ...read, authorityId: 'forged' }],
  ['caller role', 'read-observation', { ...read, role: 'owner' }],
  ['caller observation', 'read-observation', { ...read, source: 'provider-reported' }],
  ['raw evidence', 'release-reservation', { reservationId: 'reservation-1', evidence: { kind: 'no-start' } }],
])('B15 rejects %s before any transport call', async (_name, operation, args) => {
  const h = harness();
  const result = await requestResourceOperation(operation, args, h.options);
  assert.equal(result.kind, 'invalid-request');
  assert.equal(result.effect, 'not-invoked');
  assert.equal(h.calls.length, 0);
  countOperations(h, 0);
});

test.each([
  ['ACK', () => ({ ok: true })],
  ['enveloped result', wire => ({ ok: true, data: reply(wire, null) })],
  ['wrong request', wire => ({ ...reply(wire, null), requestId: 'other' })],
  ['wrong operation', wire => ({ ...reply(wire, null), operation: 'read-rollover' })],
  ['wrong version', wire => ({ ...reply(wire, null), schemaVersion: '2.0.0' })],
])('B15 %s after dispatch preserves protocol failure and unknown effect without retry', async (_name, make) => {
  const h = harness(make);
  const result = await requestResourceOperation('read-observation', read, h.options);
  assert.equal(result.kind, 'protocol-failure');
  assert.equal(result.phase, 'operation');
  assert.equal(result.effect, 'unknown');
  assert.ok(result.error instanceof Error);
  countOperations(h, 1);
});

test('B15 operation response loss preserves its cause and unknown effect without follow-up calls', async () => {
  const error = new Error('response lost; transport does not report write status');
  const h = harness(async () => { throw error; });
  const result = await requestResourceOperation('commit-reservation', commit, h.options);
  assert.equal(result.kind, 'transport-failure');
  assert.equal(result.phase, 'operation');
  assert.equal(result.effect, 'unknown');
  assert.equal(result.error, error);
  countOperations(h, 1);
});

test.each([-1, 0, 1])('B15 expiry offset %i classifies only a bound, shaped receipt as stale', async offset => {
  const value = { ...receipt, expiresAt: new Date(now + offset).toISOString() };
  const h = harness(wire => reply(wire, value));
  const result = await requestResourceOperation('issue-receipt', { reservationId: 'reservation-1' }, h.options);
  assert.equal(result.kind, offset <= 0 ? 'stale-receipt' : 'resource-result');
  if (offset <= 0) assert.equal(result.effect, 'unknown');
  else assert.deepEqual(result.result, value); // Shape and expiry are not MAC/lease authentication.
  countOperations(h, 1);
});

test.each([
  wire => reply(wire, { ...receipt, expiresAt: 'invalid' }),
  wire => reply(wire, { ...receipt, expiresAt: new Date(now).toISOString(), reservationId: 'other' }),
  wire => ({ ...reply(wire, { ...receipt, expiresAt: new Date(now).toISOString() }), requestId: 'other' }),
])('B15 malformed or unbound expired receipt is protocol failure, never stale: %#', async make => {
  const h = harness(make);
  const result = await requestResourceOperation('issue-receipt', { reservationId: 'reservation-1' }, h.options);
  assert.equal(result.kind, 'protocol-failure');
  assert.equal(result.effect, 'unknown');
  countOperations(h, 1);
});

test('B15 timeout during ping never invokes an operation, even if transport ignores abort', async () => {
  const time = fakeTime();
  const h = harness(undefined, () => new Promise(() => {}));
  const pending = requestResourceOperation('read-observation', read, h.options);
  await time.advance(100);
  const result = await pending;
  assert.equal(result.kind, 'timeout');
  assert.equal(result.phase, 'negotiation');
  assert.equal(result.effect, 'not-invoked');
  assert.equal(h.calls[0].signal.aborted, true);
  countOperations(h, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test('B15 ping consumes the shared deadline; a late operation stays unknown and is never retried', async () => {
  const time = fakeTime();
  const h = harness(() => new Promise(() => {}), async () => {
    await new Promise(resolve => globalThis.setTimeout(resolve, 60));
    return ping;
  });
  const pending = requestResourceOperation('commit-reservation', commit, h.options);
  await time.advance(60);
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls[1].remainingMs <= 40);
  await time.advance(40);
  const result = await pending;
  assert.equal(result.kind, 'timeout');
  assert.equal(result.phase, 'operation');
  assert.equal(result.effect, 'unknown');
  countOperations(h, 1);
  assert.equal(vi.getTimerCount(), 0);
});

test('B15 deadline exhausted by ping is timeout with zero operation calls', async () => {
  const time = fakeTime();
  const h = harness(undefined, async () => {
    // Move monotonic time past the deadline without firing timers first.
    time.elapse(100);
    return ping;
  });
  const result = await requestResourceOperation('read-observation', read, h.options);
  vi.restoreAllMocks();
  assert.equal(result.kind, 'timeout');
  assert.equal(result.phase, 'negotiation');
  assert.equal(result.effect, 'not-invoked');
  countOperations(h, 0);
  assert.equal(vi.getTimerCount(), 0);
});

test('B15 snapshots validated args before ping so async caller mutation cannot add authority fields', async () => {
  const args = { ...read };
  const h = harness(undefined, async () => { args.authorityId = 'forged'; args.observationId = 'bad'; return ping; });
  const result = await requestResourceOperation('read-observation', args, h.options);
  assert.equal(result.kind, 'resource-result');
  assert.deepEqual(h.calls[1].payload.args, read);
  countOperations(h, 1);
});

test.each([0, -1, NaN, Infinity])('B15 invalid timeout %s cannot invoke transport', async timeoutMs => {
  const h = harness();
  const result = await requestResourceOperation('read-observation', read, { ...h.options, timeoutMs });
  assert.equal(result.kind, 'invalid-request');
  assert.equal(result.effect, 'not-invoked');
  assert.equal(h.calls.length, 0);
});
