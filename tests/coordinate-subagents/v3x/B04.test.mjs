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
import { ResourcePoolAdmissionStore, reservePoolInTransaction } from '../../../mcp-server/src/resource/admit-pool.ts';

const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const scope = { collectorId: 'provider-1', source: 'provider-reported', accountScope, resourcePoolId: 'pool-1' };
const now = '2026-09-23T00:01:00.000Z';
const expiresAt = '2026-09-23T00:30:00.000Z';
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const window = (remaining = 10, changes = {}) => ({
  windowId: 'weekly', resetEpoch: 1, resetAt: '2026-09-30T00:00:00.000Z', revision: 1,
  limitBucket: { bucketId: 'requests', kind: 'requests', unit: 'request', limit: 10, remaining },
  coverage: 'complete', source: { kind: 'provider-observation', evidenceDigest },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z', ...changes,
});
const observation = (observedWindow = window(), accessPath = 'subscription') => ({
  schemaVersion: '1.0.0', kind: 'full', ...scope, sequence: 1,
  snapshot: { schemaVersion: '1.0.0', accountScope, resourcePoolId: scope.resourcePoolId,
    accessPath, windows: [observedWindow] },
});
const policy = (changes = {}) => ({ schemaVersion: '1.0.0', policyId: 'policy-1', revision: 1,
  accountScope, resourcePoolId: scope.resourcePoolId,
  approval: { approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00.000Z', evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: [{ windowId: 'weekly', bucketId: 'requests', unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }], ...changes });
const request = (requestKey = 'request-1', amount = 5) => ({ requestKey, taskId: 'task-1', runId: 'run-1',
  slotId: 'slot-1', attemptId: requestKey, planRevision: 1, leaseEpoch: 1, accountScope,
  resourcePoolId: scope.resourcePoolId, expiresAt,
  windows: [{ windowId: 'weekly', amount, unit: 'request' }] });

async function isolated(run, observed = observation(), approved = policy()) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b04-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const collector = { scope: { ...scope, source: observed.source }, collect: async () => observed };
  try {
    const observationStore = new ResourceObservationStore(db, config, [collector]);
    const admitted = await observationStore.admit(collector);
    assert.equal(admitted.kind, 'applied');
    await run({ db, config, approved, observed, observationStore, observationId: admitted.observationId });
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

function ledger(db) {
  return {
    reservations: db.prepare('SELECT request_key, state FROM resource_reservations ORDER BY request_key').all(),
    holds: db.prepare('SELECT h.amount, h.unit, h.window_id FROM resource_reservation_holds h ORDER BY h.reservation_id').all(),
    requests: db.prepare('SELECT request_key, state FROM resource_admission_requests ORDER BY request_key').all(),
  };
}

test('B04 local 10/reserve3/cost5 allows one hold, counts committed and uncertain, and replays identical keys', async () => {
  await isolated(async ({ db, config, approved }) => {
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => {
      assert.equal(db.isTransaction, true, 'fresh local time is read after acquiring the write lock');
      return now;
    });
    const first = store.admit(request());
    assert.equal(first.kind, 'admitted');
    assert.deepEqual(store.admit(request()), first);
    assert.throws(() => store.admit(request('request-1', 4)), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => store.admit({ ...request('request-2'), roleId: 'audit' }), { code: 'INVALID_INPUT' });
    const revised = new ResourcePoolAdmissionStore(db, config, policy({ revision: 2 }), () => now);
    assert.throws(() => revised.admit(request()), { code: 'REQUEST_CONFLICT' });
    const expired = new ResourcePoolAdmissionStore(db, config, approved, () => '2026-09-23T00:30:00.000Z');
    assert.deepEqual(expired.admit(request()), { kind: 'rejected', reason: 'RESERVATION_EXPIRED' });
    assert.deepEqual(store.admit(request('request-2')), { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
    assert.equal(ledger(db).holds.length, 1);
    db.prepare("UPDATE resource_reservations SET state = 'committed' WHERE reservation_id = ?").run(first.reservationId);
    assert.deepEqual(store.admit(request()), { kind: 'rejected', reason: 'RESERVATION_NOT_ACTIVE' });
    assert.equal(store.admit(request('request-3')).kind, 'rejected');
    db.prepare("UPDATE resource_reservations SET state = 'uncertain' WHERE reservation_id = ?").run(first.reservationId);
    assert.equal(store.admit(request('request-4')).kind, 'rejected');
    assert.deepEqual(ledger(db).requests.map(row => row.request_key), ['request-1']);
  });
});

test('B04 failed request write rolls back reservation and hold without consuming capacity', async () => {
  await isolated(async ({ db, config, approved }) => {
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
    db.exec("CREATE TRIGGER reject_request BEFORE INSERT ON resource_admission_requests BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    assert.throws(() => store.admit(request()), /blocked/u);
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
    db.exec('DROP TRIGGER reject_request;');
    assert.equal(store.admit(request()).kind, 'admitted');
    assert.equal(ledger(db).holds.length, 1);
  });
});

test('B04 rejects unknown, stale, untrusted, percent and mismatched units without a hold', async () => {
  const cases = [
    { observed: observation(window(null)), result: { kind: 'rejected', reason: 'OBSERVATION_UNKNOWN' } },
    { observed: observation(window(10, { coverage: 'partial' })), result: { kind: 'rejected', reason: 'OBSERVATION_UNTRUSTED' } },
    { observed: observation(window(10, { expiresAt: now })), result: { kind: 'rejected', reason: 'OBSERVATION_STALE' } },
    { observed: observation(window(10, { source: { kind: 'user-declared', evidenceDigest: null } })),
      source: 'fake', result: { kind: 'rejected', reason: 'OBSERVATION_UNTRUSTED' } },
    { observed: observation(window(10, { limitBucket: {
      bucketId: 'requests', kind: 'subscription-percent', unit: 'percent', limit: 100, remaining: 10 } })),
    result: { kind: 'rejected', reason: 'UNIT_UNSUPPORTED' } },
  ];
  for (const item of cases) {
    const observed = structuredClone(item.observed);
    if (item.source) observed.source = item.source;
    await isolated(async ({ db, config, approved }) => {
      const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
      assert.deepEqual(store.admit(request()), item.result);
      assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
    }, observed);
  }
  await isolated(async ({ db, config, approved }) => {
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
    const wrongUnit = request(); wrongUnit.windows[0].unit = 'token';
    assert.throws(() => store.admit(wrongUnit), { code: 'INVALID_INPUT' });
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
  });
});

test('B04 checks original evidence and every window before writing any hold', async () => {
  await isolated(async ({ db, config, approved }) => {
    db.prepare('UPDATE resource_window_observations SET remaining = 100').run();
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
    assert.throws(() => store.admit(request()), { code: 'INTEGRITY_FAILED' });
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
  });
  const monthly = window(7, { windowId: 'monthly',
    limitBucket: { bucketId: 'monthly-requests', kind: 'requests', unit: 'request', limit: 10, remaining: 7 } });
  const observed = observation(); observed.snapshot.windows.push(monthly);
  const approved = policy({ windows: [...policy().windows,
    { windowId: 'monthly', bucketId: 'monthly-requests', unit: 'request',
      reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] });
  await isolated(async ({ db, config }) => {
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
    const input = request(); input.windows.push({ windowId: 'monthly', amount: 5, unit: 'request' });
    assert.deepEqual(store.admit(input), { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
  }, observed, approved);
});

test('B04 retains active in-flight holds from an earlier reset epoch', async () => {
  await isolated(async ({ db, config, approved }) => {
    db.prepare('INSERT INTO resource_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('old-reservation', 'old-request', evidenceDigest, 'task-old', 'run-old', 'slot-old',
        'attempt-old', 1, 1, 'uncertain', now, expiresAt);
    db.prepare('INSERT INTO resource_reservation_holds VALUES (?,?,?,?,?,?,?)')
      .run('old-reservation', accountScope, scope.resourcePoolId, 'weekly', 1, 5, 'request');
    const store = new ResourcePoolAdmissionStore(db, config, approved, () => now);
    assert.deepEqual(store.admit(request()), { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
    assert.equal(ledger(db).holds.length, 1);
  }, observation(window(10, { resetEpoch: 2, revision: 2 })));
});

test('B04 internal helper uses the caller transaction and never commits', async () => {
  await isolated(async ({ db, approved }) => {
    const input = request();
    assert.throws(() => reservePoolInTransaction(db, approved, input, 'reservation-1', now),
      { code: 'INVALID_INPUT' });
    db.exec('BEGIN IMMEDIATE;');
    db.prepare(`INSERT INTO resource_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run('reservation-1', input.requestKey, evidenceDigest, input.taskId, input.runId, input.slotId,
        input.attemptId, input.planRevision, input.leaseEpoch, 'held', now, input.expiresAt);
    assert.equal(reservePoolInTransaction(db, approved, input, 'reservation-1', now).kind, 'admitted');
    assert.equal(db.isTransaction, true);
    assert.equal(ledger(db).holds.length, 1);
    db.exec('ROLLBACK;');
    assert.deepEqual(ledger(db), { reservations: [], holds: [], requests: [] });
  });
});

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B04 worker exited before ${type}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

async function compete(rollbackFirst, expiresWhileWaiting = false) {
  await isolated(async ({ db, config, approved, observed, observationStore, observationId }) => {
    const barrier = new SharedArrayBuffer(8);
    const workers = ['request-1', 'request-2'].map((key, index) => new Worker(
      new URL('./fixtures/b04-admission-worker.mjs', import.meta.url),
      { execArgv: ['--import', 'tsx'], workerData: {
        config, policy: approved, request: request(key), now, barrier,
        afterNow: '2026-09-23T00:31:00.000Z', hold: index === 0,
        fail: index === 0 && rollbackFirst,
      } },
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
      assert.equal(settled, false, 'second SQLite connection must wait for the first write lock');
      if (expiresWhileWaiting) Atomics.store(new Int32Array(barrier), 1, 1);
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      const outcomes = await Promise.all([first, second]);
      if (expiresWhileWaiting) {
        assert.match(outcomes[0].error?.message ?? '', /b04 rollback/u);
        assert.equal(outcomes[1].error?.code, 'INVALID_INPUT');
      } else if (rollbackFirst) {
        assert.match(outcomes[0].error?.message ?? '', /b04 rollback/u);
        assert.equal(outcomes[1].result?.kind, 'admitted');
      } else {
        assert.equal(outcomes[0].result?.kind, 'admitted');
        assert.deepEqual(outcomes[1].result, { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
      }
      const state = ledger(db);
      assert.equal(state.reservations.length, expiresWhileWaiting ? 0 : 1);
      assert.equal(state.holds.length, expiresWhileWaiting ? 0 : 1);
      assert.equal(state.requests.length, expiresWhileWaiting ? 0 : 1);
      if (!expiresWhileWaiting) {
        assert.equal(state.holds[0].amount, 5);
        assert.equal(state.requests[0].request_key, rollbackFirst ? 'request-2' : 'request-1');
      }
      assert.deepEqual(observationStore.getObservation(observationId), observed);
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  });
}

test('B04 independent connections serialize 10/reserve3/cost5 and admit at most one', async () => {
  await compete(false);
}, 20_000);

test('B04 competing admission succeeds after the first rolls back and leaves no partial hold', async () => {
  await compete(true);
}, 20_000);

test('B04 rechecks expiry after waiting for the SQLite write lock', async () => {
  await compete(true, true);
}, 20_000);
