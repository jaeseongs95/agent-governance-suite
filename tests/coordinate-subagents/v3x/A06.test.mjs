import assert from 'node:assert/strict';
import { test } from 'vitest';

import { CHECKPOINT_DELTA_MAX_BYTES } from '../../../contracts/types.ts';
import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const validator = new ContractValidator();
const receiver = { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' };
const base = {
  schemaVersion: '1.0.0', source: 'direct', taskCorrelation: 'task-1', epoch: 1, revision: 2,
  status: 'active', core: { objective: '원래 목표', completionCriteria: ['검증'], constraints: [],
    decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
  createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
};
const statusSet = { op: 'set', path: '/status', value: 'paused' };
const progressSet = { op: 'set', path: '/core/progress', value: ['첫째', '둘째'] };

function targetFrom(operations) {
  const target = structuredClone(base);
  for (const operation of operations) {
    const [, first, second] = operation.path.split('/');
    if (second) target[first][second] = structuredClone(operation.value);
    else target[first] = structuredClone(operation.value);
  }
  return target;
}

function delta(operations = [statusSet, progressSet]) {
  return { schemaVersion: '1.0.0', taskId: 'task-1', revision: 2, receiver,
    contextGeneration: 3, sequence: 1, baseCheckpointDigest: convergenceDigest(base),
    targetCheckpointDigest: convergenceDigest(targetFrom(operations)), operations,
    description: '변경 근거는 적용 연산과 별개', };
}

test('A06 binds base/target digests and independent set order while preserving array order', () => {
  const forward = delta();
  const reversed = delta([progressSet, statusSet]);
  assert.deepEqual(validator.checkpointDelta(forward), forward);
  assert.deepEqual(validator.checkpointDelta(reversed), reversed);
  assert.equal(forward.baseCheckpointDigest, convergenceDigest(base));
  assert.equal(forward.targetCheckpointDigest, convergenceDigest(targetFrom(forward.operations)));
  assert.equal(reversed.targetCheckpointDigest, forward.targetCheckpointDigest);
  const reorderedArray = delta([statusSet, { ...progressSet, value: ['둘째', '첫째'] }]);
  assert.notEqual(reorderedArray.targetCheckpointDigest, forward.targetCheckpointDigest);
  assert.equal(validator.checkpointDeltaForReceiver(forward, { receiver, contextGeneration: 3 }), forward);
});

test('A06 rejects deletion, arbitrary paths, duplicate fields, null and partial array operations', () => {
  for (const operation of [
    { op: 'remove', path: '/core/objective' },
    { op: 'set', path: '/core/unknown', value: 'bad' },
    { op: 'set', path: '/core/progress/0', value: 'bad' },
    { op: 'append', path: '/core/progress', value: ['bad'] },
    { op: 'set', path: '/core/objective', value: null },
    { op: 'set', path: '/evidenceRefs', value: null },
  ]) assert.throws(() => validator.checkpointDelta({ ...delta(), operations: [operation] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validator.checkpointDelta({ ...delta(), operations: [statusSet, statusSet] }), { code: 'INVALID_INPUT' });
  assert.throws(() => validator.checkpointDelta({ ...delta(), transportAck: true }), { code: 'INVALID_INPUT' });
});

test('A06 enforces UTF-8 bytes and the exact receiver generation', () => {
  const value = delta([{ op: 'set', path: '/core/objective', value: '가' }]);
  let count = 1;
  while (Buffer.byteLength(canonicalJson(value), 'utf8') <= CHECKPOINT_DELTA_MAX_BYTES) {
    value.operations[0].value = '가'.repeat(++count);
  }
  assert.ok(count < 4000);
  assert.throws(() => validator.checkpointDelta(value), { code: 'INVALID_INPUT' });
  value.operations[0].value = '가'.repeat(count - 1);
  assert.ok(Buffer.byteLength(canonicalJson(value), 'utf8') <= CHECKPOINT_DELTA_MAX_BYTES);
  validator.checkpointDelta(value);
  const original = delta();
  assert.throws(() => validator.checkpointDeltaForReceiver(original,
    { receiver: { ...receiver, instanceId: 'instance-2' }, contextGeneration: 3 }), { code: 'GATE_FAILED' });
  assert.throws(() => validator.checkpointDeltaForReceiver(original,
    { receiver, contextGeneration: 4 }), { code: 'GATE_FAILED' });
});

test('A06 state ACK and transport ACK are separate contracts', () => {
  const value = delta();
  const stateAck = { schemaVersion: '1.0.0', kind: 'checkpoint-delta-state', taskId: value.taskId,
    revision: value.revision, receiver, contextGeneration: value.contextGeneration,
    sequence: value.sequence, targetCheckpointDigest: value.targetCheckpointDigest };
  const transportAck = { schemaVersion: '1.0.0', kind: 'checkpoint-delta-transport',
    deliveryId: 'delivery-1', receiver };
  assert.deepEqual(validator.checkpointDeltaStateAck(stateAck), stateAck);
  assert.deepEqual(validator.checkpointDeltaTransportAck(transportAck), transportAck);
  assert.throws(() => validator.checkpointDeltaStateAck(transportAck), { code: 'INVALID_INPUT' });
  assert.throws(() => validator.checkpointDeltaTransportAck(stateAck), { code: 'INVALID_INPUT' });
  assert.throws(() => validator.checkpointDelta(stateAck), { code: 'INVALID_INPUT' });
});

test('A06 rejects unsafe revision, generation and sequence in both delta and state ACK', () => {
  const value = delta();
  const stateAck = { schemaVersion: '1.0.0', kind: 'checkpoint-delta-state', taskId: value.taskId,
    revision: value.revision, receiver, contextGeneration: value.contextGeneration,
    sequence: value.sequence, targetCheckpointDigest: value.targetCheckpointDigest };
  for (const field of ['revision', 'contextGeneration', 'sequence']) {
    validator.checkpointDelta({ ...value, [field]: Number.MAX_SAFE_INTEGER });
    validator.checkpointDeltaStateAck({ ...stateAck, [field]: Number.MAX_SAFE_INTEGER });
    assert.throws(() => validator.checkpointDelta({ ...value, [field]: Number.MAX_SAFE_INTEGER + 1 }),
      { code: 'INVALID_INPUT' });
    assert.throws(() => validator.checkpointDeltaStateAck({ ...stateAck, [field]: Number.MAX_SAFE_INTEGER + 1 }),
      { code: 'INVALID_INPUT' });
  }
  assert.equal(JSON.parse('9007199254740992'), JSON.parse('9007199254740993'));
});
