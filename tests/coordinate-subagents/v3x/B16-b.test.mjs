import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { test } from 'vitest';

import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';
import { ArtifactRetentionStore } from '../../../mcp-server/src/artifacts/retention.ts';
import { RawContentStore } from '../../../mcp-server/src/artifacts/content-store.ts';
import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { ResourceReservationCommitStore } from '../../../mcp-server/src/resource/commit-reservation.ts';
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
const request = (attemptId, amounts = [5, 5]) => ({ taskId: 'task-1', runId: 'run-1', slotId: 'slot-1', attemptId,
  planRevision: 1, leaseEpoch: 1, expiresAt: '2026-09-23T00:30:00.000Z',
  pools: poolIds.map((resourcePoolId, index) => ({ accountScope, resourcePoolId,
    windows: [{ windowId: 'weekly', amount: amounts[index], unit: 'request' }] })) });
const hash = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

function ledger(harness) {
  const db = new DatabaseSync(harness.config.databasePath, { readOnly: true });
  try {
    db.exec('BEGIN;');
    const rows = Object.fromEntries(['resource_reservations', 'resource_reservation_holds',
      'resource_admission_requests', 'resource_intents', 'resource_usage_events',
      'resource_terminal_evidence', 'resource_usage_coverage'].map(table =>
      [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
    db.exec('COMMIT;');
    return { rows, digest: hash(JSON.stringify(rows)) };
  } finally { db.close(); }
}

async function shard(id, run) {
  const harness = await ResourceAuthorityHarness.create({ timeoutMs: 8_000 });
  const evidence = { id, scope: 'isolated-fixture-only', status: 'NOT_RUN', timeoutMs: harness.timeoutMs,
    root: harness.root, databasePath: harness.config.databasePath, pids: harness.children.map(child => child.pid),
    connections: [], stages: [], sources: ['B16-b.test.mjs', 'fixtures/resource-authority-harness.mjs'].map(file =>
      ({ file: `tests/coordinate-subagents/v3x/${file}`, digest: hash(readFileSync(new URL(file, import.meta.url))) })) };
  const capture = label => { const observed = ledger(harness); evidence.stages.push({ label, ...observed }); return observed.rows; };
  try {
    const db = new DatabaseSync(harness.config.databasePath);
    try {
      const collectors = poolIds.map(resourcePoolId => ({ scope: scope(resourcePoolId), collect: async () => snapshot(resourcePoolId) }));
      const observations = new ResourceObservationStore(db, harness.config, collectors);
      for (const collector of collectors) assert.equal((await observations.admit(collector)).kind, 'applied');
    } finally { db.close(); }
    await harness.configure({ policies, now });
    evidence.connections = await Promise.all([0, 1].map(index => harness.request(index, { type: 'inspect' })));
    capture('before');
    await run({ harness, evidence, capture });
    capture('after');
    evidence.status = 'PASS';
  } catch (error) {
    evidence.status = /timed out/u.test(error.message) ? 'TIMEOUT' : 'FAIL';
    evidence.error = { message: error.message, code: error.code ?? null };
    if (existsSync(harness.config.databasePath)) capture('failure');
    throw error;
  } finally {
    const exits = await harness.close();
    if (evidence.connections.length > 2) await assert.rejects(harness.restart(0), /open harness/u);
    evidence.cleanup = { exits, allExited: evidence.pids.every(pid => !alive(pid)), rootRemoved: !existsSync(harness.root) };
    console.info('B16-b shard evidence', JSON.stringify(evidence));
    assert.equal(evidence.cleanup.allExited, true);
    assert.equal(evidence.cleanup.rootRemoved, true);
  }
}

async function competing(harness, firstRequest, secondRequest, fault, onHeld) {
  const dispatch = (index, input, injected) => input.type
    ? harness.transact(index, input, injected) : harness.admit(index, input, injected);
  const first = dispatch(0, firstRequest, fault);
  // Observe rejections immediately so a deliberate child/SQL fault cannot become an unhandled promise.
  const firstResult = first.result.then(value => ({ value }), error => ({ error }));
  await first.reached();
  const second = dispatch(1, secondRequest);
  let secondFinished = false;
  const secondResult = second.result.then(value => { secondFinished = true; return { value }; },
    error => { secondFinished = true; return { error }; });
  await second.started();
  assert.equal(secondFinished, false);
  await onHeld();
  first.release();
  return Promise.all([firstResult, secondResult]);
}

test('B16-b shared reserve serializes distinct attempts without oversubscription', async () => {
  await shard('shared-reserve', async ({ harness, evidence, capture }) => {
    const [one, { value: two, error: secondError }] = await competing(harness, request('winner'), request('contender'),
      { at: 'before-commit', fault: 'barrier' }, () => {
        const rows = capture('first-uncommitted-second-waiting');
        assert.equal(rows.resource_reservations.length, 0);
        assert.equal(rows.resource_reservation_holds.length, 0);
      });
    assert.equal(one.error, undefined);
    assert.equal(secondError, undefined);
    assert.equal(one.value.kind, 'admitted');
    assert.equal(two.kind, 'rejected');
    assert.equal(two.reason, 'INSUFFICIENT_LOCAL_CAPACITY');
    const rows = capture('serialized');
    assert.equal(rows.resource_reservations.length, 1);
    assert.equal(rows.resource_admission_requests.length, 2);
    assert.deepEqual(rows.resource_reservation_holds.map(row => [row.pool_id, row.amount]), [['a-pool', 5], ['z-pool', 5]]);
    assert.ok(rows.resource_reservation_holds.every(row => 10 - row.amount >= 3));
    evidence.results = [one.value, two];
  });
});

test('B16-b last-pool rejection rolls back the first hold before another process admits', async () => {
  await shard('multi-pool-rejection', async ({ harness, evidence, capture }) => {
    const [one, { value: two, error: secondError }] = await competing(harness, request('rejected', [5, 8]), request('winner'),
      { at: 'before-commit', fault: 'barrier' }, () => {
        const rows = capture('rejection-uncommitted-second-waiting');
        assert.equal(rows.resource_reservation_holds.length, 0);
      });
    assert.equal(one.error, undefined);
    assert.equal(secondError, undefined);
    assert.equal(one.value.kind, 'rejected');
    assert.equal(one.value.failedPool.resourcePoolId, 'z-pool');
    assert.equal(two.kind, 'admitted');
    const rows = capture('serialized');
    assert.equal(rows.resource_reservations.length, 1);
    assert.equal(rows.resource_reservation_holds.length, 2);
    assert.ok(rows.resource_reservation_holds.every(row => row.reservation_id === two.reservationId));
    assert.equal(rows.resource_admission_requests.length, 2);
    evidence.results = [one.value, two];
  });
});

test('B16-b last-pool write exception rolls back before the waiting process consumes capacity', async () => {
  await shard('multi-pool-exception', async ({ harness, evidence, capture }) => {
    const db = new DatabaseSync(harness.config.databasePath);
    try {
      db.exec(`CREATE TRIGGER fail_b16b_last_pool BEFORE INSERT ON resource_reservation_holds
        WHEN NEW.pool_id = 'z-pool' AND (SELECT attempt_id FROM resource_reservations
          WHERE reservation_id = NEW.reservation_id) = 'faulted'
        BEGIN SELECT RAISE(ABORT, 'B16-b last-pool fixture fault'); END;`);
    } finally { db.close(); }
    const [one, { value: two, error: secondError }] = await competing(harness, request('faulted'), request('winner'),
      { at: 'after-begin', fault: 'barrier' }, () => capture('faulting-writer-second-waiting'));
    assert.match(one.error.message, /B16-b last-pool fixture fault/u);
    assert.equal(secondError, undefined);
    assert.equal(two.kind, 'admitted');
    const rows = capture('serialized');
    assert.equal(rows.resource_reservations.length, 1);
    assert.equal(rows.resource_reservation_holds.length, 2);
    assert.equal(rows.resource_admission_requests.length, 1);
    assert.ok(rows.resource_reservation_holds.every(row => row.reservation_id === two.reservationId));
    evidence.results = [{ kind: 'fixture-sql-fault', message: one.error.message }, two];
  });
});

async function committed(harness) {
  const admitted = await harness.admit(0, request('dispatch')).result;
  assert.equal(admitted.kind, 'admitted');
  const db = new DatabaseSync(harness.config.databasePath);
  const retention = new ArtifactRetentionStore(path.join(harness.root, 'retention.sqlite3'));
  try {
    const content = new RawContentStore(path.join(harness.root, 'artifacts'));
    const row = db.prepare('SELECT * FROM resource_reservations WHERE reservation_id = ?').get(admitted.reservationId);
    const fields = { taskId: row.task_id, runId: row.run_id, slotId: row.slot_id, attemptId: row.attempt_id,
      planRevision: row.plan_revision, leaseEpoch: row.lease_epoch, requestDigest: row.request_digest };
    const reference = async (bytes, id) => {
      const ref = { schemaVersion: '1.0.0', namespace: 'task', id, digest: hash(bytes),
        hashDomain: 'raw-bytes', size: bytes.length, mediaType: 'application/json' };
      await content.put(ref, bytes);
      return ref;
    };
    const plan = { referenceId: 'plan', ref: await reference(Buffer.from('{"plan":1}'), 'plan-1') };
    const bindingRef = await reference(Buffer.from(canonicalJson({ domain: 'resource-commit-binding-v1',
      ...fields, references: [plan] })), 'binding-1');
    const binding = { ...fields, references: [{ referenceId: 'binding', ref: bindingRef }, plan] };
    const commit = new ResourceReservationCommitStore(db, harness.config, retention, () => binding, () => policies,
      () => ({ authorityId: harness.config.authorityId, realmId: harness.config.realmId, ownerId: 'fixture-owner',
        leaseId: 'lease-1', epoch: 1, expiresAt: '2026-09-23T00:20:00.000Z' }), () => now);
    const input = { reservationId: admitted.reservationId, intentId: 'intent-1' };
    assert.equal(commit.commit(input).kind, 'committed');
    return input;
  } finally { retention.close(); db.close(); }
}

const jobBindingDigest = `sha256:${'b'.repeat(64)}`;
function settlementEvidence(binding) {
  const usage = (poolId, sequence, amount, coverage) => ({ kind: 'usage',
    eventId: `${poolId}-${sequence}`, ...binding, jobBindingDigest, accountScope, poolId, windowId: 'weekly',
    amount, unit: 'request', basis: 'delta', coverage, sequence, sourceDigest: evidenceDigest,
    occurredAt: '2026-09-23T00:04:00.000Z' });
  return { 'partial-a': usage('a-pool', 1, 2, 'partial'), 'complete-a': usage('a-pool', 2, 3, 'complete'),
    'complete-z': usage('z-pool', 1, 5, 'complete'),
    terminal: { kind: 'terminal', evidenceId: 'terminal-1', ...binding, jobBindingDigest, result: 'completed',
      evidenceDigest, observedAt: '2026-09-23T00:05:00.000Z' } };
}

test('B16-b uncertain and denied release compete in separate processes without early refund', async () => {
  await shard('uncertain-no-refund', async ({ harness, evidence, capture }) => {
    const binding = await committed(harness);
    capture('committed-one-intent');
    const [one, two] = await competing(harness,
      { type: 'uncertain', request: { reservationId: binding.reservationId, reason: 'response-timeout' } },
      { type: 'release', request: { reservationId: binding.reservationId } },
      { at: 'before-commit', fault: 'barrier' }, () => {
        const rows = capture('uncertain-uncommitted-release-waiting');
        assert.equal(rows.resource_reservations[0].state, 'committed');
        assert.equal(rows.resource_intents.length, 1);
      });
    assert.equal(one.error, undefined);
    assert.equal(one.value.kind, 'observe-required');
    assert.equal(two.error.code, 'REQUEST_CONFLICT');
    await assert.rejects(harness.transact(1, { type: 'release', request: { reservationId: binding.reservationId,
      noStartReceipt: { kind: 'no-start', launchFenced: true } } }).result, { code: 'REQUEST_CONFLICT' });
    const replay = await harness.transact(1, { type: 'uncertain', request: {
      reservationId: binding.reservationId, reason: 'receipt-lost' } }).result;
    assert.equal(replay.replayed, true);
    // Expiry and observation loss are not evidence that dispatch never started.
    await harness.configure({ policies, now: '2026-09-23T00:31:00.000Z' });
    const contender = await harness.admit(1, { ...request('after-expiry'), expiresAt: '2026-09-23T00:50:00.000Z' }).result;
    assert.equal(contender.kind, 'rejected');
    assert.equal(contender.reason, 'INSUFFICIENT_LOCAL_CAPACITY');
    const rows = capture('uncertain-after-expiry');
    assert.equal(rows.resource_reservations[0].state, 'uncertain');
    assert.equal(rows.resource_reservation_holds.length, 2);
    assert.equal(rows.resource_intents.length, 1);
    evidence.results = [one.value, { deniedRelease: two.error.code }, replay, contender];
  });
});

test('B16-b fresh process restart replays lost usage and serializes duplicate settlement once', async () => {
  await shard('restart-duplicate-settlement', async ({ harness, evidence, capture }) => {
    const binding = await committed(harness);
    const fixtureSettlementEvidence = settlementEvidence(binding);
    await harness.configure({ policies, now, fixtureSettlementEvidence });
    await assert.rejects(harness.restart(0), /reaped/u);
    await assert.rejects(harness.transact(1, { type: 'settlement', token: fixtureSettlementEvidence['partial-a'] }).result,
      { code: 'INVALID_INPUT' });
    capture('committed-before-lost-usage');
    const old = evidence.connections[0];
    const crashed = harness.transact(0, { type: 'settlement', token: 'partial-a' }, { at: 'after-commit', fault: 'crash' });
    const failed = assert.rejects(crashed.result, /exited.*73/u);
    await crashed.reached();
    await failed;
    const durable = capture('usage-committed-response-lost');
    assert.equal(durable.resource_usage_events.length, 1);
    assert.equal(durable.resource_reservations[0].state, 'committed');
    const restarted = await harness.restart(0);
    assert.notEqual(restarted.pid, old.pid);
    assert.notEqual(restarted.connectionToken, old.connectionToken);
    assert.equal(restarted.databasePath, old.databasePath);
    assert.equal(restarted.realmId, old.realmId);
    evidence.pids.push(restarted.pid);
    evidence.connections.push(restarted);
    await harness.configure({ policies, now, fixtureSettlementEvidence });
    const replay = await harness.transact(0, { type: 'settlement', token: 'partial-a' }).result;
    assert.equal(replay.replayed, true);
    assert.equal(replay.observed.find(row => row.poolId === 'a-pool').observedAmount, 2);
    const [usageOne, usageTwo] = await competing(harness,
      { type: 'settlement', token: 'complete-a' }, { type: 'settlement', token: 'complete-a' },
      { at: 'before-commit', fault: 'barrier' }, () => capture('duplicate-usage-waiting'));
    assert.equal(usageOne.error, undefined);
    assert.equal(usageTwo.error, undefined);
    assert.equal(usageOne.value.replayed, false);
    assert.equal(usageTwo.value.replayed, true);
    await harness.transact(1, { type: 'settlement', token: 'complete-z' }).result;
    const beforeTerminal = capture('complete-usage-without-terminal');
    assert.equal(beforeTerminal.resource_reservations[0].state, 'committed');
    const [terminalOne, terminalTwo] = await competing(harness,
      { type: 'settlement', token: 'terminal' }, { type: 'settlement', token: 'terminal' },
      { at: 'before-commit', fault: 'barrier' }, () => capture('duplicate-terminal-waiting'));
    assert.equal(terminalOne.error, undefined);
    assert.equal(terminalTwo.error, undefined);
    assert.equal(terminalOne.value.kind, 'settled');
    assert.equal(terminalOne.value.replayed, false);
    assert.equal(terminalTwo.value.kind, 'settled');
    assert.equal(terminalTwo.value.replayed, true);
    const rows = capture('settled-once');
    assert.equal(rows.resource_reservations.length, 1);
    assert.equal(rows.resource_reservations[0].state, 'settled');
    assert.equal(rows.resource_intents.length, 1);
    assert.equal(rows.resource_usage_events.length, 3);
    assert.equal(rows.resource_terminal_evidence.length, 1);
    assert.deepEqual(rows.resource_usage_coverage.map(row => [row.pool_id, row.observed_amount, row.coverage]),
      [['a-pool', 5, 'complete'], ['z-pool', 5, 'complete']]);
    evidence.results = [replay, usageOne.value, usageTwo.value, terminalOne.value, terminalTwo.value];
  });
});
