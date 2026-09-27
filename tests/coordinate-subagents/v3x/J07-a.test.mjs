import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { SemanticShadowQueue } from '../../../mcp-server/src/semantic/shadow-queue.ts';
import { SemanticEvaluationStore } from '../../../mcp-server/src/semantic/evaluation-store.ts';
import { jevProviderIdentity, JEV_IMPLEMENTATION_IDENTITY } from '../../../mcp-server/src/semantic/providers/jev/provider.ts';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const NOW = Date.parse(contracts('shadow').request.requestedAt);
const root = fileURLToPath(new URL('../../../', import.meta.url));
const options = (extra = {}) => ({ capacity: 2, claimTimeoutMs: 100, now: () => NOW, ...extra });
function request(id = 'evaluation-1', extra = {}) {
  return resealRequest({ ...contracts('shadow').request, evaluationId: id,
    provider: jevProviderIdentity(), expiresAt: new Date(NOW + 1000).toISOString(), ...extra });
}
async function withQueue(inspect, config = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'ags-j07a-'));
  const path = join(directory, 'shadow.sqlite3');
  let db = new DatabaseSync(path);
  let queue = new SemanticShadowQueue(db, options(config));
  try {
    await inspect({ path, get db() { return db; }, get queue() { return queue; },
      reopen() { db.close(); db = new DatabaseSync(path); queue = new SemanticShadowQueue(db, options(config)); } });
  } finally {
    db.close();
    assert.ok(directory.startsWith(join(tmpdir(), 'ags-j07a-')));
    await rm(directory, { recursive: true, force: true });
  }
}

test('J07-a persists a detached shadow request without recording an observation or invoking a provider', async () => {
  await withQueue(({ queue, db }) => {
    const input = request();
    assert.equal(queue.enqueue('key-1', input).status, 'enqueued');
    input.provider.adapterVersion = 'mutated-after-enqueue';
    const claim = queue.claim('worker-1');
    assert.equal(claim.evaluation.request.provider.adapterVersion, jevProviderIdentity().adapterVersion);
    assert.equal(claim.evaluation.state, 'prepared');
    assert.equal(claim.evaluation.result, null);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ags_semantic_results_v1').get().n, 0);
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='ags_semantic_intents_v1'").get().n, 0);
    assert.equal(queue.acknowledge(claim), true);
    assert.equal(new SemanticEvaluationStore(db).get(input.evaluationId).state, 'prepared');
    assert.equal(queue.diagnostics().acknowledged, 1);
  });
});

test('J07-a duplicate enqueue remains a duplicate across acknowledgement and restart', async () => {
  await withQueue(state => {
    const input = request();
    state.queue.enqueue('key-1', input);
    assert.equal(state.queue.enqueue('key-1', input).status, 'duplicate');
    assert.equal(state.queue.acknowledge(state.queue.claim('worker-1')), true);
    state.reopen();
    assert.equal(state.queue.enqueue('key-1', input).status, 'duplicate');
    assert.equal(state.queue.claim('worker-2'), null);
  });
});

test('J07-a saturates at queued plus claimed capacity and durably drops the newest evaluation', async () => {
  await withQueue(state => {
    state.queue.enqueue('key-1', request('evaluation-1'));
    const claim = state.queue.claim('worker-1');
    state.queue.enqueue('key-2', request('evaluation-2'));
    assert.deepEqual(state.queue.enqueue('key-3', request('evaluation-3')), { status: 'dropped', reason: 'saturated' });
    assert.equal(state.queue.diagnostics().active, 2);
    assert.equal(state.queue.diagnostics().dropped, 1);
    state.queue.acknowledge(claim);
    state.reopen();
    assert.equal(state.queue.enqueue('key-3', request('evaluation-3')).status, 'duplicate');
    assert.equal(state.queue.enqueue('key-4', request('evaluation-4')).status, 'enqueued');
    assert.equal(state.queue.claim('worker-2').evaluation.evaluationId, 'evaluation-2');
  });
});

test('J07-a restart preserves an unexpired claim and fences its acknowledgement after reassignment', async () => {
  let now = NOW;
  await withQueue(state => {
    state.queue.enqueue('key-1', request());
    const old = state.queue.claim('old-worker');
    state.reopen();
    assert.equal(state.queue.claim('new-worker'), null);
    now = NOW + 100;
    assert.equal(state.queue.acknowledge(old), false);
    const fresh = state.queue.claim('new-worker');
    assert.notEqual(fresh.claimId, old.claimId);
    assert.equal(state.queue.acknowledge(old), false);
    assert.equal(state.queue.acknowledge({ ...fresh, workerId: 'other-worker' }), false);
    assert.equal(state.queue.acknowledge({ ...fresh, requestDigest: old.requestDigest.replace(/.$/u, 'x') }), false);
    assert.equal(state.queue.acknowledge(fresh), true);
    assert.equal(state.queue.acknowledge(fresh), false);
  }, { now: () => now });
});

test('J07-a deadline expires queued and claimed work, frees capacity and never renews the request deadline', async () => {
  let now = NOW;
  await withQueue(({ queue }) => {
    queue.enqueue('key-1', request('evaluation-1', { expiresAt: new Date(NOW + 50).toISOString() }));
    const claim = queue.claim('worker-1');
    assert.equal(claim.leaseUntil, NOW + 50);
    queue.enqueue('key-2', request('evaluation-2', { expiresAt: new Date(NOW + 50).toISOString() }));
    now += 50;
    assert.equal(queue.acknowledge(claim), false);
    assert.equal(queue.claim('worker-2'), null);
    assert.equal(queue.diagnostics().expired, 2);
    assert.equal(queue.diagnostics().active, 0);
    assert.equal(queue.enqueue('key-1', request('evaluation-1', { expiresAt: new Date(NOW + 50).toISOString() })).status, 'duplicate');
    assert.equal(queue.enqueue('key-3', request('evaluation-3')).status, 'enqueued');
  }, { now: () => now });
});

test('J07-a expired enqueue is diagnosed and a duplicate cannot change its deadline', async () => {
  await withQueue(({ queue }) => {
    assert.deepEqual(queue.enqueue('key-1', request('evaluation-1', {
      requestedAt: new Date(NOW - 1).toISOString(), expiresAt: new Date(NOW).toISOString() })),
      { status: 'dropped', reason: 'deadline-expired' });
    assert.throws(() => queue.enqueue('key-1', request()), { code: 'GATE_FAILED' });
    assert.equal(queue.claim('worker-1'), null);
  });
});

test('J07-a rechecks the deadline after request persistence instead of using the enqueue entry clock', async () => {
  let ticks = 0;
  await withQueue(({ queue }) => {
    assert.deepEqual(queue.enqueue('key-1', request()), { status: 'dropped', reason: 'deadline-expired' });
    assert.equal(queue.claim('worker-1'), null);
  }, { now: () => ++ticks === 1 ? NOW : NOW + 1000 });
});

test('J07-a resumes safely when the immutable request committed before the queue write', async () => {
  await withQueue(state => {
    new SemanticEvaluationStore(state.db).putRequest('key-1', request());
    state.reopen();
    assert.equal(state.queue.enqueue('key-1', request()).status, 'enqueued');
    assert.equal(state.queue.enqueue('key-1', request()).status, 'duplicate');
    assert.equal(state.queue.diagnostics().active, 1);
  });
});

test('J07-a refusing a corrupt queued identity rolls back the claim without recording a result', async () => {
  await withQueue(({ queue, db }) => {
    queue.enqueue('key-1', request());
    db.prepare("UPDATE ags_semantic_shadow_queue_v1 SET request_digest='tampered'").run();
    assert.throws(() => queue.claim('worker-1'), { code: 'GATE_FAILED' });
    assert.equal(queue.diagnostics().claimed, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM ags_semantic_results_v1').get().n, 0);
  });
});

test('J07-a reuses the immutable evaluation identity including J06 provider projection drift', async () => {
  await withQueue(({ queue }) => {
    queue.enqueue('key-1', request());
    assert.throws(() => queue.enqueue('different-key', request()), { code: 'GATE_FAILED' });
    assert.throws(() => queue.enqueue('key-1', request('different-evaluation')), { code: 'GATE_FAILED' });
    const drift = jevProviderIdentity({ ...JEV_IMPLEMENTATION_IDENTITY, projectionVersion: 'different' });
    assert.throws(() => queue.enqueue('key-1', request('evaluation-1', { provider: drift })), { code: 'GATE_FAILED' });
    assert.throws(() => queue.enqueue('assist-key', request('assist', { mode: 'assist' })), { code: 'INVALID_INPUT' });
    assert.throws(() => queue.enqueue('invalid-key', { ...request('bad'), requestDigest: 'forged' }), { code: 'INVALID_INPUT' });
    assert.equal(queue.diagnostics().active, 1);
  });
});

test('J07-a rejects inconsistent durable bounds and invalid clocks without dropping queued work', async () => {
  await withQueue(({ queue, db }) => {
    queue.enqueue('key-1', request());
    assert.throws(() => new SemanticShadowQueue(db, options({ capacity: 1 })), { code: 'GATE_FAILED' });
    assert.throws(() => new SemanticShadowQueue(db, options({ claimTimeoutMs: 1 })), { code: 'GATE_FAILED' });
    for (const capacity of [0, -1, 1.5, NaN, Infinity]) {
      assert.throws(() => new SemanticShadowQueue(db, options({ capacity })), { code: 'INVALID_INPUT' });
    }
    const invalid = new SemanticShadowQueue(db, options({ now: () => NaN }));
    assert.throws(() => invalid.claim('worker'), { code: 'INVALID_INPUT' });
    assert.throws(() => queue.claim(' '), { code: 'INVALID_INPUT' });
    assert.equal(queue.diagnostics().queued, 1);
  });
});

function bounded(promise, milliseconds, label) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} deadline exceeded`)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

function claimant(path, id, fault, deadlineMs) {
  const faults = {
    'exit-before-ready': 'process.exit(0);',
    'silent-before-ready': 'setInterval(() => {}, 1000);',
    'silent-response': 'process.send({ ready: true }); setInterval(() => {}, 1000);',
  };
  const code = faults[fault] ?? `import { DatabaseSync } from 'node:sqlite';
    import { SemanticShadowQueue } from './mcp-server/src/semantic/shadow-queue.ts';
    const db = new DatabaseSync(process.argv[1]);
    const queue = new SemanticShadowQueue(db, { capacity: 2, claimTimeoutMs: 100, now: () => ${NOW} });
    process.once('message', () => {
      try { process.send({ claim: queue.claim(process.argv[2]) }); }
      finally { db.close(); process.disconnect(); }
    });
    process.send({ ready: true });`;
  const child = spawn(process.execPath, [...(fault ? [] : ['--import', 'tsx']), '--input-type=module', '-e', code, path, id],
    { cwd: root, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = bounded(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', message => { if (message.ready) resolve(); });
    child.once('close', code => reject(new Error(stderr || `Exited before ready (code ${code})`)));
  }), deadlineMs, `${id} ready`);
  const result = bounded(new Promise((resolve, reject) => {
    let claim;
    child.once('error', reject);
    child.on('message', message => { if ('claim' in message) claim = message.claim; });
    child.once('close', code => {
      if (code !== 0 || claim === undefined) reject(new Error(stderr || 'No claim result'));
      else resolve(claim);
    });
  }), deadlineMs, `${id} result`);
  // Either phase can reject before the coordinator reaches its await.
  ready.catch(() => {});
  result.catch(() => {});
  return { child, ready, result, closed };
}

async function compete(path, { faults = [null, null], deadlineMs = 10000, pids = [] } = {}) {
  const contenders = faults.map((fault, index) => claimant(path, `process-${index}`, fault, deadlineMs));
  pids.push(...contenders.map(worker => worker.child.pid).filter(pid => pid !== undefined));
  const results = Promise.all(contenders.map(worker => worker.result));
  results.catch(() => {});
  try {
    await Promise.all(contenders.map(worker => worker.ready));
    for (const worker of contenders) worker.child.send('go');
    return await results;
  } finally {
    for (const worker of contenders) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill('SIGKILL');
    }
    await bounded(Promise.all(contenders.map(worker => worker.closed)), 5000, 'Child close/reap');
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  }
}

test('J07-a two independent processes racing for one queued item obtain exactly one claim', async () => {
  await withQueue(async ({ queue, path }) => {
    queue.enqueue('key-1', request());
    const claims = (await compete(path)).filter(Boolean);
    assert.equal(claims.length, 1);
    assert.equal(queue.diagnostics().claimed, 1);
    assert.equal(queue.acknowledge(claims[0]), true);
  });
});

for (const [fault, error] of [
  ['exit-before-ready', /Exited before ready \(code 0\)/u],
  ['silent-before-ready', /ready deadline exceeded/u],
  ['silent-response', /result deadline exceeded/u],
]) {
  test(`J07-a claimant ${fault} fails within its deadline and reaps both children before removing the temporary root`, async () => {
    const pids = [];
    let directory;
    const started = performance.now();
    await withQueue(async ({ path }) => {
      directory = dirname(path);
      await assert.rejects(compete(path, { faults: [fault, 'silent-response'], deadlineMs: 1000, pids }), error);
    });
    assert.ok(performance.now() - started < 8000);
    assert.equal(pids.length, 2);
    for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(access(directory), { code: 'ENOENT' });
  });
}
