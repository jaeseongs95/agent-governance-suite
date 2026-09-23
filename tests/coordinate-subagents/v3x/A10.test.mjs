import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { ArtifactRetentionStore } from '../../../mcp-server/src/artifacts/retention.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';

const bytes = Buffer.from('immutable checkpoint bytes');
function ref(content = bytes, id = 'checkpoint-1') {
  return { schemaVersion: '1.0.0', namespace: 'task', id,
    digest: `sha256:${createHash('sha256').update(content).digest('hex')}`,
    hashDomain: 'raw-bytes', size: content.length, mediaType: 'application/octet-stream' };
}

async function isolated(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'ags-a10-'));
  const databasePath = path.join(root, 'retention.sqlite3');
  try { await run(root, databasePath); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function pendingPinWriter(databasePath, object, owner) {
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.databasePath);
    try {
      db.exec('PRAGMA foreign_keys = ON; BEGIN IMMEDIATE;');
      db.prepare("INSERT INTO artifact_retention_pins " +
        "(owner, reference_id, namespace, digest, ref_json, phase) " +
        "VALUES (?, 'reference-1', ?, ?, ?, 'pending')")
        .run(workerData.owner, workerData.object.namespace, workerData.object.digest, workerData.refJson);
      parentPort.postMessage({ kind: 'ready' });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
      db.exec('COMMIT;');
      parentPort.postMessage({ kind: 'done', commitAt: Date.now() });
    } catch (error) {
      try { db.exec('ROLLBACK;'); } catch {}
      parentPort.postMessage({ kind: 'done', error: { message: error.message } });
    } finally { db.close(); }
  `, { eval: true, workerData: {
    databasePath, object, owner, refJson: canonicalJson(object),
  } });
  let readyResolve;
  let readyReject;
  let doneResolve;
  let doneReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const done = new Promise((resolve, reject) => { doneResolve = resolve; doneReject = reject; });
  worker.on('message', (message) => {
    if (message.kind === 'ready') readyResolve();
    if (message.kind === 'done') {
      if (message.error) readyReject(new Error(message.error.message));
      doneResolve(message);
    }
  });
  worker.on('error', (error) => { readyReject(error); doneReject(error); });
  return { worker, ready, done };
}

test('A10 pins before publication, keeps in-flight references and never deletes bytes in dry-run', async () => isolated(async (root, databasePath) => {
  const retention = new ArtifactRetentionStore(databasePath);
  const object = ref();
  const objectPath = path.join(root, 'objects', object.namespace, object.digest.slice(7, 9), object.digest.slice(7));
  try {
    assert.equal(retention.gcEnabled, false);
    assert.equal(retention.pin(object, 'owner-1', 'reference-1'), 'created');
    assert.deepEqual(retention.dryRun(), []);
    assert.throws(() => retention.release('owner-1', 'reference-1'), { code: 'GATE_FAILED' });
    assert.equal(retention.tombstone(object), 'pinned');
    await new RawContentStore(root).put(object, bytes);
    assert.deepEqual(await readFile(objectPath), bytes);

    retention.referencePublished('owner-1', 'reference-1');
    retention.referencePublished('owner-1', 'reference-1');
    assert.throws(() => retention.release('owner-1', 'reference-1'), { code: 'GATE_FAILED' });
    retention.referenceClosed('owner-1', 'reference-1', 'release');
    retention.referenceClosed('owner-1', 'reference-1', 'release');
    assert.equal(retention.release('owner-1', 'reference-1'), 'released');
    assert.equal(retention.release('owner-1', 'reference-1'), 'already-released');
    assert.deepEqual(retention.dryRun(), [{ namespace: object.namespace, digest: object.digest, size: object.size }]);
    assert.deepEqual(await readFile(objectPath), bytes);
    assert.equal(retention.tombstone(object), 'tombstoned');
    assert.equal(retention.tombstone(object), 'already-tombstoned');
    assert.equal(retention.replayState(object), 'replay-unavailable');
    assert.deepEqual(retention.dryRun(), []);
    assert.deepEqual(await readFile(objectPath), bytes);
    assert.throws(() => retention.pin(object, 'owner-2', 'reference-2'), { code: 'GATE_FAILED' });
  } finally { retention.close(); }
}));

test('A10 two connections converge on one owner/reference and block tombstone while any pin survives', async () => isolated(async (_root, databasePath) => {
  const first = new ArtifactRetentionStore(databasePath);
  const second = new ArtifactRetentionStore(databasePath);
  const object = ref();
  try {
    assert.equal(first.pin(object, 'owner-1', 'reference-1'), 'created');
    assert.equal(second.pin(object, 'owner-1', 'reference-1'), 'existing');
    assert.throws(() => second.pin(ref(Buffer.from('other bytes')), 'owner-1', 'reference-1'), { code: 'GATE_FAILED' });
    assert.equal(second.pin(ref(bytes, 'alias-2'), 'owner-2', 'reference-2'), 'created');
    first.referencePublished('owner-1', 'reference-1');
    first.referenceClosed('owner-1', 'reference-1', 'release');
    assert.equal(second.release('owner-1', 'reference-1'), 'released');
    assert.deepEqual(first.dryRun(), []);
    assert.equal(first.tombstone(object), 'pinned');
    assert.throws(() => second.release('owner-2', 'reference-2'), { code: 'GATE_FAILED' });
    second.referencePublished('owner-2', 'reference-2');
    second.referenceClosed('owner-2', 'reference-2', 'release');
    assert.equal(first.release('owner-2', 'reference-2'), 'released');
    assert.equal(second.tombstone(object), 'tombstoned');
    assert.equal(first.replayState(ref(bytes, 'alias-2')), 'replay-unavailable');
    assert.throws(() => first.pin(object, 'owner-1', 'reference-1'), { code: 'GATE_FAILED' });
  } finally { second.close(); first.close(); }
}));

test('A10 independent write-lock holders race on duplicate pin and pin versus tombstone', async () => isolated(async (_root, databasePath) => {
  const store = new ArtifactRetentionStore(databasePath);
  const object = ref();
  const workers = [];
  try {
    store.pin(object, 'bootstrap', 'reference-1');
    store.referencePublished('bootstrap', 'reference-1');
    store.referenceClosed('bootstrap', 'reference-1', 'release');
    store.release('bootstrap', 'reference-1');

    const duplicate = pendingPinWriter(databasePath, object, 'owner-race');
    workers.push(duplicate);
    await duplicate.ready;
    const duplicateStartedAt = Date.now();
    assert.equal(store.pin(object, 'owner-race', 'reference-1'), 'existing');
    const duplicateResult = await duplicate.done;
    assert.equal(duplicateResult.error, undefined);
    assert.ok(duplicateStartedAt < duplicateResult.commitAt);
    assert.deepEqual(store.dryRun(), []);

    store.referencePublished('owner-race', 'reference-1');
    store.referenceClosed('owner-race', 'reference-1', 'release');
    store.release('owner-race', 'reference-1');
    const conflict = pendingPinWriter(databasePath, object, 'owner-next');
    workers.push(conflict);
    await conflict.ready;
    const tombstoneStartedAt = Date.now();
    assert.equal(store.tombstone(object), 'pinned');
    const conflictResult = await conflict.done;
    assert.equal(conflictResult.error, undefined);
    assert.ok(tombstoneStartedAt < conflictResult.commitAt);
    assert.equal(store.replayState(object), 'not-tombstoned');
    assert.deepEqual(store.dryRun(), []);
  } finally {
    await Promise.all(workers.map((item) => item.worker.terminate()));
    store.close();
  }
}), 20_000);

test('A10 retained and incomplete references never become deletion candidates', async () => isolated(async (_root, databasePath) => {
  const retention = new ArtifactRetentionStore(databasePath);
  const object = ref();
  try {
    assert.equal(retention.pin(object, 'owner-1', 'reference-1'), 'created');
    assert.throws(() => retention.referenceClosed('owner-1', 'reference-1', 'release'), { code: 'GATE_FAILED' });
    assert.throws(() => retention.release('owner-1', 'reference-1'), { code: 'GATE_FAILED' });
    retention.referencePublished('owner-1', 'reference-1');
    assert.throws(() => retention.referenceClosed('owner-1', 'reference-1', 'unknown'), { code: 'INVALID_INPUT' });
    retention.referenceClosed('owner-1', 'reference-1', 'retain');
    assert.throws(() => retention.referenceClosed('owner-1', 'reference-1', 'release'), { code: 'GATE_FAILED' });
    assert.throws(() => retention.release('owner-1', 'reference-1'), { code: 'GATE_FAILED' });
    assert.deepEqual(retention.dryRun(), []);
    assert.equal(retention.tombstone(object), 'pinned');
    assert.equal(retention.replayState(object), 'not-tombstoned');
    assert.equal(retention.replayState(ref(Buffer.from('unknown'))), 'unknown');
  } finally { retention.close(); }
}));

test('A10 rejects non-raw references and size conflicts before changing pin state', async () => isolated(async (_root, databasePath) => {
  const retention = new ArtifactRetentionStore(databasePath);
  const object = ref();
  try {
    assert.throws(() => retention.pin({ ...object, hashDomain: 'canonical-json' }, 'owner-1', 'reference-1'),
      { code: 'INVALID_INPUT' });
    assert.equal(retention.pin(object, 'owner-1', 'reference-1'), 'created');
    assert.throws(() => retention.pin({ ...object, size: object.size + 1 }, 'owner-2', 'reference-2'),
      { code: 'INTEGRITY_FAILED' });
    assert.deepEqual(retention.dryRun(), []);
  } finally { retention.close(); }
}));
