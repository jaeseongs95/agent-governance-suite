import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { CheckpointDeltaReceiver } from '../../../mcp-server/src/artifacts/delta-receiver.ts';
import { CheckpointDeltaResync } from '../../../mcp-server/src/artifacts/delta-resync.ts';
import { ArtifactReferenceAccess } from '../../../mcp-server/src/artifacts/reference-access.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { SqliteContinuityStore } from '../../../mcp-server/src/continuity-store.ts';

const bytes = Buffer.from('authorized artifact bytes');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ref = (namespace = 'task') => ({
  schemaVersion: '1.0.0', namespace, id: 'artifact-1', digest,
  hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/octet-stream',
});
const principal = { workspaceId: 'workspace-1', taskId: 'task-1' };
const objectPath = (root, namespace = 'task') => path.join(root, 'objects', namespace, digest.slice(7, 9), digest.slice(7));

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a03-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('A03 binds task/workspace ACL to the complete reference and namespace', async () => isolated(async root => {
  const store = new RawContentStore(root);
  await store.put(ref(), bytes);
  await store.put(ref('workspace'), bytes);
  const access = new ArtifactReferenceAccess(root, principal, [
    { ref: ref(), workspaceId: 'workspace-1', taskId: 'task-1' },
    { ref: ref('workspace'), workspaceId: 'workspace-1' },
  ]);
  assert.deepEqual(await access.read(ref()), bytes);
  assert.deepEqual(await access.read(ref('workspace')), bytes);
  const otherTask = new ArtifactReferenceAccess(root, { ...principal, taskId: 'task-2' }, [{ ref: ref(), ...principal }]);
  const otherWorkspace = new ArtifactReferenceAccess(root, { ...principal, workspaceId: 'workspace-2' }, [{ ref: ref(), ...principal }]);
  await assert.rejects(() => otherTask.read(ref()), { code: 'GATE_FAILED' });
  await assert.rejects(() => otherWorkspace.read(ref()), { code: 'GATE_FAILED' });
  await assert.rejects(() => otherWorkspace.read(ref('workspace')), { code: 'GATE_FAILED' });
  assert.throws(() => new ArtifactReferenceAccess(root, principal, [{ ref: ref(), workspaceId: 'workspace-1' }]), { code: 'INVALID_INPUT' });
  const taskOnly = new ArtifactReferenceAccess(root, principal, [{ ref: ref(), workspaceId: 'workspace-1', taskId: 'task-1' }]);
  await assert.rejects(() => taskOnly.read(ref('workspace')), { code: 'GATE_FAILED' });
  await assert.rejects(() => access.read({ ...ref(), id: 'other' }), { code: 'GATE_FAILED' });
  await assert.rejects(() => access.read({ ...ref(), mediaType: 'text/plain' }), { code: 'GATE_FAILED' });
}));

test('A03 rejects caller authority claims, URL roots, and traversal references', async () => isolated(async root => {
  const access = new ArtifactReferenceAccess(root, principal, [{ ref: ref(), ...principal }]);
  assert.throws(() => new ArtifactReferenceAccess('https://example.test/object', principal, []), { code: 'INVALID_INPUT' });
  await assert.rejects(() => access.read({ ...ref(), verified: true }), { code: 'INVALID_INPUT' });
  await assert.rejects(() => access.read({ ...ref(), id: '../outside' }), { code: 'INVALID_INPUT' });
  await assert.rejects(() => access.read({ ...ref(), namespace: 'https://example.test' }), { code: 'INVALID_INPUT' });
}));

test('A03 rejects a replacement between path check and open, even with identical bytes', async () => isolated(async root => {
  await new RawContentStore(root).put(ref(), bytes);
  const replacement = path.join(root, 'replacement');
  await writeFile(replacement, bytes);
  class SwappingAccess extends ArtifactReferenceAccess {
    async afterPathCheck() {
      await rename(objectPath(root), path.join(root, 'original'));
      await link(replacement, objectPath(root));
    }
  }
  const access = new SwappingAccess(root, principal, [{ ref: ref(), ...principal }]);
  await assert.rejects(() => access.read(ref()), { code: 'INTEGRITY_FAILED' });
}));

test('A03 rejects replacement of a checked parent directory', async () => isolated(async root => {
  await new RawContentStore(root).put(ref(), bytes);
  const originalDirectory = path.dirname(objectPath(root));
  class SwappingDirectoryAccess extends ArtifactReferenceAccess {
    async afterPathCheck() {
      await rename(originalDirectory, path.join(root, 'original-directory'));
      await mkdir(originalDirectory);
      await writeFile(objectPath(root), bytes);
    }
  }
  const access = new SwappingDirectoryAccess(root, principal, [{ ref: ref(), ...principal }]);
  await assert.rejects(() => access.read(ref()), { code: 'INTEGRITY_FAILED' });
}));

test('A03 rejects a symlink and readback byte mismatch', async () => isolated(async root => {
  await new RawContentStore(root).put(ref(), bytes);
  const access = new ArtifactReferenceAccess(root, principal, [{ ref: ref(), ...principal }]);
  await writeFile(objectPath(root), Buffer.from('corrupt'));
  await assert.rejects(() => access.read(ref()), { code: 'INTEGRITY_FAILED' });
  await rm(objectPath(root));
  try {
    await symlink(path.join(root, 'outside'), objectPath(root), 'file');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES') return; // Windows without symlink privilege.
    throw error;
  }
  await assert.rejects(() => access.read(ref()), { code: 'INTEGRITY_FAILED' });
}));

test('A03 HMAC scope permits authorized resync and durable delta ACK without crossing task or receiver boundaries', async () => isolated(async root => {
  const taskId = `hmac-sha256:${'a'.repeat(64)}`;
  const otherTaskId = `hmac-sha256:${'b'.repeat(64)}`;
  const scope = { taskId, epoch: 1,
    receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' }, contextGeneration: 3 };
  const now = '2026-09-23T00:00:00.000Z';
  const content = { schemaVersion: '1.0.0', source: 'direct', taskCorrelation: taskId,
    epoch: 1, revision: 1, status: 'active', core: { objective: '목표', completionCriteria: ['완료'],
      constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [],
    createdAt: now, updatedAt: now };
  const snapshot = { ...content, snapshotDigest: convergenceDigest(content) };
  const checkpointBytes = Buffer.from(JSON.stringify(snapshot), 'utf8');
  const checkpointDigest = `sha256:${createHash('sha256').update(checkpointBytes).digest('hex')}`;
  const checkpointRef = { schemaVersion: '1.0.0', namespace: 'task', id: 'checkpoint-hmac',
    digest: checkpointDigest, hashDomain: 'raw-bytes', size: checkpointBytes.length, mediaType: 'application/json' };
  await new RawContentStore(root).put(checkpointRef, checkpointBytes);
  const grant = { ref: checkpointRef, workspaceId: 'workspace-1', taskId };
  const access = new ArtifactReferenceAccess(root, { workspaceId: 'workspace-1', taskId }, [grant]);
  for (const principal of [{ workspaceId: 'workspace-1', taskId: otherTaskId },
    { workspaceId: 'workspace-2', taskId }]) {
    await assert.rejects(() => new ArtifactReferenceAccess(root, principal, [grant]).read(checkpointRef),
      { code: 'GATE_FAILED' });
  }
  for (const invalid of [`hmac-sha256:${'A'.repeat(64)}`, `hmac-sha256:${'a'.repeat(63)}`,
    `hmac-sha256:${'g'.repeat(64)}`, `hmac-sha256:${'a'.repeat(64)}:extra`]) {
    assert.throws(() => new ArtifactReferenceAccess(root, { workspaceId: 'workspace-1', taskId: invalid }, [grant]),
      { code: 'INVALID_INPUT' });
    assert.throws(() => new ArtifactReferenceAccess(root, { workspaceId: 'workspace-1', taskId },
      [{ ...grant, taskId: invalid }]), { code: 'INVALID_INPUT' });
  }
  assert.throws(() => new ArtifactReferenceAccess(root, { workspaceId: `hmac-sha256:${'a'.repeat(64)}`, taskId },
    [grant]), { code: 'INVALID_INPUT' });

  const gate = new CheckpointDeltaResync(access, scope, snapshot.snapshotDigest);
  assert.deepEqual(await gate.resume(checkpointRef), snapshot);
  const target = { ...content, status: 'paused' };
  const delta = { schemaVersion: '1.0.0', taskId, revision: 1, receiver: scope.receiver,
    contextGeneration: 3, sequence: 1, baseCheckpointDigest: snapshot.snapshotDigest,
    targetCheckpointDigest: convergenceDigest(target),
    operations: [{ op: 'set', path: '/status', value: 'paused' }] };
  assert.deepEqual(gate.baseForDelta(delta), snapshot);
  assert.equal(gate.baseForDelta({ ...delta, taskId: otherTaskId }), null);
  for (const [field, replacement] of [['host', 'claude-code'], ['sessionId', 'session-2'],
    ['instanceId', 'instance-2']]) {
    assert.equal(gate.baseForDelta({ ...delta, receiver: { ...scope.receiver, [field]: replacement } }), null);
  }
  assert.equal(gate.baseForDelta({ ...delta, contextGeneration: 4 }), null);

  const store = new SqliteContinuityStore(':memory:');
  try {
    store.ensureTask(taskId, now);
    assert.deepEqual(store.checkpoint(taskId, 1, 0, 'initial', 'initial-command', snapshot), { kind: 'stored' });
    const receiver = new CheckpointDeltaReceiver(store, scope);
    assert.equal(receiver.bind(), true);
    assert.deepEqual(receiver.receive({ ...delta, taskId: otherTaskId }), { kind: 'receiver-mismatch' });
    for (const [field, replacement] of [['host', 'claude-code'], ['sessionId', 'session-2'],
      ['instanceId', 'instance-2']]) {
      assert.deepEqual(receiver.receive({ ...delta, receiver: { ...scope.receiver, [field]: replacement } }),
        { kind: 'receiver-mismatch' });
    }
    assert.deepEqual(receiver.receive({ ...delta, contextGeneration: 4 }), { kind: 'receiver-mismatch' });
    const applied = receiver.receive(delta);
    assert.equal(applied.kind, 'applied');
    assert.equal(applied.ack.taskId, taskId);
    assert.equal(applied.ack.targetCheckpointDigest, delta.targetCheckpointDigest);
    assert.deepEqual(store.getDeltaState(taskId, 1).ack, applied.ack);
    assert.deepEqual(receiver.receive(delta), { kind: 'replay', ack: applied.ack });
  } finally { store.close(); }
}));
