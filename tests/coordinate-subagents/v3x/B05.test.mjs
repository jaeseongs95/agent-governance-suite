import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourcePoolsAdmissionStore } from '../../../mcp-server/src/resource/admit-pools.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const now = '2026-09-23T00:01:00.000Z';
const expiresAt = '2026-09-23T00:30:00.000Z';
const ids = ['a-pool', 'z-pool'];
const scope = poolId => ({ collectorId: `collector-${poolId}`, source: 'provider-reported',
  accountScope, resourcePoolId: poolId });
const window = (poolId, remaining = 10, id = 'weekly') => ({
  windowId: id, resetEpoch: 1, resetAt: '2026-09-30T00:00:00.000Z', revision: 1,
  limitBucket: { bucketId: `${poolId}-${id}`, kind: 'requests', unit: 'request', limit: 10, remaining },
  coverage: 'complete', source: { kind: 'provider-observation', evidenceDigest },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z',
});
const response = (poolId, windows = [window(poolId)]) => ({ schemaVersion: '1.0.0', kind: 'full',
  ...scope(poolId), sequence: 1, snapshot: { schemaVersion: '1.0.0', accountScope,
    resourcePoolId: poolId, accessPath: 'subscription', windows } });
const policy = (poolId, windows = ['weekly']) => ({ schemaVersion: '1.0.0',
  policyId: `policy-${poolId}`, revision: 1, accountScope, resourcePoolId: poolId,
  approval: { approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00.000Z', evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: windows.map(id => ({ windowId: id, bucketId: `${poolId}-${id}`, unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } })) });
const request = (requestKey = 'request-1', pools = [...ids].reverse()) => ({
  requestKey, taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', attemptId: requestKey,
  planRevision: 1, leaseEpoch: 1, expiresAt,
  pools: pools.map(poolId => ({ accountScope, resourcePoolId: poolId,
    windows: [{ windowId: 'weekly', amount: 5, unit: 'request' }] })),
});

async function isolated(run, responses = ids.map(id => response(id)), policies = ids.map(id => policy(id))) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b05-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const collectors = responses.map(observed => ({ scope: scope(observed.resourcePoolId), collect: async () => observed }));
  try {
    const observations = new ResourceObservationStore(db, config, collectors);
    const admitted = [];
    for (const collector of collectors) admitted.push(await observations.admit(collector));
    assert(admitted.every(item => item.kind === 'applied'));
    await run({ db, config, observations, admitted, responses, policies });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

function ledger(db) {
  return {
    reservations: db.prepare('SELECT request_key, state FROM resource_reservations ORDER BY request_key').all(),
    holds: db.prepare('SELECT pool_id, window_id, amount FROM resource_reservation_holds ORDER BY pool_id, window_id').all(),
    requests: db.prepare('SELECT request_key, state FROM resource_admission_requests ORDER BY request_key').all(),
  };
}

test('B05 uses one outer transaction, sorted pools, one reservation and idempotent request replay', async () => {
  await isolated(async ({ db, config, policies, observations, admitted, responses }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => {
      assert.equal(db.isTransaction, true);
      return now;
    });
    const order = [];
    db.function('record_b05_order', poolId => { order.push(poolId); });
    db.exec('CREATE TRIGGER record_b05_hold AFTER INSERT ON resource_reservation_holds BEGIN SELECT record_b05_order(NEW.pool_id); END;');
    const exec = db.exec.bind(db);
    const statements = [];
    db.exec = sql => { statements.push(sql); return exec(sql); };
    const first = store.admit(request());
    assert.equal(first.kind, 'admitted');
    assert.deepEqual(statements, ['BEGIN IMMEDIATE;', 'SAVEPOINT resource_admission_candidate;',
      'RELEASE resource_admission_candidate;', 'COMMIT;']);
    assert.deepEqual(order, ids);
    assert.deepEqual(ledger(db).holds.map(row => row.pool_id), ids);
    assert.equal(ledger(db).reservations.length, 1);
    assert.equal(ledger(db).requests.length, 1);
    assert.deepEqual(store.admit(request('request-1', ids)), first);
    const changed = request(); changed.pools[0].windows[0].amount = 4;
    assert.throws(() => store.admit(changed), { code: 'REQUEST_CONFLICT' });
    const revisedPolicies = [policy('a-pool'), policy('z-pool')]; revisedPolicies[1].revision = 2;
    const revised = new ResourcePoolsAdmissionStore(db, config, revisedPolicies, () => now);
    assert.throws(() => revised.admit(request()), { code: 'REQUEST_CONFLICT' });
    const expired = new ResourcePoolsAdmissionStore(db, config, policies, () => '2026-09-23T00:31:00.000Z');
    assert.deepEqual(expired.admit(request()), { kind: 'rejected', reason: 'RESERVATION_EXPIRED', failedPool: null });
    const duplicate = request(); duplicate.pools.push(duplicate.pools[0]);
    assert.throws(() => store.admit(duplicate), { code: 'INVALID_INPUT' });
    assert.throws(() => store.admit(request('one-pool', ['a-pool'])), { code: 'INVALID_INPUT' });
    db.prepare("UPDATE resource_reservations SET state = 'committed' WHERE reservation_id = ?").run(first.reservationId);
    assert.deepEqual(store.admit(request()), { kind: 'rejected', reason: 'RESERVATION_NOT_ACTIVE', failedPool: null });
    for (let i = 0; i < ids.length; i++) {
      assert.deepEqual(observations.getObservation(admitted[i].observationId), responses[i]);
    }
  });
});

test('B05 failure at last sorted pool or last window leaves no partial hold', async () => {
  const insufficient = [response('a-pool'), response('z-pool', [window('z-pool', 7)])];
  await isolated(async ({ db, config, policies }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => now);
    assert.deepEqual(store.admit(request()), { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY',
      failedPool: { accountScope, resourcePoolId: 'z-pool' } });
    assert.deepEqual(ledger(db).reservations, []);
    assert.deepEqual(ledger(db).holds, []);
    assert.deepEqual(ledger(db).requests.map(row => ({ ...row })),
      [{ request_key: 'request-1', state: 'rejected' }]);
  }, insufficient);
  const twoWindows = [response('a-pool'), response('z-pool', [window('z-pool'), window('z-pool', 7, 'monthly')])];
  const twoPolicies = [policy('a-pool'), policy('z-pool', ['weekly', 'monthly'])];
  await isolated(async ({ db, config, policies }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => now);
    const input = request();
    input.pools[0].windows.push({ windowId: 'monthly', amount: 5, unit: 'request' });
    assert.equal(store.admit(input).kind, 'rejected');
    assert.deepEqual(ledger(db).reservations, []);
    assert.deepEqual(ledger(db).holds, []);
    assert.deepEqual(ledger(db).requests.map(row => ({ ...row })),
      [{ request_key: 'request-1', state: 'rejected' }]);
  }, twoWindows, twoPolicies);
});

test('B05 exception on the last pool write rolls back every pool and permits retry', async () => {
  await isolated(async ({ db, config, policies }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => now);
    db.exec(`CREATE TRIGGER fail_z_pool BEFORE INSERT ON resource_reservation_holds
      WHEN NEW.pool_id = 'z-pool' BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    assert.throws(() => store.admit(request()), /blocked/u);
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
    db.exec('DROP TRIGGER fail_z_pool;');
    assert.equal(store.admit(request()).kind, 'admitted');
    assert.deepEqual(ledger(db).holds.map(row => row.pool_id), ids);
  });
});

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B05 worker exited before ${type}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

async function compete(rollbackFirst) {
  await isolated(async ({ db, config, policies }) => {
    const barrier = new SharedArrayBuffer(4);
    const workers = ['request-1', 'request-2'].map((key, index) => new Worker(
      new URL('./fixtures/b05-admission-worker.mjs', import.meta.url),
      { execArgv: ['--import', 'tsx'], workerData: { config, policies, request: request(key),
        now, barrier, hold: index === 0, fail: index === 0 && rollbackFirst } },
    ));
    try {
      await Promise.all(workers.map(worker => waitFor(worker, 'ready')));
      const armed = waitFor(workers[0], 'armed'); workers[0].postMessage('arm'); await armed;
      const holding = waitFor(workers[0], 'holding');
      const first = waitFor(workers[0], 'result'); workers[0].postMessage('admit'); await holding;
      const attempt = waitFor(workers[1], 'write-attempt');
      const second = waitFor(workers[1], 'result'); workers[1].postMessage('admit'); await attempt;
      let settled = false;
      void second.then(() => { settled = true; }, () => { settled = true; });
      await delay(100);
      assert.equal(settled, false, 'second multi-pool writer must wait for the first SQLite write lock');
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      const outcomes = await Promise.all([first, second]);
      if (rollbackFirst) {
        assert.match(outcomes[0].error?.message ?? '', /b05 rollback/u);
        assert.equal(outcomes[1].result?.kind, 'admitted');
      } else {
        assert.equal(outcomes[0].result?.kind, 'admitted');
        assert.equal(outcomes[1].result?.kind, 'rejected');
      }
      const state = ledger(db);
      assert.equal(state.reservations.length, 1);
      assert.deepEqual(state.holds.map(row => row.pool_id), ids);
      assert.equal(state.requests[0].request_key, rollbackFirst ? 'request-2' : 'request-1');
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  });
}

test('B05 two SQLite connections never exceed either pool budget', async () => {
  await compete(false);
}, 20_000);

test('B05 a competing writer succeeds after first multi-pool rollback with no partial hold', async () => {
  await compete(true);
}, 20_000);
