import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { applyCheckpointDelta } from '../../../mcp-server/src/artifacts/apply-checkpoint-delta.ts';
import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { CheckpointDeltaResync } from '../../../mcp-server/src/artifacts/delta-resync.ts';
import { ArtifactReferenceAccess } from '../../../mcp-server/src/artifacts/reference-access.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';

const scope = { taskId: 'task-1', epoch: 1,
  receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' }, contextGeneration: 3 };
const now = '2026-09-23T00:00:00.000Z';

function snapshot(status = 'active') {
  const content = { schemaVersion: '1.0.0', source: 'direct', taskCorrelation: scope.taskId,
    epoch: 1, revision: 1, status, core: { objective: '목표', completionCriteria: ['완료'],
      constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
    createdAt: now, updatedAt: now };
  return { ...content, snapshotDigest: convergenceDigest(content) };
}

function delta(base, receiverScope, status = 'paused') {
  const target = { ...base, status };
  delete target.snapshotDigest;
  return { schemaVersion: '1.0.0', taskId: receiverScope.taskId, revision: base.revision,
    receiver: receiverScope.receiver, contextGeneration: receiverScope.contextGeneration, sequence: 1,
    baseCheckpointDigest: base.snapshotDigest, targetCheckpointDigest: convergenceDigest(target),
    operations: [{ op: 'set', path: '/status', value: status }] };
}

async function published(root, value) {
  const bytes = Buffer.from(JSON.stringify(value), 'utf8');
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const ref = { schemaVersion: '1.0.0', namespace: 'task', id: `checkpoint-${digest.slice(7)}`,
    digest, hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' };
  await new RawContentStore(root).put(ref, bytes);
  return ref;
}

function access(root, refs) {
  return new ArtifactReferenceAccess(root, { workspaceId: 'workspace-1', taskId: scope.taskId },
    refs.map((ref) => ({ ref, workspaceId: 'workspace-1', taskId: scope.taskId })));
}

test('A08 blocks delta until an authorized full checkpoint is read and reproduces the target', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a08-'));
  try {
    const base = snapshot();
    const ref = await published(root, base);
    const gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest);
    const command = delta(base, scope);
    assert.equal(gate.status, 'resync-required');
    assert.equal(gate.baseForDelta(command), null);
    await gate.resume(ref);
    assert.equal(gate.status, 'ready');
    assert.deepEqual(await gate.resume(ref), base);
    const recovered = gate.baseForDelta(command);
    assert.deepEqual(recovered, base);
    const target = applyCheckpointDelta(recovered, command, { ...scope, revision: base.revision, sequence: 1 });
    assert.equal(target.snapshotDigest, command.targetCheckpointDigest);
    assert.equal(target.status, 'paused');
    recovered.core.objective = 'mutated by caller';
    assert.equal(gate.baseForDelta(command).core.objective, '목표');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('A08 revokes old instance and same-session generation, without inheriting old ACK', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a08-receiver-'));
  try {
    const base = snapshot();
    const ref = await published(root, base);
    const gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest);
    await gate.resume(ref);
    const oldDelta = delta(base, scope);
    const oldAck = { schemaVersion: '1.0.0', kind: 'checkpoint-delta-state', taskId: scope.taskId,
      revision: 1, receiver: scope.receiver, contextGeneration: scope.contextGeneration, sequence: 1,
      targetCheckpointDigest: oldDelta.targetCheckpointDigest };
    const newInstance = { ...scope, receiver: { ...scope.receiver, instanceId: 'instance-2' } };
    assert.throws(() => gate.changeReceiver(newInstance, 'invalid'), { code: 'INVALID_INPUT' });
    assert.equal(gate.baseForDelta(delta(base, newInstance)), null);
    gate.changeReceiver(newInstance, base.snapshotDigest);
    assert.equal(gate.status, 'resync-required');
    assert.equal(gate.baseForDelta(oldDelta), null);
    assert.equal(gate.baseForDelta(oldAck), null);
    await gate.resume(ref);
    assert.equal(gate.baseForDelta(oldDelta), null);
    assert.deepEqual(gate.baseForDelta(delta(base, newInstance)), base);

    const nextGeneration = { ...newInstance, contextGeneration: 4 };
    gate.changeReceiver(nextGeneration, base.snapshotDigest);
    assert.equal(gate.baseForDelta(delta(base, newInstance)), null);
    await gate.resume(ref);
    assert.equal(gate.baseForDelta(delta(base, newInstance)), null);
    assert.deepEqual(gate.baseForDelta(delta(base, nextGeneration)), base);
    gate.loseBase(base.snapshotDigest);
    assert.equal(gate.baseForDelta(delta(base, nextGeneration)), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('A08 rejects denied references and a target that changes during an authorized read', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a08-race-'));
  try {
    const first = snapshot();
    const second = snapshot('paused');
    const firstRef = await published(root, first);
    const secondRef = await published(root, second);
    const denied = new CheckpointDeltaResync(access(root, [secondRef]), scope, first.snapshotDigest);
    await assert.rejects(denied.resume(firstRef), { code: 'GATE_FAILED' });
    assert.equal(denied.status, 'resync-required');

    let release;
    let entered;
    const enteredRead = new Promise((resolve) => { entered = resolve; });
    const hold = new Promise((resolve) => { release = resolve; });
    class HeldAccess extends ArtifactReferenceAccess {
      async read(ref) {
        const bytes = await super.read(ref);
        entered();
        await hold;
        return bytes;
      }
    }
    const grants = [firstRef, secondRef].map((ref) => ({ ref, workspaceId: 'workspace-1', taskId: scope.taskId }));
    const checked = new HeldAccess(root, { workspaceId: 'workspace-1', taskId: scope.taskId }, grants);
    const gate = new CheckpointDeltaResync(checked, scope, first.snapshotDigest);
    const pending = gate.resume(firstRef);
    await enteredRead;
    gate.targetChanged(second.snapshotDigest);
    release();
    await assert.rejects(pending, { code: 'GATE_FAILED' });
    assert.equal(gate.status, 'resync-required');
    await assert.rejects(gate.resume(firstRef), { code: 'INTEGRITY_FAILED' });
    assert.deepEqual(await gate.resume(secondRef), second);
    assert.equal(gate.status, 'ready');
    assert.deepEqual(gate.baseForDelta(delta(second, scope, 'completed')), second);
  } finally { await rm(root, { recursive: true, force: true }); }
});
