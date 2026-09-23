import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourcePoolsAdmissionStore } from '../../../mcp-server/src/resource/admit-pools.ts';
import { ResourceReservationReceiptStore } from '../../../mcp-server/src/resource/reservation-receipt.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const now = '2026-09-23T00:03:00.000Z';
const expiresAt = '2026-09-23T00:30:00.000Z';
const secret = Buffer.alloc(32, 7);
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
const request = (epoch = 1, attemptId = 'attempt-1', amount = 5) => ({
  taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', attemptId,
  planRevision: epoch, leaseEpoch: epoch, expiresAt,
  pools: ids.map(resourcePoolId => ({ accountScope, resourcePoolId,
    windows: [{ windowId: 'weekly', amount, unit: 'request' }] })),
});
const lease = (config, epoch = 1, ownerId = 'owner-1', leaseId = 'lease-1',
  leaseExpiry = '2026-09-23T00:20:00.000Z') => ({ authorityId: config.authorityId,
  realmId: config.realmId, ownerId, leaseId, epoch, expiresAt: leaseExpiry });

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b07-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  let db = new DatabaseSync(config.databasePath);
  try {
    const collectors = ids.map(id => ({ scope: scope(id), collect: async () => response(id) }));
    const observations = new ResourceObservationStore(db, config, collectors);
    for (const collector of collectors) assert.equal((await observations.admit(collector)).kind, 'applied');
    const policies = ids.map(policy);
    await run({ config, policies, db, reopen: () => {
      db.close(); db = new DatabaseSync(config.databasePath); return db;
    } });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

function commit(db, reservationId, digest, intentId = 'intent-1') {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare("UPDATE resource_reservations SET state = 'committed' WHERE reservation_id = ?")
      .run(reservationId);
    db.prepare(`INSERT INTO resource_intents
      (intent_id,reservation_id,request_digest,state,created_at,updated_at)
      VALUES (?,?,?,'committed',?,?)`).run(intentId, reservationId, digest, now, now);
    db.exec('COMMIT;');
  } catch (error) { db.exec('ROLLBACK;'); throw error; }
}

test('B07 receipt binds authority, reservation and committed intent at launch check', async () => {
  await isolated(async ({ config, policies, db }) => {
    let current = lease(config);
    const receipts = new ResourceReservationReceiptStore(db, config, () => current, secret, () => now);
    const admitted = new ResourcePoolsAdmissionStore(db, config, policies, () => now)
      .admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    current = lease(config, 1, 'owner-1', 'lease-1', '2026-09-23T00:02:00.000Z');
    assert.throws(() => receipts.issue(admitted.reservationId), { code: 'REQUEST_CONFLICT' });
    current = lease(config, 2, 'owner-2', 'lease-2');
    assert.throws(() => receipts.issue(admitted.reservationId), { code: 'REQUEST_CONFLICT' });
    current = lease(config);
    const receipt = receipts.issue(admitted.reservationId);
    assert.equal(receipt.authorityId, config.authorityId);
    assert.equal(receipt.realmId, config.realmId);
    assert.equal(receipt.leaseEpoch, 1);
    assert.equal(receipt.reservationId, admitted.reservationId);
    assert.throws(() => receipts.verifyForLaunch(receipt), { code: 'REQUEST_CONFLICT' });
    const digest = db.prepare('SELECT request_digest FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).request_digest;
    commit(db, admitted.reservationId, digest);
    assert.deepEqual(receipts.verifyForLaunch(receipt), { reservationId: admitted.reservationId,
      intentId: 'intent-1', requestDigest: digest });
    assert.throws(() => receipts.issue(admitted.reservationId), { code: 'REQUEST_CONFLICT' });
    const forged = { ...receipt, requestDigest: `sha256:${'f'.repeat(64)}` };
    assert.throws(() => receipts.verifyForLaunch(forged), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => receipts.verifyForLaunch({ ...receipt, mac: `hmac-sha256:${'0'.repeat(64)}` }),
      { code: 'REQUEST_CONFLICT' });
    current = lease(config, 1, 'owner-1', 'lease-1', '2026-09-23T00:02:00.000Z');
    assert.throws(() => receipts.verifyForLaunch(receipt), { code: 'REQUEST_CONFLICT' });
    current = lease(config);
    db.prepare('UPDATE resource_intents SET request_digest = ? WHERE intent_id = ?')
      .run(`sha256:${'e'.repeat(64)}`, 'intent-1');
    assert.throws(() => receipts.verifyForLaunch(receipt), { code: 'REQUEST_CONFLICT' });
  });
});

test('B07 old epoch and former owner receipts fail after restart without erasing committed intent', async () => {
  await isolated(async ({ config, policies, db, reopen }) => {
    const firstLease = lease(config);
    const first = new ResourceReservationReceiptStore(db, config, () => firstLease, secret, () => now);
    const admitted = new ResourcePoolsAdmissionStore(db, config, policies, () => now)
      .admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    const oldReceipt = first.issue(admitted.reservationId);
    const digest = db.prepare('SELECT request_digest FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).request_digest;
    commit(db, admitted.reservationId, digest);
    assert.equal(first.verifyForLaunch(oldReceipt).intentId, 'intent-1');

    db = reopen();
    let current = lease(config, 2, 'owner-2', 'lease-2');
    const second = new ResourceReservationReceiptStore(db, config, () => current, secret, () => now);
    assert.throws(() => second.verifyForLaunch(oldReceipt), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => second.issue(admitted.reservationId), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(db.prepare('SELECT state FROM resource_intents WHERE intent_id = ?').get('intent-1').state,
      'committed');
    assert.equal(db.prepare('SELECT state FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).state, 'committed');

    const next = new ResourcePoolsAdmissionStore(db, config, policies, () => now)
      .admitIdempotent(request(2, 'attempt-2', 1));
    assert.equal(next.kind, 'admitted');
    const newReceipt = second.issue(next.reservationId);
    assert.equal(newReceipt.ownerId, 'owner-2');
    assert.equal(newReceipt.leaseEpoch, 2);
    assert.notEqual(newReceipt.mac, oldReceipt.mac);
    current = lease(config, 2, 'owner-3', 'lease-3');
    assert.throws(() => second.verifyForLaunch(newReceipt), { code: 'REQUEST_CONFLICT' });
  });
});

test('B07 stale lease and incorrect authority secret cannot authorize launch', async () => {
  await isolated(async ({ config, policies, db }) => {
    let current = lease(config);
    const receipts = new ResourceReservationReceiptStore(db, config, () => current, secret, () => now);
    const admitted = new ResourcePoolsAdmissionStore(db, config, policies, () => now)
      .admitIdempotent(request());
    assert.equal(admitted.kind, 'admitted');
    const receipt = receipts.issue(admitted.reservationId);
    const digest = db.prepare('SELECT request_digest FROM resource_reservations WHERE reservation_id = ?')
      .get(admitted.reservationId).request_digest;
    commit(db, admitted.reservationId, digest);
    const wrongSecret = new ResourceReservationReceiptStore(db, config, () => current,
      Buffer.alloc(32, 8), () => now);
    assert.throws(() => wrongSecret.verifyForLaunch(receipt), { code: 'REQUEST_CONFLICT' });
    current = lease(config, 2, 'owner-1', 'lease-1');
    assert.throws(() => receipts.verifyForLaunch(receipt), { code: 'REQUEST_CONFLICT' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_intents').get().n, 1);
  });
});
