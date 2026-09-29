// Crash-injection preload (experiment harness only; product code untouched).
// Counts every node:sqlite exec/statement call boundary (pre/post) in this process.
//   AGS_KILL_AT=<n>        SIGKILL self at event n (1-based)
//   AGS_KILL_POINT=<name>  SIGKILL self when globalThis.__agsPoint(name) is reached
//   AGS_TRACE=<file>       append "<n>\t<label>" for every event (trace runs)
//   AGS_KILL_LOG=<file>    write label of the kill event before SIGKILL
//   AGS_SLOW_MS=<ms>       synchronous sleep at every event (timing mode window widening)
import { appendFileSync, writeFileSync, fsyncSync, openSync, closeSync } from 'node:fs';
import { DatabaseSync, StatementSync } from 'node:sqlite';

const killAt = Number(process.env.AGS_KILL_AT || 0);
const killPoint = process.env.AGS_KILL_POINT || '';
const trace = process.env.AGS_TRACE || '';
const killLog = process.env.AGS_KILL_LOG || '';
const slow = Number(process.env.AGS_SLOW_MS || 0);
const role = process.env.AGS_ROLE || 'proc';
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const delayUs = process.env.AGS_KILL_DELAY_US === undefined ? null : Number(process.env.AGS_KILL_DELAY_US);
let n = 0;
// Asynchronous (timing) mode: a helper thread delivers SIGKILL d microseconds after arming,
// while the main thread keeps executing SQLite internals.
let arm = null;
if (delayUs !== null && killAt) {
  const { Worker } = await import('node:worker_threads');
  const shared = new Int32Array(new SharedArrayBuffer(4));
  const w = new Worker(`const { workerData } = require('node:worker_threads');
    const a = workerData.shared; Atomics.wait(a, 0, 0);
    const end = process.hrtime.bigint() + BigInt(workerData.delayUs) * 1000n;
    while (process.hrtime.bigint() < end) {}
    process.kill(workerData.pid, 'SIGKILL');`, { eval: true, workerData: { shared, delayUs, pid: process.pid } });
  w.unref();
  arm = (label) => {
    if (killLog) writeFileSync(killLog, JSON.stringify({ role, event: n, label, armedDelayUs: delayUs, pid: process.pid, at: new Date().toISOString() }) + '\n');
    Atomics.store(shared, 0, 1); Atomics.notify(shared, 0);
  };
}

function die(label) {
  if (killLog) {
    const fd = openSync(killLog, 'w');
    writeFileSync(fd, JSON.stringify({ role, event: n, label, pid: process.pid, at: new Date().toISOString() }) + '\n');
    fsyncSync(fd); closeSync(fd);
  }
  process.kill(process.pid, 'SIGKILL');
  Atomics.wait(sleeper, 0, 0, 10_000);
}
function event(kind, sql) {
  n += 1;
  const label = `${kind}|${String(sql).replace(/\s+/g, ' ').trim().slice(0, 110)}`;
  if (trace) appendFileSync(trace, `${role}\t${n}\t${label}\n`);
  if (slow) Atomics.wait(sleeper, 0, 0, slow);
  if (killAt && n === killAt) { if (arm) arm(label); else die(label); }
}
globalThis.__agsPoint = (name) => {
  n += 1;
  const label = `point|${name}`;
  if (trace) appendFileSync(trace, `${role}\t${n}\t${label}\n`);
  if ((killPoint && killPoint === name) || (killAt && n === killAt)) die(label);
};

const exec = DatabaseSync.prototype.exec;
DatabaseSync.prototype.exec = function (sql) {
  event('exec:pre', sql);
  const r = exec.call(this, sql);
  event('exec:post', sql);
  return r;
};
for (const m of ['run', 'get', 'all', 'iterate']) {
  const orig = StatementSync.prototype[m];
  StatementSync.prototype[m] = function (...args) {
    const sql = this.sourceSQL;
    event(`${m}:pre`, sql);
    const r = orig.apply(this, args);
    event(`${m}:post`, sql);
    return r;
  };
}
