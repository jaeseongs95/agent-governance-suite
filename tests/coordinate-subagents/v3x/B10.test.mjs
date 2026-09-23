import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { test } from 'vitest';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceReservationReceiptStore } from '../../../mcp-server/src/resource/reservation-receipt.ts';
import { ResourceReservationReleaseStore } from '../../../mcp-server/src/resource/release-reservation.ts';
import { ResourceUncertainReservationStore } from '../../../mcp-server/src/resource/uncertain-reservation.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const jobBindingDigest = `sha256:${'b'.repeat(64)}`;
const requestJson = canonicalJson({ requestKey: 'request-1', taskId: 'task-1', runId: 'run-1',
  slotId: 'slot-1', attemptId: 'attempt-1', planRevision: 1, leaseEpoch: 1,
  accountScope, resourcePoolId: 'pool-1', expiresAt: '2026-09-23T00:06:00.000Z',
  windows: [{ windowId: 'weekly', amount: 4, unit: 'request' }],
  policyDigest: `sha256:${'d'.repeat(64)}` });
const digest = `sha256:${createHash('sha256').update(requestJson).digest('hex')}`;
const reservationId = 'reservation-1';
const intentId = 'intent-1';
const now = '2026-09-23T00:10:00.000Z';

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b10-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const opaqueReceipt = Object.freeze({ token: 'fake-trusted-no-start' });
  const verified = { kind: 'no-start', launchFenced: true, authorityId: config.authorityId,
    realmId: config.realmId, ownerId: 'owner-1', reservationId, intentId,
    invocationId: 'invocation-1', jobBindingDigest, requestDigest: digest, leaseEpoch: 1,
    issuedAt: '2026-09-23T00:05:00.000Z', expiresAt: '2026-09-23T00:20:00.000Z' };
  try {
    const uncertain = new ResourceUncertainReservationStore(db, config);
    const release = new ResourceReservationReleaseStore(db, config,
      input => input === opaqueReceipt ? verified : null,
      () => ({ ownerId: 'owner-1', invocationId: 'invocation-1', jobBindingDigest }), () => now);
    db.prepare(`INSERT INTO resource_pools(account_scope,pool_id,access_path)
      VALUES (?,'pool-1','subscription')`).run(accountScope);
    db.prepare(`INSERT INTO resource_reservations
      (reservation_id,request_key,request_digest,task_id,run_id,slot_id,attempt_id,
        plan_revision,lease_epoch,state,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,'committed',?,?)`).run(reservationId, 'request-1', digest,
      'task-1', 'run-1', 'slot-1', 'attempt-1', 1, 1,
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:06:00.000Z');
    db.prepare(`INSERT INTO resource_admission_requests
      (request_key,request_digest,plan_revision,request_json,state,reservation_id)
      VALUES (?,?,?,?,?,?)`).run('request-1', digest, 1, requestJson, 'admitted', reservationId);
    db.prepare(`INSERT INTO resource_reservation_holds
      (reservation_id,account_scope,pool_id,window_id,reset_epoch,amount,unit)
      VALUES (?,?,?,?,?,?,?)`).run(reservationId, accountScope, 'pool-1', 'weekly', 1, 4, 'request');
    db.prepare(`INSERT INTO resource_intents
      (intent_id,reservation_id,request_digest,state,created_at,updated_at)
      VALUES (?,?,?,'committed',?,?)`).run(intentId, reservationId, digest,
      '2026-09-23T00:02:00.000Z', '2026-09-23T00:02:00.000Z');
    await run({ db, config, uncertain, release, opaqueReceipt });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

const state = db => db.prepare(`SELECT state FROM resource_reservations
  WHERE reservation_id = ?`).get(reservationId).state;
const intentCount = db => db.prepare('SELECT count(*) AS n FROM resource_intents').get().n;

test('B10 timeout after commit requires observation and retains the sole intent and hold', async () => {
  await isolated(async ({ db, config, uncertain, release }) => {
    assert.deepEqual(uncertain.markUncertain({ reservationId, reason: 'response-timeout' }),
      { kind: 'observe-required', reservationId, intentId, replayed: false });
    assert.equal(state(db), 'uncertain');
    assert.equal(intentCount(db), 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n, 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 0);
    assert.throws(() => release.release({ reservationId }), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => release.release({ reservationId,
      noStartReceipt: { kind: 'user-zero-usage' } }), { code: 'REQUEST_CONFLICT' });
    const receipts = new ResourceReservationReceiptStore(db, config,
      () => ({ authorityId: config.authorityId, realmId: config.realmId,
        ownerId: 'owner-1', leaseId: 'lease-1', epoch: 1,
        expiresAt: '2026-09-23T00:20:00.000Z' }), Buffer.alloc(32, 7),
      () => '2026-09-23T00:03:00.000Z');
    assert.throws(() => receipts.issue(reservationId), { code: 'REQUEST_CONFLICT' });
    assert.equal(intentCount(db), 1);
  });
});

test('B10 receipt loss and a new connection replay uncertainty after restart', async () => {
  await isolated(async ({ db, config, uncertain }) => {
    assert.equal(uncertain.markUncertain({ reservationId, reason: 'receipt-lost' }).replayed, false);
    const reopened = new DatabaseSync(config.databasePath);
    try {
      const afterRestart = new ResourceUncertainReservationStore(reopened, config);
      assert.deepEqual(afterRestart.markUncertain({ reservationId, reason: 'owner-restarted' }),
        { kind: 'observe-required', reservationId, intentId, replayed: true });
      assert.equal(intentCount(reopened), 1);
    } finally { reopened.close(); }
    assert.equal(state(db), 'uncertain');
  });
});

test('B10 explicit trusted no-start resolution uses B09 release', async () => {
  await isolated(async ({ db, uncertain, release, opaqueReceipt }) => {
    uncertain.markUncertain({ reservationId, reason: 'owner-restarted' });
    assert.equal(state(db), 'uncertain');
    assert.deepEqual(release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { kind: 'released', reservationId });
    assert.equal(state(db), 'released');
    assert.equal(intentCount(db), 1);
  });
});

test('B10 rejects caller zero-use claims, missing intents and noncommitted reservations', async () => {
  await isolated(async ({ db, uncertain }) => {
    assert.throws(() => uncertain.markUncertain({ reservationId, reason: 'user-zero-usage' }),
      { code: 'INVALID_INPUT' });
    assert.equal(state(db), 'committed');
    db.prepare('DELETE FROM resource_intents WHERE reservation_id = ?').run(reservationId);
    assert.throws(() => uncertain.markUncertain({ reservationId, reason: 'receipt-lost' }),
      { code: 'REQUEST_CONFLICT' });
    db.prepare(`UPDATE resource_reservations SET state = 'held' WHERE reservation_id = ?`)
      .run(reservationId);
    assert.throws(() => uncertain.markUncertain({ reservationId, reason: 'response-timeout' }),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(state(db), 'held');
    assert.equal(intentCount(db), 0);
  });
});

test('B10 SQL fault rolls back without releasing a hold or issuing an intent', async () => {
  await isolated(async ({ db, uncertain }) => {
    db.exec(`CREATE TRIGGER fail_uncertain BEFORE UPDATE ON resource_reservations
      WHEN NEW.state = 'uncertain' BEGIN SELECT RAISE(ABORT, 'uncertain fault'); END;`);
    assert.throws(() => uncertain.markUncertain({ reservationId, reason: 'response-timeout' }),
      /uncertain fault/u);
    assert.equal(state(db), 'committed');
    assert.equal(intentCount(db), 1);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n, 1);
  });
});

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message?.error) { cleanup(); reject(new Error(message.error)); }
      else if (message === type) { cleanup(); resolve(); }
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B10 worker exited before ${type}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError);
      worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

test('B10 two SQLite writers converge on one uncertain reservation', async () => {
  await isolated(async ({ db, config, uncertain }) => {
    const worker = new Worker(new URL('./fixtures/b10-uncertain-worker.mjs', import.meta.url),
      { execArgv: [], workerData: { databasePath: config.databasePath, reservationId } });
    try {
      const holding = waitFor(worker, 'holding');
      const done = waitFor(worker, 'done');
      await holding;
      assert.deepEqual(uncertain.markUncertain({ reservationId, reason: 'response-timeout' }),
        { kind: 'observe-required', reservationId, intentId, replayed: true });
      await done;
      assert.equal(state(db), 'uncertain');
      assert.equal(intentCount(db), 1);
    } finally { await worker.terminate(); }
  });
});
