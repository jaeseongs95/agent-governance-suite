// Independent audit tests for the v2.7.3 wake-liveness candidate (e739090). Not product code.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../mcp-server/src/session-message-broker.ts';
import { adaptHostInput } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../mcp-server/src/session-message-wake-port.ts';
import { ContractValidator } from '../../mcp-server/src/schema-validator.ts';

const target = { host: 'portable', sessionId: 'audit-target' };
const sender = { host: 'portable', sessionId: 'audit-sender' };
const caps = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' };
const iso = ms => new Date(ms).toISOString();
const validator = new ContractValidator();
const cleanup = [];
afterEach(() => { vi.unstubAllEnvs(); for (const f of cleanup.splice(0)) { for (const s of f.stores) s.close(); rmSync(f.directory, { recursive: true, force: true }); } });

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-audit-'));
  const database = join(directory, 'session-messages.sqlite3');
  const store = new SessionMessageStore(database);
  const f = { directory, database, store, stores: [store], now: Date.now() };
  cleanup.push(f);
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(directory, 'trust.sqlite3'));
  born(store, 'inst-1', 'relay-1', f.now);
  return f;
}
function born(store, instanceId, relayId, at, t = target) {
  store.startPresence({ ...t, instanceId, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, at);
  store.acquireRelay({ ...t, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
// Keep a presence birth alive across a fixture gap without creating a new generation, and renew the relay lease.
function alive(store, instanceId, relayId, at) {
  store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), instanceId);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
const req = (instanceId, relayId, n = 'x') => ({ ...target, nonce: `${instanceId}-${n}-nonce-abcdefghijklmnopq`, instanceId, transport: 'portable', relayId, resume: true });
function latch(f, outcome = 'submitted', at = f.now) {
  f.store.send({ sender, target, messageId: `body-${at}`, body: 'b', ttlSeconds: 86400 }, at);
  const r = f.store.reserveManagedWake(req('inst-1', 'relay-1', `first${at}`), at);
  assert.equal(r.dispatch, true);
  const s = f.store.startManagedWake(r.attempt, at + 1); assert.equal(s.dispatch, true);
  if (outcome !== 'started') assert.equal(f.store.recordManagedWakeOutcome(s.attempt, outcome, at + 2), true);
  return s.attempt;
}
const row = (store, a) => store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(a.attemptId);
const activeCount = store => store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved','started','submitted','unknown')").get().n;
function observe(nonces, at) {
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: nonces.map(n => `[agent-governance-suite:wake:${n}]`).join('\n') }, target.host).observation;
  return { observation, receipt: recordWakeHookObservation(observation, at) };
}
const hostClaim = (store, o, at) => store.claimHostWake(target, o.observation, o.receipt, wakeHookObservationReader, at);

// ---------- Item 1: single condition must not retire ----------
test('1a expiry only (same generation, relay live, no activity) never retires, up to 7 days', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  for (const at of [exp + WAKE_RETIRE_GRACE_MS, exp + WAKE_RETIRE_GRACE_MS + 1, exp + 86_400_000, exp + 7 * 86_400_000]) {
    alive(f.store, 'inst-1', 'relay-1', at);
    assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', `r${at}`), at).dispatch, false);
    assert.equal(row(f.store, a).state, 'submitted');
    assert.equal(f.store.autoWakeOutlook(target, at).state, 'latched');
  }
});

test('1b generation replacement only (before expiry+grace) does not retire; boundary is exact', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 60_000);
  for (const at of [f.now + 120_000, exp - 1, exp, exp + 1, exp + WAKE_RETIRE_GRACE_MS - 1]) {
    alive(f.store, 'inst-2', 'relay-2', at);
    assert.equal(f.store.reserveManagedWake(req('inst-2', 'relay-2', `r${at}`), at).dispatch, false, `at ${at - exp}`);
    assert.equal(row(f.store, a).state, 'submitted');
  }
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at);
  assert.equal(f.store.reserveManagedWake(req('inst-2', 'relay-2', 'final'), at).dispatch, true);
  assert.equal(row(f.store, a).state, 'expired-unobserved');
});

test('1c ACK only (before expiry) does not retire even long after expiry', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  const [m] = f.store.claim(target, exp - 10_000); f.store.acknowledge(target, [m.messageId], exp - 5_000);
  f.store.send({ sender, target, messageId: 'second-body', body: 'b2', ttlSeconds: 86400 }, exp - 1_000);
  for (const at of [exp + WAKE_RETIRE_GRACE_MS, exp + 86_400_000]) {
    alive(f.store, 'inst-1', 'relay-1', at);
    assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', `r${at}`), at).dispatch, false);
    assert.equal(row(f.store, a).state, 'submitted');
  }
});

test('1c2 ACK after expiry but checked before grace does not retire yet; after grace it retires once', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  f.store.acknowledge(target, ['nope'], exp + 1);
  alive(f.store, 'inst-1', 'relay-1', exp + WAKE_RETIRE_GRACE_MS - 1);
  assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', 'a'), exp + WAKE_RETIRE_GRACE_MS - 1).dispatch, false);
  alive(f.store, 'inst-1', 'relay-1', exp + WAKE_RETIRE_GRACE_MS);
  assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', 'b'), exp + WAKE_RETIRE_GRACE_MS).dispatch, true);
});

test('1d relay restart only (new relay id, lapsed old relay lease, same presence birth) does not retire and is not activity', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  // Relay dies; its 15s lease lapses; a new relay with a new id acquires and ticks (presence kept alive by the fixture).
  for (const [i, at] of [[1, f.now + 30_000], [2, exp + 60_000], [3, exp + WAKE_RETIRE_GRACE_MS + 60_000], [4, exp + 86_400_000]]) {
    f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), 'inst-1');
    assert.equal(f.store.acquireRelay({ ...target, transport: 'portable', relayId: `relay-new-${i}`, pid: process.pid + i, parentPid: 999_000 + i }, at), true);
    assert.equal(f.store.relayTick({ ...target, transport: 'portable', relayId: `relay-new-${i}`, instanceId: 'inst-1', includePending: true }, at + 1).alive, true);
    assert.equal(f.store.reserveManagedWake(req('inst-1', `relay-new-${i}`, `r${i}`), at + 2).dispatch, false);
    assert.equal(row(f.store, a).state, 'submitted');
  }
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM session_activity').get().n, 0);
});

test('1e activity of another session or another host with the same session id is not evidence', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  f.store.claim(sender, exp + 1); f.store.acknowledge(sender, ['x'], exp + 2);
  f.store.observeNativeInput({ host: 'other-host', sessionId: target.sessionId }, exp + 3);
  const at = exp + WAKE_RETIRE_GRACE_MS + 10; alive(f.store, 'inst-1', 'relay-1', at);
  assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', 'z'), at).dispatch, false);
  assert.equal(row(f.store, a).state, 'submitted');
});

test('1f newer generation that is unreachable (lease lapsed, not ended) is not evidence', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', exp - 1000); // lease 20s, never renewed
  f.store.prune(exp + WAKE_RETIRE_GRACE_MS + 5);
  assert.equal(row(f.store, a).state, 'submitted');
});

// ---------- Item 1: both conditions -> exactly one new attempt ----------
test('1g both conditions: exactly one new attempt across repeated reserves, relays and connections', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS;
  alive(f.store, 'inst-2', 'relay-2', at);
  const peer = new SessionMessageStore(f.database); f.stores.push(peer);
  const results = [];
  for (let i = 0; i < 20; i++) results.push((i % 2 ? peer : f.store).reserveManagedWake(req('inst-2', 'relay-2', `k${i}`), at + i));
  const attempts = new Set(results.filter(r => r.attempt).map(r => r.attempt.attemptId));
  assert.equal(attempts.size, 1); assert.equal(activeCount(f.store), 1);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'expired-unobserved'").get().n, 1);
});

test('1h activity that retired W1 does not carry over to retire the next attempt W2', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  f.store.observeNativeInput(target, exp + 1);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-1', 'relay-1', at);
  const w2 = f.store.reserveManagedWake(req('inst-1', 'relay-1', 'w2'), at); assert.equal(w2.dispatch, true);
  const s2 = f.store.startManagedWake(w2.attempt, at + 1).attempt; f.store.recordManagedWakeOutcome(s2, 'submitted', at + 2);
  const exp2 = Date.parse(row(f.store, s2).expires_at);
  const later = exp2 + WAKE_RETIRE_GRACE_MS + 1000; alive(f.store, 'inst-1', 'relay-1', later);
  assert.equal(f.store.reserveManagedWake(req('inst-1', 'relay-1', 'w3'), later).dispatch, false);
  assert.equal(row(f.store, s2).state, 'submitted');
});

// ---------- Item 1: no path to observed / PASS ----------
test('1i a retired row cannot become observed via any public transition', () => {
  const f = setup(); const a = latch(f, 'accepted-or-unknown'); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at); f.store.prune(at);
  const retired = row(f.store, a); assert.equal(retired.state, 'expired-unobserved');
  for (const o of ['submitted', 'definite-failure', 'accepted-or-unknown']) assert.equal(f.store.recordManagedWakeOutcome(a, o, at + 1), false);
  assert.equal(f.store.startManagedWake(a, at + 1).dispatch, false);
  const late = hostClaim(f.store, observe([a.nonce], at + 2), at + 3);
  assert.deepEqual(late, { recognized: false, messages: [], binding: null, retired: true });
  const r = row(f.store, a);
  assert.equal(r.state, 'expired-unobserved'); assert.equal(r.observed_at, null); assert.equal(r.consumed_at, null);
  // Manual reconcile path requires state 'unknown'; returns reconciled:false and changes nothing.
  const rec = f.store.reconcileHistoricalWake(target, a.attemptId, late.receipt ?? 'source-abcdef', at + 4, () => ({ observedAt: iso(at + 3) }));
  assert.equal(rec.reconciled, false); assert.equal(row(f.store, a).state, 'expired-unobserved');
  const st = f.store.status(sender, `body-${f.now}`, at + 5);
  assert.notEqual(st?.wake?.observation, 'observed');
  const ws = dispatch(f.store, 'wake-status', { target });
  assert.ok(ws.wake === null || ws.wake.state !== 'observed');
});

// ---------- Item 2: late retired nonce ----------
test('2a late retired nonce with no current wake reserved claims no body and records late once', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at); f.store.prune(at);
  const before = f.store.database.prepare('SELECT * FROM messages').all();
  for (let i = 0; i < 3; i++) assert.deepEqual(hostClaim(f.store, observe([a.nonce], at + 10 * i), at + 10 * i + 1), { recognized: false, messages: [], binding: null, retired: true });
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), before);
  assert.equal(row(f.store, a).late_observed_at, iso(at + 1));
});

test('2b mixed prompt: retired nonce + current live nonce (finding probe)', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at);
  const w2 = f.store.startManagedWake(f.store.reserveManagedWake(req('inst-2', 'relay-2', 'w2'), at).attempt, at + 1).attempt;
  f.store.recordManagedWakeOutcome(w2, 'submitted', at + 2);
  const res = hostClaim(f.store, observe([a.nonce, w2.nonce], at + 3), at + 4);
  const w2row = row(f.store, w2);
  // Record the observed behavior for the report.
  console.log('AUDIT-2b', JSON.stringify({ res, w2state: w2row.state, w2late: w2row.late_observed_at, pending: f.store.pendingCount(target, at + 5) }));
  assert.equal(res.messages.length, 0);
  // Body must remain deliverable: a fresh wake must be reservable for the pending body.
  alive(f.store, 'inst-2', 'relay-2', at + 6);
  const w3 = f.store.reserveManagedWake(req('inst-2', 'relay-2', 'w3'), at + 6);
  console.log('AUDIT-2b-next', JSON.stringify({ w3dispatch: w3.dispatch }));
  assert.equal(w3.dispatch, true);
});

test('2c same prune/event replayed many times: no second retirement or second attempt', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  f.store.observeNativeInput(target, exp + 1);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-1', 'relay-1', at);
  for (let i = 0; i < 10; i++) { f.store.prune(at + i); f.store.observeNativeInput(target, exp + 1); }
  const retired = row(f.store, a); assert.equal(retired.retired_at, iso(at));
  const first = f.store.reserveManagedWake(req('inst-1', 'relay-1', 'n1'), at + 20);
  for (let i = 0; i < 10; i++) {
    const again = f.store.reserveManagedWake(req('inst-1', 'relay-1', `n${i + 2}`), at + 21 + i);
    assert.equal(again.attempt?.attemptId ?? first.attempt.attemptId, first.attempt.attemptId);
  }
  assert.equal(activeCount(f.store), 1);
});

// ---------- Long turn: activity during a busy turn (design probe) ----------
test('LT a long busy turn with tool activity lets one extra marker per ~70 min be queued (probe)', () => {
  const f = setup(); let at = f.now; const markers = [];
  f.store.send({ sender, target, messageId: 'lt-body-0', body: 'b', ttlSeconds: 86400 }, at);
  for (let i = 0; i < 4; i++) {
    alive(f.store, 'inst-1', 'relay-1', at);
    const r = f.store.reserveManagedWake(req('inst-1', 'relay-1', `lt${i}`), at);
    if (r.dispatch) { const s = f.store.startManagedWake(r.attempt, at + 1); if (s.dispatch) { markers.push(s.attempt.nonce); f.store.recordManagedWakeOutcome(s.attempt, 'submitted', at + 2); } }
    // The host is busy in one turn: queued follow-up is not delivered, but tool boundaries happen and ACK the body
    at += WAKE_TTL_MS + 60_000;
    const got = f.store.claimDeferred(target, at); f.store.acknowledge(target, got.map(m => m.messageId), at + 1);
    at += WAKE_RETIRE_GRACE_MS;
    f.store.send({ sender, target, messageId: `lt-body-${i + 1}`, body: 'b', ttlSeconds: 86400 }, at);
  }
  console.log('AUDIT-LT markers queued while one turn stayed busy:', markers.length);
  assert.ok(markers.length >= 2);
});

// ---------- Item 5: outlook schema validity across states ----------
test('5a every outlook produced is schema-valid and carries authorityEffect none; send/status never claim delivery', () => {
  const f = setup(); const a = latch(f);
  const sent = f.store.submitPrepared(sender, f.store.prepare({ sender, target, body: 'x', ttlSeconds: 600 }, f.now + 10).messageId, f.now + 10);
  assert.deepEqual(validator.sessionAutoWakeOutlook(sent.autoWake), sent.autoWake);
  assert.deepEqual(Object.keys(sent).sort(), ['autoWake', 'createdAt', 'duplicate', 'expiresAt', 'messageId'].sort().filter(k => k in sent));
  const st = f.store.status(sender, sent.messageId, f.now + 11);
  assert.equal(st.state, 'queued'); assert.deepEqual(validator.sessionAutoWakeOutlook(st.autoWake), st.autoWake);
  for (const p of f.store.listPresence(f.now + 12)) assert.deepEqual(validator.sessionAutoWakeOutlook(p.autoWake), p.autoWake);
  assert.throws(() => validator.sessionAutoWakeOutlook({ ...sent.autoWake, authorityEffect: 'delivered' }));
  assert.throws(() => validator.sessionAutoWakeOutlook({ ...sent.autoWake, delivered: true }));
  void a;
});

// ---------- C2 property: same-ms rebirth always gets a strictly later, well-formed, +1ms generation ----------
test('C2 fuzz: rebirth at equal or earlier time yields prev+1ms for 2000 random birth times', () => {
  const f = setup();
  for (let i = 0; i < 2000; i++) {
    const base = 1_600_000_000_000 + Math.floor(Math.random() * 400_000_000_000);
    const t = { host: 'portable', sessionId: `c2-${i}` };
    f.store.startPresence({ ...t, instanceId: 'same', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, base);
    f.store.endPresence(t, 'x', 'same', base);
    const back = i % 3 === 0 ? base - 5 : base;
    const reborn = f.store.startPresence({ ...t, instanceId: 'same', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, back);
    assert.equal(reborn.startedAt, iso(base + 1), `base ${iso(base)}`);
  }
});

test('2d ordering where the verified late arrival lands before any prune retired the row: observed (real arrival), then one new wake', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS + 1000;
  // Renew only the presence lease (acquireRelay would prune and retire first).
  f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), 'inst-2');
  const res = hostClaim(f.store, observe([a.nonce], at), at);
  assert.deepEqual(res, { recognized: false, messages: [], binding: null });
  assert.equal(row(f.store, a).state, 'observed');
  assert.equal(f.store.pendingCount(target, at + 1), 1);
  alive(f.store, 'inst-2', 'relay-2', at + 2);
  const next = f.store.reserveManagedWake(req('inst-2', 'relay-2', 'after'), at + 2);
  assert.equal(next.dispatch, true); assert.equal(activeCount(f.store), 1);
});

test('5b probe: outlook for an old-generation wake that has NOT passed its injection expiry', () => {
  const f = setup(); const a = latch(f);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const o = f.store.autoWakeOutlook(target, f.now + 6_000);
  console.log('AUDIT-5b', JSON.stringify({ outlook: o, expiresAt: row(f.store, a).expires_at, beforeExpiry: o.basisAt > iso(f.now + 6_000) }));
  assert.deepEqual(validator.sessionAutoWakeOutlook(o), o);
});
