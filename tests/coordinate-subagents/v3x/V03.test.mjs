import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  ObservationChallengeAuthority, registerHostObservationReader, registerTestObservationReader,
} from '../../../mcp-server/src/host-integration/observation-challenge.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';

const issuedAt = new Date('2026-09-23T00:00:00.000Z');
const observed = () => ({
  binding: {
    invocationId: 'invocation-1', turnId: 'turn-1', taskId: 'task-1', runId: 'run-1',
    attemptId: 'attempt-1', hostId: 'flowmarshal-engine', sessionId: 'session-1', instanceId: 'instance-1',
  },
  observationId: 'host-event-1', observedAt: issuedAt.toISOString(),
  model: 'observed-model', reasoningEffort: 'high',
});

function authority(domain = 'host', store = new InMemoryWorkflowStore()) {
  let current = observed();
  let time = issuedAt;
  const reader = (domain === 'host' ? registerHostObservationReader : registerTestObservationReader)(() => current);
  return {
    challenge: new ObservationChallengeAuthority(store, reader, domain, () => time),
    change(next) { current = next; },
    setTime(next) { time = next; },
    store, reader,
  };
}

test('issues from a host reader, verifies the same invocation, and consumes once', () => {
  const service = authority();
  const { challenge } = service;
  const token = challenge.issue();
  service.setTime(new Date(issuedAt.getTime() + 1));
  const body = challenge.verifyAndConsume(token);
  assert.equal(body.binding.invocationId, 'invocation-1');
  assert.equal(body.model, 'observed-model');
  assert.equal(body.reasoningEffort, 'high');
  assert.equal(body.expiresAt, new Date(issuedAt.getTime() + 60_000).toISOString());
  service.setTime(new Date(issuedAt.getTime() + 2));
  assert.throws(() => challenge.verifyAndConsume(token), /already consumed/);
});

test('separate issuer and verifier instances share a durable one-use claim boundary', () => {
  const store = new InMemoryWorkflowStore();
  const issuer = authority('host', store);
  const verifier = authority('host', store);
  const token = issuer.challenge.issue();
  assert.equal(verifier.challenge.verifyAndConsume(token).binding.turnId, 'turn-1');
  assert.throws(() => issuer.challenge.verifyAndConsume(token), /already consumed/);
});

test.each(['invocationId', 'turnId', 'taskId', 'runId', 'attemptId', 'hostId', 'sessionId', 'instanceId'])(
  'rejects a different %s observed by the verifier', (field) => {
    const service = authority();
    const token = service.challenge.issue();
    service.change({ ...observed(), binding: { ...observed().binding, [field]: `other-${field}` } });
    assert.throws(() => service.challenge.verifyAndConsume(token), /different host invocation/);
  },
);

test('format-valid self-report is not a host reader, and observed model is not caller configuration', () => {
  assert.throws(() => new ObservationChallengeAuthority(new InMemoryWorkflowStore(), { ...observed(), source: 'runtime' }, 'host'), /reader domain mismatch/);
  const service = authority();
  const token = service.challenge.issue();
  service.change({ ...observed(), model: 'requested-model' });
  assert.throws(() => service.challenge.verifyAndConsume(token), /different host invocation/);
  const [prefix, encoded, signature] = token.split('.');
  assert.throws(() => service.challenge.verifyAndConsume(`${prefix}.${encoded[0] === 'A' ? 'B' : 'A'}${encoded.slice(1)}.${signature}`), /signature mismatch/);
});

test('test producer cannot satisfy a host verifier, even with the same store and observation', () => {
  const store = new InMemoryWorkflowStore();
  const testProducer = authority('test', store);
  const hostVerifier = authority('host', store);
  const token = testProducer.challenge.issue();
  assert.throws(() => new ObservationChallengeAuthority(store, testProducer.reader, 'host'), /reader domain mismatch/);
  assert.throws(() => hostVerifier.challenge.verifyAndConsume(token), /signature mismatch/);
  assert.equal(testProducer.challenge.verifyAndConsume(token).domain, 'test');
});

test('rejects expired, stale and future observations', () => {
  const service = authority();
  const token = service.challenge.issue();
  service.setTime(new Date(issuedAt.getTime() + 60_000));
  assert.throws(() => service.challenge.verifyAndConsume(token), /expired/);
  service.setTime(new Date(issuedAt.getTime() + 5 * 60_000 + 1));
  assert.throws(() => service.challenge.issue(), /stale/);
  service.change({ ...observed(), observedAt: new Date(issuedAt.getTime() + 5_001).toISOString() });
  service.setTime(issuedAt);
  assert.throws(() => service.challenge.issue(), /future/);
});
