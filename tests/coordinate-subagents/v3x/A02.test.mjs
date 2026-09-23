import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';

const bytes = Buffer.from('the same immutable content');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const ref = (namespace = 'task') => ({
  schemaVersion: '1.0.0', namespace, id: 'artifact-1', digest,
  hashDomain: 'raw-bytes', size: bytes.byteLength, mediaType: 'application/octet-stream',
});
const objectPath = (root, namespace = 'task') => path.join(root, 'objects', namespace, digest.slice(7, 9), digest.slice(7));

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a02-'));
  try { await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('A02 simultaneous identical writes converge without replacing the object', async () => isolated(async root => {
  const store = new RawContentStore(root);
  const results = await Promise.all(Array.from({ length: 8 }, () => store.put(ref(), bytes)));
  assert.equal(results.filter(result => result.disposition === 'created').length, 1);
  assert.equal(results.filter(result => result.disposition === 'existing').length, 7);
  assert.equal(results.every(result => result.durability === 'best-effort'), true);
  assert.deepEqual(await readFile(objectPath(root)), bytes);
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
  await store.put(ref('workspace'), bytes);
  assert.deepEqual(await readFile(objectPath(root, 'workspace')), bytes);
}));

test('A02 rejects a pre-existing corrupt object and never overwrites it', async () => isolated(async root => {
  const store = new RawContentStore(root);
  await store.put(ref(), bytes);
  const damaged = Buffer.from('damaged');
  await writeFile(objectPath(root), damaged);
  await assert.rejects(() => store.put(ref(), bytes));
  assert.deepEqual(await readFile(objectPath(root)), damaged);
  assert.deepEqual(await readdir(path.join(root, '.tmp')), []);
}));

test('A02 pre-publish and post-publish crash residues are distinguishable and recoverable', async () => isolated(async root => {
  const store = new RawContentStore(root);
  const tempDirectory = path.join(root, '.tmp');
  const canonical = objectPath(root);
  await mkdir(tempDirectory);
  await mkdir(path.dirname(canonical), { recursive: true });
  const orphan = path.join(tempDirectory, 'before-link.tmp');
  await writeFile(orphan, bytes);
  assert.equal((await readdir(path.dirname(canonical))).length, 0);
  assert.equal((await store.put(ref(), bytes)).disposition, 'created');
  assert.deepEqual(await readdir(tempDirectory), ['before-link.tmp']);
  assert.deepEqual(await readFile(canonical), bytes);

  const linkedResidue = path.join(tempDirectory, 'after-link.tmp');
  await link(canonical, linkedResidue);
  assert.equal((await store.put(ref(), bytes)).disposition, 'existing');
  assert.deepEqual((await readdir(tempDirectory)).sort(), ['after-link.tmp', 'before-link.tmp']);
  assert.deepEqual(await readFile(canonical), bytes);
}));

test('A02 rejects invalid bytes, domain, size, and unapproved relative roots before publication', async () => isolated(async root => {
  assert.throws(() => new RawContentStore('relative/root'));
  const store = new RawContentStore(root);
  await assert.rejects(() => store.put(ref(), Buffer.from('wrong bytes')));
  await assert.rejects(() => store.put({ ...ref(), hashDomain: 'canonical-json' }, bytes));
  await assert.rejects(() => store.put({ ...ref(), size: bytes.byteLength + 1 }, bytes));
  assert.deepEqual(await readdir(root), []);
}));
