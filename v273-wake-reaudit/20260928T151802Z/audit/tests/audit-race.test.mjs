// Independent audit: multi-process races around retirement (candidate e739090). Not product code.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import { SessionMessageStore, WAKE_RETIRE_GRACE_MS } from '../../mcp-server/src/session-message-store.ts';

const target = { host: 'portable', sessionId: 'audit-target' };
const sender = { host: 'portable', sessionId: 'audit-sender' };
const caps = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' };
const iso = ms => new Date(ms).toISOString();
const worker = fileURLToPath(new URL('./fixtures/audit-race-worker.mjs', import.meta.url));
const ROUNDS = Number(process.env.AUDIT_RACE_ROUNDS ?? 10);
const cleanup = [];
afterEach(() => { for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function spawnWorker(mode, database, effects, relayId) {
  const p = fork(worker, [mode, database, effects, relayId], { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
  let stderr = ''; p.stderr.on('data', c => { stderr += c; });
  const exit = once(p, 'exit');
  const [first] = await Promise.race([once(p, 'message'), exit.then(([c]) => { throw new Error(`early exit ${c}: ${stderr}`); })]);
  assert.equal(first.type, 'ready', stderr);
  return { p, exit, stderr: () => stderr };
}
async function go(w, input) { w.p.send(input); const [m] = await once(w.p, 'message'); await w.exit; return m; }

function latchedDb(directory, withNewGeneration) {
  const database = join(directory, 'session-messages.sqlite3');
  const s = new SessionMessageStore(database); const now = Date.now();
  s.startPresence({ ...target, instanceId: 'inst-1', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, now);
  s.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-0', pid: process.pid, parentPid: process.pid }, now);
  s.send({ sender, target, messageId: 'race-body-1', body: 'b', ttlSeconds: 86400 }, now);
  const r = s.reserveManagedWake({ ...target, nonce: 'audit-old-nonce-abcdefghijklmnopqr', instanceId: 'inst-1', transport: 'portable', relayId: 'relay-0' }, now);
  const st = s.startManagedWake(r.attempt, now + 1); s.recordManagedWakeOutcome(st.attempt, 'submitted', now + 2);
  const exp = Date.parse(s.database.prepare('SELECT expires_at FROM wake_nonces').get().expires_at);
  const at = exp + WAKE_RETIRE_GRACE_MS + 1000;
  const instanceId = withNewGeneration ? 'inst-2' : 'inst-1';
  if (withNewGeneration) s.startPresence({ ...target, instanceId: 'inst-2', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, now + 10_000);
  s.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 120_000), instanceId);
  s.close();
  return { database, at, exp, instanceId, oldNonce: 'audit-old-nonce-abcdefghijklmnopqr' };
}

test.each([6])('R1 %i relay processes racing reserve/start after both conditions: one effect, one attempt, repeated rounds', async (n) => {
  for (let round = 0; round < ROUNDS; round++) {
    const directory = mkdtempSync(join(tmpdir(), 'ags-audit-race-')); cleanup.push(directory);
    const d = latchedDb(directory, true); const effects = join(directory, 'effects.txt');
    const ws = await Promise.all(Array.from({ length: n }, (_, i) => spawnWorker('relay-effect', d.database, effects, `relay-${i}`)));
    const results = await Promise.all(ws.map(w => go(w, { now: d.at, instanceId: d.instanceId, parentPid: 4242 })));
    for (const r of results) assert.equal(r.error, undefined, r.error);
    const lines = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean) : [];
    const s = new SessionMessageStore(d.database);
    try {
      const states = s.database.prepare('SELECT state, count(*) AS n FROM wake_nonces GROUP BY state').all();
      assert.equal(lines.length, 1, `round ${round}: effects ${JSON.stringify(lines)} states ${JSON.stringify(states)}`);
      assert.equal(s.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved','started','submitted','unknown')").get().n, 1);
      assert.equal(s.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'expired-unobserved'").get().n, 1);
    } finally { s.close(); }
  }
}, 600_000);

test('R2 late arrival of the old nonce racing retirement+reserve: no body claim by old nonce, at most one new attempt', async () => {
  const outcomes = {};
  for (let round = 0; round < ROUNDS; round++) {
    const directory = mkdtempSync(join(tmpdir(), 'ags-audit-race2-')); cleanup.push(directory);
    const d = latchedDb(directory, true); const effects = join(directory, 'effects.txt');
    const [relay, late] = await Promise.all([spawnWorker('relay-effect', d.database, effects, 'relay-x'), spawnWorker('late-arrival', d.database, effects, 'late')]);
    const [rr, lr] = await Promise.all([go(relay, { now: d.at, instanceId: d.instanceId, parentPid: 4242 }),
      go(late, { now: d.at, nonce: d.oldNonce, trustPath: join(directory, 'trust.sqlite3') })]);
    assert.equal(rr.error, undefined, rr.error); assert.equal(lr.error, undefined, lr.error);
    assert.equal(lr.result.recognized, false); assert.deepEqual(lr.result.messages, []);
    const s = new SessionMessageStore(d.database);
    try {
      const old = s.database.prepare("SELECT state FROM wake_nonces WHERE nonce = ?").get(d.oldNonce).state;
      const key = `${old}/retiredFlag=${lr.result.retired === true}/relayReserved=${rr.result.reserved}`;
      outcomes[key] = (outcomes[key] ?? 0) + 1;
      assert.ok(['expired-unobserved', 'observed'].includes(old));
      assert.ok(s.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved','started','submitted','unknown')").get().n <= 1);
      assert.equal(s.database.prepare('SELECT claimed_at FROM messages WHERE message_id = ?').get('race-body-1').claimed_at, null);
      const lines = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean) : [];
      assert.ok(lines.length <= 1);
    } finally { s.close(); }
  }
  console.log('AUDIT-R2 outcome distribution', JSON.stringify(outcomes));
}, 600_000);

test('R3 activity and relays racing in the same-generation path: one effect', async () => {
  for (let round = 0; round < ROUNDS; round++) {
    const directory = mkdtempSync(join(tmpdir(), 'ags-audit-race3-')); cleanup.push(directory);
    const d = latchedDb(directory, false); const effects = join(directory, 'effects.txt');
    // Activity after expiry committed first by a separate process, then 4 relays race.
    const act = await spawnWorker('activity', d.database, effects, 'act');
    await go(act, { now: d.exp + 1 });
    const ws = await Promise.all(Array.from({ length: 4 }, (_, i) => spawnWorker('relay-effect', d.database, effects, `relay-${i}`)));
    await Promise.all(ws.map(w => go(w, { now: d.at, instanceId: d.instanceId, parentPid: 4242 })));
    const lines = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean) : [];
    assert.equal(lines.length, 1, `round ${round}`);
  }
}, 600_000);
