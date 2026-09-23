import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourcePoolAdmissionStore } from '../../../mcp-server/src/resource/admit-pool.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ResourceUsageReconciliationStore } from '../../../mcp-server/src/resource/reconcile-usage.ts';
import { ResourceReservationSettlementStore } from '../../../mcp-server/src/resource/settle-reservation.ts';

const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const jobBindingDigest = `sha256:${'c'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const scope = { collectorId: 'provider-1', source: 'provider-reported',
  accountScope, resourcePoolId: 'pool-1' };
const now = '2026-09-23T00:01:00.000Z';
const window = epoch => ({ windowId: 'weekly', resetEpoch: epoch,
  resetAt: '2026-09-30T00:00:00.000Z', revision: 1,
  limitBucket: { bucketId: 'requests', kind: 'requests', unit: 'request',
    limit: 10, remaining: 10 }, coverage: 'complete',
  source: { kind: 'provider-observation', evidenceDigest },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T01:00:00.000Z' });
const response = (sequence, epoch) => ({ schemaVersion: '1.0.0', kind: 'full',
  ...scope, sequence, snapshot: { schemaVersion: '1.0.0', accountScope,
    resourcePoolId: 'pool-1', accessPath: 'subscription', windows: [window(epoch)] } });
const policy = onUnknown => ({ schemaVersion: '1.0.0', policyId: 'policy-1',
  revision: 1, accountScope, resourcePoolId: 'pool-1',
  approval: { approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00.000Z',
    evidenceDigest }, allowedAccessPaths: ['subscription'], onUnknown,
  onStale: 'block', windows: [{ windowId: 'weekly', bucketId: 'requests',
    unit: 'request', reservePolicy: { hardReserve: {
      minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] });
const request = (key, amount = 1) => ({ requestKey: key, taskId: 'task-1',
  runId: 'run-1', slotId: 'slot-1', attemptId: key, planRevision: 1,
  leaseEpoch: 1, accountScope, resourcePoolId: 'pool-1',
  expiresAt: '2026-09-23T00:30:00.000Z',
  windows: [{ windowId: 'weekly', amount, unit: 'request' }] });
const usage = (reservationId, coverage, amount) => ({ kind: 'usage',
  eventId: 'event-1', reservationId, intentId: 'intent-1', jobBindingDigest,
  accountScope, poolId: 'pool-1', windowId: 'weekly', amount, unit: 'request',
  basis: 'delta', coverage, sequence: 1, sourceDigest: evidenceDigest,
  occurredAt: '2026-09-23T00:02:00.000Z' });
const terminal = reservationId => ({ kind: 'terminal', evidenceId: 'terminal-1',
  reservationId, intentId: 'intent-1', jobBindingDigest, result: 'completed',
  evidenceDigest, observedAt: '2026-09-23T00:03:00.000Z' });

async function isolated(run, onUnknown = 'block') {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b13a-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared },
    process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  let latest = response(1, 1);
  const collector = { scope, collect: async () => latest };
  try {
    const observation = new ResourceObservationStore(db, config, [collector]);
    assert.equal((await observation.admit(collector)).kind, 'applied');
    const admission = new ResourcePoolAdmissionStore(db, config, policy(onUnknown), () => now);
    const roll = async () => {
      latest = response(2, 2);
      assert.equal((await observation.admit(collector)).kind, 'applied');
    };
    const prepareSettlement = () => {
      const old = admission.admit(request('old'));
      assert.equal(old.kind, 'admitted');
      db.prepare("UPDATE resource_reservations SET state='committed' WHERE reservation_id=?")
        .run(old.reservationId);
      const header = db.prepare(`SELECT request_digest FROM resource_reservations
        WHERE reservation_id=?`).get(old.reservationId);
      db.prepare(`INSERT INTO resource_intents VALUES
        ('intent-1',?,?,'committed',?,?)`).run(old.reservationId,
        header.request_digest, now, now);
      const tokens = new Map();
      const settlement = new ResourceReservationSettlementStore(db, config,
        token => tokens.get(token) ?? null,
        () => jobBindingDigest,
        () => ({ terminalResults: ['completed'], onUnknown: 'settle-with-unknown' }));
      const record = evidence => {
        const token = Object.freeze({}); tokens.set(token, evidence);
        return settlement.record(token);
      };
      return { reservationId: old.reservationId, record };
    };
    await run({ db, config, admission, roll, prepareSettlement });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

test('B13-a B11 settled unknown NULL and partial stay blocked in same and next epoch', async () => {
  for (const amount of [null, 2]) for (const nextEpoch of [false, true]) {
    await isolated(async ({ db, admission, roll, prepareSettlement }) => {
      const { reservationId, record } = prepareSettlement();
      if (amount !== null) record(usage(reservationId, 'partial', amount));
      const result = record(terminal(reservationId));
      assert.equal(result.kind, 'settled');
      assert.equal(result.coverage, 'unknown');
      if (nextEpoch) await roll();
      const before = db.prepare('SELECT COUNT(*) AS n FROM resource_reservations').get().n;
      assert.deepEqual(admission.admit(request('next')),
        { kind: 'rejected', reason: 'SETTLED_USAGE_UNKNOWN' });
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_reservations').get().n, before);
    });
  }
});

test('B13-a unknown follows server-owned defer policy without estimating usage', async () => {
  await isolated(async ({ db, admission, prepareSettlement }) => {
    const { reservationId, record } = prepareSettlement();
    record(terminal(reservationId));
    assert.deepEqual(admission.admit(request('next')),
      { kind: 'deferred', reason: 'SETTLED_USAGE_UNKNOWN' });
    assert.deepEqual({ ...db.prepare(`SELECT coverage,observed_amount FROM resource_usage_coverage
      WHERE reservation_id=?`).get(reservationId) },
    { coverage: 'unknown', observed_amount: null });
  }, 'defer');
});

test('B13-a complete B11 usage needs current B12 projection; included usage is not debited twice', async () => {
  for (const included of [true, false]) await isolated(async ({ db, config, admission, prepareSettlement }) => {
    const { reservationId, record } = prepareSettlement();
    record(usage(reservationId, 'complete', 2));
    assert.equal(record(terminal(reservationId)).coverage, 'complete');
    assert.deepEqual(admission.admit(request('unproven', 7)),
      { kind: 'rejected', reason: 'SNAPSHOT_COVERAGE_UNKNOWN' });
    let verified;
    const reconciliation = new ResourceUsageReconciliationStore(db, config,
      token => token === 'proof' ? verified : null);
    const revision = reconciliation.capture(accountScope, 'pool-1', 'weekly');
    verified = { observationId: revision.observationId, revision: revision.revision,
      input: { snapshot: { accountScope, poolId: 'pool-1', windowId: 'weekly',
        resetEpoch: 1, unit: 'request', metricKind: 'remaining', observedAmount: 10,
        coverage: 'complete', jobBindingDigest,
        includedEventIds: included ? ['event-1'] : [],
        excludedEventIds: included ? [] : ['event-1'], watermarkSequence: null },
      events: [{ eventId: 'event-1', accountScope, poolId: 'pool-1',
        windowId: 'weekly', resetEpoch: 1, jobBindingDigest, unit: 'request',
        amount: 2, basis: 'delta', sequence: 1, correctsEventId: null }],
      internalSlotBudget: { unit: 'slot', reservedAmount: 0, observedUse: null } } };
    assert.equal(reconciliation.apply(revision, 'proof').kind, 'applied');
    assert.equal(reconciliation.readCurrent(accountScope, 'pool-1', 'weekly')
      .providerMetric.projectedAmount, included ? 10 : 8);
    assert.deepEqual(admission.admit(request('next', 7)), included
      ? { kind: 'admitted', reservationId: db.prepare(`SELECT reservation_id FROM
          resource_reservations WHERE request_key='next'`).get().reservation_id }
      : { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
  });
});

test('B13-a older held, committed and uncertain reservations stay counted across reset', async () => {
  for (const state of ['held', 'committed', 'uncertain']) await isolated(async ({ db, admission, roll }) => {
    const old = admission.admit(request('old', 1));
    assert.equal(old.kind, 'admitted');
    db.prepare('UPDATE resource_reservations SET state=? WHERE reservation_id=?')
      .run(state, old.reservationId);
    await roll();
    assert.deepEqual(admission.admit(request('next', 7)),
      { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
  });
});

test('B13-a mismatched unit and damaged complete origin fail closed', async () => {
  for (const damage of ['unit', 'amount']) await isolated(async ({ db, admission, prepareSettlement }) => {
    const { reservationId, record } = prepareSettlement();
    record(usage(reservationId, 'complete', 2));
    record(terminal(reservationId));
    if (damage === 'unit') db.prepare(`UPDATE resource_usage_coverage SET unit='token'
      WHERE reservation_id=?`).run(reservationId);
    else db.prepare(`UPDATE resource_usage_coverage SET observed_amount=9
      WHERE reservation_id=?`).run(reservationId);
    assert.deepEqual(admission.admit(request('next')),
      { kind: 'rejected', reason: damage === 'unit'
        ? 'SETTLED_USAGE_UNIT_MISMATCH' : 'SETTLED_USAGE_UNKNOWN' });
  });
});
