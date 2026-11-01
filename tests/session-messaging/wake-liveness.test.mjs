import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_OBSERVATION_WINDOW_MS, WAKE_QUIET_MS } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../mcp-server/src/session-message-broker.ts';
import '../../mcp-server/src/builtin-hook-host-adapters.ts';
import { adaptHostInput, registerHookHostAdapter } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeBackoffDelay, wakeHookObservationReader } from '../../mcp-server/src/session-message-wake-port.ts';
import { ContractValidator } from '../../mcp-server/src/schema-validator.ts';

// AGS 3.0 doorbell (docs/ags30-wake-doorbell-design.md r3.2). These cases were rewritten from the 2.x "permanent latch"
// rules: a hand-off now ends by a later claim boundary, the end of its birth or its resend deadline (2.6), and the
// invariants I1, I2, I5, I6 and I11 are kept. Clocks are explicit arguments.
// The process fixture binds the same target identity.
// Explicit synthetic root adapter for core regression cases; not native capture or R7 evidence.
registerHookHostAdapter("portable", {
    adaptInput: (input, selectedHost) => {
      const adapted = adaptHostInput(input, "codex");
      return {...adapted, observation: {...adapted.observation, host: selectedHost,
        actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_CORE_ROOT"}}};
    },
  deliveryProfile: () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined,
});

const BASE = 10 * 60_000;
const HANDED = { result: 'handed-off' };
const UNKNOWN = { result: 'unknown', reasonCode: 'SYNTHETIC_TIMEOUT' };
const TRANSIENT = { result: 'not-delivered', kind: 'transient', reasonCode: 'SYNTHETIC_TRANSIENT' };
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
  return { directory, database, store, now };
}
function live(store, instanceId, relayId, at) {
  store.startPresence({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: capabilities }, at);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
/** Keeps one presence birth alive across a long fixture gap without a new generation. */
function keepAlive(store, instanceId, relayId, at) {
  store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ? AND ended_at IS NULL').run(iso(at + 60_000), instanceId);
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
  const started = store.startManagedWake(reserved.attempt, BASE, at + 1);
  assert.equal(started.dispatch, true);
  return started.attempt;
}
/** Hands a marker to the host (outcome at f.now + 2) with one pending body. */
function handOff(f, outcome = HANDED) {
  body(f.store, 'pending-body', f.now);
  const attempt = begin(f.store, f.now);
  if (outcome !== 'started') assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome, BASE, f.now + 2), true);
  return attempt;
}
function attemptRow(store, attempt) { return store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(attempt.attemptId); }
function without(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
function observe(f, attempt, at, nonces = [attempt.nonce]) {
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(f.directory, 'trust.sqlite3'));
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: nonces.map(nonce => `[agent-governance-suite:wake:${nonce}]`).join('\n') }, target.host).observation;
  return { observation, sourceReceiptId: recordWakeHookObservation(observation, at) };
}
function hostClaim(f, observed, at) {
  return f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, wakeHookObservationReader, at);
}
const ACTIVE = "('reserved', 'started', 'handed-off', 'unknown')";

test.each(['handed-off', 'unknown', 'started'])('I2/I11: a %s attempt of an old birth ends as birth-ended; its verified marker claims no current-birth body', outcome => {
  const f = fixture();
  const old = handOff(f, outcome === 'handed-off' ? HANDED : outcome === 'unknown' ? UNKNOWN : 'started');
  live(f.store, 'instance-2', 'relay-2', f.now + 10);
  const next = f.store.reserveManagedWake(request('instance-2', 'relay-2'), f.now + 11);
  const ended = attemptRow(f.store, old);
  if (outcome === 'started') {
    // A started attempt changes only by the start timeout (2.6); it keeps the slot until then (I4, I5).
    assert.equal(next.dispatch, false);
    assert.equal(ended.state, 'started');
    return;
  }
  assert.deepEqual([ended.state, ended.release_reason, ended.released_at], ['released', 'birth-ended', iso(f.now + 11)]);
  assert.equal(next.dispatch, true);
  assert.notEqual(next.attempt.nonce, old.nonce); assert.notEqual(next.attempt.attemptId, old.attemptId);
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  const late = hostClaim(f, observe(f, old, f.now + 12), f.now + 13);
  assert.equal(late.recognized, false); assert.deepEqual(late.messages, []); assert.equal(late.binding, null);
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  const recorded = attemptRow(f.store, old);
  assert.equal(recorded.late_observed_at, iso(f.now + 13));
  assert.deepEqual(without(recorded, ['late_observed_at']), without(ended, ['late_observed_at']));
  for (const value of [HANDED, UNKNOWN, TRANSIENT]) assert.equal(f.store.recordManagedWakeOutcome(old, value, BASE, f.now + 14), false);
  assert.equal(f.store.startManagedWake(old, BASE, f.now + 14).dispatch, false);
  assert.deepEqual(attemptRow(f.store, old), recorded);
  assert.equal(f.store.startManagedWake(next.attempt, BASE, f.now + 15).dispatch, true);
  assert.equal(f.store.managedWakeStatus(target, f.now + 15).attemptId, next.attempt.attemptId);
});

/** Each case leaves the wake's own birth no longer the live latest presence row. */
const deaths = {
  // The lease lapsed (process exit, reboot); a lapsed birth never renews.
  unreachable: () => null,
  ended: f => { assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true); return null; },
  'ended-new-generation': f => {
    live(f.store, 'instance-2', 'relay-2', f.now + 20);
    assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-2', f.now + 30), true);
    return null;
  },
  purged: f => { f.store.database.prepare('DELETE FROM session_presence WHERE session_id = ?').run(target.sessionId); return null; },
  'older-instance-live': f => {
    f.store.startPresence({ ...target, instanceId: 'instance-0', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
      deliveryCapabilities: capabilities }, f.now - 1000);
    assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true);
    return 'instance-0';
  },
  'generation-missing': f => {
    f.store.database.prepare('UPDATE wake_nonces SET birth_generation = ? WHERE instance_id = ?').run(iso(f.now + 5), 'instance-1');
    return 'instance-1';
  },
  // The wake's birth stays live, but a later birth of another instance ended and is the latest row.
  'live-birth-behind-ended': f => {
    live(f.store, 'instance-2', 'relay-2', f.now + 20);
    assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-2', f.now + 30), true);
    return 'instance-1';
  },
  'same-ms-other-instance': f => {
    f.store.startPresence({ ...target, instanceId: 'instance-2', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
      deliveryCapabilities: capabilities }, f.now);
    assert.equal(f.store.presence(target, f.now).instanceId, 'instance-2');
    return 'instance-2';
  },
};
test.each(Object.keys(deaths))('2.6: the end of the hand-off birth releases its slot as birth-ended and keeps the streak: %s', kind => {
  const f = fixture(); const old = handOff(f);
  const alive = deaths[kind](f);
  const at = f.now + 60_000;
  if (alive) f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), alive);
  f.store.prune(at);
  const ended = attemptRow(f.store, old);
  assert.deepEqual([ended.state, ended.release_reason, ended.released_at], ['released', 'birth-ended', iso(at)]);
  assert.equal(f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE state IN ${ACTIVE}`).get().n, 0);
  // Idempotent: later prunes never touch the ended row again (I11).
  f.store.prune(at + 3600_000); assert.deepEqual(attemptRow(f.store, old), ended);
});

test('an ended birth ends its hand-off; the verified late arrival claims nothing; a rebirth is rung and delivers', () => {
  const f = fixture(); const old = handOff(f);
  assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true);
  f.store.prune(f.now + 11);
  assert.equal(attemptRow(f.store, old).release_reason, 'birth-ended');
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  assert.equal(hostClaim(f, observe(f, old, f.now + 12), f.now + 13).recognized, false);
  assert.equal(attemptRow(f.store, old).late_observed_at, iso(f.now + 13));
  assert.equal(attemptRow(f.store, old).state, 'released');
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  live(f.store, 'instance-1', 'relay-1', f.now + 14);
  const started = begin(f.store, f.now + 14, request('instance-1', 'relay-1'));
  assert.equal(f.store.recordManagedWakeOutcome(started, HANDED, BASE, f.now + 16), true);
  const delivered = hostClaim(f, observe(f, started, f.now + 17), f.now + 18);
  assert.equal(delivered.recognized, true); assert.deepEqual(delivered.messages.map(message => message.messageId), ['pending-body']);
});

const boundaries = {
  claim: (store, at) => store.claim(target, at),
  claimDeferred: (store, at) => store.claimDeferred(target, at),
  claimTurnEnd: (store, at) => store.claimTurnEnd(target, at),
};
const activities = {
  observeNativeInput: (store, at) => store.observeNativeInput(target, at),
  clearDeferred: (store, at) => store.clearDeferred(target, at),
  // A deferred claim skipped after native input records activity only (S:755-757).
  skippedClaimDeferred: (store, at) => { store.observeNativeInput(target, at - 1); assert.deepEqual(store.claimDeferred(target, at), []); },
};
test.each(Object.keys(boundaries))('2.3/2.6: the claim boundary %s after the hand-off releases it as claimed-after-handoff and resets the streak', kind => {
  const f = fixture(); const old = handOff(f);
  const at = f.now + 30_000;
  keepAlive(f.store, 'instance-1', 'relay-1', at);
  boundaries[kind](f.store, at);
  f.store.prune(at + 1);
  const ended = attemptRow(f.store, old);
  assert.deepEqual([ended.state, ended.release_reason], ['released', 'claimed-after-handoff']);
  assert.equal(ended.observed_at, null, 'a boundary is no evidence the marker was consumed');
  assert.equal(f.store.database.prepare('SELECT streak, claim_boundary_at FROM wake_paths WHERE instance_id = ?').get('instance-1').claim_boundary_at, iso(at));
});
test.each(Object.keys(activities))('2.3: the activity-only path %s is no claim boundary and leaves the hand-off in place', kind => {
  const f = fixture(); const old = handOff(f);
  const before = attemptRow(f.store, old);
  const at = f.now + 30_000;
  keepAlive(f.store, 'instance-1', 'relay-1', at);
  activities[kind](f.store, at);
  f.store.prune(at + 1);
  assert.deepEqual(attemptRow(f.store, old), before);
  const path = f.store.database.prepare('SELECT claim_boundary_at FROM wake_paths WHERE instance_id = ?').get('instance-1');
  assert.equal(path?.claim_boundary_at ?? null, null);
});

test('a reservation of an ended birth is replaced idempotently across two reopened connections, one active attempt only', () => {
  const f = fixture();
  body(f.store, 'pending-body', f.now);
  const old = f.store.reserveManagedWake(request('instance-1', 'relay-1', 'liveness-first-nonce-abcdefghijklmnop'), f.now).attempt;
  assert.ok(old);
  assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true);
  live(f.store, 'instance-2', 'relay-2', f.now + 20);
  f.store.prune(f.now + 21);
  const replaced = attemptRow(f.store, old);
  assert.equal(replaced.state, 'not-delivered', 'a reservation has no external effect, so a replaced birth ends it as not-delivered');
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer);
  peer.prune(f.now + 25);
  assert.deepEqual(attemptRow(peer, old), replaced);
  const first = peer.reserveManagedWake(request('instance-2', 'relay-2'), f.now + 26);
  assert.equal(first.dispatch, true);
  const again = f.store.reserveManagedWake(request('instance-2', 'relay-2', 'another-nonce-abcdefghijklmnopqrst'), f.now + 27);
  assert.equal(again.attempt.attemptId, first.attempt.attemptId);
  assert.equal(f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE state IN ${ACTIVE}`).get().n, 1);
  assert.deepEqual(attemptRow(f.store, old), replaced);
});

/** Ends the first hand-off by a new birth and hands off a current attempt of that birth. */
function endedAndCurrent(f) {
  const old = handOff(f);
  live(f.store, 'instance-2', 'relay-2', f.now + 10);
  const next = begin(f.store, f.now + 11, request('instance-2', 'relay-2'));
  assert.equal(attemptRow(f.store, old).release_reason, 'birth-ended');
  return { old, next };
}

test('I2: a verified late arrival of an ended old-birth marker is recorded without claiming the current birth body', () => {
  const f = fixture(); const { old, next } = endedAndCurrent(f);
  const ended = attemptRow(f.store, old); const current = attemptRow(f.store, next);
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  const result = hostClaim(f, observe(f, old, f.now + 13), f.now + 14);
  assert.deepEqual(result, { recognized: false, messages: [], binding: null, retired: true });
  const late = attemptRow(f.store, old);
  assert.equal(late.late_observed_at, iso(f.now + 14));
  assert.deepEqual(without(late, ['late_observed_at']), without(ended, ['late_observed_at']));
  assert.deepEqual(attemptRow(f.store, next), current);
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  hostClaim(f, observe(f, old, f.now + 15), f.now + 16);
  assert.equal(attemptRow(f.store, old).late_observed_at, iso(f.now + 14), 'only the first late arrival is recorded');
  const delivered = hostClaim(f, observe(f, next, f.now + 17), f.now + 18);
  assert.equal(delivered.recognized, true); assert.deepEqual(delivered.messages.map(message => message.messageId), ['pending-body']);
});

test('F1: an ended old-birth marker mixed with the current marker records late only and lets the current attempt claim its body', () => {
  const f = fixture(); const { old, next } = endedAndCurrent(f);
  assert.equal(f.store.recordManagedWakeOutcome(next, HANDED, BASE, f.now + 12), true);
  const ended = attemptRow(f.store, old);
  const mixed = observe(f, next, f.now + 13, [old.nonce, next.nonce]);
  const result = hostClaim(f, mixed, f.now + 14);
  assert.equal(result.recognized, true); assert.equal(result.retired, undefined);
  assert.deepEqual(result.messages.map(message => message.messageId), ['pending-body']);
  assert.equal(result.binding.attemptId, next.attemptId);
  const current = attemptRow(f.store, next);
  assert.equal(current.state, 'observed'); assert.equal(current.observed_at, iso(f.now + 14)); assert.equal(current.late_observed_at, null);
  const late = attemptRow(f.store, old);
  assert.equal(late.late_observed_at, iso(f.now + 14));
  assert.deepEqual(without(late, ['late_observed_at']), without(ended, ['late_observed_at']));
  // Replaying the same prompt: the current marker now names only ended rows; the leased body is not claimed again (I6).
  const replay = hostClaim(f, observe(f, next, f.now + 15, [old.nonce, next.nonce]), f.now + 16);
  assert.deepEqual(replay.messages, []);
  assert.equal(f.store.database.prepare("SELECT delivery_attempts FROM messages WHERE message_id = 'pending-body'").get().delivery_attempts, 1);
});

test('I1: an ended marker cannot be laundered by forged provenance or a mixed unknown nonce', () => {
  const f = fixture(); const { old } = endedAndCurrent(f);
  const ended = attemptRow(f.store, old);
  const observed = observe(f, old, f.now + 13);
  assert.equal(hostClaim(f, { ...observed, sourceReceiptId: 'source-forged' }, f.now + 14).recognized, false);
  const mixed = observe(f, old, f.now + 15, [old.nonce, 'unregistered-nonce-abcdefghijklmnop']);
  assert.deepEqual(hostClaim(f, mixed, f.now + 16), { recognized: false, messages: [], binding: null });
  assert.deepEqual(attemptRow(f.store, old), ended);
  assert.equal(f.store.pendingCount(target, f.now + 17), 1);
});

test('I1: an expired hook receipt is refused; a fresh verified receipt of the same marker claims the body once', () => {
  const f = fixture(); const old = handOff(f);
  const observed = observe(f, old, f.now + 5);
  // The broker was down past the 30 second receipt TTL, so the same receipt is rejected on retry.
  assert.equal(hostClaim(f, observed, f.now + 35_005).recognized, false);
  assert.equal(attemptRow(f.store, old).state, 'handed-off');
  keepAlive(f.store, 'instance-1', 'relay-1', f.now + 40_000);
  const fresh = hostClaim(f, observe(f, old, f.now + 40_001), f.now + 40_002);
  assert.equal(fresh.recognized, true);
  assert.deepEqual(fresh.messages.map(message => message.messageId), ['pending-body']);
  assert.equal(attemptRow(f.store, old).state, 'observed');
});

test('C2: a same-millisecond rebirth gets a distinct generation, so the previous birth cannot claim', () => {
  const f = fixture(); const old = handOff(f);
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

test('2.8: autoWake v2 is advisory and reports each delivery path fact', () => {
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
  const board = f.store.listPresence(f.now + 21_000, [target])[0];
  assert.equal(board.state, 'unreachable'); assert.equal(board.autoWake.state, 'no-live-relay'); assert.equal(board.relayLive, false);
  keepAlive(f.store, 'instance-1', 'relay-1', f.now + 22_000);
  const handedAt = f.now + 22_000;
  const attempt = handOff({ ...f, now: handedAt });
  const outcomeAt = attemptRow(f.store, attempt).outcome_at;
  assert.equal(outcomeAt, iso(handedAt + 2));
  check(f.store, handedAt + 10, 'available', 'wake-in-flight', outcomeAt);
  const unanswered = handedAt + 2 + WAKE_OBSERVATION_WINDOW_MS + 1_000;
  keepAlive(f.store, 'instance-1', 'relay-1', unanswered);
  check(f.store, unanswered, 'available', 'wake-unanswered', attemptRow(f.store, attempt).resend_due_at);
  const sent = f.store.submitPrepared(sender, f.store.prepare({ sender, target, body: 'advisory send', ttlSeconds: 600 }, unanswered).messageId, unanswered);
  assert.equal(sent.autoWake.reason, 'wake-unanswered');
  assert.equal(f.store.status(sender, sent.messageId, unanswered + 2).autoWake.reason, 'wake-unanswered');
  // A claim boundary releases the hand-off and is reported as the fact it is.
  const claimed = f.store.claim(target, unanswered + 3);
  assert.ok(claimed.some(message => message.messageId === sent.messageId));
  f.store.prune(unanswered + 4);
  assert.equal(attemptRow(f.store, attempt).release_reason, 'claimed-after-handoff');
  check(f.store, unanswered + 4, 'available', 'recipient-active', iso(unanswered + 3));
  assert.equal(f.store.acknowledge(target, [sent.messageId], unanswered + 5, claimed.filter(message => message.messageId === sent.messageId)
    .map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }))), 1);
  assert.equal(f.store.status(sender, sent.messageId, unanswered + 6).autoWake, null);
  const quietAt = unanswered + 3 + WAKE_QUIET_MS + 1;
  keepAlive(f.store, 'instance-1', 'relay-1', quietAt);
  check(f.store, quietAt, 'available', 'relay-live', iso(quietAt));
  assert.equal(dispatch(f.store, 'status', { sender, messageId: sent.messageId }).status.autoWake, null);
});

// 2026-10-27 local incident: Codex markers handed to `codex queue` stayed unobserved for 70 minutes while send
// results kept reporting available/wake-in-flight. The fact after the window is now wake-unanswered (I10).
test('I10: an unobserved hand-off is reported as unanswered after the observation window, with no state change', () => {
  for (const outcome of [HANDED, UNKNOWN]) {
    const f = fixture();
    const attempt = handOff(f, outcome);
    const row = attemptRow(f.store, attempt);
    const handedOff = Date.parse(row.outcome_at);
    const at = ms => { keepAlive(f.store, 'instance-1', 'relay-1', ms); return ms; };
    const inFlight = at(handedOff + WAKE_OBSERVATION_WINDOW_MS - 1);
    assert.deepEqual(f.store.autoWakeOutlook(target, inFlight),
      { state: 'available', reason: 'wake-in-flight', basisAt: row.outcome_at, checkedAt: iso(inFlight), authorityEffect: 'none' }, outcome.result);
    assert.equal(f.store.managedWakeStatus(target, inFlight).observation, 'pending', outcome.result);
    assert.notEqual(f.store.managedWakeStatus(target, inFlight).deliveryState, 'delivered', 'handed-off is not delivery');
    const overdue = at(handedOff + WAKE_OBSERVATION_WINDOW_MS);
    assert.deepEqual(f.store.autoWakeOutlook(target, overdue),
      { state: 'available', reason: 'wake-unanswered', basisAt: row.resend_due_at, checkedAt: iso(overdue), authorityEffect: 'none' }, outcome.result);
    const sent = f.store.submitPrepared(sender, f.store.prepare({ sender, target, body: `after ${outcome.result}`, ttlSeconds: 600 }, overdue).messageId, overdue);
    assert.equal(sent.autoWake.reason, 'wake-unanswered', outcome.result);
    // Reporting only: suppression and the stored attempt are unchanged before the resend deadline (I4, I5).
    assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), overdue).dispatch, false, outcome.result);
    assert.deepEqual(attemptRow(f.store, attempt), row, outcome.result);
  }
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

test('a reservation expiry committed by another process just before it exits leaves one ended row and one next reservation', async () => {
  const f = fixture();
  body(f.store, 'pending-body', f.now);
  const reservation = f.store.reserveManagedWake(request('instance-1', 'relay-1', 'liveness-first-nonce-abcdefghijklmnop'), f.now);
  assert.equal(reservation.dispatch, true);
  const old = reservation.attempt;
  const before = attemptRow(f.store, old);
  const expiry = Date.parse(before.expires_at);
  const p = await child(f.database, 'retire-then-exit', 'relay-retire', f.directory);
  assert.equal(p.first.type, 'ready', p.stderr());
  p.process.send({ now: expiry });
  const [code] = await p.exit; assert.equal(code, 21, p.stderr());
  const released = attemptRow(f.store, old);
  assert.deepEqual([released.state, released.release_reason, released.released_at], ['released', 'expired', iso(expiry)]);
  assert.deepEqual(without(released, ['state', 'release_reason', 'released_at']), without(before, ['state', 'release_reason', 'released_at']));
  f.store.prune(expiry + 1); assert.deepEqual(attemptRow(f.store, old), released);
  live(f.store, 'instance-2', 'relay-2', expiry + 2);
  assert.equal(f.store.reserveManagedWake(request('instance-2', 'relay-2'), expiry + 2).dispatch, true);
});

test('two independent processes settling an ended birth agree on one birth-ended row', async () => {
  const f = fixture(); const old = handOff(f);
  assert.equal(f.store.endPresence(target, 'fixture-ended', 'instance-1', f.now + 10), true);
  const raced = await Promise.all(['retire-a', 'retire-b'].map(id => child(f.database, 'retire-then-exit', id, f.directory)));
  for (const p of raced) assert.equal(p.first.type, 'ready', p.stderr());
  raced.forEach((p, index) => p.process.send({ now: f.now + 20 + index * 5 }));
  for (const p of raced) { const [code] = await p.exit; assert.equal(code, 21, p.stderr()); }
  const ended = attemptRow(f.store, old);
  assert.deepEqual([ended.state, ended.release_reason], ['released', 'birth-ended']);
  assert.ok([iso(f.now + 20), iso(f.now + 25)].includes(ended.released_at));
  f.store.prune(f.now + 3600_000); assert.deepEqual(attemptRow(f.store, old), ended);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1);
});

test('I5: two independent relay processes after a birth-ended release reserve exactly one new attempt', async () => {
  const f = fixture(); const old = handOff(f);
  live(f.store, 'instance-2', 'relay-a', f.now + 20_000);
  const raced = await Promise.all(['relay-a', 'relay-b'].map(id => child(f.database, 'wake-transition', id, f.directory)));
  for (const p of raced) assert.equal(p.first.type, 'ready', p.stderr());
  const results = await Promise.all(raced.map(p => result(p, { kind: 'relay', now: f.now + 20_001 })));
  assert.equal(results.map(item => item.result).filter(item => item?.dispatch).length, 1);
  assert.equal(attemptRow(f.store, old).release_reason, 'birth-ended');
  assert.equal(f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE state IN ${ACTIVE}`).get().n, 1);
});

test('AGS-D-0304 (a): a transient failure retries with a new row after backoff, and a claim of every body stops the retry', () => {
  const f = fixture();
  body(f.store, 'f8b4539a', f.now);
  const first = begin(f.store, f.now);
  assert.equal(f.store.recordManagedWakeOutcome(first, TRANSIENT, BASE, f.now + 2), true);
  assert.equal(attemptRow(f.store, first).state, 'not-delivered');
  const retryNotBefore = f.store.database.prepare('SELECT retry_not_before FROM wake_paths WHERE instance_id = ?').get('instance-1').retry_not_before;
  assert.ok([iso(f.now + 2 + wakeBackoffDelay(0)), iso(f.now + 2 + wakeBackoffDelay(1))].includes(retryNotBefore));
  const retryOutlook = f.store.autoWakeOutlook(target, f.now + 3);
  assert.deepEqual([retryOutlook.reason, retryOutlook.basisAt], ['retry-backoff', retryNotBefore]);
  const claimed = f.store.claim(target, f.now + 10);
  assert.equal(claimed.length, 1);
  const afterClaim = f.store.status(sender, 'f8b4539a', f.now + 11);
  assert.equal(afterClaim.state, 'delivered');
  assert.equal(afterClaim.wake.state, 'not-delivered');
  const backoffPassed = Date.parse(retryNotBefore) + WAKE_QUIET_MS;
  keepAlive(f.store, 'instance-1', 'relay-1', backoffPassed);
  assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), backoffPassed).dispatch, false, 'nothing left to deliver');
  f.store.acknowledge(target, ['f8b4539a'], backoffPassed + 1, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt })));
  body(f.store, 'message-0001', backoffPassed + 2);
  body(f.store, 'message-0002', backoffPassed + 3);
  const batchWake = begin(f.store, backoffPassed + 4, request('instance-1', 'relay-1', 'batch-wake-nonce-abcdefghijklmnop'));
  assert.equal(f.store.recordManagedWakeOutcome(batchWake, TRANSIENT, BASE, backoffPassed + 5), true);
  const batchClaim = f.store.claim(target, backoffPassed + 6, { maxMessages: 1 });
  assert.deepEqual(batchClaim.map(m => m.messageId), ['message-0001']);
  assert.equal(f.store.acknowledge(target, ['message-0001'], backoffPassed + 7, batchClaim.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }))), 1);
  const nextRetry = backoffPassed + 7 + 10 * 60_000;
  keepAlive(f.store, 'instance-1', 'relay-1', nextRetry);
  const resumedForRemaining = f.store.reserveManagedWake(request('instance-1', 'relay-1', 'batch-retry-nonce-abcdefghijklmnop'), nextRetry);
  assert.equal(resumedForRemaining.dispatch, true, 'the remaining body is still rung');
  assert.notEqual(resumedForRemaining.attempt.attemptId, batchWake.attemptId, 'a retry is always a new row (2.2)');
  assert.notEqual(resumedForRemaining.attempt.nonce, batchWake.nonce);
});

test('AGS-D-0304 (b): a claim after the hand-off stops reporting wake-in-flight; the boundary keeps the session from being rung at once', () => {
  const f = fixture();
  body(f.store, '417e2c85', f.now);
  const attempt = begin(f.store, f.now);
  const outcomeAt = f.now + 5_880;
  assert.equal(f.store.recordManagedWakeOutcome(attempt, HANDED, BASE, outcomeAt), true);
  assert.equal(f.store.autoWakeOutlook(target, outcomeAt + 100).reason, 'wake-in-flight');
  const claimAt = f.now + 38_000;
  keepAlive(f.store, 'instance-1', 'relay-1', claimAt);
  const claimed = f.store.claim(target, claimAt);
  assert.deepEqual(claimed.map(m => m.messageId), ['417e2c85']);
  f.store.prune(claimAt + 50);
  const statusAfterClaim = f.store.status(sender, '417e2c85', claimAt + 100);
  assert.equal(statusAfterClaim.state, 'delivered');
  assert.equal(statusAfterClaim.wake.state, 'released');
  assert.equal(statusAfterClaim.wake.releaseReason, 'claimed-after-handoff');
  assert.equal(statusAfterClaim.autoWake.reason, 'recipient-active');
  const ackAt = f.now + 54_000;
  keepAlive(f.store, 'instance-1', 'relay-1', ackAt);
  assert.equal(f.store.acknowledge(target, ['417e2c85'], ackAt, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }))), 1);
  assert.equal(f.store.status(sender, '417e2c85', ackAt + 100).state, 'acknowledged');
  body(f.store, 'after-ack', ackAt + 150);
  assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), ackAt + 200).dispatch, false, 'not quiet yet');
});

test('D0353 / D0305: a claim and ACK after the hand-off free the slot; the next message is rung once the session is quiet', () => {
  const f = fixture();
  body(f.store, 'batch-1-msg', f.now);
  const first = begin(f.store, f.now);
  const outcomeAt = f.now + 5_880;
  assert.equal(f.store.recordManagedWakeOutcome(first, HANDED, BASE, outcomeAt), true);
  const claimAt = f.now + 38_000;
  keepAlive(f.store, 'instance-1', 'relay-1', claimAt);
  const claimed = f.store.claim(target, claimAt);
  assert.deepEqual(claimed.map(m => m.messageId), ['batch-1-msg']);
  assert.equal(f.store.acknowledge(target, ['batch-1-msg'], f.now + 54_000, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }))), 1);
  body(f.store, 'batch-2-msg', f.now + 55_000);
  keepAlive(f.store, 'instance-1', 'relay-1', claimAt + WAKE_QUIET_MS - 1);
  assert.equal(f.store.reserveManagedWake(request('instance-1', 'relay-1'), claimAt + WAKE_QUIET_MS - 1).dispatch, false);
  assert.deepEqual([attemptRow(f.store, first).state, attemptRow(f.store, first).release_reason], ['released', 'claimed-after-handoff']);
  keepAlive(f.store, 'instance-1', 'relay-1', claimAt + WAKE_QUIET_MS + 1);
  const next = f.store.reserveManagedWake(request('instance-1', 'relay-1'), claimAt + WAKE_QUIET_MS + 1);
  assert.equal(next.dispatch, true);
  assert.notEqual(next.attempt.attemptId, first.attemptId);
  // The late marker of the released attempt claims the current body of the same birth; the next attempt is not disturbed.
  const late = hostClaim(f, observe(f, first, claimAt + WAKE_QUIET_MS + 2), claimAt + WAKE_QUIET_MS + 3);
  assert.deepEqual(late.messages.map(m => m.messageId), ['batch-2-msg']);
  assert.equal(attemptRow(f.store, first).state, 'released');
});
