import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { ResourcePoolAdmissionStore } from '../../../mcp-server/src/resource/admit-pool.ts';
import { ResourceReservationSettlementStore } from '../../../mcp-server/src/resource/settle-reservation.ts';
import { ResourceWindowRolloverStore } from '../../../mcp-server/src/resource/window-rollover.ts';

const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const evidenceDigest = `sha256:${'a'.repeat(64)}`;
const jobBindingDigest = `sha256:${'c'.repeat(64)}`;
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
const policy = { schemaVersion: '1.0.0', policyId: 'policy-1', revision: 1,
  accountScope, resourcePoolId: 'pool-1',
  approval: { approvedBy: 'operator', approvedAt: now, evidenceDigest },
  allowedAccessPaths: ['subscription'], onUnknown: 'block', onStale: 'block',
  windows: [{ windowId: 'weekly', bucketId: 'requests', unit: 'request',
    reservePolicy: { hardReserve: { minimumRemaining: 3, protectedRoleIds: ['audit'] } } }] };
const request = (key, amount = 1) => ({ requestKey: key, taskId: 'task-1',
  runId: 'run-1', slotId: 'slot-1', attemptId: key, planRevision: 1,
  leaseEpoch: 1, accountScope, resourcePoolId: 'pool-1',
  expiresAt: '2026-09-23T00:30:00.000Z',
  windows: [{ windowId: 'weekly', amount, unit: 'request' }] });
const terminal = reservationId => ({ kind: 'terminal', evidenceId: `terminal-${reservationId}`,
  reservationId, intentId: `intent-${reservationId}`, jobBindingDigest,
  result: 'completed', evidenceDigest, observedAt: '2026-09-23T00:03:00.000Z' });
const usage = (reservationId, amount) => ({ kind: 'usage',
  eventId: `usage-${reservationId}`, reservationId, intentId: `intent-${reservationId}`,
  jobBindingDigest, accountScope, poolId: 'pool-1', windowId: 'weekly',
  amount, unit: 'request', basis: 'delta', coverage: 'partial', sequence: 1,
  sourceDigest: evidenceDigest, occurredAt: '2026-09-23T00:02:00.000Z' });

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b13b-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared },
    process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  let latest = response(1, 1);
  const collector = { scope, collect: async () => latest };
  try {
    const rollover = new ResourceWindowRolloverStore(db, config, [collector]);
    assert.equal((await rollover.admit(collector)).kind, 'applied');
    const admission = new ResourcePoolAdmissionStore(db, config, policy, () => now);
    const roll = async (sequence = 2, epoch = 2) => {
      latest = response(sequence, epoch);
      return rollover.admit(collector);
    };
    await run({ db, config, rollover, admission, collector, roll,
      setResponse: value => { latest = value; } });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

function commit(db, admission, key) {
  const result = admission.admit(request(key));
  assert.equal(result.kind, 'admitted');
  const digest = db.prepare('SELECT request_digest FROM resource_reservations WHERE reservation_id=?')
    .get(result.reservationId).request_digest;
  db.prepare("UPDATE resource_reservations SET state='committed' WHERE reservation_id=?")
    .run(result.reservationId);
  db.prepare("INSERT INTO resource_intents VALUES (?,?,?,'committed',?,?)")
    .run(`intent-${result.reservationId}`, result.reservationId, digest, now, now);
  return result.reservationId;
}

test('B13-b pending holds and intent retain original epoch across a new observation', async () => {
  await isolated(async ({ db, rollover, admission, roll }) => {
    const held = admission.admit(request('held'));
    const committed = commit(db, admission, 'committed');
    const uncertain = admission.admit(request('uncertain'));
    db.prepare("UPDATE resource_reservations SET state='uncertain' WHERE reservation_id=?")
      .run(uncertain.reservationId);
    assert.equal((await roll()).kind, 'applied');
    const state = rollover.readCurrent(accountScope, 'pool-1', 'weekly');
    assert.equal(state.resetEpoch, 2);
    assert.equal(state.carryover.length, 3);
    const byId = new Map(state.carryover.map(item => [item.reservationId, item]));
    assert.equal(byId.get(held.reservationId).state, 'held');
    assert.equal(byId.get(committed).state, 'committed');
    assert.equal(byId.get(committed).intentId, `intent-${committed}`);
    assert.equal(byId.get(uncertain.reservationId).state, 'uncertain');
    assert.ok(state.carryover.every(item => item.originalResetEpoch === 1
      && item.heldAmount === 1 && item.inclusion === 'unknown'));
    assert.deepEqual(admission.admit(request('next', 5)),
      { kind: 'rejected', reason: 'INSUFFICIENT_LOCAL_CAPACITY' });
    assert.deepEqual(db.prepare('SELECT DISTINCT reset_epoch FROM resource_reservation_holds').all()
      .map(row => row.reset_epoch), [1]);
  });
});

test('B13-b settled unknown and partial consumption persist after rollover and restart', async () => {
  for (const amount of [null, 2]) await isolated(async ({ db, config, rollover, admission, roll }) => {
    const reservationId = commit(db, admission, 'old');
    const evidence = new Map();
    const settlement = new ResourceReservationSettlementStore(db, config,
      token => evidence.get(token) ?? null, () => jobBindingDigest,
      () => ({ terminalResults: ['completed'], onUnknown: 'settle-with-unknown' }));
    const record = value => { const token = Object.freeze({}); evidence.set(token, value);
      return settlement.record(token); };
    assert.equal((await roll()).kind, 'applied');
    if (amount !== null) record(usage(reservationId, amount));
    assert.equal(record(terminal(reservationId)).coverage, 'unknown');
    const first = rollover.readCurrent(accountScope, 'pool-1', 'weekly');
    const carried = first.carryover.find(item => item.reservationId === reservationId);
    assert.equal(carried.originalResetEpoch, 1);
    assert.equal(carried.state, 'settled');
    assert.equal(carried.coverage, 'unknown');
    assert.equal(carried.observedAmount, amount);
    assert.deepEqual(admission.admit(request('next')),
      { kind: 'rejected', reason: 'SETTLED_USAGE_UNKNOWN' });
    const other = new DatabaseSync(config.databasePath);
    try {
      const reloaded = new ResourceWindowRolloverStore(other, config,
        [{ scope, collect: async () => response(2, 2) }]);
      assert.deepEqual(reloaded.readCurrent(accountScope, 'pool-1', 'weekly'), first);
      const restartedAdmission = new ResourcePoolAdmissionStore(other, config, policy, () => now);
      assert.deepEqual(restartedAdmission.admit(request('restart')),
        { kind: 'rejected', reason: 'SETTLED_USAGE_UNKNOWN' });
    } finally { other.close(); }
  });
});

test('B13-b duplicate and late reset notification cannot rewind epoch or carryover', async () => {
  await isolated(async ({ db, rollover, admission, collector, roll, setResponse }) => {
    const old = admission.admit(request('old'));
    const applied = await roll();
    assert.equal(applied.kind, 'applied');
    const before = rollover.readCurrent(accountScope, 'pool-1', 'weekly');
    assert.deepEqual(await rollover.admit(collector),
      { kind: 'duplicate', observationId: applied.observationId });
    assert.equal((await roll(1, 1)).kind, 'out-of-order');
    await assert.rejects(() => roll(3, 1), { code: 'INVALID_INPUT' });
    assert.deepEqual(rollover.readCurrent(accountScope, 'pool-1', 'weekly'), before);
    assert.equal(before.carryover[0].reservationId, old.reservationId);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 2);
    setResponse(response(2, 2));
  });
});
