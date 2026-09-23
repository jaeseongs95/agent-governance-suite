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
import { ResourceReservationSettlementStore } from '../../../mcp-server/src/resource/settle-reservation.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const jobBindingDigest = `sha256:${'b'.repeat(64)}`;
const requestJson = canonicalJson({ requestKey: 'request-1', taskId: 'task-1', runId: 'run-1',
  slotId: 'slot-1', attemptId: 'attempt-1', planRevision: 1, leaseEpoch: 1,
  accountScope, resourcePoolId: 'pool-1', expiresAt: '2026-09-23T00:06:00.000Z',
  windows: [{ windowId: 'weekly', amount: 4, unit: 'request' }],
  policyDigest: `sha256:${'d'.repeat(64)}` });
const requestDigest = `sha256:${createHash('sha256').update(requestJson).digest('hex')}`;

function usage(eventId, amount, extra = {}) {
  const mode = extra.basis ?? 'delta';
  const sequence = mode === 'delta' ? Number(eventId.match(/\d+$/u)?.[0] ?? 1) : null;
  return { kind: 'usage', eventId, reservationId: 'reservation-1', intentId: 'intent-1',
    jobBindingDigest, accountScope, poolId: 'pool-1', windowId: 'weekly', amount,
    unit: 'request', basis: 'delta', coverage: 'partial', sequence,
    sourceDigest: `sha256:${'a'.repeat(64)}`, occurredAt: '2026-09-23T00:04:00.000Z', ...extra };
}
function terminal(extra = {}) {
  return { kind: 'terminal', evidenceId: 'terminal-1', reservationId: 'reservation-1',
    intentId: 'intent-1', jobBindingDigest, result: 'completed',
    evidenceDigest: `sha256:${'e'.repeat(64)}`, observedAt: '2026-09-23T00:05:00.000Z', ...extra };
}

async function isolated(run, onUnknown = 'retain') {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b11-'));
  const shared = path.join(root, 'shared'); mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const db = new DatabaseSync(config.databasePath);
  const tokens = new Map();
  const store = new ResourceReservationSettlementStore(db, config,
    opaque => tokens.get(opaque) ?? null,
    () => jobBindingDigest,
    () => ({ terminalResults: ['completed'], onUnknown }));
  const record = evidence => {
    const token = Object.freeze({ nonce: Symbol() });
    tokens.set(token, evidence);
    return store.record(token);
  };
  try {
    db.prepare(`INSERT INTO resource_pools(account_scope,pool_id,access_path)
      VALUES (?,'pool-1','subscription')`).run(accountScope);
    db.prepare(`INSERT INTO resource_reservations
      (reservation_id,request_key,request_digest,task_id,run_id,slot_id,attempt_id,
        plan_revision,lease_epoch,state,created_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,'committed',?,?)`).run('reservation-1', 'request-1', requestDigest,
      'task-1', 'run-1', 'slot-1', 'attempt-1', 1, 1,
      '2026-09-23T00:00:00.000Z', '2026-09-23T00:06:00.000Z');
    db.prepare(`INSERT INTO resource_admission_requests
      (request_key,request_digest,plan_revision,request_json,state,reservation_id)
      VALUES (?,?,?,?,?,?)`).run('request-1', requestDigest, 1, requestJson, 'admitted', 'reservation-1');
    db.prepare(`INSERT INTO resource_reservation_holds
      (reservation_id,account_scope,pool_id,window_id,reset_epoch,amount,unit)
      VALUES (?,?,?,?,?,?,?)`).run('reservation-1', accountScope, 'pool-1', 'weekly', 1, 4, 'request');
    db.prepare(`INSERT INTO resource_intents
      (intent_id,reservation_id,request_digest,state,created_at,updated_at)
      VALUES (?,?,?,'committed',?,?)`).run('intent-1', 'reservation-1', requestDigest,
      '2026-09-23T00:02:00.000Z', '2026-09-23T00:02:00.000Z');
    await run({ db, config, store, record });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}

const state = db => db.prepare(`SELECT state FROM resource_reservations
  WHERE reservation_id = 'reservation-1'`).get().state;
const coverage = db => ({ ...db.prepare(`SELECT coverage,observed_amount FROM resource_usage_coverage
  WHERE reservation_id = 'reservation-1'`).get() });

test('B11 partial delta usage accumulates before terminal, duplicate replays, excess remains observed', async () => {
  await isolated(({ db, record }) => {
    const first = record(usage('event-1', 3));
    assert.equal(first.kind, 'recorded');
    assert.equal(first.observed[0].observedAmount, 3);
    assert.equal(first.observed[0].coverage, 'partial');
    assert.equal(state(db), 'committed');
    assert.equal(record(usage('event-1', 3)).replayed, true);
    assert.deepEqual(coverage(db), { coverage: 'partial', observed_amount: 3 });
    assert.equal(record(usage('event-2', 5, { coverage: 'complete' })).kind, 'recorded');
    assert.equal(state(db), 'committed');
    const final = record(terminal());
    assert.equal(final.kind, 'settled');
    assert.deepEqual(final.observed[0], { accountScope, poolId: 'pool-1', windowId: 'weekly',
      unit: 'request', estimatedAmount: 4, observedAmount: 8, coverage: 'complete' });
    assert.equal(state(db), 'settled');
    assert.equal(record(terminal()).replayed, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 2);
  });
});

test('B11 cumulative stream uses the latest total and rejects delta mixing or decreasing totals', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-1', 2, { basis: 'cumulative' }));
    assert.throws(() => record(usage('event-2', 1, { basis: 'cumulative' })), { code: 'REQUEST_CONFLICT' });
    assert.throws(() => record(usage('event-2', 1)), { code: 'REQUEST_CONFLICT' });
    const second = record(usage('event-2', 6, { basis: 'cumulative', coverage: 'complete' }));
    assert.equal(second.observed[0].observedAmount, 6);
    assert.equal(state(db), 'committed');
    assert.equal(record(terminal()).observed[0].observedAmount, 6);
  });
});

test('B11 terminal and unknown coverage require an explicit server policy and retain unknown', async () => {
  await isolated(({ db, record }) => {
    record(terminal());
    const unknown = record(usage('event-1', null, { coverage: 'unknown' }));
    assert.equal(unknown.kind, 'recorded');
    assert.equal(state(db), 'committed');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: null });
  });
  await isolated(({ db, record }) => {
    const final = record(terminal());
    assert.equal(final.kind, 'settled');
    assert.equal(final.coverage, 'unknown');
    assert.equal(final.observed[0].observedAmount, null);
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: null });
    const late = record(usage('event-1', 3));
    assert.equal(late.kind, 'settled');
    assert.equal(late.coverage, 'unknown');
    assert.equal(late.observed[0].observedAmount, 3);
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 3 });
    assert.equal(state(db), 'settled');
  }, 'settle-with-unknown');
  await isolated(({ db, record }) => {
    record(usage('event-1', 2));
    const final = record(terminal());
    assert.equal(final.kind, 'settled');
    assert.equal(final.coverage, 'unknown');
    assert.equal(final.observed[0].observedAmount, 2);
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 2 });
  }, 'settle-with-unknown');
});

test('B11 retains reconciliation unknown despite complete usage replay', async () => {
  await isolated(({ db, record }) => {
    const complete = usage('event-1', 5, { coverage: 'complete' });
    record(complete);
    db.prepare(`UPDATE resource_usage_coverage SET coverage = 'unknown', observed_amount = NULL
      WHERE reservation_id = 'reservation-1'`).run();
    assert.equal(record(terminal()).kind, 'recorded');
    const replay = record(complete);
    assert.equal(replay.replayed, true);
    assert.equal(replay.kind, 'recorded');
    assert.equal(replay.coverage, 'unknown');
    assert.equal(coverage(db).coverage, 'unknown');
    assert.equal(state(db), 'committed');
  });
});

test('B11 does not replace a disagreeing complete reconciliation amount', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-1', 5, { coverage: 'complete' }));
    db.prepare(`UPDATE resource_usage_coverage SET observed_amount = 9
      WHERE reservation_id = 'reservation-1'`).run();
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 9 });
    assert.equal(state(db), 'committed');
  });
});

test('B11 preserves a larger partial reconciliation amount instead of claiming exact lower usage', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-1', 5, { coverage: 'complete' }));
    db.prepare(`UPDATE resource_usage_coverage SET coverage = 'partial', observed_amount = 9
      WHERE reservation_id = 'reservation-1'`).run();
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 9 });
    assert.equal(state(db), 'committed');
  });
  await isolated(({ db, record }) => {
    db.prepare(`INSERT INTO resource_usage_coverage
      (reservation_id,account_scope,pool_id,window_id,coverage,observed_amount,unit,updated_at)
      VALUES ('reservation-1',?,'pool-1','weekly','partial',9,'request',?)`).run(
      accountScope, '2026-09-23T00:04:00.000Z');
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 9 });
    assert.equal(state(db), 'committed');
  });
});

test('B11 preserves external partial even when its amount is below complete usage', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-1', 5, { coverage: 'complete' }));
    db.prepare(`UPDATE resource_usage_coverage SET coverage = 'partial', observed_amount = 3,
      updated_at = '2026-09-23T00:05:00.000Z' WHERE reservation_id = 'reservation-1'`).run();
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 5 });
    assert.equal(state(db), 'committed');
  });
});

test('B11 waits for missing earlier delta after terminal and then counts it once', async () => {
  await isolated(({ db, record }) => {
    const last = record(usage('event-2', 5, { coverage: 'complete' }));
    assert.equal(last.kind, 'recorded');
    assert.equal(last.coverage, 'partial');
    const before = record(terminal());
    assert.equal(before.kind, 'recorded');
    assert.equal(before.coverage, 'unknown');
    assert.equal(state(db), 'committed');
    const first = record(usage('event-1', 3));
    assert.equal(first.kind, 'settled');
    assert.equal(first.observed[0].observedAmount, 8);
    assert.equal(coverage(db).observed_amount, 8);
    assert.equal(state(db), 'settled');
    assert.equal(record(usage('event-1', 3)).replayed, true);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 2);
  });
});

test('B11 unknown-settlement policy retains a late earlier delta without claiming exact cost', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-2', 5, { coverage: 'complete' }));
    const terminalResult = record(terminal());
    assert.equal(terminalResult.kind, 'settled');
    assert.equal(terminalResult.coverage, 'unknown');
    assert.equal(terminalResult.observed[0].observedAmount, 5);
    const late = record(usage('event-1', 3));
    assert.equal(late.kind, 'settled');
    assert.equal(late.coverage, 'unknown');
    assert.equal(late.observed[0].observedAmount, 8);
    assert.equal(state(db), 'settled');
  }, 'settle-with-unknown');
});

test('B11 rejects a final delta marker before an already observed later sequence', async () => {
  await isolated(({ db, record }) => {
    record(usage('event-3', 2));
    assert.throws(() => record(usage('event-2', 5, { coverage: 'complete' })),
      { code: 'REQUEST_CONFLICT' });
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 1);
    assert.equal(state(db), 'committed');
  });
});

test('B11 refuses an external coverage unit mismatch without rewriting amount or state', async () => {
  for (const observedCoverage of ['complete', 'partial']) {
    await isolated(({ db, record }) => {
      db.prepare(`INSERT INTO resource_usage_coverage
        (reservation_id,account_scope,pool_id,window_id,coverage,observed_amount,unit,updated_at)
        VALUES ('reservation-1',?,'pool-1','weekly',?,9,'tokens',?)`).run(
        accountScope, observedCoverage, '2026-09-23T00:04:00.000Z');
      assert.throws(() => record(terminal()), { code: 'INTEGRITY_FAILED' });
      assert.equal(state(db), 'committed');
      assert.equal(db.prepare('SELECT count(*) AS n FROM resource_terminal_evidence').get().n, 0);
      assert.deepEqual({ ...db.prepare(`SELECT coverage,observed_amount,unit
        FROM resource_usage_coverage`).get() },
      { coverage: observedCoverage, observed_amount: 9, unit: 'tokens' });
    });
  }
});

test('B11 does not settle exact from external complete coverage without usage events', async () => {
  await isolated(({ db, record }) => {
    db.prepare(`INSERT INTO resource_usage_coverage
      (reservation_id,account_scope,pool_id,window_id,coverage,observed_amount,unit,updated_at)
      VALUES ('reservation-1',?,'pool-1','weekly','complete',9,'request',?)`).run(
      accountScope, '2026-09-23T00:04:00.000Z');
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 9 });
    assert.equal(state(db), 'committed');
  });
});

test('B11 does not treat equal external complete and event totals as proven overlap', async () => {
  await isolated(({ db, record }) => {
    db.prepare(`INSERT INTO resource_usage_coverage
      (reservation_id,account_scope,pool_id,window_id,coverage,observed_amount,unit,updated_at)
      VALUES ('reservation-1',?,'pool-1','weekly','complete',5,'request',?)`).run(
      accountScope, '2026-09-23T00:04:00.000Z');
    const event = record(usage('event-1', 5, { coverage: 'complete' }));
    assert.equal(event.coverage, 'unknown');
    const result = record(terminal());
    assert.equal(result.kind, 'recorded');
    assert.equal(result.coverage, 'unknown');
    assert.deepEqual(coverage(db), { coverage: 'unknown', observed_amount: 5 });
    assert.equal(state(db), 'committed');
  });
});

test('B11 terminal-only unknown under retain permits later complete evidence', async () => {
  await isolated(({ db, record }) => {
    assert.equal(record(terminal()).kind, 'recorded');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_coverage').get().n, 0);
    const later = record(usage('event-1', 6, { coverage: 'complete' }));
    assert.equal(later.kind, 'settled');
    assert.equal(later.coverage, 'complete');
    assert.deepEqual(coverage(db), { coverage: 'complete', observed_amount: 6 });
    assert.equal(state(db), 'settled');
  });
});

test('B11 rejects unverified, conflicting, foreign-bound and wrong-unit evidence atomically', async () => {
  await isolated(({ db, store, record }) => {
    assert.throws(() => store.record(usage('event-1', 2)), { code: 'INVALID_INPUT' });
    assert.throws(() => record(usage('event-1', 2, { jobBindingDigest: `sha256:${'f'.repeat(64)}` })),
      { code: 'REQUEST_CONFLICT' });
    assert.throws(() => record(usage('event-1', 2, { intentId: 'different' })),
      { code: 'REQUEST_CONFLICT' });
    assert.throws(() => record(usage('event-1', 2, { unit: 'tokens' })),
      { code: 'REQUEST_CONFLICT' });
    assert.throws(() => record(usage('event-1', 2, { exactCost: 0 })),
      { code: 'INVALID_INPUT' });
    record(usage('event-1', 2));
    assert.throws(() => record(usage('event-1', 3)), { code: 'REQUEST_CONFLICT' });
    record(terminal());
    assert.throws(() => record(terminal({ result: 'failed' })), { code: 'REQUEST_CONFLICT' });
    assert.equal(state(db), 'committed');
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 1);
  });
});

test('B11 restart preserves usage projection and replays terminal exactly once', async () => {
  await isolated(({ db, config, record }) => {
    record(usage('event-1', 2));
    const other = new DatabaseSync(config.databasePath);
    try {
      const replayStore = new ResourceReservationSettlementStore(other, config,
        opaque => opaque === 'terminal-token' ? terminal() : null,
        () => jobBindingDigest, () => ({ terminalResults: ['completed'], onUnknown: 'retain' }));
      assert.equal(replayStore.record('terminal-token').kind, 'recorded');
      assert.equal(record(usage('event-2', 3, { coverage: 'complete' })).kind, 'settled');
      assert.equal(replayStore.record('terminal-token').replayed, true);
      assert.equal(coverage(db).observed_amount, 5);
      assert.equal(state(db), 'settled');
    } finally { other.close(); }
  });
});

test('B11 a coverage write failure rolls back the usage event and leaves the hold active', async () => {
  await isolated(({ db, record }) => {
    db.exec(`CREATE TRIGGER fail_b11_coverage BEFORE INSERT ON resource_usage_coverage
      BEGIN SELECT RAISE(ABORT, 'coverage fault'); END;`);
    assert.throws(() => record(usage('event-1', 2)), /coverage fault/u);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_coverage').get().n, 0);
    assert.equal(state(db), 'committed');
  });
});

function waitFor(worker, expected) {
  return new Promise((resolve, reject) => {
    const onMessage = value => {
      if (value?.error) { cleanup(); reject(new Error(value.error)); }
      else if (value === expected) { cleanup(); resolve(); }
    };
    const onError = error => { cleanup(); reject(error); };
    const onExit = code => { cleanup(); reject(new Error(`B11 worker exited before ${expected}: ${code}`)); };
    const cleanup = () => { worker.off('message', onMessage); worker.off('error', onError);
      worker.off('exit', onExit); };
    worker.on('message', onMessage); worker.once('error', onError); worker.once('exit', onExit);
  });
}

test('B11 concurrent SQLite event insert is replayed once by the settlement writer', async () => {
  await isolated(async ({ db, config, record }) => {
    const event = usage('event-1', 2);
    const worker = new Worker(new URL('./fixtures/b11-usage-worker.mjs', import.meta.url),
      { execArgv: [], workerData: { databasePath: config.databasePath,
        event, payload: canonicalJson(event) } });
    try {
      const holding = waitFor(worker, 'holding');
      const done = waitFor(worker, 'done');
      await holding;
      assert.equal(record(event).replayed, true);
      await done;
      assert.equal(db.prepare('SELECT count(*) AS n FROM resource_usage_events').get().n, 1);
      assert.deepEqual(coverage(db), { coverage: 'partial', observed_amount: 2 });
      assert.equal(state(db), 'committed');
    } finally { await worker.terminate(); }
  });
});
