import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { test } from 'vitest';

import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourceAuthorityHarness } from './fixtures/resource-authority-harness.mjs';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const now = '2026-09-23T00:03:00.000Z';
const poolIds = ['a-pool', 'z-pool'];
const scope = resourcePoolId => ({ collectorId: `collector-${resourcePoolId}`, source: 'provider-reported',
  accountScope, resourcePoolId });
const snapshot = resourcePoolId => ({ schemaVersion: '1.0.0', kind: 'full', ...scope(resourcePoolId),
  sequence: 1, snapshot: { schemaVersion: '1.0.0', accountScope, resourcePoolId, accessPath: 'subscription',
    windows: [{ windowId: 'weekly', resetEpoch: 1, resetAt: '2026-09-30T00:00:00.000Z', revision: 1,
      limitBucket: { bucketId: `${resourcePoolId}-weekly`, kind: 'requests', unit: 'request', limit: 10, remaining: 10 },
      coverage: 'complete', source: { kind: 'provider-observation', evidenceDigest },
      observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z' }] } });
const policies = poolIds.map(resourcePoolId => ({ schemaVersion: '1.0.0',
  policyId: `policy-${resourcePoolId}`, revision: 1, accountScope, resourcePoolId,
  approval: { approvedBy: 'fixture-operator', approvedAt: '2026-09-23T00:00:00.000Z', evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: [{ windowId: 'weekly', bucketId: `${resourcePoolId}-weekly`, unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] }));
const request = { taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', attemptId: 'attempt-1',
  planRevision: 1, leaseEpoch: 1, expiresAt: '2026-09-23T00:30:00.000Z',
  pools: poolIds.map(resourcePoolId => ({ accountScope, resourcePoolId,
    windows: [{ windowId: 'weekly', amount: 5, unit: 'request' }] })) };

async function seeded(options) {
  const harness = await ResourceAuthorityHarness.create(options);
  try {
    const db = new DatabaseSync(harness.config.databasePath);
    try {
      const collectors = poolIds.map(resourcePoolId => ({ scope: scope(resourcePoolId),
        collect: async () => snapshot(resourcePoolId) }));
      const observations = new ResourceObservationStore(db, harness.config, collectors);
      for (const collector of collectors) assert.equal((await observations.admit(collector)).kind, 'applied');
    } finally { db.close(); }
    await harness.configure({ policies, now });
    return harness;
  } catch (error) { await harness.close(); throw error; }
}

const inspect = (harness, index = 0) => harness.request(index, { type: 'inspect' });
const counts = observation => ({ reservations: observation.reservations, holds: observation.holds,
  requests: observation.requests });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('B16-a creates two OS processes with independent connections to one disposable resource ledger', async () => {
  const harness = await seeded();
  const root = harness.root;
  const pids = harness.children.map(child => child.pid);
  try {
    assert.equal(new Set(pids).size, 2);
    assert.ok(pids.every(pid => pid !== process.pid && alive(pid)));
    const [left, right] = await Promise.all([inspect(harness, 0), inspect(harness, 1)]);
    assert.equal(left.databasePath, right.databasePath);
    assert.equal(left.realmId, harness.config.realmId);
    assert.equal(right.realmId, harness.config.realmId);
    assert.notEqual(left.connectionToken, right.connectionToken);
    console.info('B16-a process evidence', JSON.stringify({ root, pids, databasePath: left.databasePath,
      connectionTokens: [left.connectionToken, right.connectionToken], realmId: left.realmId }));
    await harness.request(0, { type: 'marker', value: 'left-only' });
    assert.equal((await inspect(harness, 0)).marker, 'left-only');
    assert.equal((await inspect(harness, 1)).marker, null);
    const outcomes = await Promise.all([harness.admit(0, request).result, harness.admit(1, request).result]);
    assert.equal(outcomes[0].kind, 'admitted');
    assert.deepEqual(outcomes[1], outcomes[0]);
    assert.deepEqual(counts(await inspect(harness)), { reservations: 1, holds: 2, requests: 1 });
  } finally { await harness.close(); }
  assert.ok(pids.every(pid => !alive(pid)));
  assert.equal(existsSync(root), false);
  console.info('B16-a cleanup evidence', JSON.stringify({ pids, allExited: true, rootRemoved: true }));
});

test('B16-a rejects caller DB/root paths before opening or modifying an external database', async () => {
  await assert.rejects(ResourceAuthorityHarness.create({ databasePath: 'user.sqlite3' }), /options/u);
  await assert.rejects(ResourceAuthorityHarness.create({ root: 'user-root' }), /options/u);
  const harness = await seeded();
  const externalRoot = mkdtempSync(path.join(tmpdir(), 'ags-b16a-external-'));
  const outside = path.join(externalRoot, 'user.sqlite3');
  try {
    const external = new DatabaseSync(outside);
    try { external.exec("CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES ('keep');"); }
    finally { external.close(); }
    const externalBefore = readFileSync(outside);
    await assert.rejects(harness.request(0, { type: 'connect', databasePath: outside }), /database path/u);
    await assert.rejects(harness.request(1, { type: 'connect', databasePath: path.join(harness.root, '..', 'user.sqlite3') }), /database path/u);
    assert.deepEqual(readFileSync(outside), externalBefore);
    const before = readFileSync(harness.config.databasePath);
    await assert.rejects(harness.request(0, { type: 'connect', databasePath: `${harness.config.databasePath}-alternate` }), /database path/u);
    assert.deepEqual(readFileSync(harness.config.databasePath), before);
  } finally {
    await harness.close();
    assert.equal(path.relative(externalRoot, realpathSync(externalRoot)), '');
    assert.equal(path.relative(realpathSync(tmpdir()), path.dirname(realpathSync(externalRoot))), '');
    rmSync(externalRoot, { recursive: true, force: true });
  }
});

test('B16-a barrier holds a real transaction and the second process cannot finish until release', async () => {
  const harness = await seeded();
  try {
    const first = harness.admit(0, request, { at: 'before-commit', fault: 'barrier' });
    const reached = await first.reached();
    assert.deepEqual(reached, { at: 'before-commit', pid: harness.children[0].pid });
    const second = harness.admit(1, request);
    let finished = false;
    const observedSecond = second.result.then(result => { finished = true; return result; });
    await second.started();
    assert.equal(finished, false);
    first.release();
    const [one, two] = await Promise.all([first.result, observedSecond]);
    assert.equal(one.kind, 'admitted');
    assert.deepEqual(two, one);
    assert.deepEqual(counts(await inspect(harness)), { reservations: 1, holds: 2, requests: 1 });
  } finally { await harness.close(); }
});

for (const at of ['after-begin', 'before-commit', 'after-commit']) {
  test(`B16-a crash at ${at} reports lost outcome and preserves the corresponding SQLite state`, async () => {
    const harness = await seeded();
    try {
      const crashed = harness.admit(0, request, { at, fault: 'crash' });
      const failed = assert.rejects(crashed.result, /exited.*73/u);
      await crashed.reached();
      await failed;
      const committed = at === 'after-commit';
      const remaining = counts(await inspect(harness, 1));
      assert.deepEqual(remaining, committed
        ? { reservations: 1, holds: 2, requests: 1 } : { reservations: 0, holds: 0, requests: 0 });
      console.info('B16-a crash evidence', JSON.stringify({ at, pid: harness.children[0].pid,
        exitCode: harness.children[0].exitCode, remaining }));
      const replay = await harness.admit(1, request).result;
      assert.equal(replay.kind, 'admitted');
      assert.deepEqual(counts(await inspect(harness, 1)), { reservations: 1, holds: 2, requests: 1 });
    } finally { await harness.close(); }
  });
}

test('B16-a timeout kills both children, waits for exit, and removes the temporary root', async () => {
  const harness = await seeded({ timeoutMs: 1_500 });
  const root = harness.root;
  const pids = harness.children.map(child => child.pid);
  const blocked = harness.admit(0, request, { at: 'before-commit', fault: 'barrier' });
  const failed = assert.rejects(blocked.result, /timed out/u);
  await blocked.reached();
  await failed;
  assert.ok(pids.every(pid => !alive(pid)));
  assert.equal(existsSync(root), false);
  console.info('B16-a timeout evidence', JSON.stringify({ pids, allExited: true, rootRemoved: true }));
  await harness.close();
});

test('B16-a invalid fault points and operations fail without changing the ledger', async () => {
  const harness = await seeded();
  try {
    assert.throws(() => harness.admit(0, request, { at: 'imaginary', fault: 'barrier' }), /checkpoint/u);
    assert.throws(() => harness.admit(0, request, { at: 'before-commit', fault: 'success' }), /fault/u);
    await assert.rejects(harness.request(0, { type: 'arbitrary-sql', sql: 'ATTACH DATABASE user.sqlite3' }), /operation/u);
    assert.deepEqual(counts(await inspect(harness)), { reservations: 0, holds: 0, requests: 0 });
  } finally { await harness.close(); }
});
