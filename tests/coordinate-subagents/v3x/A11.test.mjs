import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { CheckpointDeltaResync } from '../../../mcp-server/src/artifacts/delta-resync.ts';
import { ArtifactReferenceAccess } from '../../../mcp-server/src/artifacts/reference-access.ts';
import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';

const scope = { taskId: 'task-1', epoch: 1,
  receiver: { host: 'codex', sessionId: 'session-1', instanceId: 'instance-1' }, contextGeneration: 3 };
const now = '2026-09-23T00:00:00.000Z';

function checkpoint() {
  const content = { schemaVersion: '1.0.0', source: 'direct', taskCorrelation: scope.taskId,
    epoch: scope.epoch, revision: 1, status: 'active', core: { objective: '목표',
      completionCriteria: ['완료'], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
    evidenceRefs: [], createdAt: now, updatedAt: now };
  return { ...content, snapshotDigest: convergenceDigest(content) };
}

function reference(bytes, mediaType = 'application/json') {
  const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  return { schemaVersion: '1.0.0', namespace: 'task', id: `checkpoint-${digest.slice(7)}`,
    digest, hashDomain: 'raw-bytes', size: bytes.length, mediaType };
}

function access(root, refs) {
  return new ArtifactReferenceAccess(root, { workspaceId: 'workspace-1', taskId: scope.taskId },
    refs.map((ref) => ({ ref, workspaceId: 'workspace-1', taskId: scope.taskId })));
}

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a11-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('A11 actual raw reference readback passes verifier before parsing and restores the base', async () => isolated(async root => {
  const base = checkpoint();
  const bytes = Buffer.from(JSON.stringify(base));
  const ref = reference(bytes);
  await new RawContentStore(root).put(ref, bytes);
  let parses = 0;
  const gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest, {
    onParse: () => { parses += 1; },
  });
  const content = structuredClone(base);
  delete content.snapshotDigest;
  const delta = { schemaVersion: '1.0.0', taskId: scope.taskId, revision: base.revision,
    receiver: scope.receiver, contextGeneration: scope.contextGeneration, sequence: 1,
    baseCheckpointDigest: base.snapshotDigest,
    targetCheckpointDigest: convergenceDigest({ ...content, status: 'paused' }),
    operations: [{ op: 'set', path: '/status', value: 'paused' }] };
  assert.equal(gate.baseForDelta(delta), null);
  assert.deepEqual(await gate.resume(ref), base);
  assert.equal(parses, 1);
  assert.deepEqual(gate.baseForDelta(delta), base);
}));

test('A11 actual compressed reference verifies compressed and raw hashes before parse', async () => isolated(async root => {
  const base = checkpoint();
  const raw = Buffer.from(JSON.stringify(base));
  const compressed = gzipSync(raw);
  const ref = reference(compressed, 'application/gzip');
  await new RawContentStore(root).put(ref, compressed);
  const calls = { parse: 0, decompress: 0 };
  const gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest, {
    encoding: 'gzip', raw: { size: raw.length, digest: reference(raw).digest },
    onParse: () => { calls.parse += 1; },
    onDecompress: () => { calls.decompress += 1; },
  });
  assert.deepEqual(await gate.resume(ref), base);
  assert.deepEqual(calls, { parse: 1, decompress: 1 });
}));

test('A11 rejects damaged, length-mismatched and wrong-namespace readback before parser or decompressor', async () => isolated(async root => {
  const base = checkpoint();
  const raw = Buffer.from(JSON.stringify(base));
  const compressed = gzipSync(raw);
  const ref = reference(compressed, 'application/gzip');
  class SuppliedReadback extends ArtifactReferenceAccess {
    constructor(bytes) { super(root, { workspaceId: 'workspace-1', taskId: scope.taskId }, []); this.bytes = bytes; }
    async read() { return this.bytes; }
  }
  for (const [attemptRef, supplied] of [
    [ref, Buffer.from(compressed.map((value, index) => index === 0 ? value ^ 1 : value))],
    [{ ...ref, size: ref.size + 1 }, compressed],
    [{ ...ref, namespace: 'workspace' }, compressed],
    [{ ...ref, hashDomain: 'canonical-json' }, compressed],
  ]) {
    const calls = { parse: 0, decompress: 0 };
    const gate = new CheckpointDeltaResync(new SuppliedReadback(supplied), scope, base.snapshotDigest, {
      encoding: 'gzip', raw: { size: raw.length, digest: reference(raw).digest },
      onParse: () => { calls.parse += 1; },
      onDecompress: () => { calls.decompress += 1; },
    });
    await assert.rejects(gate.resume(attemptRef));
    assert.deepEqual(calls, { parse: 0, decompress: 0 });
    assert.equal(gate.status, 'resync-required');
  }
  const gate = new CheckpointDeltaResync(new SuppliedReadback(raw), scope, base.snapshotDigest);
  await assert.rejects(gate.resume(base), { code: 'INVALID_INPUT' });
}));

test('A11 rejects wrong uncompressed digest after decompress and before parser', async () => isolated(async root => {
  const base = checkpoint();
  const raw = Buffer.from(JSON.stringify(base));
  const compressed = gzipSync(raw);
  const ref = reference(compressed, 'application/gzip');
  await new RawContentStore(root).put(ref, compressed);
  const calls = { parse: 0, decompress: 0 };
  const gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest, {
    encoding: 'gzip', raw: { size: raw.length, digest: reference(Buffer.from('different')).digest },
    onParse: () => { calls.parse += 1; },
    onDecompress: () => { calls.decompress += 1; },
  });
  await assert.rejects(gate.resume(ref), { code: 'INTEGRITY_FAILED' });
  assert.deepEqual(calls, { parse: 0, decompress: 1 });
  assert.equal(gate.status, 'resync-required');
}));

test('A11 does not restore a base when the target changes inside the verified codec boundary', async () => isolated(async root => {
  const base = checkpoint();
  const bytes = Buffer.from(JSON.stringify(base));
  const ref = reference(bytes);
  await new RawContentStore(root).put(ref, bytes);
  let gate;
  gate = new CheckpointDeltaResync(access(root, [ref]), scope, base.snapshotDigest, {
    onParse: () => { gate.targetChanged(reference(Buffer.from('new target')).digest); },
  });
  await assert.rejects(gate.resume(ref), { code: 'GATE_FAILED' });
  assert.equal(gate.status, 'resync-required');
}));
