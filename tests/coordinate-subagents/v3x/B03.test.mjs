import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { FakeResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/fake.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';

const accountScope = `acct-hmac-sha256:${'a'.repeat(64)}`;
const scope = { collectorId: 'collector-1', source: 'fake', accountScope, resourcePoolId: 'shared-pool' };
const window = (revision, remaining = 50) => ({
  windowId: 'weekly', resetEpoch: 1, resetAt: '2026-09-30T00:00:00.000Z', revision,
  limitBucket: { bucketId: 'requests', kind: 'requests', unit: 'request', limit: 100, remaining },
  coverage: 'partial', source: { kind: 'user-declared', evidenceDigest: null },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T00:05:00.000Z',
});
const full = (sequence, revision, remaining = 50) => ({
  schemaVersion: '1.0.0', kind: 'full', ...scope, sequence,
  snapshot: { schemaVersion: '1.0.0', accountScope, resourcePoolId: scope.resourcePoolId,
    accessPath: 'subscription', windows: [window(revision, remaining)] },
});
const fake = responses => new FakeResourceCollectorV1(scope, responses);

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b03-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const databases = [];
  const open = collector => {
    const db = new DatabaseSync(config.databasePath);
    databases.push(db);
    return { db, store: new ResourceObservationStore(db, config, [collector]) };
  };
  try { await run(open); }
  finally {
    for (const db of databases) db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('B03 two connections admit latest/older responses without replacing the latest window', async () => {
  for (const order of [[1, 2], [2, 1]]) await isolated(async open => {
    const ports = order.map(revision => fake([full(revision, revision, 80 - revision * 10)]));
    const connections = ports.map(port => open(port));
    const results = await Promise.all(connections.map(({ store }, index) => store.admit(ports[index])));
    assert.equal(results.some(result => result.kind === 'applied'), true);
    const db = connections[0].db;
    const current = db.prepare('SELECT revision, remaining FROM resource_window_observations').get();
    assert.equal(current.revision, 2);
    assert.equal(current.remaining, 60);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n,
      results.filter(result => result.kind === 'applied').length);
  });
});

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message.type !== type) return;
      cleanup();
      resolve(message);
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B03 worker exited before ${type}: ${code}`)); };
    const cleanup = () => {
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
    };
    worker.on('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
  });
}

async function competingAdmissions(first, second, rollbackFirst) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b03-race-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const barrier = new SharedArrayBuffer(4);
  const workers = [first, second].map((response, index) => new Worker(
    new URL('./fixtures/b03-admission-worker.mjs', import.meta.url),
    { execArgv: ['--import', 'tsx'], workerData: {
      config, response, barrier, hold: index === 0, fail: index === 0 && rollbackFirst,
    } },
  ));
  try {
    await Promise.all(workers.map(worker => waitFor(worker, 'ready')));
    const armed = waitFor(workers[0], 'armed');
    workers[0].postMessage('arm');
    await armed;

    const holding = waitFor(workers[0], 'holding');
    const firstResult = waitFor(workers[0], 'result');
    workers[0].postMessage('admit');
    await holding;

    const collected = waitFor(workers[1], 'collected');
    const writeAttempt = waitFor(workers[1], 'write-attempt');
    const secondResult = waitFor(workers[1], 'result');
    workers[1].postMessage('admit');
    await collected;
    await writeAttempt;
    let secondSettled = false;
    void secondResult.then(() => { secondSettled = true; }, () => { secondSettled = true; });
    await delay(100);
    assert.equal(secondSettled, false, 'second connection must wait while the first holds the SQLite write lock');

    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0);
    const outcomes = await Promise.all([firstResult, secondResult]);
    const db = new DatabaseSync(config.databasePath);
    try {
      const store = new ResourceObservationStore(db, config, [fake([])]);
      const events = db.prepare('SELECT observation_id, sequence FROM resource_observations ORDER BY sequence').all();
      const windows = db.prepare('SELECT window_id, observation_id, revision, remaining FROM resource_window_observations').all();
      const pools = db.prepare('SELECT COUNT(*) AS n FROM resource_pools').get().n;
      const readback = events.map(event => store.getObservation(event.observation_id));
      return { outcomes, events, windows, pools, readback };
    } finally { db.close(); }
  } finally {
    Atomics.store(new Int32Array(barrier), 0, 1);
    Atomics.notify(new Int32Array(barrier), 0);
    await Promise.all(workers.map(worker => worker.terminate()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('B03 independent SQLite connections serialize latest/older admissions in both commit orders', async () => {
  for (const [first, second, expectedKinds, expectedSequences] of [
    [full(2, 2, 60), full(1, 1, 70), ['applied', 'out-of-order'], [2]],
    [full(1, 1, 70), full(2, 2, 60), ['applied', 'applied'], [1, 2]],
  ]) {
    const state = await competingAdmissions(first, second, false);
    assert.deepEqual(state.outcomes.map(outcome => outcome.result?.kind), expectedKinds);
    assert.deepEqual(state.events.map(event => event.sequence), expectedSequences);
    assert.deepEqual(state.readback, expectedSequences.map(sequence => sequence === first.sequence ? first : second));
    assert.equal(state.pools, 1);
    assert.equal(state.windows.length, 1);
    assert.equal(state.windows[0].window_id, 'weekly');
    assert.equal(state.windows[0].revision, 2);
    assert.equal(state.windows[0].remaining, 60);
    assert.equal(state.windows[0].observation_id, state.events.at(-1).observation_id);
  }
}, 20_000);

test('B03 rollback under a competing writer leaves no partial evidence or window', async () => {
  const first = full(1, 1, 70);
  const second = full(2, 2, 60);
  const state = await competingAdmissions(first, second, true);
  assert.match(state.outcomes[0].error?.message ?? '', /b03 rollback/u);
  assert.equal(state.outcomes[1].result?.kind, 'applied');
  assert.deepEqual(state.events.map(event => event.sequence), [2]);
  assert.deepEqual(state.readback, [second]);
  assert.equal(state.pools, 1);
  assert.equal(state.windows.length, 1);
  assert.equal(state.windows[0].revision, 2);
  assert.equal(state.windows[0].remaining, 60);
  assert.equal(state.windows[0].observation_id, state.events[0].observation_id);
}, 20_000);

test('B03 duplicate is idempotent, conflicting bytes fail, and raw model input or source spoofing is rejected', async () => {
  await isolated(async open => {
    const port = fake([full(1, 1), full(1, 1)]);
    const { db, store } = open(port);
    const first = await store.admit(port);
    assert.equal(first.kind, 'applied');
    assert.deepEqual(await store.admit(port), { kind: 'duplicate', observationId: first.observationId });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 1);
    assert.deepEqual(store.getObservation(first.observationId), full(1, 1));
    await assert.rejects(() => store.admit(full(3, 3)), { code: 'INVALID_INPUT' });
    const conflictPort = fake([full(1, 2)]);
    const conflicting = open(conflictPort).store;
    await assert.rejects(() => conflicting.admit(conflictPort), { code: 'SNAPSHOT_CONFLICT' });
    const forgedPort = { scope, collect: async () => ({ ...full(2, 2), source: 'provider-reported' }) };
    const forged = open(forgedPort).store;
    await assert.rejects(() => forged.admit(forgedPort), { code: 'INVALID_INPUT' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 1);
    db.prepare('UPDATE resource_observations SET payload_json = ? WHERE observation_id = ?')
      .run('{"tampered":true}', first.observationId);
    assert.throws(() => store.getObservation(first.observationId), { code: 'INVALID_INPUT' });
  });
});

test('B03 rejects duplicate window IDs in a full response before changing event or current state', async () => {
  await isolated(async open => {
    const duplicate = full(1, 2);
    duplicate.snapshot.windows.push(window(1, 99));
    const port = { scope, collect: async () => duplicate };
    const { db, store } = open(port);
    await assert.rejects(() => store.admit(port), { code: 'INVALID_INPUT' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_window_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_pools').get().n, 0);
  });
});

test('B03 observation event and current window write atomically; unavailable clears numeric capacity', async () => {
  await isolated(async open => {
    const unavailable = { schemaVersion: '1.0.0', kind: 'unavailable', ...scope, sequence: 2, reason: 'not-exposed' };
    const port = fake([full(1, 1), full(1, 1), unavailable]);
    const { db, store } = open(port);
    db.exec("CREATE TRIGGER reject_window BEFORE INSERT ON resource_window_observations BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    await assert.rejects(() => store.admit(port), /blocked/u);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_pools').get().n, 0);
    db.exec('DROP TRIGGER reject_window;');
    assert.equal((await store.admit(port)).kind, 'applied');
    const lost = await store.admit(port);
    assert.equal(lost.kind, 'applied');
    assert.deepEqual(store.getObservation(lost.observationId), unavailable);
    assert.equal(db.prepare('SELECT remaining FROM resource_window_observations').get().remaining, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 2);
  });
});
