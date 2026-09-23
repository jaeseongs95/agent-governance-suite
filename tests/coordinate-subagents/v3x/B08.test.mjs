import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

import { ArtifactRetentionStore } from '../../../mcp-server/src/artifacts/retention.ts';
import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourcePoolsAdmissionStore } from '../../../mcp-server/src/resource/admit-pools.ts';
import { ResourceReservationCommitStore } from '../../../mcp-server/src/resource/commit-reservation.ts';
import { ResourceReservationReceiptStore } from '../../../mcp-server/src/resource/reservation-receipt.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const now = '2026-09-23T00:03:00.000Z';
const expiresAt = '2026-09-23T00:30:00.000Z';
const ids = ['a-pool', 'z-pool'];
const scope = resourcePoolId => ({ collectorId: `collector-${resourcePoolId}`,
  source: 'provider-reported', accountScope, resourcePoolId });
const response = resourcePoolId => ({ schemaVersion: '1.0.0', kind: 'full',
  ...scope(resourcePoolId), sequence: 1, snapshot: { schemaVersion: '1.0.0', accountScope,
    resourcePoolId, accessPath: 'subscription', windows: [{ windowId: 'weekly', resetEpoch: 1,
      resetAt: '2026-09-30T00:00:00.000Z', revision: 1,
      limitBucket: { bucketId: `${resourcePoolId}-weekly`, kind: 'requests', unit: 'request',
        limit: 10, remaining: 10 }, coverage: 'complete',
      source: { kind: 'provider-observation', evidenceDigest },
      observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z' }] } });
const policy = resourcePoolId => ({ schemaVersion: '1.0.0', policyId: `policy-${resourcePoolId}`,
  revision: 1, accountScope, resourcePoolId,
  approval: { approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00.000Z', evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: [{ windowId: 'weekly', bucketId: `${resourcePoolId}-weekly`, unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] });
const request = (attemptId = 'attempt-1', amount = 5, revision = 1) => ({
  taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', attemptId,
  planRevision: revision, leaseEpoch: 1, expiresAt,
  pools: ids.map(resourcePoolId => ({ accountScope, resourcePoolId,
    windows: [{ windowId: 'weekly', amount, unit: 'request' }] })),
});
const ref = (bytes, id) => ({ schemaVersion: '1.0.0', namespace: 'task', id,
  digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
  hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' });
const retentionOwner = (realmId, intentId) => `resource-intent:sha256:${createHash('sha256')
  .update(canonicalJson({ domain: 'resource-retention-owner-v1', realmId, intentId })).digest('hex')}`;

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b08-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const retentionPath = path.join(root, 'retention.sqlite3');
  const retention = new ArtifactRetentionStore(retentionPath);
  const content = new RawContentStore(path.join(root, 'artifacts'));
  let currentPolicies = ids.map(policy);
  let currentTime = now;
  let leaseExpiry = '2026-09-23T00:20:00.000Z';
  let leaseOwnerId = 'owner-1';
  let binding;
  const currentLease = () => ({ authorityId: config.authorityId, realmId: config.realmId,
    ownerId: leaseOwnerId, leaseId: 'lease-1', epoch: 1, expiresAt: leaseExpiry });
  try {
    const collectors = ids.map(id => ({ scope: scope(id), collect: async () => response(id) }));
    const observations = new ResourceObservationStore(db, config, collectors);
    for (const collector of collectors) assert.equal((await observations.admit(collector)).kind, 'applied');
    const admissions = new ResourcePoolsAdmissionStore(db, config, currentPolicies, () => now);
    const commit = new ResourceReservationCommitStore(db, config, retention,
      () => binding, () => currentPolicies, currentLease, () => currentTime);
    const prepareBinding = async (reservationId, planBytes = Buffer.from('{"plan":1}')) => {
      const row = db.prepare(`SELECT task_id,run_id,slot_id,attempt_id,plan_revision,lease_epoch,request_digest
        FROM resource_reservations WHERE reservation_id = ?`).get(reservationId);
      const planRef = ref(planBytes, 'plan-1');
      await content.put(planRef, planBytes);
      const fields = { taskId: row.task_id, runId: row.run_id, slotId: row.slot_id,
        attemptId: row.attempt_id, planRevision: row.plan_revision,
        leaseEpoch: row.lease_epoch, requestDigest: row.request_digest };
      const plan = { referenceId: 'plan', ref: planRef };
      const bindingBytes = Buffer.from(canonicalJson({ domain: 'resource-commit-binding-v1',
        ...fields, references: [plan] }));
      const bindingRef = ref(bindingBytes, 'binding-1');
      await content.put(bindingRef, bindingBytes);
      binding = { ...fields, references: [{ referenceId: 'binding', ref: bindingRef }, plan] };
      return { binding, bindingRef, planRef };
    };
    await run({ db, config, retention, retentionPath, admissions, commit, currentLease,
      prepareBinding, getBinding: () => binding, setBinding: value => { binding = value; },
      setPolicies: value => { currentPolicies = value; }, setTime: value => { currentTime = value; },
      setLeaseExpiry: value => { leaseExpiry = value; },
      setLeaseOwnerId: value => { leaseOwnerId = value; } });
  } finally { retention.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('B08 commits one intent after pins and replays without treating commit as execution', async () => {
  await isolated(async ({ db, config, retention, admissions, commit, currentLease, prepareBinding }) => {
    const admitted = admissions.admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    const receipts = new ResourceReservationReceiptStore(db, config, currentLease,
      Buffer.alloc(32, 7), () => now);
    const receipt = receipts.issue(admitted.reservationId);
    const { bindingRef, planRef } = await prepareBinding(admitted.reservationId);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    assert.deepEqual(commit.commit(input), { kind: 'committed', ...input, replayed: false });
    assert.deepEqual(commit.commit(input), { kind: 'committed', ...input, replayed: true });
    assert.equal(db.prepare('SELECT state FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).state, 'committed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 1);
    assert.equal(db.prepare('SELECT state FROM resource_intents WHERE intent_id = ?').get('intent-1').state,
      'committed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 0);
    assert.equal(retention.tombstone(bindingRef), 'pinned');
    assert.equal(retention.tombstone(planRef), 'pinned');
    assert.throws(() => retention.release(retentionOwner(config.realmId, 'intent-1'), 'binding'),
      { code: 'GATE_FAILED' });
    assert.equal(receipts.verifyForLaunch(receipt).intentId, 'intent-1');
  });
});

test('B08 rejects other intent reuse, expired holds, policy drift, and binding drift', async () => {
  await isolated(async ({ db, retention, admissions, commit, prepareBinding,
    getBinding, setBinding, setPolicies, setTime }) => {
    const admitted = admissions.admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    await prepareBinding(admitted.reservationId);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    const changedPolicies = ids.map(policy); changedPolicies[1].revision = 2;
    setPolicies(changedPolicies);
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    setPolicies(ids.map(policy));
    setBinding({ ...getBinding(), taskId: 'other-task' });
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    await prepareBinding(admitted.reservationId);
    assert.equal(commit.commit(input).kind, 'committed');
    assert.throws(() => commit.commit({ ...input, intentId: 'intent-2' }),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 1);
    await prepareBinding(admitted.reservationId, Buffer.from('{"plan":2}'));
    assert.throws(() => commit.commit(input), { code: 'GATE_FAILED' });
    await prepareBinding(admitted.reservationId);

    const next = admissions.admitIdempotent(request('attempt-2', 1, 2));
    assert.equal(next.kind, 'admitted');
    await prepareBinding(next.reservationId);
    assert.throws(() => commit.commit({ reservationId: next.reservationId, intentId: 'intent-1' }),
      { code: 'REQUEST_CONFLICT' });
    setTime('2026-09-23T00:31:00.000Z');
    assert.throws(() => commit.commit({ reservationId: next.reservationId, intentId: 'intent-3' }),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(db.prepare('SELECT state FROM resource_reservations WHERE reservation_id = ?')
      .get(next.reservationId).state, 'held');
    assert.equal(retention.replayState(getBinding().references[0].ref), 'unknown');
  });
});

test('B08 journal fault leaves pending orphan pins and same intent retry publishes them', async () => {
  await isolated(async ({ db, retentionPath, admissions, commit, prepareBinding }) => {
    const admitted = admissions.admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    await prepareBinding(admitted.reservationId);
    db.exec(`CREATE TRIGGER fail_b08_intent BEFORE INSERT ON resource_intents
      BEGIN SELECT RAISE(ABORT, 'intent journal fault'); END;`);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    assert.throws(() => commit.commit(input), /intent journal fault/u);
    assert.equal(db.prepare('SELECT state FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).state, 'held');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 0);
    const metadata = new DatabaseSync(retentionPath);
    try {
      assert.deepEqual(metadata.prepare('SELECT phase FROM artifact_retention_pins ORDER BY reference_id')
        .all().map(row => row.phase), ['pending', 'pending']);
    } finally { metadata.close(); }
    db.exec('DROP TRIGGER fail_b08_intent;');
    assert.deepEqual(commit.commit(input), { kind: 'committed', ...input, replayed: false });
    const published = new DatabaseSync(retentionPath);
    try {
      assert.deepEqual(published.prepare('SELECT phase FROM artifact_retention_pins ORDER BY reference_id')
        .all().map(row => row.phase), ['published', 'published']);
    } finally { published.close(); }
  });
});

test('B08 rejects altered authority and malformed lease or expiry without publishing an intent', async () => {
  await isolated(async ({ db, config, admissions, commit, prepareBinding,
    setLeaseExpiry, setLeaseOwnerId }) => {
    const admitted = admissions.admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    await prepareBinding(admitted.reservationId);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    db.prepare('UPDATE resource_authority SET realm_id = ? WHERE id = 1').run('other-realm');
    assert.throws(() => commit.commit(input), { code: 'INTEGRITY_FAILED' });
    db.prepare('UPDATE resource_authority SET realm_id = ? WHERE id = 1').run(config.realmId);
    setLeaseExpiry('invalid');
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    setLeaseExpiry(9999999999999);
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    setLeaseExpiry('2026-09-23T00:20:00.000Z');
    setLeaseOwnerId('invalid owner');
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    setLeaseOwnerId('owner-1');
    db.prepare('UPDATE resource_reservations SET expires_at = ? WHERE reservation_id = ?')
      .run('invalid', admitted.reservationId);
    assert.throws(() => commit.commit(input), { code: 'REQUEST_CONFLICT' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 0);
  });
});

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => { if (message.type === type) { cleanup(); resolve(message); } };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B08 worker exited before ${type}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError); worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

async function compete(rollbackFirst) {
  await isolated(async ({ db, config, retentionPath, admissions, prepareBinding }) => {
    const admitted = admissions.admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    const { binding } = await prepareBinding(admitted.reservationId);
    const barrier = new SharedArrayBuffer(4);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    const workers = [0, 1].map(index => new Worker(
      new URL('./fixtures/b08-commit-worker.mjs', import.meta.url),
      { execArgv: ['--import', 'tsx'], workerData: { config, retentionPath, binding,
        policies: ids.map(policy), request: input, now, barrier,
        hold: index === 0, fail: index === 0 && rollbackFirst } },
    ));
    try {
      await Promise.all(workers.map(worker => waitFor(worker, 'ready')));
      const first = waitFor(workers[0], 'result');
      const holding = waitFor(workers[0], 'holding'); workers[0].postMessage('commit'); await holding;
      const second = waitFor(workers[1], 'result');
      const attempt = waitFor(workers[1], 'attempt'); workers[1].postMessage('commit'); await attempt;
      let settled = false;
      void second.then(() => { settled = true; }, () => { settled = true; });
      await delay(100);
      assert.equal(settled, false, 'second SQLite writer must wait for the first commit');
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      const outcomes = await Promise.all([first, second]);
      if (rollbackFirst) {
        assert.match(outcomes[0].error?.message ?? '', /forced commit fault/u);
        assert.equal(outcomes[1].result?.replayed, false);
      } else {
        assert.equal(outcomes[0].result?.replayed, false);
        assert.equal(outcomes[1].result?.replayed, true);
      }
      assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 1);
      assert.equal(db.prepare('SELECT state FROM resource_reservations WHERE reservation_id = ?')
        .get(admitted.reservationId).state, 'committed');
    } finally {
      Atomics.store(new Int32Array(barrier), 0, 1); Atomics.notify(new Int32Array(barrier), 0);
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  });
}

test('B08 two SQLite writers converge on one committed intent', async () => compete(false), 20_000);
test('B08 second writer succeeds after first transaction rollback', async () => compete(true), 20_000);
