import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { SnapshotSetStore } from '../../../mcp-server/src/artifacts/snapshot-set.ts';

const roles = ['request', 'policy', 'catalog', 'capability', 'advice'];
const principal = { workspaceId: 'workspace-1', taskId: 'task-1' };
const material = Object.fromEntries(roles.map(role => [role, Buffer.from(`immutable ${role} bytes`)]));
const refs = Object.fromEntries(roles.map(role => [role, {
  schemaVersion: '1.0.0', namespace: 'task', id: role,
  digest: `sha256:${createHash('sha256').update(material[role]).digest('hex')}`,
  hashDomain: 'raw-bytes', size: material[role].length, mediaType: 'application/octet-stream',
}]));
const grant = ref => ({ ref, ...principal });
const objectPath = (root, ref) => path.join(root, 'objects', ref.namespace, ref.digest.slice(7, 9), ref.digest.slice(7));
const allObjects = root => readdir(path.join(root, 'objects', 'task'), { recursive: true });

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a04-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

async function fixture(root, savedRoles = roles) {
  const store = new RawContentStore(root);
  for (const role of savedRoles) await store.put(refs[role], material[role]);
  const snapshots = new SnapshotSetStore(root, principal, roles.map(role => grant(refs[role])));
  return { store, snapshots };
}

test('A04 publishes only after all five saved references pass authorized readback', async () => isolated(async root => {
  const { snapshots, store } = await fixture(root, roles.slice(0, 4));
  const before = (await allObjects(root)).sort();
  await assert.rejects(() => snapshots.publish(refs));
  assert.deepEqual((await allObjects(root)).sort(), before);
  await store.put(refs.advice, material.advice);
  const manifestRef = await snapshots.publish(refs);
  const reader = new SnapshotSetStore(root, principal, [...roles.map(role => grant(refs[role])), grant(manifestRef)]);
  const loaded = await reader.load(manifestRef);
  assert.deepEqual(loaded.inputs, refs);
  await rm(objectPath(root, refs.advice));
  await assert.rejects(() => reader.load(manifestRef));
}));

test('A04 rejects tampered member bytes without publishing a manifest', async () => isolated(async root => {
  const { snapshots } = await fixture(root);
  const before = (await allObjects(root)).sort();
  await writeFile(objectPath(root, refs.policy), Buffer.from('damaged'));
  await assert.rejects(() => snapshots.publish(refs), { code: 'INTEGRITY_FAILED' });
  assert.deepEqual((await allObjects(root)).sort(), before);
}));

test('A04 retries preserve manifest identity and changed inputs create a different immutable manifest', async () => isolated(async root => {
  const { snapshots, store } = await fixture(root);
  const first = await snapshots.publish(refs);
  assert.deepEqual(await snapshots.publish(refs), first);
  await assert.rejects(() => store.put(first, Buffer.from('different bytes')), { code: 'INTEGRITY_FAILED' });

  const changedBytes = Buffer.from('changed advice');
  const changedRef = { ...refs.advice, digest: `sha256:${createHash('sha256').update(changedBytes).digest('hex')}`, size: changedBytes.length };
  await store.put(changedRef, changedBytes);
  const changed = { ...refs, advice: changedRef };
  const changedSnapshots = new SnapshotSetStore(root, principal, [...roles.slice(0, 4).map(role => grant(refs[role])), grant(changedRef)]);
  const second = await changedSnapshots.publish(changed);
  assert.notEqual(second.digest, first.digest);
  assert.notEqual(second.id, first.id);
  const reader = new SnapshotSetStore(root, principal, [
    ...roles.map(role => grant(refs[role])), grant(changedRef), grant(first), grant(second),
  ]);
  assert.deepEqual((await reader.load(first)).inputs, refs);
  assert.deepEqual((await reader.load(second)).inputs, changed);
  await writeFile(objectPath(root, first), Buffer.from('tampered manifest'));
  await assert.rejects(() => reader.load(first), { code: 'INTEGRITY_FAILED' });
  assert.deepEqual((await reader.load(second)).inputs, changed);
}));

test('A04 refuses incomplete or ungranted input sets', async () => isolated(async root => {
  const { snapshots } = await fixture(root);
  await assert.rejects(() => snapshots.publish({ ...refs, advice: undefined }), { code: 'INVALID_INPUT' });
  await assert.rejects(() => snapshots.publish({ ...refs, extra: refs.request }), { code: 'INVALID_INPUT' });
  const noAdviceGrant = new SnapshotSetStore(root, principal, roles.slice(0, 4).map(role => grant(refs[role])));
  await assert.rejects(() => noAdviceGrant.publish(refs), { code: 'GATE_FAILED' });
}));
