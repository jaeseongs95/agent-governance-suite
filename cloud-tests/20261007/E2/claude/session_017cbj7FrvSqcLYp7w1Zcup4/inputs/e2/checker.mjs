import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tick = () => new Promise(resolve => setImmediate(resolve));
function gate() {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  return { wait, release };
}
function deadline(work, ms = 1500) {
  let timer;
  return Promise.race([work, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('CHECKER_DEADLINE')), ms);
  })]).finally(() => clearTimeout(timer));
}
const req = (id, amount = 7) => ({ id, amount });
const state = (ledger, total, effects, keys, pending = 0) =>
  assert.deepEqual(ledger.snapshot(), { total, effects, keys, pending });
const reject = (work, code) => assert.rejects(work, error => error?.message === code);

// 기대값은 공개 계약과 손계산 상수에서 정한다. target 내부 상태/알고리즘을 oracle로 읽지 않는다.
export async function runSuite(createLedger) {
  const cases = [
    ['C01-empty-normal-bounds', async () => {
      const l = createLedger(); state(l, 0, 0, 0);
      assert.deepEqual(await l.apply(req('a', 1)), { id: 'a', amount: 1, total: 1 });
      assert.deepEqual(await l.apply(req('x'.repeat(64), 1000)), { id: 'x'.repeat(64), amount: 1000, total: 1001 });
      state(l, 1001, 2, 2);
    }],
    ['C02-invalid-no-effect', async () => {
      const l = createLedger();
      const invalidInputs = [undefined, null, [], {}, req(''), req('x'.repeat(65)), req('한글'),
        req('a', 0), req('a', 1001), req('a', 1.5), req('a', '7'), req('a', NaN)];
      for (const input of invalidInputs) {
        await reject(l.apply(input), 'INVALID_REQUEST'); state(l, 0, 0, 0);
      }
      await l.apply(req('a'));
      for (const input of invalidInputs) {
        await reject(l.apply(input), 'INVALID_REQUEST'); state(l, 7, 1, 1);
      }
      assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 }); state(l, 7, 1, 1);
      for (const limit of [0, 1025, 1.5]) assert.throws(() => createLedger({ maxKeys: limit }), /INVALID_LIMIT/);
    }],
    ['C03-sequential-duplicate-conflict', async () => {
      const l = createLedger(); const first = await l.apply(req('a'));
      assert.deepEqual(await l.apply(req('a')), first);
      await reject(l.apply(req('a', 8)), 'CONFLICT'); state(l, 7, 1, 1);
    }],
    ['C04-concurrent-same-id', async () => {
      const l = createLedger(); const g = gate(); let calls = 0;
      const hook = async () => { calls++; await g.wait; };
      const a = l.apply(req('a'), { beforeCommit: hook });
      const b = l.apply(req('a'), { beforeCommit: hook });
      const observed = Promise.allSettled([a, b]);
      try { await tick(); state(l, 0, 0, 1, 1); } finally { g.release(); }
      const results = await observed;
      assert.equal(calls, 1);
      assert.deepEqual(results, [0, 1].map(() => ({ status: 'fulfilled', value: { id: 'a', amount: 7, total: 7 } })));
      state(l, 7, 1, 1);
    }],
    ['C05-pending-payload-conflict', async () => {
      const l = createLedger(); const g = gate();
      const a = l.apply(req('a'), { beforeCommit: () => g.wait });
      const conflict = Promise.allSettled([l.apply(req('a', 8))]);
      try { await tick(); } finally { g.release(); }
      assert.deepEqual(await conflict, [{ status: 'rejected', reason: new Error('CONFLICT') }]);
      await a; state(l, 7, 1, 1);
    }],
    ['C06-timeout-releases-pending-retry', async () => {
      const l = createLedger({ maxKeys: 1 }); const g = gate(); let calls = 0;
      const hook = async () => { calls++; await g.wait; throw new Error('TIMED_OUT'); };
      const results = Promise.allSettled([l.apply(req('a'), { beforeCommit: hook }), l.apply(req('a'), { beforeCommit: hook })]);
      try { await tick(); state(l, 0, 0, 1, 1); } finally { g.release(); }
      const out = await results;
      assert.equal(calls, 1); assert.equal(out.length, 2);
      for (const r of out) { assert.equal(r.status, 'rejected'); assert.equal(r.reason.message, 'TIMED_OUT'); }
      state(l, 0, 0, 0);
      await l.apply(req('a')); state(l, 7, 1, 1);
    }],
    ['C07-ack-lost-retry', async () => {
      const l = createLedger(); await reject(l.apply(req('a'), { loseAck: true }), 'ACK_LOST');
      state(l, 7, 1, 1);
      assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 });
      state(l, 7, 1, 1);
      await reject(l.apply(req('a'), { loseAck: true }), 'ACK_LOST'); state(l, 7, 1, 1);
      assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 }); state(l, 7, 1, 1);
    }],
    ['C08-capacity-pending-and-retained-retry', async () => {
      const l = createLedger({ maxKeys: 1 }); const g = gate();
      const a = l.apply(req('a'), { beforeCommit: () => g.wait });
      const rejected = Promise.allSettled([l.apply(req('b'))]);
      const pendingConflict = Promise.allSettled([l.apply(req('a', 8))]);
      try {
        await tick(); state(l, 0, 0, 1, 1);
      } finally { g.release(); }
      const conflictResult = await pendingConflict;
      assert.equal(conflictResult[0].status, 'rejected'); assert.equal(conflictResult[0].reason.message, 'CONFLICT');
      const out = await rejected; assert.equal(out[0].status, 'rejected'); assert.equal(out[0].reason.message, 'CAPACITY');
      await a; await l.apply(req('a'));
      await reject(l.apply(req('a', 8)), 'CONFLICT'); state(l, 7, 1, 1);
      await reject(l.apply(req('b')), 'CAPACITY'); state(l, 7, 1, 1);
    }],
    ['C09-result-alias-isolation', async () => {
      const l = createLedger(); const first = await l.apply(req('a')); const second = await l.apply(req('a'));
      first.total = 500; second.total = 600;
      assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 }); state(l, 7, 1, 1);
    }],
    ['C10-permutation-duplicate-metamorphic', async () => {
      for (const inputs of [[req('a', 2), req('b', 3)], [req('b', 3), req('a', 2)],
        [req('a', 2), req('a', 2), req('b', 3), req('b', 3)], []]) {
        const l = createLedger(); await Promise.all(inputs.map(x => l.apply(x)));
        const empty = inputs.length === 0; state(l, empty ? 0 : 5, empty ? 0 : 2, empty ? 0 : 2);
      }
    }],
    ['C11-capacity-boundary-load', async () => {
      const l = createLedger({ maxKeys: 32 });
      await Promise.all(Array.from({ length: 32 }, (_, i) => l.apply(req(`k${i}`, 1))));
      state(l, 32, 32, 32); await reject(l.apply(req('overflow', 1)), 'CAPACITY');
      await l.apply(req('k0', 1)); state(l, 32, 32, 32);
    }]
  ];
  const results = [];
  for (const [id, run] of cases) {
    try { await deadline(run()); results.push({ id, state: 'PASS' }); }
    catch (error) { results.push({ id, state: error.message === 'CHECKER_DEADLINE' ? 'TIMED_OUT' : 'FAIL', error: error.message }); }
  }
  return { oracleVersion: '1.0.1', verdict: results.every(x => x.state === 'PASS') ? 'PASS' : 'FAIL', results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) { console.error('사용법: node e2/checker.mjs <target.mjs>'); process.exitCode = 2; }
  else {
    try {
      const { createLedger } = await import(pathToFileURL(resolve(process.argv[2])).href);
      assert.equal(typeof createLedger, 'function');
      const report = await runSuite(createLedger); console.log(JSON.stringify(report, null, 2));
      process.exitCode = report.verdict === 'PASS' ? 0 : 1;
    } catch (error) { console.error(JSON.stringify({ state: 'INPUT_ERROR', error: error.message })); process.exitCode = 2; }
  }
}
