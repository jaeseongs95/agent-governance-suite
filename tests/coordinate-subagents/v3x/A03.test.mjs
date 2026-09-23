import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { ArtifactReferenceAccess } from '../../../mcp-server/src/artifacts/reference-access.ts';

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
