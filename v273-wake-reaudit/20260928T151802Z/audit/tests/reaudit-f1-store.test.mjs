// Re-audit F1 store-level tests for 651f5ec. Not product code.
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


// ---------- Re-audit F1 (651f5ec) ----------
function retiredPlusCurrent(f) {
  const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at);
  const w2 = f.store.startManagedWake(f.store.reserveManagedWake(req('inst-2', 'relay-2', 'w2'), at).attempt, at + 1).attempt;
  f.store.recordManagedWakeOutcome(w2, 'submitted', at + 2);
  return { a, w2, at };
}
test('F1-a (2b with corrected expectation) mixed retired+current: current claims its body once; retired keeps state, gets late', () => {
  const f = setup(); const { a, w2, at } = retiredPlusCurrent(f);
  const retiredBefore = row(f.store, a);
  const res = hostClaim(f.store, observe([a.nonce, w2.nonce], at + 3), at + 4);
  assert.equal(res.recognized, true); assert.equal(res.retired, undefined);
  assert.deepEqual(res.messages.map(m => m.messageId), [`body-${f.now}`]);
  assert.equal(res.binding.attemptId, w2.attemptId);
  const r2 = row(f.store, w2); assert.equal(r2.state, 'observed'); assert.equal(r2.late_observed_at, null);
  const r1 = row(f.store, a); assert.equal(r1.state, 'expired-unobserved'); assert.equal(r1.late_observed_at, iso(at + 4)); assert.equal(r1.observed_at, null);
  // no second claim, in either order, with fresh receipts
  for (const [i, order] of [[a.nonce, w2.nonce], [w2.nonce, a.nonce], [w2.nonce]].entries()) {
    const again = hostClaim(f.store, observe(order, at + 10 + i), at + 11 + i);
    assert.equal(again.recognized, false); assert.deepEqual(again.messages, []);
  }
  assert.equal(row(f.store, a).late_observed_at, iso(at + 4));
  assert.deepEqual({ ...row(f.store, a), late_observed_at: null }, { ...retiredBefore, late_observed_at: null });
});
test('F1-b retired-only prompt still reports retired and claims nothing; late recorded once', () => {
  const f = setup(); const { a, at } = retiredPlusCurrent(f);
  const res = hostClaim(f.store, observe([a.nonce], at + 3), at + 4);
  assert.deepEqual(res, { recognized: false, messages: [], binding: null, retired: true });
  assert.equal(row(f.store, a).late_observed_at, iso(at + 4));
  assert.deepEqual(hostClaim(f.store, observe([a.nonce, a.nonce], at + 5), at + 6), { recognized: false, messages: [], binding: null, retired: true });
  assert.equal(row(f.store, a).late_observed_at, iso(at + 4));
  assert.equal(f.store.pendingCount(target, at + 7), 1);
});
test('F1-c retired + old-generation (non-retired) marker: no claim, no retired flag, old row observed(late)', () => {
  const f = setup(); const a = latch(f); const exp = Date.parse(row(f.store, a).expires_at);
  // second session generation gets its own wake, then a third generation replaces it (w2 old but not retired)
  born(f.store, 'inst-2', 'relay-2', f.now + 5_000);
  const at = exp + WAKE_RETIRE_GRACE_MS; alive(f.store, 'inst-2', 'relay-2', at);
  const w2 = f.store.startManagedWake(f.store.reserveManagedWake(req('inst-2', 'relay-2', 'w2'), at).attempt, at + 1).attempt;
  f.store.recordManagedWakeOutcome(w2, 'submitted', at + 2);
  born(f.store, 'inst-3', 'relay-3', at + 100);
  const res = hostClaim(f.store, observe([a.nonce, w2.nonce], at + 200), at + 201);
  assert.deepEqual(res, { recognized: false, messages: [], binding: null });
  assert.equal(row(f.store, w2).state, 'observed'); assert.equal(row(f.store, a).state, 'expired-unobserved');
  assert.equal(f.store.pendingCount(target, at + 202), 1);
});
test('F1-d retired + unregistered nonce: whole prompt rejected, nothing written', () => {
  const f = setup(); const { a, w2, at } = retiredPlusCurrent(f);
  const b1 = row(f.store, a), b2 = row(f.store, w2);
  const res = hostClaim(f.store, observe([a.nonce, w2.nonce, 'unregistered-nonce-abcdefghijklmnop'], at + 3), at + 4);
  assert.deepEqual(res, { recognized: false, messages: [], binding: null });
  assert.deepEqual(row(f.store, a), b1); assert.deepEqual(row(f.store, w2), b2);
});
test('F1-e forged receipt on a mixed prompt writes nothing', () => {
  const f = setup(); const { a, w2, at } = retiredPlusCurrent(f);
  const b1 = row(f.store, a), b2 = row(f.store, w2);
  const o = observe([a.nonce, w2.nonce], at + 3);
  const res = hostClaim(f.store, { ...o, receipt: 'source-forged' }, at + 4);
  assert.equal(res.recognized, false); assert.deepEqual(row(f.store, a), b1); assert.deepEqual(row(f.store, w2), b2);
});
test('F1-f mixed retired+current whose current is past its expiry: no claim, no retired flag', () => {
  const f = setup(); const { a, w2, at } = retiredPlusCurrent(f);
  const late = Date.parse(row(f.store, w2).expires_at) + 1;
  f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(late + 60_000), 'inst-2');
  const res = hostClaim(f.store, observe([a.nonce, w2.nonce], late), late);
  assert.deepEqual(res, { recognized: false, messages: [], binding: null });
});
