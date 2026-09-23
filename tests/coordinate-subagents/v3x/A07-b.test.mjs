import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { CheckpointDeltaReceiver } from '../../../mcp-server/src/artifacts/delta-receiver.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { SqliteContinuityStore } from '../../../mcp-server/src/continuity-store.ts';

const now = '2026-09-23T00:00:00.000Z';
const scope = { taskId: `hmac-sha256:${'a'.repeat(64)}`, epoch: 1,
  receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' }, contextGeneration: 3 };
const operation = { op: 'set', path: '/core/progress', value: ['보존된 진전'] };

function initialSnapshot() {
  const content = { schemaVersion: '1.0.0', source: 'direct', taskCorrelation: scope.taskId,
    epoch: 1, revision: 1, status: 'active', core: { objective: '목표', completionCriteria: ['완료'],
      constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
    createdAt: now, updatedAt: now };
  return { ...content, snapshotDigest: convergenceDigest(content) };
}

function nextDelta(base, sequence = 1, operations = [operation]) {
  const { snapshotDigest, ...content } = structuredClone(base);
  for (const item of operations) {
    const [, first, second] = item.path.split('/');
    if (second) content[first][second] = structuredClone(item.value);
    else content[first] = structuredClone(item.value);
  }
  return { schemaVersion: '1.0.0', taskId: scope.taskId, revision: base.revision,
    receiver: scope.receiver, contextGeneration: scope.contextGeneration, sequence,
    baseCheckpointDigest: snapshotDigest, targetCheckpointDigest: convergenceDigest(content), operations };
}

function preparedStore(databasePath = ':memory:', base = initialSnapshot()) {
  const store = new SqliteContinuityStore(databasePath);
  store.ensureTask(scope.taskId, now);
  assert.deepEqual(store.checkpoint(scope.taskId, scope.epoch, 0, 'initial', 'initial-command', base),
    { kind: 'stored' });
  const receiver = new CheckpointDeltaReceiver(store, scope);
  assert.equal(receiver.bind(), true);
  return { store, receiver, base };
}

test('A07-b commits target and state ACK together, then replays the same ACK after loss', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-a07b-'));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const { store, receiver, base } = preparedStore(databasePath);
  let second;
  try {
    second = new SqliteContinuityStore(databasePath);
    const delta = nextDelta(base);
    const first = receiver.receive(delta);
    assert.equal(first.kind, 'applied');
    assert.equal(first.ack.kind, 'checkpoint-delta-state');
    assert.equal(first.ack.targetCheckpointDigest, delta.targetCheckpointDigest);
    const current = second.getDeltaState(scope.taskId, scope.epoch);
    assert.equal(current.sequence, 1);
    assert.equal(current.checkpoint.snapshotDigest, delta.targetCheckpointDigest);
    assert.deepEqual(current.ack, first.ack);
    assert.equal(second.getSnapshot(scope.taskId, scope.epoch).snapshotDigest, base.snapshotDigest);
    assert.equal(receiver.bind(), true);
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 1);
    const retry = new CheckpointDeltaReceiver(second, scope).receive(delta);
    assert.deepEqual(retry, { kind: 'replay', ack: first.ack });
    const next = nextDelta(current.checkpoint, 2, [{ op: 'set', path: '/status', value: 'paused' }]);
    assert.equal(new CheckpointDeltaReceiver(second, scope).receive(next).kind, 'applied');
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 2);
    assert.equal(store.bindRoot(scope.taskId, scope.epoch, 'workflow-root', now), true);
    assert.equal(receiver.receive(next).kind, 'replay');
  } finally {
    second?.close(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('A07-b leaves target and ACK unchanged on invalid target, stale base or out-of-order sequence', () => {
  const { store, receiver, base } = preparedStore();
  try {
    const valid = nextDelta(base);
    assert.throws(() => receiver.receive({ ...valid, targetCheckpointDigest: base.snapshotDigest }));
    assert.deepEqual(store.getDeltaState(scope.taskId, scope.epoch), {
      receiver: scope.receiver, contextGeneration: 3, sequence: 0, checkpoint: base, ack: null,
    });
    assert.deepEqual(receiver.receive({ ...valid, baseCheckpointDigest: valid.targetCheckpointDigest }), { kind: 'stale' });
    assert.deepEqual(receiver.receive({ ...valid, sequence: 2 }), { kind: 'out-of-order' });
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 0);
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).ack, null);
  } finally { store.close(); }
});

test('A07-b permits one winner across two connections and preserves the winner after a failed contender', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-a07b-contend-'));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const { store: first, receiver: firstReceiver, base } = preparedStore(databasePath);
  const second = new SqliteContinuityStore(databasePath);
  const secondReceiver = new CheckpointDeltaReceiver(second, scope);
  try {
    assert.equal(secondReceiver.bind(), true);
    const winner = nextDelta(base);
    const loser = nextDelta(base, 1, [{ op: 'set', path: '/status', value: 'paused' }]);
    assert.equal(firstReceiver.receive(winner).kind, 'applied');
    assert.deepEqual(secondReceiver.receive(loser), { kind: 'out-of-order' });
    assert.equal(first.getDeltaState(scope.taskId, scope.epoch).sequence, 1);
    assert.equal(second.getDeltaState(scope.taskId, scope.epoch).checkpoint.snapshotDigest,
      winner.targetCheckpointDigest);
    assert.equal(first.getDeltaState(scope.taskId, scope.epoch).ack.targetCheckpointDigest,
      winner.targetCheckpointDigest);

    const current = second.getDeltaState(scope.taskId, scope.epoch).checkpoint;
    const valid = nextDelta(current, 2, [{ op: 'set', path: '/status', value: 'paused' }]);
    assert.throws(() => firstReceiver.receive({ ...valid, targetCheckpointDigest: base.snapshotDigest }));
    assert.equal(secondReceiver.receive(valid).kind, 'applied');
    assert.equal(first.getDeltaState(scope.taskId, scope.epoch).sequence, 2);
    assert.equal(first.getDeltaState(scope.taskId, scope.epoch).ack.targetCheckpointDigest,
      valid.targetCheckpointDigest);
  } finally {
    second.close(); first.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('A07-b rejects changed receiver, generation, duplicate conflict and transport ACK', () => {
  const { store, receiver, base } = preparedStore();
  try {
    const valid = nextDelta(base);
    for (const changed of [
      { receiver: { ...scope.receiver, instanceId: 'other' } }, { contextGeneration: 4 },
    ]) assert.deepEqual(receiver.receive({ ...valid, ...changed }), { kind: 'receiver-mismatch' });
    assert.throws(() => receiver.receive({ schemaVersion: '1.0.0', kind: 'checkpoint-delta-transport',
      deliveryId: 'delivery-1', receiver: scope.receiver }), { code: 'INVALID_INPUT' });
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 0);
    assert.equal(receiver.receive(valid).kind, 'applied');
    const conflicting = { ...valid, description: 'different request' };
    assert.deepEqual(receiver.receive(conflicting), { kind: 'out-of-order' });
    const newScope = { ...scope, contextGeneration: 4 };
    const newReceiver = new CheckpointDeltaReceiver(store, newScope);
    assert.equal(newReceiver.bind(), true);
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 0);
    assert.deepEqual(receiver.receive(valid), { kind: 'receiver-mismatch' });
  } finally { store.close(); }
});

test('A07-b rolls back both target and ACK when the storage CAS write fails', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-a07b-fail-'));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const { store, receiver, base } = preparedStore(databasePath);
  const interference = new DatabaseSync(databasePath);
  try {
    interference.exec(`CREATE TRIGGER reject_delta BEFORE UPDATE ON continuity_delta_state
      BEGIN SELECT RAISE(ABORT, 'forced CAS write failure'); END;`);
    assert.throws(() => receiver.receive(nextDelta(base)));
    const state = store.getDeltaState(scope.taskId, scope.epoch);
    assert.equal(state.sequence, 0);
    assert.equal(state.checkpoint.snapshotDigest, base.snapshotDigest);
    assert.equal(state.ack, null);
    assert.equal(store.getSnapshot(scope.taskId, scope.epoch).snapshotDigest, base.snapshotDigest);
  } finally {
    interference.close(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('A07-b refuses a delta after the source continuity checkpoint changes', () => {
  const { store, receiver, base } = preparedStore();
  try {
    const valid = nextDelta(base);
    const changed = structuredClone(base);
    delete changed.snapshotDigest;
    changed.revision = 2;
    changed.updatedAt = '2026-09-23T00:01:00.000Z';
    const newer = { ...changed, snapshotDigest: convergenceDigest(changed) };
    assert.deepEqual(store.checkpoint(scope.taskId, scope.epoch, 1, 'newer', 'newer-command', newer),
      { kind: 'stored' });
    assert.deepEqual(receiver.receive(valid), { kind: 'stale' });
    const state = store.getDeltaState(scope.taskId, scope.epoch);
    assert.equal(state.sequence, 0);
    assert.equal(state.ack, null);
  } finally { store.close(); }
});

test('A07-b returns the committed ACK on retry after the source changes', () => {
  const { store, receiver, base } = preparedStore();
  try {
    const valid = nextDelta(base);
    const first = receiver.receive(valid);
    assert.equal(first.kind, 'applied');
    const changed = structuredClone(base);
    delete changed.snapshotDigest;
    changed.revision = 2;
    changed.updatedAt = '2026-09-23T00:01:00.000Z';
    const newer = { ...changed, snapshotDigest: convergenceDigest(changed) };
    assert.equal(store.checkpoint(scope.taskId, scope.epoch, 1, 'newer', 'newer-command', newer).kind, 'stored');
    assert.deepEqual(receiver.receive(valid), { kind: 'replay', ack: first.ack });
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 1);
  } finally { store.close(); }
});

test('A07-b protects receiver state from cleanup until an epoch transition', () => {
  const initial = initialSnapshot();
  const content = structuredClone(initial);
  delete content.snapshotDigest;
  content.status = 'paused';
  const base = { ...content, snapshotDigest: convergenceDigest(content) };
  const { store } = preparedStore(':memory:', base);
  try {
    const preview = store.previewCleanup('2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z');
    assert.deepEqual(preview.snapshots, []);
    assert.deepEqual(preview.tasks, []);
    assert.ok(preview.protectedActiveTasks > 0);
    store.rotateEpoch(scope.taskId, '2026-09-23T00:01:00.000Z');
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch), null);
  } finally { store.close(); }
});

test('A07-b does not replay a damaged stored ACK', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-a07b-ack-'));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const { store, receiver, base } = preparedStore(databasePath);
  const direct = new DatabaseSync(databasePath);
  try {
    const delta = nextDelta(base);
    assert.equal(receiver.receive(delta).kind, 'applied');
    direct.prepare('UPDATE continuity_delta_state SET state_ack_json = ? WHERE task_correlation = ?')
      .run('{"kind":"checkpoint-delta-state"}', scope.taskId);
    assert.throws(() => receiver.receive(delta));
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 1);
  } finally {
    direct.close(); store.close(); await rm(directory, { recursive: true, force: true });
  }
});

test('A07-b refuses delta writes after a workflow root takes ownership', () => {
  const { store, receiver, base } = preparedStore();
  try {
    assert.equal(store.bindRoot(scope.taskId, scope.epoch, 'workflow-root', now), true);
    assert.deepEqual(receiver.receive(nextDelta(base)), { kind: 'stale' });
    assert.equal(store.getDeltaState(scope.taskId, scope.epoch).sequence, 0);
  } finally { store.close(); }
});

test('A07-b migrates an existing continuity database without replacing its checkpoint', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'ags-a07b-migrate-'));
  const databasePath = path.join(directory, 'continuity.sqlite3');
  const { store, base } = preparedStore(databasePath);
  store.close();
  const legacy = new DatabaseSync(databasePath);
  legacy.exec('DROP TABLE continuity_delta_state; PRAGMA user_version = 2;');
  legacy.close();
  let migrated;
  try {
    migrated = new SqliteContinuityStore(databasePath);
    assert.equal(migrated.getSchemaVersion(), 3);
    assert.deepEqual(migrated.getSnapshot(scope.taskId, scope.epoch), base);
    const receiver = new CheckpointDeltaReceiver(migrated, scope);
    assert.equal(receiver.bind(), true);
    assert.equal(receiver.receive(nextDelta(base)).kind, 'applied');
  } finally {
    migrated?.close(); await rm(directory, { recursive: true, force: true });
  }
});
