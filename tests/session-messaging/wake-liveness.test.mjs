import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../mcp-server/src/session-message-broker.ts';
import { adaptHostInput } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../mcp-server/src/session-message-wake-port.ts';
import { ContractValidator } from '../../mcp-server/src/schema-validator.ts';

// The process fixture binds the same target identity.
const target = { host: 'portable', sessionId: 'wake-target' };
const sender = { host: 'portable', sessionId: 'liveness-sender' };
const capabilities = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' };
const iso = ms => new Date(ms).toISOString();
const validator = new ContractValidator();
const resources = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-wake-liveness-'));
  const database = join(directory, 'session-messages.sqlite3');
  const store = new SessionMessageStore(database);
  resources.push({ directory, stores: [store] });
  const now = Date.now();
  live(store, 'instance-1', 'relay-1', now);
  return { directory, database, store, now, retireAt: now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS };
}
function live(store, instanceId, relayId, at) {
  store.startPresence({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: capabilities }, at);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
/** Keeps one presence birth alive across a long fixture gap without a new generation. */
function keepAlive(store, instanceId, relayId, at) {
  store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), instanceId);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
  assert.equal(store.presence(target, at).state, 'online');
}
function body(store, id, at) { store.send({ sender, target, messageId: id, body: id, ttlSeconds: 86400 }, at); }
function request(instanceId, relayId, nonce = `${instanceId}-next-nonce-abcdefghijklmnop`) {
  return { ...target, nonce, instanceId, transport: 'portable', relayId, resume: true };
}
function begin(store, at, input = request('instance-1', 'relay-1', 'liveness-first-nonce-abcdefghijklmnop')) {
  const reserved = store.reserveManagedWake(input, at);
  assert.equal(reserved.dispatch, true);
  const started = store.startManagedWake(reserved.attempt, at + 1);
  assert.equal(started.dispatch, true);
  return started.attempt;
}
function latched(f, outcome = 'submitted') {
  body(f.store, 'pending-body', f.now);
  const attempt = begin(f.store, f.now);
  if (outcome !== 'started') assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome, f.now + 2), true);
  return attempt;
}
function attemptRow(store, attempt) { return store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(attempt.attemptId); }
function without(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
function observe(f, attempt, at) {
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(f.directory, 'trust.sqlite3'));
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
  return { observation, sourceReceiptId: recordWakeHookObservation(observation, at) };
}
function hostClaim(f, observed, at) {
  return f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, wakeHookObservationReader, at);
}

test.each(['submitted', 'accepted-or-unknown', 'started'])('an expired %s latch retires for a newer live generation and a new wake is reserved', outcome => {
  const f = fixture(); const old = latched(f, outcome);
  live(f.store, 'instance-2', 'relay-2', f.retireAt - 1);
  assert.equal(f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt - 1).dispatch, false);
  const before = attemptRow(f.store, old);
  assert.ok(['started', 'submitted', 'unknown'].includes(before.state));
  keepAlive(f.store, 'instance-2', 'relay-2', f.retireAt);
  const next = f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt);
  assert.equal(next.dispatch, true);
  assert.notEqual(next.attempt.nonce, old.nonce); assert.notEqual(next.attempt.attemptId, old.attemptId);
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved');
  assert.equal(retired.retired_at, iso(f.retireAt));
  assert.equal(retired.observed_at, null); assert.equal(retired.consumed_at, null);
  assert.deepEqual(without(retired, ['state', 'retired_at']), without(before, ['state', 'retired_at']));
  assert.equal(f.store.recordManagedWakeOutcome(old, 'definite-failure', f.retireAt + 1), false);
  assert.equal(f.store.recordManagedWakeOutcome(old, 'submitted', f.retireAt + 1), false);
  assert.equal(f.store.startManagedWake(old, f.retireAt + 1).dispatch, false);
  assert.deepEqual(attemptRow(f.store, old), retired);
  assert.equal(f.store.startManagedWake(next.attempt, f.retireAt + 2).dispatch, true);
  const status = f.store.managedWakeStatus(target, f.retireAt + 2);
  assert.equal(status.attemptId, next.attempt.attemptId); assert.equal(status.state, 'started');
});

test.each(['same-generation', 'other-transport'])('an expired latch of a live, quiet birth without activity stays latched: %s', kind => {
  const f = fixture(); const old = latched(f);
  const later = f.retireAt + 24 * 3600_000;
  // A live birth may switch transport and back without a new generation, so a transport change alone is no death.
  if (kind === 'other-transport') f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable-other', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: capabilities }, f.now + 10);
  const before = attemptRow(f.store, old);
  for (const at of [f.retireAt, later]) {
    keepAlive(f.store, 'instance-1', 'relay-1', at);
    f.store.prune(at);
    if (kind === 'same-generation') assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), at).dispatch, false);
    assert.deepEqual(attemptRow(f.store, old), before);
  }
  assert.equal(f.store.presence(target, later).startedAt, old.generation);
  if (kind === 'same-generation') {
    const outlook = f.store.autoWakeOutlook(target, later);
    assert.equal(outlook.state, 'latched'); assert.equal(outlook.reason, 'wake-unobserved');
    assert.equal(outlook.basisAt, before.expires_at);
    assert.deepEqual(validator.sessionAutoWakeOutlook(outlook), outlook);
  }
});

/** Each case leaves the wake's own birth no longer the live latest presence row, with no activity and no newer live birth. */
const deaths = {
  // The lease lapsed (process exit, reboot); a lapsed birth never renews.
  unreachable: () => null,
  ended: f => { assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true); return null; },
  'ended-new-generation': f => {
    live(f.store, 'instance-2', 'relay-2', f.now + 20);
    assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-2', f.now + 30), true);
    return null;
  },
  // A 2.7.4 broker already deleted every presence row of the identity.
  purged: f => { f.store.database.prepare('DELETE FROM session_presence WHERE session_id = ?').run(target.sessionId); return null; },
  // An older instance of the same session stays live; only the wake's own birth counts.
  'older-instance-live': f => {
    f.store.startPresence({ ...target, instanceId: 'instance-0', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
      deliveryCapabilities: capabilities }, f.now - 1000);
    assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true);
    return 'instance-0';
  },
  // The same instance is live, but its birth is not the wake's (no row carries that generation any more).
  'generation-missing': f => {
    f.store.database.prepare('UPDATE wake_nonces SET birth_generation = ? WHERE instance_id = ?').run(iso(f.now + 5), 'instance-1');
    return 'instance-1';
  },
};
function death(f, kind) {
  const old = latched(f);
  const alive = deaths[kind](f);
  // Keep the surviving birth live without a new generation; it need not be the latest row.
  return { old, keep: at => { if (alive) f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), alive); } };
}

test.each(Object.keys(deaths))('an expired latch whose birth is no longer live retires after the grace without activity: %s', kind => {
  const f = fixture(); const { old, keep } = death(f, kind);
  const before = attemptRow(f.store, old);
  keep(f.retireAt - 1); f.store.prune(f.retireAt - 1);
  assert.deepEqual(attemptRow(f.store, old), before, 'not before the expiry plus grace');
  keep(f.retireAt); f.store.prune(f.retireAt);
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved'); assert.equal(retired.retired_at, iso(f.retireAt));
  assert.equal(retired.observed_at, null); assert.equal(retired.consumed_at, null);
  assert.deepEqual(without(retired, ['state', 'retired_at']), without(before, ['state', 'retired_at']));
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM session_activity WHERE session_id = ?').get(target.sessionId).n, 0);
  f.store.prune(f.retireAt + 5); assert.deepEqual(attemptRow(f.store, old), retired);
  // Retired terminal rows follow the existing one-hour cleanup.
  f.store.prune(f.retireAt + 3600_000 - 1); assert.deepEqual(attemptRow(f.store, old), retired);
  f.store.prune(f.retireAt + 3600_000); assert.equal(attemptRow(f.store, old), undefined);
});

test('a wake of an ended birth retired without activity records a late arrival as evidence only, then a rebirth delivers', () => {
  const f = fixture(); const { old } = death(f, 'ended');
  f.store.prune(f.retireAt);
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved');
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  assert.deepEqual(hostClaim(f, observe(f, old, f.retireAt + 1), f.retireAt + 2), { recognized: false, messages: [], binding: null, retired: true });
  const late = attemptRow(f.store, old);
  assert.equal(late.late_observed_at, iso(f.retireAt + 2));
  assert.deepEqual(without(late, ['late_observed_at']), without(retired, ['late_observed_at']));
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  live(f.store, 'instance-1', 'relay-1', f.retireAt + 3);
  const next = f.store.reserveManagedWake(request('instance-1', 'relay-1'), f.retireAt + 3);
  assert.equal(next.dispatch, true);
  const started = f.store.startManagedWake(next.attempt, f.retireAt + 4).attempt;
  f.store.recordManagedWakeOutcome(started, 'submitted', f.retireAt + 5);
  const delivered = hostClaim(f, observe(f, started, f.retireAt + 6), f.retireAt + 7);
  assert.equal(delivered.recognized, true); assert.deepEqual(delivered.messages.map(message => message.messageId), ['pending-body']);
});

const activities = {
  claim: (store, at) => store.claim(target, at),
  claimDeferred: (store, at) => store.claimDeferred(target, at),
  claimTurnEnd: (store, at) => store.claimTurnEnd(target, at),
  clearDeferred: (store, at) => store.clearDeferred(target, at),
  acknowledge: (store, at) => store.acknowledge(target, ['no-such-message'], at),
  observeNativeInput: (store, at) => store.observeNativeInput(target, at),
};
test.each([...Object.keys(activities), 'before-expiry'])('same-generation activity %s after expiry retires the latch after the grace', kind => {
  const f = fixture(); const old = latched(f);
  const expiry = Date.parse(attemptRow(f.store, old).expires_at);
  if (kind === 'before-expiry') activities.claimDeferred(f.store, expiry - 1);
  else activities[kind](f.store, expiry + 1);
  keepAlive(f.store, 'instance-1', 'relay-1', f.retireAt - 1);
  assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), f.retireAt - 1).dispatch, false);
  keepAlive(f.store, 'instance-1', 'relay-1', f.retireAt);
  const next = f.store.reserveManagedWake(request('instance-1', 'relay-1'), f.retireAt);
  assert.equal(next.dispatch, kind !== 'before-expiry');
  assert.equal(attemptRow(f.store, old).state, kind === 'before-expiry' ? 'submitted' : 'expired-unobserved');
});

test('retirement and re-reservation are idempotent across prunes and reopened connections', () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-2', f.retireAt);
  f.store.prune(f.retireAt);
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved');
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer);
  peer.prune(f.retireAt + 5);
  assert.deepEqual(attemptRow(peer, old), retired);
  const first = peer.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt + 6);
  assert.equal(first.dispatch, true);
  const again = f.store.reserveManagedWake(request('instance-2', 'relay-2', 'another-nonce-abcdefghijklmnopqrst'), f.retireAt + 7);
  assert.equal(again.attempt.attemptId, first.attempt.attemptId);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved', 'started', 'submitted', 'unknown')").get().n, 1);
  assert.deepEqual(attemptRow(f.store, old), retired);
});

test('a verified late arrival of a retired nonce is recorded without claiming the current generation body', () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-2', f.retireAt);
  const next = f.store.startManagedWake(f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt).attempt, f.retireAt + 1).attempt;
  const retired = attemptRow(f.store, old); const current = attemptRow(f.store, next);
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  const result = hostClaim(f, observe(f, old, f.retireAt + 2), f.retireAt + 3);
  assert.deepEqual(result, { recognized: false, messages: [], binding: null, retired: true });
  const late = attemptRow(f.store, old);
  assert.equal(late.state, 'expired-unobserved'); assert.equal(late.late_observed_at, iso(f.retireAt + 3));
  assert.deepEqual(without(late, ['late_observed_at']), without(retired, ['late_observed_at']));
  assert.deepEqual(attemptRow(f.store, next), current);
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  assert.deepEqual(hostClaim(f, observe(f, old, f.retireAt + 4), f.retireAt + 5), { recognized: false, messages: [], binding: null, retired: true });
  assert.equal(attemptRow(f.store, old).late_observed_at, iso(f.retireAt + 3));
  // The current attempt still delivers its own body exactly once.
  const delivered = hostClaim(f, observe(f, next, f.retireAt + 6), f.retireAt + 7);
  assert.equal(delivered.recognized, true); assert.deepEqual(delivered.messages.map(message => message.messageId), ['pending-body']);
});

test('F1: a retired nonce mixed with the current nonce records late only and lets the current attempt claim its body', () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-2', f.retireAt);
  const next = f.store.startManagedWake(f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt).attempt, f.retireAt + 1).attempt;
  assert.equal(f.store.recordManagedWakeOutcome(next, 'submitted', f.retireAt + 2), true);
  const retired = attemptRow(f.store, old);
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(f.directory, 'trust.sqlite3'));
  const prompt = [old, next].map(attempt => `[agent-governance-suite:wake:${attempt.nonce}]`).join('\n');
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '', prompt }, target.host).observation;
  const mixed = { observation, sourceReceiptId: recordWakeHookObservation(observation, f.retireAt + 3) };
  const result = hostClaim(f, mixed, f.retireAt + 4);
  assert.equal(result.recognized, true); assert.equal(result.retired, undefined);
  assert.deepEqual(result.messages.map(message => message.messageId), ['pending-body']);
  assert.equal(result.binding.attemptId, next.attemptId);
  const current = attemptRow(f.store, next);
  assert.equal(current.state, 'observed'); assert.equal(current.observed_at, iso(f.retireAt + 4)); assert.equal(current.late_observed_at, null);
  const late = attemptRow(f.store, old);
  assert.equal(late.late_observed_at, iso(f.retireAt + 4));
  assert.deepEqual(without(late, ['late_observed_at']), without(retired, ['late_observed_at']));
  // Replaying the same prompt is no longer a fully retired marker, so it neither claims nor asks the host to block.
  assert.deepEqual(hostClaim(f, { observation, sourceReceiptId: recordWakeHookObservation(observation, f.retireAt + 5) }, f.retireAt + 6),
    { recognized: false, messages: [], binding: null });
});

test('a retired nonce cannot be laundered by forged provenance or a mixed unknown nonce', () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-2', f.retireAt); f.store.prune(f.retireAt);
  const retired = attemptRow(f.store, old);
  const observed = observe(f, old, f.retireAt + 1);
  assert.equal(hostClaim(f, { ...observed, sourceReceiptId: 'source-forged' }, f.retireAt + 2).recognized, false);
  const mixed = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: `[agent-governance-suite:wake:${old.nonce}]\n[agent-governance-suite:wake:unregistered-nonce-abcdefghijklmnop]` }, target.host).observation;
  const mixedResult = hostClaim(f, { observation: mixed, sourceReceiptId: recordWakeHookObservation(mixed, f.retireAt + 3) }, f.retireAt + 4);
  assert.deepEqual(mixedResult, { recognized: false, messages: [], binding: null });
  assert.deepEqual(attemptRow(f.store, old), retired);
});

test('K: an arrival whose hook receipt expired during a broker outage stays latched until retirement evidence, then a new wake delivers', () => {
  const f = fixture(); const old = latched(f);
  const observed = observe(f, old, f.now + 5);
  // The broker was down past the 30 second receipt TTL, so the same receipt is rejected on retry (e9 (b) FAIL shape).
  assert.equal(hostClaim(f, observed, f.now + 35_005).recognized, false);
  assert.equal(attemptRow(f.store, old).state, 'submitted');
  keepAlive(f.store, 'instance-1', 'relay-1', f.retireAt);
  assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), f.retireAt).dispatch, false);
  const expiry = Date.parse(attemptRow(f.store, old).expires_at);
  f.store.observeNativeInput(target, f.retireAt + 1);
  assert.ok(f.retireAt + 1 > expiry);
  keepAlive(f.store, 'instance-1', 'relay-1', f.retireAt + 2);
  const next = f.store.reserveManagedWake(request('instance-1', 'relay-1'), f.retireAt + 2);
  assert.equal(next.dispatch, true);
  assert.equal(attemptRow(f.store, old).state, 'expired-unobserved');
  const started = f.store.startManagedWake(next.attempt, f.retireAt + 3).attempt;
  f.store.recordManagedWakeOutcome(started, 'submitted', f.retireAt + 4);
  const delivered = hostClaim(f, observe(f, started, f.retireAt + 5), f.retireAt + 6);
  assert.equal(delivered.recognized, true);
  assert.deepEqual(delivered.messages.map(message => message.messageId), ['pending-body']);
});

test('C2: a same-millisecond rebirth gets a distinct generation, so the previous birth cannot claim', () => {
  const f = fixture(); const old = latched(f);
  assert.equal(f.store.endPresence(target, 'fixture-rebirth', 'instance-1', f.now), true);
  const reborn = f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: capabilities }, f.now);
  assert.ok(reborn.startedAt > old.generation);
  f.store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, f.now + 3);
  const result = hostClaim(f, observe(f, old, f.now + 4), f.now + 5);
  assert.equal(result.recognized, false); assert.deepEqual(result.messages, []);
  assert.equal(f.store.pendingCount(target, f.now + 5), 1);
  const again = f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: capabilities }, f.now + 6);
  assert.equal(again.startedAt, reborn.startedAt, 'a live renewal keeps its birth');
});

test('autoWake is advisory and reports each delivery path state', () => {
  const f = fixture();
  const check = (store, at, state, reason, basisAt, who = target) => {
    const outlook = store.autoWakeOutlook(who, at);
    assert.deepEqual(outlook, { state, reason, basisAt, checkedAt: iso(at), authorityEffect: 'none' });
    assert.deepEqual(validator.sessionAutoWakeOutlook(outlook), outlook);
    return outlook;
  };
  check(f.store, f.now, 'no-live-relay', 'presence-unknown', null, { host: 'portable', sessionId: 'never-seen' });
  check(f.store, f.now, 'available', 'relay-live', iso(f.now));
  const deferred = { host: 'portable', sessionId: 'deferred-only' };
  f.store.startPresence({ ...deferred, instanceId: 'deferred-1', transport: 'codex-deferred', wakeVisibility: 'none', canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ['tool-boundary'], idleWake: 'none' } }, f.now);
  check(f.store, f.now, 'unsupported', 'no-idle-wake', iso(f.now), deferred);
  f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(f.now + 19_000), 'instance-1');
  check(f.store, f.now + 16_000, 'no-live-relay', 'relay-lease-missing', iso(f.now));
  check(f.store, f.now + 21_000, 'no-live-relay', 'presence-not-online', iso(f.now + 19_000));
  assert.equal(f.store.presence(target, f.now + 21_000).state, 'unreachable');
  const board = f.store.listPresence(f.now + 21_000).find(item => item.sessionId === target.sessionId);
  assert.equal(board.state, 'unreachable'); assert.equal(board.autoWake.state, 'no-live-relay');
  keepAlive(f.store, 'instance-1', 'relay-1', f.now + 22_000);
  const old = latched({ ...f, now: f.now + 22_000 });
  const expiresAt = attemptRow(f.store, old).expires_at;
  check(f.store, f.now + 22_010, 'available', 'wake-in-flight', expiresAt);
  const overdue = Date.parse(expiresAt) + 1;
  keepAlive(f.store, 'instance-1', 'relay-1', overdue);
  check(f.store, overdue, 'latched', 'wake-unobserved', expiresAt);
  const sent = f.store.submitPrepared(sender, f.store.prepare({ sender, target, body: 'advisory send', ttlSeconds: 600 }, overdue).messageId, overdue);
  assert.equal(sent.autoWake.state, 'latched');
  assert.equal(f.store.submitPrepared(sender, sent.messageId, overdue + 1).autoWake.state, 'latched');
  assert.equal(f.store.status(sender, sent.messageId, overdue + 2).autoWake.state, 'latched');
  f.store.acknowledge(target, [sent.messageId], overdue + 3);
  assert.equal(f.store.status(sender, sent.messageId, overdue + 4).autoWake, null);
  const retireAt = Date.parse(expiresAt) + WAKE_RETIRE_GRACE_MS;
  keepAlive(f.store, 'instance-1', 'relay-1', retireAt);
  f.store.prune(retireAt);
  check(f.store, retireAt, 'available', 'relay-live', iso(retireAt));
  const brokerStatus = dispatch(f.store, 'status', { sender, messageId: sent.messageId });
  assert.equal(brokerStatus.status.autoWake, null);
});

function v272Database(path, rows) {
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE wake_nonces (nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL,
    expires_at TEXT NOT NULL, consumed_at TEXT) STRICT;`);
  for (const [name, definition] of [
    ['state', "TEXT NOT NULL DEFAULT 'legacy' CHECK (state IN ('legacy', 'reserved', 'started', 'submitted', 'unknown', 'observed', 'not-submitted'))"],
    ['nonce', 'TEXT'], ['instance_id', 'TEXT'], ['birth_generation', 'TEXT'], ['transport', 'TEXT'],
    ['relay_id', 'TEXT'], ['attempt_id', 'TEXT'], ['dispatch_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['retry_not_before', 'TEXT'], ['retry_count', 'INTEGER NOT NULL DEFAULT 0'],
    ['started_at', 'TEXT'], ['outcome_at', 'TEXT'], ['observed_at', 'TEXT'], ['late_observed_at', 'TEXT'],
  ]) db.exec(`ALTER TABLE wake_nonces ADD COLUMN ${name} ${definition};`);
  db.exec(`CREATE UNIQUE INDEX wake_active_target ON wake_nonces (host, session_id)
    WHERE state IN ('reserved', 'started', 'submitted', 'unknown');`);
  const insert = db.prepare(`INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, consumed_at, state, nonce, instance_id,
    birth_generation, transport, relay_id, attempt_id, dispatch_epoch, started_at, outcome_at, late_observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const row of rows) insert.run(...row);
  db.close();
}
const V272_COLUMNS = ['nonce_digest', 'host', 'session_id', 'expires_at', 'consumed_at', 'state', 'nonce', 'instance_id', 'birth_generation',
  'transport', 'relay_id', 'attempt_id', 'dispatch_epoch', 'retry_not_before', 'retry_count', 'started_at', 'outcome_at', 'observed_at', 'late_observed_at'];
function oldRows(now) {
  const old = iso(now - 5 * 3600_000);
  return [
    ['digest-latched', target.host, target.sessionId, iso(now - 4 * 3600_000), null, 'submitted', 'latched-nonce-abcdefghijklmnopqrst', 'old-instance',
      old, 'portable', 'old-relay', 'old-attempt', 1, old, old, null],
    ['digest-late', target.host, 'late-target', iso(now - 4 * 3600_000), null, 'unknown', 'late-nonce-abcdefghijklmnopqrstuv', 'old-instance',
      old, 'portable', 'old-relay', 'late-attempt', 1, old, old, old],
    ['digest-legacy', target.host, 'legacy-target', iso(now + 3600_000), null, 'legacy', null, null, null, null, null, null, 0, null, null, null],
    ['digest-observed', target.host, 'observed-target', iso(now + 3600_000), iso(now), 'observed', 'observed-nonce-abcdefghijklmnopq', 'i',
      old, 'portable', 'r', 'observed-attempt', 1, old, old, null],
  ];
}
function snapshotV272(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return { rows: db.prepare(`SELECT rowid, ${V272_COLUMNS.join(', ')} FROM wake_nonces ORDER BY rowid`).all(),
      version: db.prepare('PRAGMA user_version').get().user_version,
      columns: db.prepare('PRAGMA table_info(wake_nonces)').all().map(row => row.name),
      sql: db.prepare("SELECT sql FROM sqlite_master WHERE name = 'wake_nonces'").get().sql };
  } finally { db.close(); }
}
function migrationFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-wake-liveness-migrate-'));
  const database = join(directory, 'session-messages.sqlite3'); const now = Date.now();
  v272Database(database, oldRows(now));
  const entry = { directory, stores: [] }; resources.push(entry);
  return { directory, database, now, entry };
}

test('G: v2.7.2 latch rows migrate once, keep evidence and retire under the new rule', () => {
  const m = migrationFixture(); const before = snapshotV272(m.database);
  assert.equal(before.version, 0);
  const store = new SessionMessageStore(m.database); m.entry.stores.push(store);
  const after = snapshotV272(m.database);
  assert.equal(after.version, 1);
  assert.deepEqual(after.rows, before.rows);
  assert.deepEqual(after.columns, [...V272_COLUMNS, 'retired_at']);
  assert.match(after.sql, /'expired-unobserved'/);
  assert.ok(store.database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'wake_active_target'").get());
  body(store, 'post-upgrade-body', m.now);
  live(store, 'instance-new', 'relay-new', m.now);
  const next = store.reserveManagedWake(request('instance-new', 'relay-new'), m.now + 1);
  assert.equal(next.dispatch, true);
  // The relay acquisition already pruned once the newer live presence existed.
  const retired = store.database.prepare("SELECT * FROM wake_nonces WHERE nonce_digest = 'digest-latched'").get();
  assert.equal(retired.state, 'expired-unobserved'); assert.equal(retired.retired_at, iso(m.now));
  assert.deepEqual(without(retired, ['state', 'retired_at']), without({ ...before.rows[0], retired_at: null }, ['rowid', 'state', 'retired_at']));
  // A migrated row whose birth has no live presence row retires on the same prune, with its late evidence kept.
  const late = store.database.prepare("SELECT * FROM wake_nonces WHERE nonce_digest = 'digest-late'").get();
  assert.equal(late.state, 'expired-unobserved'); assert.equal(late.retired_at, iso(m.now));
  assert.deepEqual(without(late, ['state', 'retired_at']), without({ ...before.rows[1], retired_at: null }, ['rowid', 'state', 'retired_at']));
  const reopened = new SessionMessageStore(m.database); m.entry.stores.push(reopened);
  const stable = snapshotV272(m.database);
  assert.equal(stable.version, 1); assert.equal(stable.sql, after.sql);
  assert.deepEqual(reopened.database.prepare('SELECT rowid, * FROM wake_nonces ORDER BY rowid').all(),
    store.database.prepare('SELECT rowid, * FROM wake_nonces ORDER BY rowid').all());
});

test('G: a newer message schema version is rejected without mutation', () => {
  const m = migrationFixture();
  const db = new DatabaseSync(m.database); db.exec('PRAGMA user_version = 7;'); db.close();
  const before = snapshotV272(m.database);
  assert.throws(() => new SessionMessageStore(m.database), /newer/);
  assert.deepEqual(snapshotV272(m.database), before);
});

const worker = fileURLToPath(new URL('./fixtures/managed-wake-process.mjs', import.meta.url));
async function child(database, mode, relayId = `relay-${mode}`, directory = tmpdir()) {
  const process_ = fork(worker, [mode, database, join(directory, 'effects.txt'), relayId, String(process.pid)],
    { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
  let stderr = ''; process_.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(process_, 'exit');
  const [first] = await Promise.race([once(process_, 'message'), exit.then(([code]) => { throw new Error(`worker exited early: ${code}; ${stderr}`); })]);
  return { process: process_, first, exit, stderr: () => stderr };
}
async function result(p, input) {
  p.process.send(input ?? 'go');
  const [message] = await once(p.process, 'message');
  await p.exit;
  return message;
}

test('G: two independent processes racing the v2.7.2 upgrade both open one migrated schema', async () => {
  const m = migrationFixture(); const before = snapshotV272(m.database);
  const opened = await Promise.all(['a', 'b'].map(id => child(m.database, 'open-only', id, m.directory)));
  for (const p of opened) assert.equal(p.first.type, 'ready', p.stderr());
  const versions = await Promise.all(opened.map(p => result(p)));
  assert.deepEqual(versions.map(item => item.version), [1, 1]);
  const after = snapshotV272(m.database);
  assert.deepEqual(after.rows, before.rows); assert.equal(after.version, 1);
});

test('G: a failure inside the table rebuild rolls back columns, rows and schema version', async () => {
  const m = migrationFixture(); const before = snapshotV272(m.database);
  const p = await child(m.database, 'rebuild-failure', 'relay-rebuild', m.directory);
  const [code] = await p.exit;
  assert.equal(code, 0, p.stderr()); assert.match(p.first.error, /rebuild failure/);
  assert.deepEqual(snapshotV272(m.database), before);
  const store = new SessionMessageStore(m.database); m.entry.stores.push(store);
  assert.equal(snapshotV272(m.database).version, 1);
});

test('crash right after a committed retirement leaves a retired row and one later reservation', async () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-2', f.retireAt);
  const before = attemptRow(f.store, old);
  const p = await child(f.database, 'retire-then-exit', 'relay-retire', f.directory);
  assert.equal(p.first.type, 'ready', p.stderr());
  p.process.send({ now: f.retireAt });
  const [code] = await p.exit; assert.equal(code, 21, p.stderr());
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved'); assert.equal(retired.retired_at, iso(f.retireAt));
  assert.deepEqual(without(retired, ['state', 'retired_at']), without(before, ['state', 'retired_at']));
  f.store.prune(f.retireAt + 1); assert.deepEqual(attemptRow(f.store, old), retired);
  keepAlive(f.store, 'instance-2', 'relay-2', f.retireAt + 2);
  assert.equal(f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.retireAt + 2).dispatch, true);
});

test('two independent processes racing the retirement of an ended birth retire it once', async () => {
  const f = fixture(); const { old } = death(f, 'ended');
  const before = attemptRow(f.store, old);
  const raced = await Promise.all(['retire-a', 'retire-b'].map(id => child(f.database, 'retire-then-exit', id, f.directory)));
  for (const p of raced) assert.equal(p.first.type, 'ready', p.stderr());
  raced.forEach((p, index) => p.process.send({ now: f.retireAt + index * 5 }));
  for (const p of raced) { const [code] = await p.exit; assert.equal(code, 21, p.stderr()); }
  const retired = attemptRow(f.store, old);
  assert.equal(retired.state, 'expired-unobserved');
  assert.ok([iso(f.retireAt), iso(f.retireAt + 5)].includes(retired.retired_at));
  assert.deepEqual(without(retired, ['state', 'retired_at']), without(before, ['state', 'retired_at']));
  f.store.prune(f.retireAt + 10); assert.deepEqual(attemptRow(f.store, old), retired);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1);
});

test('two independent relay processes racing retirement create one active attempt', async () => {
  const f = fixture(); const old = latched(f);
  live(f.store, 'instance-2', 'relay-a', f.retireAt);
  const raced = await Promise.all(['relay-a', 'relay-b'].map(id => child(f.database, 'wake-transition', id, f.directory)));
  for (const p of raced) assert.equal(p.first.type, 'ready', p.stderr());
  const results = await Promise.all(raced.map(p => result(p, { kind: 'relay', now: f.retireAt + 1, attempt: old })));
  const dispatched = results.map(item => item.result).filter(item => item.dispatch);
  assert.ok(dispatched.length >= 1);
  assert.equal(new Set(dispatched.map(item => item.attempt.attemptId)).size, 1);
  assert.equal(attemptRow(f.store, old).state, 'expired-unobserved');
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved', 'started', 'submitted', 'unknown')").get().n, 1);
});
