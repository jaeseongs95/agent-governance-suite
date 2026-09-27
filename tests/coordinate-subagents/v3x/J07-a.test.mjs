import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

function claimant(path, id) {
  const code = `import { DatabaseSync } from 'node:sqlite';
    import { SemanticShadowQueue } from './mcp-server/src/semantic/shadow-queue.ts';
    const db = new DatabaseSync(process.argv[1]);
    const queue = new SemanticShadowQueue(db, { capacity: 2, claimTimeoutMs: 100, now: () => ${NOW} });
    process.once('message', () => {
      try { process.send({ claim: queue.claim(process.argv[2]) }); }
      finally { db.close(); process.disconnect(); }
    });
    process.send({ ready: true });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, path, id],
    { cwd: root, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', message => { if (message.ready) resolve(); });
    child.once('exit', code => { if (code !== 0) reject(new Error(stderr)); });
  });
  const result = new Promise((resolve, reject) => {
    let claim;
    child.once('error', reject);
    child.on('message', message => { if ('claim' in message) claim = message.claim; });
    child.once('exit', code => {
      if (code !== 0 || claim === undefined) reject(new Error(stderr || 'No claim result'));
      else resolve(claim);
    });
  });
  return { child, ready, result };
}

test('J07-a two independent processes racing for one queued item obtain exactly one claim', async () => {
  await withQueue(async ({ queue, path }) => {
    queue.enqueue('key-1', request());
    const contenders = [claimant(path, 'process-a'), claimant(path, 'process-b')];
    // Attach rejection handlers before either child can exit.
    const results = Promise.all(contenders.map(worker => worker.result));
    try {
      await Promise.all(contenders.map(worker => worker.ready));
      for (const worker of contenders) worker.child.send('go');
      const claims = (await results).filter(Boolean);
      assert.equal(claims.length, 1);
      assert.equal(queue.diagnostics().claimed, 1);
      assert.equal(queue.acknowledge(claims[0]), true);
    } finally {
      for (const worker of contenders) if (worker.child.exitCode === null) worker.child.kill();
      await results.catch(() => {});
    }
  });
});
