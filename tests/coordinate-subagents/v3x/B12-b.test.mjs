import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourceUsageReconciliationStore } from '../../../mcp-server/src/resource/reconcile-usage.ts';
import { ResourceReservationSettlementStore } from '../../../mcp-server/src/resource/settle-reservation.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const jobBindingDigest = `sha256:${'b'.repeat(64)}`;
const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const window = (revision = 1, coverage = 'complete', remaining = 10) => ({
  windowId: 'weekly', resetEpoch: 1, resetAt: null, revision,
  limitBucket: { bucketId: 'bucket-1', kind: 'requests', unit: 'request',
    limit: 100, remaining }, coverage,
  source: { kind: 'provider-observation', evidenceDigest: digest(`evidence-${revision}`) },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z',
});
const input = (extra = {}) => ({
  snapshot: { accountScope, poolId: 'pool-1', windowId: 'weekly', resetEpoch: 1,
    unit: 'request', metricKind: 'remaining', observedAmount: 10, coverage: 'complete',
    jobBindingDigest, includedEventIds: [], excludedEventIds: [],
    watermarkSequence: null, ...extra },
  events: [],
  internalSlotBudget: { unit: 'slot', reservedAmount: 2, observedUse: 1 },
});
const correction = { eventId: 'correction-1', accountScope, poolId: 'pool-1',
    windowId: 'weekly', resetEpoch: 1, jobBindingDigest, unit: 'request',
    amount: 2, basis: 'delta', sequence: null, correctsEventId: 'event-1' };
const correctedOriginal = { ...correction, eventId: 'event-1', amount: 1,
  sequence: 1, correctsEventId: null };
const correctionInput = () => ({ ...input({ includedEventIds: ['event-1', 'correction-1'] }),
  events: [correctedOriginal, correction] });

function seedCorrectedEvent(db) {
  db.prepare(`INSERT INTO resource_reservations VALUES
    ('reservation-0','request-0',?,'task-0','run-0','slot-0','attempt-0',1,1,
     'committed','2026-09-23T00:00:00.000Z','2026-09-23T01:00:00.000Z')`).run(digest('request-0'));
  db.prepare(`INSERT INTO resource_reservation_holds VALUES
    ('reservation-0',?,?,'weekly',1,4,'request')`).run(accountScope, 'pool-1');
  const usage = { kind: 'usage', eventId: 'event-1', reservationId: 'reservation-0',
    intentId: 'intent-0', jobBindingDigest, accountScope, poolId: 'pool-1',
    windowId: 'weekly', amount: 1, unit: 'request', basis: 'delta',
    coverage: 'partial', sequence: 1, sourceDigest: digest('usage-0'),
    occurredAt: '2026-09-23T00:01:00.000Z' };
  db.prepare(`INSERT INTO resource_usage_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    usage.eventId, usage.reservationId, accountScope, 'pool-1', 'weekly',
    usage.amount, usage.unit, usage.basis, usage.coverage, jobBindingDigest,
    usage.sourceDigest, canonicalJson(usage), usage.occurredAt);
}

function observation(db, revision = 1, coverage = 'complete', remaining = 10) {
  const w = window(revision, coverage, remaining);
  const response = { schemaVersion: '1.0.0', collectorId: 'collector-1', sequence: revision,
    kind: 'full', snapshot: { schemaVersion: '1.0.0', accountScope,
      resourcePoolId: 'pool-1', accessPath: 'subscription', windows: [w] } };
  const payload = canonicalJson(response);
  const observationId = digest(payload);
  db.prepare(`INSERT INTO resource_observations VALUES (?,?,?,?,?,?,?)`).run(
    observationId, accountScope, 'pool-1', 'collector-1', revision, observationId, payload);
  db.prepare(`INSERT INTO resource_window_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(account_scope,pool_id,window_id) DO UPDATE SET
      observation_id=excluded.observation_id,reset_epoch=excluded.reset_epoch,
      revision=excluded.revision,unit=excluded.unit,remaining=excluded.remaining,
      observed_at=excluded.observed_at,expires_at=excluded.expires_at`).run(
    accountScope, 'pool-1', 'weekly', observationId, 1, revision,
    'bucket-1', 'request', remaining, w.observedAt, w.expiresAt);
}

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b12b-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared },
    process.platform, root);
  let db = new DatabaseSync(config.databasePath);
  const proofs = new Map();
  const makeStore = () => new ResourceUsageReconciliationStore(db, config,
    token => proofs.get(token) ?? null);
  try {
    let store = makeStore();
    db.prepare('INSERT INTO resource_pools VALUES (?,?,?)').run(accountScope, 'pool-1', 'subscription');
    observation(db);
    const token = proof => {
      const row = db.prepare(`SELECT observation_id,revision FROM resource_window_observations
        WHERE account_scope=? AND pool_id=? AND window_id='weekly'`).get(accountScope, 'pool-1');
      const key = Object.freeze({});
      proofs.set(key, { observationId: row.observation_id, revision: row.revision, input: proof });
      return key;
    };
    await run({ db, store, config, token, restart: () => {
      db.close(); db = new DatabaseSync(config.databasePath); store = makeStore();
      return { db, store };
    } });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('B12-b applies once, replays duplicate correction, and survives restart', async () => {
  await isolated(({ db, store, token, restart }) => {
    seedCorrectedEvent(db);
    const proof = token(correctionInput());
    const expected = store.capture(accountScope, 'pool-1', 'weekly');
    assert.equal(store.apply(expected, proof).kind, 'applied');
    assert.equal(store.apply(expected, proof).kind, 'duplicate');
    const next = store.capture(accountScope, 'pool-1', 'weekly');
    const changedCorrection = token({ ...correctionInput(), events: [
      correctedOriginal, { ...correction, amount: 9 }] });
    assert.throws(() => store.apply(next, changedCorrection), /collides/u);
    assert.equal(store.readCurrent(accountScope, 'pool-1', 'weekly').providerMetric.projectedAmount, 10);
    const reopened = restart().store;
    assert.equal(reopened.readCurrent(accountScope, 'pool-1', 'weekly').providerMetric.projectedAmount, 10);
    assert.equal(reopened.apply(expected, proof).kind, 'duplicate');
  });
});

test('B12-b snapshot replacement and B11 settlement invalidate stale projection', async () => {
  await isolated(({ db, store, config, token }) => {
    const proof = token(input());
    const old = store.capture(accountScope, 'pool-1', 'weekly');
    observation(db, 2, 'complete', 8);
    assert.equal(store.apply(old, proof).kind, 'stale');
    const fresh = store.capture(accountScope, 'pool-1', 'weekly');
    assert.equal(store.apply(fresh, proof).kind, 'stale');
    const currentProof = token(input({ observedAmount: 8 }));
    assert.equal(store.apply(fresh, currentProof).kind, 'applied');
    const requestJson = canonicalJson({ requestKey: 'request-1', taskId: 'task-1',
      runId: 'run-1', slotId: 'slot-1', attemptId: 'attempt-1', planRevision: 1,
      leaseEpoch: 1, accountScope, resourcePoolId: 'pool-1',
      expiresAt: '2026-09-23T01:00:00.000Z',
      windows: [{ windowId: 'weekly', amount: 4, unit: 'request' }],
      policyDigest: digest('policy') });
    const requestDigest = digest(requestJson);
    db.prepare(`INSERT INTO resource_reservations VALUES
      ('reservation-1','request-1',?,'task-1','run-1','slot-1','attempt-1',1,1,
       'committed','2026-09-23T00:00:00.000Z','2026-09-23T01:00:00.000Z')`).run(requestDigest);
    db.prepare(`INSERT INTO resource_reservation_holds VALUES
      ('reservation-1',?,?,'weekly',1,4,'request')`).run(accountScope, 'pool-1');
    db.prepare(`INSERT INTO resource_admission_requests
      (request_key,request_digest,plan_revision,request_json,state,reservation_id)
      VALUES ('request-1',?,1,?,'admitted','reservation-1')`).run(requestDigest, requestJson);
    db.prepare(`INSERT INTO resource_intents VALUES
      ('intent-1','reservation-1',?,'committed','2026-09-23T00:00:00.000Z',
       '2026-09-23T00:00:00.000Z')`).run(requestDigest);
    const usage = { kind: 'usage', eventId: 'event-2', reservationId: 'reservation-1',
      intentId: 'intent-1', jobBindingDigest, accountScope, poolId: 'pool-1',
      windowId: 'weekly', amount: 2, unit: 'request', basis: 'delta',
      coverage: 'partial', sequence: 1, sourceDigest: digest('usage'),
      occurredAt: '2026-09-23T00:02:00.000Z' };
    const evidence = token(usage);
    const settlement = new ResourceReservationSettlementStore(db, config,
      opaque => opaque === evidence ? usage : null,
      () => jobBindingDigest, () => ({ terminalResults: ['completed'], onUnknown: 'retain' }));
    assert.equal(settlement.record(evidence).kind, 'recorded');
    assert.equal(store.readCurrent(accountScope, 'pool-1', 'weekly'), null);
    assert.equal(store.apply(fresh, currentProof).kind, 'stale');
    const afterSettlement = store.capture(accountScope, 'pool-1', 'weekly');
    assert.throws(() => store.apply(afterSettlement, currentProof), /omits/u);
    const matchedUsage = { eventId: 'event-2', accountScope, poolId: 'pool-1',
      windowId: 'weekly', resetEpoch: 1, jobBindingDigest, unit: 'request',
      amount: 2, basis: 'delta', sequence: 1, correctsEventId: null };
    const boundProof = token({ ...input({ observedAmount: 8,
      excludedEventIds: ['event-2'] }), events: [matchedUsage] });
    assert.equal(store.apply(afterSettlement, boundProof).projection.providerMetric.projectedAmount, 6);
  });
});

test('B12-b evidence for an older observation cannot match a newer equal-valued snapshot', async () => {
  await isolated(({ db, store, token }) => {
    const oldProof = token(input());
    observation(db, 2, 'complete', 10);
    const expected = store.capture(accountScope, 'pool-1', 'weekly');
    assert.equal(store.apply(expected, oldProof).kind, 'stale');
    assert.equal(store.readCurrent(accountScope, 'pool-1', 'weekly'), null);
  });
});

test('B12-b removed window has no current revision or projection', async () => {
  await isolated(({ db, store, token }) => {
    const expected = store.capture(accountScope, 'pool-1', 'weekly');
    const proof = token(input());
    assert.equal(store.apply(expected, proof).kind, 'applied');
    const response = { schemaVersion: '1.0.0', collectorId: 'collector-1', sequence: 2,
      kind: 'full', snapshot: { schemaVersion: '1.0.0', accountScope,
        resourcePoolId: 'pool-1', accessPath: 'subscription',
        windows: [{ ...window(2), windowId: 'monthly' }] } };
    const payload = canonicalJson(response);
    const observationId = digest(payload);
    db.prepare('INSERT INTO resource_observations VALUES (?,?,?,?,?,?,?)').run(
      observationId, accountScope, 'pool-1', 'collector-1', 2, observationId, payload);
    db.prepare(`UPDATE resource_window_observations SET observation_id=?,remaining=NULL
      WHERE account_scope=? AND pool_id=? AND window_id='weekly'`).run(
      observationId, accountScope, 'pool-1');
    assert.equal(store.capture(accountScope, 'pool-1', 'weekly'), null);
    assert.equal(store.readCurrent(accountScope, 'pool-1', 'weekly'), null);
    assert.equal(store.apply(expected, proof).kind, 'stale');
  });
});

test('B12-b failed CAS write rolls back and unknown coverage stays conservative', async () => {
  await isolated(({ db, store, token }) => {
    observation(db, 2, 'unknown', 10);
    const unknown = token(input({ coverage: 'unknown', observedAmount: 10 }));
    const expected = store.capture(accountScope, 'pool-1', 'weekly');
    db.exec(`CREATE TRIGGER reject_reconciliation BEFORE INSERT ON resource_usage_reconciliation
      BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    assert.throws(() => store.apply(expected, unknown), /injected failure/u);
    assert.equal(db.isTransaction, false);
    assert.equal(store.readCurrent(accountScope, 'pool-1', 'weekly'), null);
    db.exec('DROP TRIGGER reject_reconciliation;');
    const result = store.apply(expected, unknown);
    assert.equal(result.kind, 'applied');
    assert.equal(result.projection.providerMetric.projectedAmount, null);
    assert.equal(result.projection.internalSlotBudget.reservedAmount, 2);
    assert.throws(() => store.apply(expected, token({ ...correctionInput(), events: [
      correction, correction] })), /duplicate/u);
  });
});
