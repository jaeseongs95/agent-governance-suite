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
import { ResourceReservationReleaseStore } from '../../../mcp-server/src/resource/release-reservation.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const requestJson = canonicalJson({ requestKey: 'request-1', taskId: 'task-1', runId: 'run-1',
  slotId: 'slot-1', attemptId: 'attempt-1', planRevision: 1, leaseEpoch: 1,
  accountScope, resourcePoolId: 'pool-1', expiresAt: '2026-09-23T00:06:00.000Z',
  windows: [{ windowId: 'weekly', amount: 4, unit: 'request' }],
  policyDigest: `sha256:${'d'.repeat(64)}` });
const digest = `sha256:${createHash('sha256').update(requestJson).digest('hex')}`;
const jobDigest = `sha256:${'b'.repeat(64)}`;
const now = '2026-09-23T00:10:00.000Z';
const intentCreated = '2026-09-23T00:02:00.000Z';
const receiptIssued = '2026-09-23T00:05:00.000Z';

async function isolated(state, withIntent, run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b09-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const reservationId = 'reservation-1';
  const intentId = 'intent-1';
  const opaqueReceipt = Object.freeze({ token: 'fake-trusted-no-start' });
  let verified = { kind: 'no-start', launchFenced: true,
    authorityId: config.authorityId, realmId: config.realmId,
    ownerId: 'owner-1', reservationId, intentId, invocationId: 'invocation-1',
    jobBindingDigest: jobDigest, requestDigest: digest, leaseEpoch: 1,
    issuedAt: receiptIssued, expiresAt: '2026-09-23T00:20:00.000Z' };
  let binding = { ownerId: 'owner-1', invocationId: 'invocation-1', jobBindingDigest: jobDigest };
  let currentTime = now;
  try {
    const release = new ResourceReservationReleaseStore(db, config,
      input => input === opaqueReceipt ? verified : null,
      () => binding, () => currentTime);
    db.prepare(`INSERT INTO resource_pools(account_scope,pool_id,access_path)
      VALUES (?,'pool-1','subscription')`).run(accountScope);
    db.prepare(`INSERT INTO resource_reservations
      (reservation_id,request_key,request_digest,task_id,run_id,slot_id,attempt_id,
        plan_revision,lease_epoch,state,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(reservationId, 'request-1', digest,
      'task-1', 'run-1', 'slot-1', 'attempt-1', 1, 1, state,
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:06:00.000Z');
    db.prepare(`INSERT INTO resource_admission_requests
      (request_key,request_digest,plan_revision,request_json,state,reservation_id)
      VALUES (?,?,?,?,?,?)`).run('request-1', digest, 1, requestJson, 'admitted', reservationId);
    db.prepare(`INSERT INTO resource_reservation_holds
      (reservation_id,account_scope,pool_id,window_id,reset_epoch,amount,unit)
      VALUES (?,?,?,?,?,?,?)`).run(reservationId, accountScope, 'pool-1', 'weekly', 1, 4, 'request');
    if (withIntent) db.prepare(`INSERT INTO resource_intents
      (intent_id,reservation_id,request_digest,state,created_at,updated_at)
      VALUES (?,?,?,'committed',?,?)`).run(intentId, reservationId, digest, intentCreated, intentCreated);
    await run({ db, config, release, reservationId, intentId, opaqueReceipt,
      getVerified: () => verified, setVerified: value => { verified = value; },
      setBinding: value => { binding = value; }, setTime: value => { currentTime = value; } });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

const state = (db, reservationId) => db.prepare(`SELECT state FROM resource_reservations
  WHERE reservation_id = ?`).get(reservationId).state;

function waitFor(worker, type) {
  return new Promise((resolve, reject) => {
    const onMessage = message => {
      if (message?.error) { cleanup(); reject(new Error(message.error)); }
      else if (message === type) { cleanup(); resolve(); }
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B09 worker exited before ${type}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError);
      worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

test('B09 releases an expired held reservation only when no intent exists and replay is inert', async () => {
  await isolated('held', false, async ({ db, release, reservationId }) => {
    assert.deepEqual(release.release({ reservationId }), { kind: 'released', reservationId });
    assert.deepEqual(release.release({ reservationId }), { kind: 'already-released', reservationId });
    assert.equal(state(db, reservationId), 'released');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n, 1);
  });
  await isolated('held', true, async ({ db, release, reservationId, opaqueReceipt }) => {
    assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(state(db, reservationId), 'held');
  });
  await isolated('held', false, async ({ db, release, reservationId }) => {
    db.prepare('DELETE FROM resource_admission_requests WHERE reservation_id = ?').run(reservationId);
    assert.throws(() => release.release({ reservationId }), { code: 'INTEGRITY_FAILED' });
    assert.equal(state(db, reservationId), 'held');
  });
});

test('B09 keeps committed reservation for timeout, not-found, cancel ACK and user zero claim', async () => {
  await isolated('committed', true, async ({ db, release, reservationId }) => {
    for (const noStartReceipt of [{ kind: 'timeout' }, { kind: 'provider-not-found' },
      { kind: 'cancel-ack' }, { kind: 'user-zero-usage' }]) {
      assert.throws(() => release.release({ reservationId, noStartReceipt }),
        { code: 'REQUEST_CONFLICT' });
      assert.equal(state(db, reservationId), 'committed');
    }
    assert.throws(() => release.release({ reservationId }), { code: 'REQUEST_CONFLICT' });
    assert.equal(state(db, reservationId), 'committed');
  });
});

test('B09 retains held and committed holds when admission request bytes are corrupted', async () => {
  for (const reservationState of ['held', 'committed']) {
    await isolated(reservationState, reservationState === 'committed', async ({
      db, release, reservationId, opaqueReceipt,
    }) => {
      db.prepare(`UPDATE resource_admission_requests SET request_json = '{}'
        WHERE reservation_id = ?`).run(reservationId);
      const input = { reservationId, ...(reservationState === 'committed'
        ? { noStartReceipt: opaqueReceipt } : {}) };
      assert.throws(() => release.release(input), { code: 'INTEGRITY_FAILED' });
      assert.equal(state(db, reservationId), reservationState);
      assert.equal(db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n, 1);
    });
  }
});

test('B09 rejects a rehashed journal that changes the reservation binding', async () => {
  await isolated('held', false, async ({ db, release, reservationId }) => {
    const changedJson = canonicalJson({ ...JSON.parse(requestJson), slotId: 'other-slot' });
    const changedDigest = `sha256:${createHash('sha256').update(changedJson).digest('hex')}`;
    db.prepare(`UPDATE resource_admission_requests SET request_json = ?, request_digest = ?
      WHERE reservation_id = ?`).run(changedJson, changedDigest, reservationId);
    db.prepare(`UPDATE resource_reservations SET request_digest = ? WHERE reservation_id = ?`)
      .run(changedDigest, reservationId);
    assert.throws(() => release.release({ reservationId }), { code: 'INTEGRITY_FAILED' });
    assert.equal(state(db, reservationId), 'held');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_reservation_holds').get().n, 1);
  });
});

test('B09 accepts a bound trusted no-start and duplicate release does not consume twice', async () => {
  await isolated('committed', true, async ({ db, release, reservationId, opaqueReceipt }) => {
    assert.deepEqual(release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { kind: 'released', reservationId });
    assert.deepEqual(release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { kind: 'already-released', reservationId });
    assert.equal(state(db, reservationId), 'released');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 0);
    db.prepare(`INSERT INTO resource_terminal_evidence
      (evidence_id,reservation_id,job_binding_digest,result,evidence_digest,payload_json,observed_at)
      VALUES (?,?,?,?,?,?,?)`).run('late-launch', reservationId, jobDigest,
      'started', digest, '{}', now);
    assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { code: 'REQUEST_CONFLICT' });
  });
  await isolated('uncertain', true, async ({ db, release, reservationId, opaqueReceipt }) => {
    assert.throws(() => release.release({ reservationId }), { code: 'REQUEST_CONFLICT' });
    assert.deepEqual(release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { kind: 'released', reservationId });
    assert.equal(state(db, reservationId), 'released');
  });
});

test('B09 rejects expired, mismatched or unverified no-start evidence', async () => {
  await isolated('committed', true, async ({ db, release, reservationId, opaqueReceipt,
    getVerified, setVerified, setBinding }) => {
    const original = getVerified();
    for (const change of [
      { intentId: 'other-intent' }, { invocationId: 'other-invocation' },
      { jobBindingDigest: `sha256:${'c'.repeat(64)}` }, { ownerId: 'other-owner' },
      { expiresAt: '2026-09-23T00:09:00.000Z' }, { issuedAt: '2026-09-23T00:01:00.000Z' },
      { kind: 'provider-not-found' }, { launchFenced: false },
    ]) {
      setVerified({ ...original, ...change });
      assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
        { code: 'REQUEST_CONFLICT' });
      assert.equal(state(db, reservationId), 'committed');
    }
    setVerified(original);
    setBinding({ ownerId: 'owner-1', invocationId: 'new-invocation', jobBindingDigest: jobDigest });
    assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { code: 'REQUEST_CONFLICT' });
  });
});

test('B09 retains reservation after a late launch event, including from another DB connection', async () => {
  await isolated('committed', true, async ({ db, config, release, reservationId, opaqueReceipt }) => {
    const worker = new Worker(new URL('./fixtures/b09-late-launch-worker.mjs', import.meta.url),
      { execArgv: [], workerData: { databasePath: config.databasePath, reservationId,
        jobDigest, digest, now } });
    try {
      const holding = waitFor(worker, 'holding');
      const done = waitFor(worker, 'done');
      await holding;
      assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
        { code: 'REQUEST_CONFLICT' });
      await done;
      assert.equal(state(db, reservationId), 'committed');
    } finally { await worker.terminate(); }
  });
  await isolated('committed', true, async ({ db, release, reservationId, opaqueReceipt }) => {
    db.prepare(`UPDATE resource_intents SET state = 'launched' WHERE reservation_id = ?`)
      .run(reservationId);
    assert.throws(() => release.release({ reservationId, noStartReceipt: opaqueReceipt }),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(state(db, reservationId), 'committed');
  });
});
