// 기준 checker(e2/checker.mjs)를 대체하지 않는 보강 검사. 사용법: node output/e2/extra-checks.mjs <target.mjs>
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const tick = () => new Promise(r => setImmediate(r));
const gate = () => { let release; const wait = new Promise(r => { release = r; }); return { wait, release }; };
const req = (id, amount = 7) => ({ id, amount });
const state = (l, total, effects, keys, pending = 0) => assert.deepEqual(l.snapshot(), { total, effects, keys, pending });
const rejects = (work, code) => assert.rejects(work, e => e?.message === code);

const cases = [
  ['X01-default-maxKeys-32-and-1024-bound', async createLedger => {
    const l = createLedger();
    for (let i = 0; i < 32; i++) await l.apply(req(`k${i}`, 1));
    await rejects(l.apply(req('k32', 1)), 'CAPACITY'); state(l, 32, 32, 32);
    const big = createLedger({ maxKeys: 1024 });
    await Promise.all(Array.from({ length: 1024 }, (_, i) => big.apply(req(`k${i}`, 1000))));
    state(big, 1024000, 1024, 1024); await rejects(big.apply(req('more', 1)), 'CAPACITY');
    createLedger({ maxKeys: 1 });
    for (const bad of [-1, '32', NaN, Infinity, null]) assert.throws(() => createLedger({ maxKeys: bad }), /INVALID_LIMIT/);
  }],
  ['X02-id-charset-boundaries', async createLedger => {
    const l = createLedger();
    for (const id of ['-', '_', 'A-z_09', '__proto__', 'constructor']) await l.apply(req(id, 1));
    state(l, 5, 5, 5);
    for (const id of ['a b', 'a.b', 'a\n', 'é', 7, 'x'.repeat(65)]) await rejects(l.apply({ id, amount: 1 }), 'INVALID_REQUEST');
    for (const amount of [-1, Infinity, 1e3 + 0.5, null, undefined, 7n]) await rejects(l.apply({ id: 'z', amount }), 'INVALID_REQUEST');
    state(l, 5, 5, 5);
  }],
  ['X03-many-concurrent-duplicates-one-effect', async createLedger => {
    const l = createLedger(); const g = gate(); let calls = 0;
    const hook = async () => { calls++; await g.wait; };
    const all = Promise.all(Array.from({ length: 100 }, () => l.apply(req('a'), { beforeCommit: hook })));
    await tick(); state(l, 0, 0, 1, 1); g.release();
    const out = await all; assert.equal(calls, 1);
    for (const r of out) assert.deepEqual(r, { id: 'a', amount: 7, total: 7 });
    assert.equal(new Set(out).size, 100, '각 호출은 독립된 반환 객체');
    state(l, 7, 1, 1);
  }],
  ['X04-pending-conflict-no-hook-no-effect', async createLedger => {
    const l = createLedger(); const g = gate(); let conflictHook = 0;
    const a = l.apply(req('a'), { beforeCommit: () => g.wait });
    await rejects(l.apply(req('a', 8), { beforeCommit: async () => { conflictHook++; } }), 'CONFLICT');
    state(l, 0, 0, 1, 1); g.release(); await a;
    assert.equal(conflictHook, 0); state(l, 7, 1, 1);
  }],
  ['X05-sync-throw-and-non-function-hook-release', async createLedger => {
    const l = createLedger({ maxKeys: 1 });
    await rejects(l.apply(req('a'), { beforeCommit: () => { throw new Error('SYNC'); } }), 'SYNC'); state(l, 0, 0, 0);
    await assert.rejects(l.apply(req('a'), { beforeCommit: 'nope' })); state(l, 0, 0, 0);
    await l.apply(req('b')); state(l, 7, 1, 1);
  }],
  ['X06-timeout-then-retry-with-different-amount-allowed', async createLedger => {
    const l = createLedger();
    await rejects(l.apply(req('a'), { beforeCommit: async () => { throw new Error('TIMED_OUT'); } }), 'TIMED_OUT');
    assert.deepEqual(await l.apply(req('a', 9)), { id: 'a', amount: 9, total: 9 }); state(l, 9, 1, 1);
  }],
  ['X07-ack-lost-on-pending-waiter', async createLedger => {
    const l = createLedger(); const g = gate();
    const a = l.apply(req('a'), { beforeCommit: () => g.wait });
    const b = Promise.allSettled([l.apply(req('a'), { loseAck: true })]);
    await tick(); g.release();
    assert.deepEqual(await a, { id: 'a', amount: 7, total: 7 });
    const [r] = await b; assert.equal(r.status, 'rejected'); assert.equal(r.reason.message, 'ACK_LOST');
    state(l, 7, 1, 1);
    assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 });
  }],
  ['X08-ack-lost-then-conflict', async createLedger => {
    const l = createLedger();
    await rejects(l.apply(req('a'), { loseAck: true }), 'ACK_LOST');
    await rejects(l.apply(req('a', 8)), 'CONFLICT'); state(l, 7, 1, 1);
  }],
  ['X09-request-read-once', async createLedger => {
    // 읽을 때마다 값이 바뀌는 입력: 거부(상태 변화 없음)하거나, 검증한 값 그대로 반영해야 한다.
    for (const switchAfter of [1, 3]) {
      const l = createLedger(); let reads = 0;
      const tricky = { id: 'a', get amount() { reads++; return reads <= switchAfter ? 7 : 2000; } };
      const out = await Promise.allSettled([l.apply(tricky)]);
      if (out[0].status === 'rejected') { assert.equal(out[0].reason.message, 'INVALID_REQUEST'); state(l, 0, 0, 0); continue; }
      const { total } = l.snapshot();
      assert.ok(total >= 1 && total <= 1000 && total === out[0].value.amount, `검증한 값과 반영한 값이 같아야 함(total=${total})`);
    }
  }],
  ['X10-waiter-result-isolation', async createLedger => {
    const l = createLedger(); const g = gate();
    const a = l.apply(req('a'), { beforeCommit: () => g.wait }); const b = l.apply(req('a'));
    await tick(); g.release();
    const [ra, rb] = await Promise.all([a, b]); ra.total = 1; rb.amount = 2;
    assert.deepEqual(await l.apply(req('a')), { id: 'a', amount: 7, total: 7 });
  }],
  ['X11-capacity-freed-after-failed-reservation-concurrent', async createLedger => {
    const l = createLedger({ maxKeys: 2 }); const g = gate();
    const fail = l.apply(req('f'), { beforeCommit: async () => { await g.wait; throw new Error('TIMED_OUT'); } });
    await l.apply(req('a')); await rejects(l.apply(req('c')), 'CAPACITY'); state(l, 7, 1, 2, 1);
    g.release(); await rejects(fail, 'TIMED_OUT'); state(l, 7, 1, 1);
    await l.apply(req('c')); state(l, 14, 2, 2);
  }]
];

if (!process.argv[2]) { console.error('사용법: node output/e2/extra-checks.mjs <target.mjs>'); process.exit(2); }
const { createLedger } = await import(pathToFileURL(resolve(process.argv[2])).href);
const results = [];
for (const [id, run] of cases) {
  let timer;
  try {
    await Promise.race([run(createLedger), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('DEADLINE')), 3000); })]);
    results.push({ id, state: 'PASS' });
  } catch (error) {
    results.push({ id, state: error.message === 'DEADLINE' ? 'TIMED_OUT' : 'FAIL', error: error.message.split('\n')[0] });
  } finally { clearTimeout(timer); }
}
const verdict = results.every(x => x.state === 'PASS') ? 'PASS' : 'FAIL';
console.log(JSON.stringify({ target: process.argv[2], verdict, pass: results.filter(x => x.state === 'PASS').length, total: results.length, results }, null, 2));
process.exitCode = verdict === 'PASS' ? 0 : 1;
