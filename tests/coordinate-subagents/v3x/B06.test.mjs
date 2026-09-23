import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourcePoolsAdmissionStore } from '../../../mcp-server/src/resource/admit-pools.ts';
import { reservationIdempotencyKeyV1 } from '../../../mcp-server/src/resource/reservation-idempotency.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const now = '2026-09-23T00:03:00.000Z';
const expiresAt = '2026-09-23T00:30:00.000Z';
const ids = ['a-pool', 'z-pool'];
const scope = poolId => ({ collectorId: `collector-${poolId}`, source: 'provider-reported',
  accountScope, resourcePoolId: poolId });
const response = (poolId, remaining = 10, sequence = 1) => ({ schemaVersion: '1.0.0', kind: 'full',
  ...scope(poolId), sequence, snapshot: { schemaVersion: '1.0.0', accountScope,
    resourcePoolId: poolId, accessPath: 'subscription', windows: [{ windowId: 'weekly', resetEpoch: 1,
      resetAt: '2026-09-30T00:00:00.000Z', revision: sequence,
      limitBucket: { bucketId: `${poolId}-weekly`, kind: 'requests', unit: 'request', limit: 10, remaining },
      coverage: 'complete', source: { kind: 'provider-observation', evidenceDigest },
      observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z' }] } });
const policy = poolId => ({ schemaVersion: '1.0.0', policyId: `policy-${poolId}`, revision: 1,
  accountScope, resourcePoolId: poolId,
  approval: { approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00.000Z', evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: [{ windowId: 'weekly', bucketId: `${poolId}-weekly`, unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] });
const request = (planRevision = 1, amount = 5) => ({ taskId: 'task-1', runId: 'run-1', slotId: 'slot-1',
  attemptId: 'attempt-1', planRevision, leaseEpoch: 1, expiresAt,
  pools: [...ids].reverse().map(resourcePoolId => ({ accountScope, resourcePoolId,
    windows: [{ windowId: 'weekly', amount, unit: 'request' }] })) });

async function isolated(run, remaining = 10) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b06-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const policies = ids.map(policy);
  try {
    const collectors = ids.map(id => ({
      scope: scope(id), collect: async () => response(id, id === 'z-pool' ? remaining : 10),
    }));
    const observations = new ResourceObservationStore(db, config, collectors);
    for (const collector of collectors) assert.equal((await observations.admit(collector)).kind, 'applied');
    await run({ db, config, policies });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

const counts = db => ({ reservations: db.prepare('SELECT count(*) AS n FROM resource_reservations').get().n,
  holds: db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n,
  requests: db.prepare('SELECT count(*) AS n FROM resource_admission_requests').get().n });

test('B06 key binds identity, digest, and plan revision', () => {
  const identity = { taskId: 't', runId: 'r', slotId: 's', attemptId: 'a', planRevision: 1,
    requestDigest: `sha256:${'1'.repeat(64)}` };
  const key = reservationIdempotencyKeyV1(identity);
  assert.equal(key, reservationIdempotencyKeyV1({ ...identity }));
  assert.notEqual(key, reservationIdempotencyKeyV1({ ...identity, planRevision: 2 }));
  assert.notEqual(key, reservationIdempotencyKeyV1({ ...identity, requestDigest: `sha256:${'2'.repeat(64)}` }));
});

test('B06 journal fault after both holds rolls back identity, holds, and result', async () => {
  await isolated(async ({ db, config, policies }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => now);
    db.exec(`CREATE TRIGGER fail_b06_journal BEFORE INSERT ON resource_admission_requests
      WHEN (SELECT count(*) FROM resource_reservation_holds) = 2
      BEGIN SELECT RAISE(ABORT, 'journal fault'); END;`);
    assert.throws(() => store.admitIdempotent(request()), /journal fault/u);
    assert.deepEqual(counts(db), { reservations: 0, holds: 0, requests: 0 });
    db.exec('DROP TRIGGER fail_b06_journal;');
    assert.equal(store.admitIdempotent(request()).kind, 'admitted');
    assert.deepEqual(counts(db), { reservations: 1, holds: 2, requests: 1 });
  });
});

test('B06 denied attempt is stable; a new plan revision uses a separate key and result', async () => {
  await isolated(async ({ db, config, policies }) => {
    const store = new ResourcePoolsAdmissionStore(db, config, policies, () => now);
    const denied = store.admitIdempotent(request());
    assert.equal(denied.kind, 'rejected');
    assert.deepEqual(counts(db), { reservations: 0, holds: 0, requests: 1 });
    const updated = response('z-pool', 10, 2);
    const collector = { scope: scope('z-pool'), collect: async () => updated };
    const observations = new ResourceObservationStore(db, config, [collector]);
    assert.equal((await observations.admit(collector)).kind, 'applied');
    assert.deepEqual(store.admitIdempotent(request()), denied);
    const admitted = store.admitIdempotent(request(2));
    assert.equal(admitted.kind, 'admitted');
    assert.deepEqual(counts(db), { reservations: 1, holds: 2, requests: 2 });
    const rows = db.prepare('SELECT request_key, state FROM resource_admission_requests ORDER BY plan_revision').all();
    assert.deepEqual(rows.map(row => row.state), ['rejected', 'admitted']);
    assert.notEqual(rows[0].request_key, rows[1].request_key);
    assert.throws(() => store.admitIdempotent(request(2, 4)), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(counts(db), { reservations: 1, holds: 2, requests: 2 });
  }, 7);
});

function waitFor(child, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B06 process exited before ${type}: ${code}`)); };
    const cleanup = () => { child.off('message', onMessage); child.off('error', onError); child.off('exit', onExit); };
    child.on('message', onMessage); child.once('error', onError); child.once('exit', onExit);
  });
}

async function compete(changed) {
  await isolated(async ({ db, config, policies }) => {
    const children = [0, 1].map(() => fork(new URL('./fixtures/b06-admission-process.mjs', import.meta.url),
      { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
    try {
      const ready = children.map(child => waitFor(child, 'ready'));
      children.forEach(child => child.send({ type: 'setup', config, policies, now }));
      await Promise.all(ready);
      const results = children.map(child => waitFor(child, 'result'));
      children.forEach((child, i) => child.send({ type: 'admit', request: request(1, changed && i ? 4 : 5) }));
      const outcomes = await Promise.all(results);
      if (changed) {
        assert.deepEqual(outcomes.map(item => item.result?.kind ?? item.error?.code).sort(),
          ['REQUEST_CONFLICT', 'admitted']);
      } else {
        assert.equal(outcomes[0].result?.kind, 'admitted');
        assert.deepEqual(outcomes[1].result, outcomes[0].result);
      }
      assert.deepEqual(counts(db), { reservations: 1, holds: 2, requests: 1 });
    } finally {
      const exited = children.map(child => child.exitCode !== null ? Promise.resolve() :
        new Promise(resolve => child.once('exit', resolve)));
      for (const child of children) child.disconnect();
      await Promise.all(exited);
    }
  });
}

test('B06 two processes replay one request with one set of holds', async () => compete(false), 20_000);
test('B06 two processes reject changed payload for the same identity', async () => compete(true), 20_000);
