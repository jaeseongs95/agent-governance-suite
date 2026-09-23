import assert from 'node:assert/strict';
import { test } from 'vitest';

import { applyCheckpointDelta } from '../../../mcp-server/src/artifacts/apply-checkpoint-delta.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';

const receiver = { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' };
const expected = { taskId: 'task-1', revision: 2, receiver, contextGeneration: 3, sequence: 1 };
const statusSet = { op: 'set', path: '/status', value: 'paused' };
const progressSet = { op: 'set', path: '/core/progress', value: ['첫째', '둘째'] };

function checkpoint() {
  const value = {
    schemaVersion: '1.0.0', source: 'direct', taskCorrelation: 'task-1', epoch: 1, revision: 2,
    status: 'active', core: { objective: '원래 목표', completionCriteria: ['검증'], constraints: [],
      decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
    createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
  };
  return { ...value, snapshotDigest: convergenceDigest(value) };
}

function delta(base, operations = [statusSet, progressSet]) {
  const { snapshotDigest, ...target } = structuredClone(base);
  for (const operation of operations) {
    const [, first, second] = operation.path.split('/');
    if (second) target[first][second] = structuredClone(operation.value);
    else target[first] = structuredClone(operation.value);
  }
  return { schemaVersion: '1.0.0', taskId: expected.taskId, revision: expected.revision,
    receiver, contextGeneration: expected.contextGeneration, sequence: expected.sequence,
    baseCheckpointDigest: snapshotDigest, targetCheckpointDigest: convergenceDigest(target), operations };
}

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

test('A07-a applies independent sets deterministically without mutating the base or delta', () => {
  const base = freeze(checkpoint());
  const first = freeze(delta(base));
  const second = freeze(delta(base, [progressSet, statusSet]));
  const result = applyCheckpointDelta(base, first, expected);
  const reversed = applyCheckpointDelta(base, second, expected);
  assert.deepEqual(result, reversed);
  assert.equal(result.snapshotDigest, first.targetCheckpointDigest);
  assert.equal(result.status, 'paused');
  assert.deepEqual(result.core.progress, ['첫째', '둘째']);
  assert.deepEqual(base.core.progress, []);
  result.core.progress.push('later');
  assert.deepEqual(base.core.progress, []);
  assert.deepEqual(first.operations[1].value, ['첫째', '둘째']);
});

test('A07-a binds array order and rejects an incorrect base or target digest', () => {
  const base = checkpoint();
  const valid = delta(base);
  const reordered = delta(base, [statusSet, { ...progressSet, value: ['둘째', '첫째'] }]);
  assert.notEqual(valid.targetCheckpointDigest, reordered.targetCheckpointDigest);
  assert.throws(() => applyCheckpointDelta(base,
    { ...valid, targetCheckpointDigest: reordered.targetCheckpointDigest }, expected),
  { code: 'INTEGRITY_FAILED' });
  assert.throws(() => applyCheckpointDelta({ ...base, status: 'paused' }, valid, expected),
    { code: 'INTEGRITY_FAILED' });
  assert.throws(() => applyCheckpointDelta(base,
    { ...valid, baseCheckpointDigest: reordered.targetCheckpointDigest }, expected),
  { code: 'INTEGRITY_FAILED' });
});

test('A07-a rejects invalid base/target schema and disallowed or duplicate operations', () => {
  const base = checkpoint();
  const valid = delta(base);
  assert.throws(() => applyCheckpointDelta({ ...base, core: { ...base.core, objective: null } }, valid, expected),
    { code: 'INVALID_INPUT' });
  assert.throws(() => applyCheckpointDelta({ ...base, extra: true }, valid, expected), { code: 'INVALID_INPUT' });
  for (const operations of [
    [statusSet, statusSet],
    [{ op: 'remove', path: '/core/objective' }],
    [{ op: 'set', path: '/core/progress/0', value: 'changed' }],
    [{ op: 'set', path: '/core/objective', value: null }],
    [{ op: 'set', path: '/evidenceRefs', value: [{ artifactId: 'id' }] }],
  ]) assert.throws(() => applyCheckpointDelta(base, { ...valid, operations }, expected), { code: 'INVALID_INPUT' });
});

test('A07-a rejects receiver, sequence, generation, task and revision mismatch', () => {
  const base = checkpoint();
  const valid = delta(base);
  for (const changed of [
    { receiver: { ...receiver, instanceId: 'instance-2' } },
    { sequence: 2 }, { contextGeneration: 4 }, { taskId: 'task-2' }, { revision: 3 },
  ]) assert.throws(() => applyCheckpointDelta(base, { ...valid, ...changed }, expected), { code: 'GATE_FAILED' });
  assert.throws(() => applyCheckpointDelta({ ...base, taskCorrelation: 'task-2' }, valid, expected),
    { code: 'GATE_FAILED' });
});
