import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_QUIET_MS, WAKE_RESEND_MAX_MS, WAKE_START_TIMEOUT_MS } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageOperation } from '../../mcp-server/src/session-message-operations.ts';
import { dispatchManagedWake } from '../../mcp-server/src/session-message-relay.ts';
import '../../mcp-server/src/builtin-hook-host-adapters.ts';
import { adaptHostInput, registerHookHostAdapter } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader } from '../../mcp-server/src/session-message-wake-port.ts';
import { transportDeliveryCapabilities } from '../../mcp-server/src/wake-transports.ts';
import { TrustStore } from '../../mcp-server/src/trust-store.ts';

const dispatch = (store, operation, payload, reader) => dispatchSessionMessageOperation(store, operation, payload, reader);
// AGS 3.0 doorbell (docs/ags30-wake-doorbell-design.md r3.2): outcomes are objects, every start/outcome carries the
// port's resend base, and a retry is always a new row. These cases keep I1-I6 and I11.
const BASE = 10 * 60_000;
const HANDED = { result: 'handed-off' };
const UNKNOWN = { result: 'unknown', reasonCode: 'SYNTHETIC_UNKNOWN' };
const TRANSIENT = { result: 'not-delivered', kind: 'transient', reasonCode: 'SYNTHETIC_TRANSIENT' };
const iso = at => new Date(at).toISOString();
const ACTIVE = "('reserved','started','handed-off','unknown')";
const portOf = (fields) => ({ capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, resendBaseMs: BASE, ...fields });
// The synthetic host process the hook reported (the parent of the fixture processes) and the birth its relay's watcher bound.
const HOST_PID = process.pid;
const HOST_START = 'synthetic-host-start';
/** The hook grants the birth a lease under a fresh relay_id; the relay's first tick binds the host birth so it may ring. */
function grantRelay(store, instanceId, at, transport = 'portable') {
  const grant = store.grantRelay({ ...target, transport, instanceId, codeDigest: null, hostPid: HOST_PID }, at);
  assert.ok(grant.relayId, grant.reason);
  assert.deepEqual(store.relayTick({ ...target, transport, relayId: grant.relayId, instanceId, includePending: false, hostStart: HOST_START }, at),
    { alive: true, count: 0, hostBound: true });
  return grant.relayId;
}
/** Keeps the fixture birth and its relay live without a new birth and without a claim boundary (one extension models the relay's ticks). */
function keepAlive(f, at, instanceId = 'instance-1') {
  f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ? AND ended_at IS NULL').run(iso(at + 20_000), instanceId);
  assert.equal(f.store.database.prepare("UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE transport = 'portable' AND relay_id = ?")
    .run(iso(at + 15_000), iso(at), f.relayId).changes, 1);
}
const resources = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
// Explicit synthetic root adapter for core regression cases; not native capture or R7 evidence.
// The builtin decoder supplies event shape only; actor authority is this fake fixture contract.
registerHookHostAdapter("portable", {
    adaptInput: (input, selectedHost) => {
      const adapted = adaptHostInput(input, "codex");
      return {...adapted, observation: {...adapted.observation, host: selectedHost,
        actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_CORE_ROOT"}}};
    },
  deliveryProfile: () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined,
});

const target = { host: 'portable', sessionId: 'wake-target' };
const sender = { host: 'portable', sessionId: 'wake-sender' };
function fixture(relayRemainingMs = 15_000) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r2-'));
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  resources.push({ directory, stores: [store] });
  const now = Date.now();
  store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable',
    wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' }, hostPid: HOST_PID }, now);
  const relayId = grantRelay(store, 'instance-1', now);
  // An aged lease expires naturally at now + relayRemainingMs, before a replacement relay is granted it.
  store.database.prepare('UPDATE relay_leases SET lease_until = ? WHERE relay_id = ?').run(iso(now + relayRemainingMs), relayId);
  return { directory, database, store, now, relayId };
}
// Bulk rows go through a separate filling connection. Autocommit INSERTs fsync every commit under the default
// synchronous=FULL (about 1,000 per test), which exceeds the timeout on slow CI disks. NORMAL is per connection,
// so the store under test keeps its own setting; the filling connection is closed before the store reads the rows.
function fillRows(f, sql, count, values) {
  const filler = new DatabaseSync(f.database);
  try {
    filler.exec('PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
    const insert = filler.prepare(sql);
    for (let i = 0; i < count; i++) insert.run(...values(i));
  } finally { filler.close(); }
}
function reservation(f, nonce = 'managed-wake-nonce-abcdefghijklmnop') {
  return { target, nonce, instanceId: 'instance-1', transport: 'portable', relayId: f.relayId };
}
function begin(f, now, input = reservation(f)) {
  const reserved = f.store.reserveManagedWake({ ...input.target, ...input }, now);
  assert.equal(reserved.dispatch, true);
  const started = f.store.startManagedWake(reserved.attempt, BASE, now + 1);
  assert.equal(started.dispatch, true);
  return started.attempt;
}
function observe(f, attempt, now = f.now + 3, extra = {}) {
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(f.directory, 'trust.sqlite3'));
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]`, ...extra }, target.host).observation;
  const sourceReceiptId = recordWakeHookObservation(observation, now);
  return { observation, sourceReceiptId };
}
function hostClaim(f, observed, now = f.now + 4, limits = {}) {
  return f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, wakeHookObservationReader, now, limits);
}
function body(store, id = 'body-0001', now = Date.now(), ttlSeconds = 3600) {
  store.send({ sender, target, messageId: id, body: id, ttlSeconds }, now);
}
function attemptRow(store, attempt) { return store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(attempt.attemptId); }
function without(row, keys) { return Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key))); }
const receipts = messages => messages.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }));

test('W05-r2 a reservation ended by a claim and ACK cannot authorize another wake while the session is not quiet', () => {
  const f = fixture(); const { store } = f;
  store.send({ sender, target, messageId: 'first-body', body: 'first' });
  assert.equal(dispatch(store, 'reserve-wake', reservation(f)).dispatch, true);
  const claimed = store.claim(target);
  store.acknowledge(target, ['first-body'], undefined, receipts(claimed));
  store.send({ sender, target, messageId: 'second-body', body: 'second-body' });
  assert.equal(dispatch(store, 'reserve-wake', reservation(f, 'another-wake-nonce-abcdefghijklmnop')).dispatch, false);
});

test('W05-r2 board ownership check has no nonce state effect', () => {
  const f = fixture(); const { store } = f;
  store.send({ sender, target, messageId: 'owned-body', body: 'body-0001' });
  const input = reservation(f);
  assert.equal(dispatch(store, 'reserve-wake', input).dispatch, true);
  store.claim(target);
  const before = store.database.prepare('SELECT * FROM wake_nonces').get();
  assert.equal(store.consumeWake(target, input.nonce), true);
  assert.deepEqual(store.database.prepare('SELECT * FROM wake_nonces').get(), before);
});

test.each(['claimDeferred', 'claimTurnEnd'])('I5: %s and ACK during a started attempt leave its slot until the start timeout', (method) => {
  const f = fixture(); body(f.store, 'boundary-body', f.now);
  const attempt = begin(f, f.now);
  const claimed = f.store[method](target, f.now + 2);
  assert.equal(claimed.length, 1);
  f.store.acknowledge(target, ['boundary-body'], f.now + 3, receipts(claimed));
  body(f.store, 'new-boundary-body', f.now + 4);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'second-nonce-abcdefghijklmnop') }, f.now + 5).dispatch, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 5).attemptId, attempt.attemptId);
  assert.equal(attemptRow(f.store, attempt).state, 'started');
});

test('W05-r2 start rechecks claim/ACK and persists a no-effect end; the next body is rung once quiet', () => {
  const f = fixture(); body(f.store, 'before-start', f.now);
  const reserved = f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now);
  const claimed = f.store.claim(target, f.now + 1); f.store.acknowledge(target, ['before-start'], f.now + 2, receipts(claimed));
  assert.equal(f.store.startManagedWake(reserved.attempt, BASE, f.now + 3).dispatch, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 3).state, 'not-delivered');
  body(f.store, 'next-body', f.now + 4);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'next-nonce-abcdefghijklmnop') }, f.now + 5).dispatch, false, 'the claim was a boundary');
  const quiet = f.now + 1 + WAKE_QUIET_MS + 1;
  keepAlive(f, quiet);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'next-nonce-abcdefghijklmnop') }, quiet).dispatch, true);
});

test('W05-r2 a claim before the outcome keeps one slot until the actual hook', () => {
  const f = fixture(); body(f.store, 'after-start', f.now);
  const attempt = begin(f, f.now);
  const firstClaim = f.store.claim(target, f.now + 2); f.store.acknowledge(target, ['after-start'], f.now + 3, receipts(firstClaim));
  assert.equal(f.store.recordManagedWakeOutcome(attempt, HANDED, BASE, f.now + 4), true);
  body(f.store, 'next-body', f.now + 5);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'next-nonce-abcdefghijklmnop') }, f.now + 6).dispatch, false);
  assert.equal(attemptRow(f.store, attempt).state, 'handed-off', 'a boundary before the hand-off does not release it');
  const result = hostClaim(f, observe(f, attempt, f.now + 7), f.now + 8);
  assert.equal(result.recognized, true); assert.deepEqual(result.messages.map(message => message.messageId), ['next-body']);
  assert.equal(f.store.managedWakeStatus(target, f.now + 8).state, 'observed');
  assert.equal(f.store.recordManagedWakeOutcome(attempt, UNKNOWN, BASE, f.now + 9), false);
});

test('W05-r2 reserved crash recovery keeps the nonce/attempt and fences the replaced relay_id at start', () => {
  const f = fixture(1); body(f.store, 'body-0001', f.now);
  const reserved = f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now);
  assert.equal(reserved.dispatch, true);
  const first = reserved.attempt;
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer);
  assert.equal(peer.liveRelay(target, 'portable', f.now + 1), null);
  const replacement = grantRelay(peer, 'instance-1', f.now + 1);
  assert.notEqual(replacement, f.relayId);
  const recovery = peer.reserveManagedWake({ ...target, ...reservation(f), relayId: replacement, resume: true }, f.now + 2);
  assert.equal(recovery.dispatch, true);
  const recovered = recovery.attempt;
  assert.equal(recovered.nonce, first.nonce); assert.equal(recovered.attemptId, first.attemptId);
  assert.equal(f.store.startManagedWake(first, BASE, f.now + 3).dispatch, false);
  assert.equal(peer.startManagedWake(recovered, BASE, f.now + 4).dispatch, true);
  assert.equal(peer.startManagedWake(recovered, BASE, f.now + 4).dispatch, false);
});

test('W05-r2 transport remains part of the exact stored attempt binding', () => {
  const f = fixture(); body(f.store, 'exact-binding-body', f.now);
  const reserved = f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now).attempt;
  f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'other-port', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + 1);
  grantRelay(f.store, 'instance-1', f.now + 1, 'other-port');
  assert.equal(f.store.startManagedWake({ ...reserved, transport: 'other-port' }, BASE, f.now + 2).dispatch, false);
  f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + 3);
  const reopened = f.store.reserveManagedWake({ ...target, ...reservation(f, 'exact-binding-retry-nonce-abcdef'), resume: true }, f.now + 3);
  const started = f.store.startManagedWake(reopened.attempt ?? reserved, BASE, f.now + 4).attempt;
  assert.ok(started);
  assert.equal(f.store.recordManagedWakeOutcome({ ...started, transport: 'other-port' }, TRANSIENT, BASE, f.now + 5), false);
  assert.equal(attemptRow(f.store, started).state, 'started');
});

test('W05-r2 a transient failure ends its row; the retry is a new row after durable backoff and late results need the exact epoch', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now, 86_400);
  const first = begin(f, f.now);
  assert.equal(f.store.recordManagedWakeOutcome(first, TRANSIENT, BASE, f.now + 2), true);
  assert.equal(attemptRow(f.store, first).state, 'not-delivered');
  const deadline = Date.parse(f.store.database.prepare('SELECT retry_not_before FROM wake_paths WHERE instance_id = ?').get('instance-1').retry_not_before);
  keepAlive(f, deadline - 1);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'retry-nonce-abcdefghijklmnopqr'), resume: true }, deadline - 1).dispatch, false);
  keepAlive(f, deadline);
  const retried = f.store.reserveManagedWake({ ...target, ...reservation(f, 'retry-nonce-abcdefghijklmnopqr'), resume: true }, deadline).attempt;
  assert.ok(retried);
  assert.notEqual(retried.attemptId, first.attemptId); assert.notEqual(retried.nonce, first.nonce);
  const second = f.store.startManagedWake(retried, BASE, deadline + 1).attempt;
  assert.equal(second.dispatchEpoch, 1);
  assert.equal(f.store.recordManagedWakeOutcome(first, HANDED, BASE, deadline + 2), false);
  assert.equal(f.store.recordManagedWakeOutcome({ ...second, dispatchEpoch: 0 }, HANDED, BASE, deadline + 2), false);
  assert.equal(f.store.recordManagedWakeOutcome(second, UNKNOWN, BASE, deadline + 3), true);
  assert.equal(f.store.managedWakeStatus(target, deadline + 3).state, 'unknown');
});

function currentGeneration(f, kind, at) {
  const current = { ...target, instanceId: kind === 'instance' ? 'instance-2' : 'instance-1',
    transport: kind === 'transport' ? 'other-port' : 'portable', relayId: null,
    wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, hostPid: HOST_PID };
  if (kind === 'rebirth') f.store.endPresence(target, 'fixture-rebirth', 'instance-1', at);
  // The fixture lease lapsed at f.now + 2, so the current generation is granted a new relay.
  assert.equal(f.store.liveRelay(target, current.transport, at), null);
  renewCurrent(f.store, current, at);
  return current;
}
/** First call: the current birth and its granted relay. Later calls: its relay kept both live up to `at` (no new birth). */
function renewCurrent(store, current, at) {
  if (current.relayId !== null) {
    store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ? AND ended_at IS NULL').run(iso(at + 20_000), current.instanceId);
    assert.equal(store.database.prepare('UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE relay_id = ?')
      .run(iso(at + 15_000), iso(at), current.relayId).changes, 1);
  }
  store.startPresence(current, at);
  current.relayId ??= grantRelay(store, current.instanceId, at, current.transport);
  assert.equal(store.presence(target, at).state, 'online');
  assert.equal(store.liveRelay(target, current.transport, at).relayId, current.relayId);
  assert.equal(store.pendingCount(target, at), 1);
}
// H1 reserved only; H2 started then a transient failure; H3 started, the binding changes, then a late transient failure.
const staleCases = ['H1', 'H2', 'H3'].flatMap(order => ['instance', 'rebirth', 'transport'].map(kind => [order, kind]));
test.each(staleCases)('a no-effect old attempt %s/%s ends as not-delivered and a separate attempt follows (new birth from zero, same birth after backoff)', (order, kind) => {
  const f = fixture(2); body(f.store, 'old-pending', f.now, 86_400);
  const old = order === 'H1' ? f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now).attempt : begin(f, f.now);
  if (order === 'H2') assert.equal(f.store.recordManagedWakeOutcome(old, TRANSIENT, BASE, f.now + 2), true);
  const current = currentGeneration(f, kind, f.now + 3);
  const request = { ...current, nonce: 'new-generation-nonce-abcdefghijklmnop', resume: true };
  const messages = f.store.database.prepare('SELECT * FROM messages').all();
  if (order === 'H3') {
    // A started attempt holds the slot until its timeout; the binding change alone proves nothing (I4).
    assert.equal(f.store.reserveManagedWake(request, f.now + 4).dispatch, false);
    assert.equal(attemptRow(f.store, old).state, 'started');
    assert.equal(f.store.recordManagedWakeOutcome(old, TRANSIENT, BASE, f.now + 5), true);
  }
  const early = f.store.reserveManagedWake(request, f.now + 6);
  const terminal = attemptRow(f.store, old);
  assert.equal(terminal.state, 'not-delivered');
  for (const outcome of [HANDED, TRANSIENT]) assert.equal(f.store.recordManagedWakeOutcome(old, outcome, BASE, f.now + 7), false);
  assert.equal(f.store.startManagedWake(old, BASE, f.now + 7).dispatch, false);
  let next = early;
  let nextAt = f.now + 6;
  // The transport kind keeps the same birth, so a failure's backoff of that birth still holds (2.3); a new birth starts at zero (r3 F2).
  if (order !== 'H1' && kind === 'transport') {
    assert.equal(early.dispatch, false);
    const deadline = Date.parse(f.store.database.prepare('SELECT retry_not_before FROM wake_paths WHERE instance_id = ? AND birth_generation = ?')
      .get(current.instanceId, f.store.presence(target, f.now + 6).startedAt).retry_not_before);
    renewCurrent(f.store, current, deadline - 1);
    const reopened = new SessionMessageStore(f.database); resources.at(-1).stores.push(reopened);
    assert.equal(reopened.reserveManagedWake(request, deadline - 1).dispatch, false);
    renewCurrent(f.store, current, deadline);
    nextAt = deadline;
    next = reopened.reserveManagedWake({ ...request, nonce: 'new-generation-retry-nonce-abcdefghij' }, deadline);
  }
  assert.equal(next.dispatch, true); assert.notEqual(next.attempt.nonce, old.nonce);
  assert.notEqual(next.attempt.attemptId, old.attemptId); assert.equal(next.attempt.dispatchEpoch, 0);
  const at = nextAt + 1;
  const started = f.store.startManagedWake(next.attempt, BASE, at); assert.equal(started.dispatch, true);
  assert.equal(f.store.startManagedWake(next.attempt, BASE, at).dispatch, false);
  assert.equal(f.store.recordManagedWakeOutcome(old, UNKNOWN, BASE, at), false);
  const fresh = attemptRow(f.store, started.attempt);
  assert.equal(hostClaim(f, observe(f, old, at), at + 1).recognized, false);
  assert.deepEqual(attemptRow(f.store, started.attempt), fresh);
  assert.deepEqual(f.store.database.prepare('SELECT * FROM messages').all(), messages);
  assert.deepEqual(without(attemptRow(f.store, old), ['late_observed_at']), without(terminal, ['late_observed_at']));
});

test.each(['handed-off', 'unknown'])('a new birth ends the old %s hand-off as birth-ended and rings the pending body', outcome => {
  const f = fixture(2); body(f.store, 'uncertain-pending', f.now); const old = begin(f, f.now);
  f.store.recordManagedWakeOutcome(old, outcome === 'handed-off' ? HANDED : UNKNOWN, BASE, f.now + 2);
  const current = currentGeneration(f, 'instance', f.now + 3);
  const next = f.store.reserveManagedWake({ ...current, nonce: 'new-fenced-nonce-abcdefghijklmnop', resume: true }, f.now + 4);
  assert.deepEqual([attemptRow(f.store, old).state, attemptRow(f.store, old).release_reason], ['released', 'birth-ended']);
  assert.equal(next.dispatch, true);
  assert.equal(f.store.pendingCount(target, f.now + 5), 1);
});

test('I4/I5: a started attempt is not replaced by a new birth before its start timeout', () => {
  const f = fixture(2); body(f.store, 'started-pending', f.now); const old = begin(f, f.now);
  const current = currentGeneration(f, 'instance', f.now + 3);
  assert.equal(f.store.reserveManagedWake({ ...current, nonce: 'new-fenced-nonce-abcdefghijklmnop', resume: true }, f.now + 4).dispatch, false);
  assert.equal(attemptRow(f.store, old).state, 'started');
  // After the timeout it becomes unknown and, its birth being gone, is released at once.
  const timeout = f.now + 1 + WAKE_START_TIMEOUT_MS;
  renewCurrent(f.store, current, timeout);
  assert.equal(f.store.reserveManagedWake({ ...current, nonce: 'new-fenced-nonce-abcdefghijklmnop', resume: true }, timeout).dispatch, true);
  assert.deepEqual([attemptRow(f.store, old).state, attemptRow(f.store, old).release_reason], ['released', 'birth-ended']);
});

test('an old-birth late failure requires every original binding field and epoch', () => {
  const f = fixture(2); body(f.store, 'exact-pending', f.now); const old = begin(f, f.now);
  const current = currentGeneration(f, 'instance', f.now + 2);
  assert.equal(f.store.reserveManagedWake({ ...current, nonce: 'new-exact-nonce-abcdefghijklmnop' }, f.now + 3).dispatch, false);
  const before = attemptRow(f.store, old);
  for (const key of ['host', 'sessionId', 'nonce', 'instanceId', 'generation', 'transport', 'relayId', 'attemptId', 'dispatchEpoch']) {
    const wrong = { ...old, [key]: key === 'dispatchEpoch' ? old.dispatchEpoch + 1 : `different-${key}-abcdefghijklmnop` };
    assert.equal(f.store.recordManagedWakeOutcome(wrong, TRANSIENT, BASE, f.now + 4), false, key);
    assert.deepEqual(attemptRow(f.store, old), before);
  }
  assert.equal(f.store.recordManagedWakeOutcome(old, TRANSIENT, BASE, f.now + 5), true);
});

test('terminal row pruning cannot erase the birth backoff', () => {
  const f = fixture(); body(f.store, 'cooldown-pending', f.now, 86_400); const old = begin(f, f.now);
  assert.equal(f.store.recordManagedWakeOutcome(old, TRANSIENT, BASE, f.now + 3), true);
  const deadline = Date.parse(f.store.database.prepare('SELECT retry_not_before FROM wake_paths WHERE instance_id = ?').get('instance-1').retry_not_before);
  fillRows(f, "INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, observed_at) VALUES (?, 'portable', ?, ?, 'observed', ?)",
    1005, i => [`new-terminal-${i}`, `other-${i}`, iso(deadline + 60_000), iso(f.now + 4 + i)]);
  keepAlive(f, f.now + 5);
  f.store.prune(f.now + 5);
  assert.equal(attemptRow(f.store, old), undefined, 'the oldest ended rows went to the 1000-row cap');
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'prune-retry-nonce-abcdefghijklmnop') }, f.now + 5).dispatch, false);
  keepAlive(f, deadline);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(f, 'prune-retry-nonce-abcdefghijklmnop') }, deadline).dispatch, true);
});

test('W05-r2 active budget overflow is an explicit rejection and does not remove active attempts', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  fillRows(f, "INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, started_at, dispatch_epoch, resend_base_ms) VALUES (?, 'portable', ?, ?, 'started', ?, 1, 600000)",
    1000, i => [`digest-${i}`, `target-${i}`, iso(f.now + 3600_000), iso(f.now)]);
  assert.throws(() => f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now + 1), /active wake store is full/);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'started'").get().n, 1000);
});

test('W05-r2 ordinary peer provenance, expired hook receipts and changed observation digests cannot observe', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f, f.now); const observed = observe(f, attempt, f.now + 2);
  const trust = new TrustStore(join(f.directory, 'trust.sqlite3'));
  let ordinary;
  try {
    const hook = trust.getInputSource(observed.sourceReceiptId);
    ordinary = trust.recordInputSource({ originKind: 'peer', host: hook.host, sessionId: hook.sessionId,
      eventId: 'ordinary-peer-0001', contentDigest: hook.contentDigest, observedAt: hook.observedAt, expiresAt: hook.expiresAt,
      authorityEffect: 'none', attestation: { kind: 'broker-peer-envelope', adapter: 'session-message-hook', capabilityVersion: '1.0.0' } });
  } finally { trust.close(); }
  assert.equal(hostClaim(f, { ...observed, sourceReceiptId: ordinary.receiptId }, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, { ...observed, observation: { ...observed.observation, actor: { role: 'indeterminate', basis: 'unavailable', reasonCode: 'SYNTHETIC_CHANGED_ACTOR' } } }, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, observed, f.now + 30_003).recognized, false);
  assert.equal(attemptRow(f.store, attempt).state, 'started');
});

test('W05-r2 observation holds the SQLite generation lock and notices a generation change during verification', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f, f.now); const observed = observe(f, attempt);
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer); peer.database.exec('PRAGMA busy_timeout = 1');
  let blocked = false;
  const reader = { verifyObservation: (...args) => {
    try { peer.endPresence(target, 'racing-change', 'instance-1', f.now + 4); }
    catch (error) { assert.match(error.message, /locked/); blocked = true; }
    // Even an injected verifier cannot make a stale snapshot authorize the later claim.
    f.store.endPresence(target, 'same-connection-change', 'instance-1', f.now + 4);
    return wakeHookObservationReader.verifyObservation(...args);
  } };
  assert.equal(f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, reader, f.now + 4).recognized, false);
  assert.equal(blocked, true); assert.equal(f.store.pendingCount(target, f.now + 4), 1);
  // Another birth's arrival is evidence only (2.7): no body, no observed state.
  const row = attemptRow(f.store, attempt);
  assert.equal(row.observed_at, null);
  assert.equal(row.late_observed_at, iso(f.now + 4));
});

test('I4: a lost committed outcome response never dispatches again', async () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  let calls = 0;
  const request = async (operation, payload) => {
    const result = dispatch(f.store, operation, payload);
    if (operation === 'record-wake-outcome') throw new Error('fixture response lost after commit');
    return result;
  };
  const port = portOf({ dispatch: async () => { calls++; return HANDED; } });
  await assert.rejects(dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId, port, request), /response lost/);
  assert.equal(f.store.managedWakeStatus(target).state, 'handed-off');
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId, port,
    async (operation, payload) => dispatch(f.store, operation, payload)), false);
  assert.equal(calls, 1);
});

test('I1: a forged nonce, a caller approval or a normalized observation cannot observe without the hook receipt', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f, f.now);
  const observed = observe(f, attempt, f.now + 2);
  assert.equal(f.store.consumeWake(target, attempt.nonce), true);
  assert.equal(f.store.claimHostWake(target, observed.observation, '', wakeHookObservationReader, f.now + 3).recognized, false);
  assert.equal(f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, undefined, f.now + 3).recognized, false);
  assert.throws(() => dispatch(f.store, 'claim-host-wake', { target, ...observed, approved: true }, wakeHookObservationReader), /source receipt/);
  assert.throws(() => dispatch(f.store, 'claim-wake', { target, nonces: [attempt.nonce] }), /Unknown session message operation/);
  assert.equal(attemptRow(f.store, attempt).state, 'started');
  assert.equal(f.store.claimHostWake(target, { ...observed.observation, wakeCandidates: ['forged-nonce-abcdefghijklmnop'] },
    observed.sourceReceiptId, wakeHookObservationReader, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, observed, f.now + 4).recognized, true);
  assert.deepEqual(hostClaim(f, observed, f.now + 5).messages, []);
});

test.each(['new-instance', 'same-instance-new-birth'])('I2: a verified %s arrival of an old marker claims nothing and a separate current wake delivers', variant => {
  const f = fixture(6); body(f.store, 'old-body', f.now);
  const attempt = begin(f, f.now);
  f.store.recordManagedWakeOutcome(attempt, HANDED, BASE, f.now + 2);
  const claimed = f.store.claim(target, f.now + 3); f.store.acknowledge(target, ['old-body'], f.now + 4, receipts(claimed));
  const at = f.now + 5;
  f.store.endPresence(target, 'fixture', 'instance-1', at);
  const instanceId = variant === 'new-instance' ? 'instance-2' : 'instance-1';
  f.store.startPresence({ ...target, instanceId, transport: 'portable',
    wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, hostPid: HOST_PID }, at + 1);
  // The fixture lease lapsed at f.now + 6: the new birth's relay is a new grant.
  const relayId = grantRelay(f.store, instanceId, at + 1);
  assert.notEqual(relayId, f.relayId);
  body(f.store, 'new-body', at + 2);
  const current = { ...target, ...reservation(f, 'current-wake-nonce-abcdefghijklmnop'), instanceId, relayId };
  const observed = observe(f, attempt, at + 3);
  const late = hostClaim(f, observed, at + 4);
  assert.equal(late.recognized, false); assert.deepEqual(late.messages, []);
  assert.equal(f.store.pendingCount(target, at + 4), 1);
  assert.equal(attemptRow(f.store, attempt).state, 'released');
  assert.equal(f.store.recordManagedWakeOutcome(attempt, TRANSIENT, BASE, at + 5), false);
  const reserved = f.store.reserveManagedWake(current, at + 6);
  assert.equal(reserved.dispatch, true);
  const next = f.store.startManagedWake(reserved.attempt, BASE, at + 7).attempt;
  assert.ok(next); assert.notEqual(next.attemptId, attempt.attemptId);
  assert.equal(hostClaim(f, observed, at + 8).recognized, false);
  assert.equal(f.store.managedWakeStatus(target, at + 8).attemptId, next.attemptId);
  assert.equal(f.store.reserveManagedWake({ ...current, nonce: 'duplicate-new-wake-abcdefghijklmnop' }, at + 9).dispatch, false);
  const delivered = hostClaim(f, observe(f, next, at + 10), at + 11);
  assert.equal(delivered.recognized, true);
  assert.deepEqual(delivered.messages.map(message => message.messageId), ['new-body']);
  assert.equal(delivered.binding.attemptId, next.attemptId);
});

test('I1/I2: old-birth arrival still rejects wrong target, unknown or mixed nonces and stale provenance', () => {
  const f = fixture(); body(f.store, 'old-body', f.now);
  const attempt = begin(f, f.now);
  f.store.recordManagedWakeOutcome(attempt, UNKNOWN, BASE, f.now + 2);
  f.store.startPresence({ ...target, instanceId: 'instance-2', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + 3);
  const observed = observe(f, attempt, f.now + 4);
  const mixed = observe(f, attempt, f.now + 4, {
    prompt: `[agent-governance-suite:wake:${attempt.nonce}]\n[agent-governance-suite:wake:unknown-nonce-abcdefghijklmnop]`,
  });
  assert.equal(hostClaim(f, mixed, f.now + 5).recognized, false);
  const ordinary = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]\nuser request` }, target.host).observation;
  assert.equal(hostClaim(f, { ...observed, observation: ordinary }, f.now + 5).recognized, false);
  assert.equal(f.store.claimHostWake({ ...target, sessionId: 'wrong-target' }, observed.observation,
    observed.sourceReceiptId, wakeHookObservationReader, f.now + 5).recognized, false);
  assert.equal(hostClaim(f, { ...observed, sourceReceiptId: 'unregistered-receipt' }, f.now + 5).recognized, false);
  assert.equal(hostClaim(f, observed, f.now + 30_005).recognized, false);
  const row = attemptRow(f.store, attempt);
  assert.ok(['unknown', 'released'].includes(row.state), row.state);
  assert.equal(row.observed_at, null);
  assert.equal(f.store.pendingCount(target, f.now + 30_005), 1);
});

test('I6: batch redelivery and hook rollback claim each body once per claim lease', () => {
  const f = fixture(); body(f.store, 'body-one', f.now); body(f.store, 'body-two', f.now);
  const attempt = begin(f, f.now); const observed = observe(f, attempt);
  assert.throws(() => hostClaim(f, observed, f.now + 4, { maxBodyChars: 1 }), /claim budget/);
  assert.equal(attemptRow(f.store, attempt).state, 'started', 'the failed claim rolled back');
  const first = hostClaim(f, observed, f.now + 5, { maxMessages: 1 });
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].messageId, 'body-one');
  // The next arrival of the current marker takes the rest of the batch, never the leased body again.
  assert.deepEqual(hostClaim(f, observed, f.now + 6).messages.map(message => message.messageId), ['body-two']);
  assert.deepEqual(f.store.claim(target, f.now + 7), []);
  assert.equal(f.store.claim(target, f.now + 120_006)[0].messageId, 'body-one');
  assert.equal(attemptRow(f.store, attempt).state, 'observed');
});

test('W05-r2 hook-before-outcome, adapter exception and new vendor use the same core', async () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  let calls = 0;
  let claimed = [];
  const request = async (operation, payload) => dispatch(f.store, operation, payload);
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId, portOf({
    dispatch: async () => {
      calls++;
      const row = f.store.database.prepare("SELECT * FROM wake_nonces WHERE state = 'started'").get();
      assert.ok(row); const observation = observe(f, { nonce: row.nonce }, Date.now());
      const observed = hostClaim(f, observation, Date.now());
      claimed = observed.messages;
      assert.equal(observed.recognized, true);
      return HANDED;
    },
  }), request), true);
  assert.equal(calls, 1); assert.equal(f.store.managedWakeStatus(target).state, 'observed', 'a late outcome never revives an observed row (I11)');
  f.store.acknowledge(target, ['body-0001'], undefined, receipts(claimed)); body(f.store, 'second-body');
  f.store.clearDeferred(target); // The woken turn ends (3.5.2: a wake opens a turn and its turn-end hook closes it).
  const later = Date.now() + WAKE_QUIET_MS + 1;
  keepAlive(f, later);
  const timed = async (operation, payload) => {
    if (operation === 'reserve-wake') return f.store.reserveManagedWake({ ...payload.target, nonce: payload.nonce, instanceId: payload.instanceId,
      relayId: payload.relayId, transport: payload.transport, resume: payload.resume }, later);
    if (operation === 'start-wake') return f.store.startManagedWake(payload.attempt, payload.resendBaseMs, later);
    if (operation === 'record-wake-outcome') return { recorded: f.store.recordManagedWakeOutcome(payload.attempt, payload.outcome, payload.resendBaseMs, later) };
    return dispatch(f.store, operation, payload);
  };
  await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId,
    portOf({ dispatch: async () => { calls++; throw new Error('lost adapter result'); } }), timed);
  assert.equal(f.store.managedWakeStatus(target, later).state, 'unknown'); assert.equal(calls, 2);
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId,
    portOf({ dispatch: async () => { calls++; return HANDED; } }), timed), false);
  assert.equal(calls, 2);
  const relaySource = readFileSync(new URL('../../mcp-server/src/session-message-relay.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(relaySource, /codex-queue|codex-deferred|claude-inbox|antigravity-queue|ringCodex\(/);
});

test('W05-r2 host capabilities keep submission/observation distinct and deferred idle wake zero', async () => {
  assert.deepEqual(transportDeliveryCapabilities('claude-inbox'), { supportedInjection: ['peer-wake', 'tool-boundary', 'turn-end'], idleWake: 'silent' });
  assert.deepEqual(transportDeliveryCapabilities('codex-queue'), { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'user-message' });
  assert.deepEqual(transportDeliveryCapabilities('antigravity-queue'), { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'user-message' });
  assert.deepEqual(transportDeliveryCapabilities('codex-deferred'), { supportedInjection: ['tool-boundary'], idleWake: 'none' });
  assert.deepEqual(transportDeliveryCapabilities('gemini-deferred'), { supportedInjection: ['tool-boundary'], idleWake: 'none' });
  assert.throws(() => transportDeliveryCapabilities('gemini-queue'), /unavailable/, '3.0 takes no 2.x transport name');
  assert.throws(() => transportDeliveryCapabilities('missing-adapter'), /unavailable/);
  let calls = 0;
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'unused-relay-id', {
    capabilities: { supportedInjection: ['tool-boundary'], idleWake: 'none' }, resendBaseMs: BASE, dispatch: async () => { calls++; return HANDED; },
  }, async () => { throw new Error('deferred must not request a reservation'); }), false);
  assert.equal(calls, 0);
});

function legacyDatabase(database) {
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE wake_nonces (nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT');
  db.prepare('INSERT INTO wake_nonces VALUES (?, ?, ?, ?, ?)').run('legacy-digest', 'portable', 'old', new Date(Date.now() + 3600_000).toISOString(), new Date().toISOString());
  db.close();
}

test('2.7: ended-row retention is bounded to 1000 rows and WAKE_RESEND_MAX_MS while active rows are retained', () => {
  const f = fixture();
  fillRows(f, "INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, observed_at) VALUES (?, 'portable', ?, ?, 'observed', ?)",
    1005, i => [`terminal-${i}`, `target-${i}`, iso(f.now + 3600_000), iso(f.now + i)]);
  f.store.prune(f.now + 1006);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1000);
  // Ended rows older than WAKE_RESEND_MAX_MS go: observed_at now+5..now+504 are past it, now+505..now+1004 are not.
  f.store.prune(f.now + 504 + WAKE_RESEND_MAX_MS);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 500);
  f.store.prune(f.now + 1006 + WAKE_RESEND_MAX_MS);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 0);
});

const worker = fileURLToPath(new URL('./fixtures/managed-wake-process.mjs', import.meta.url));
async function processFixture(f, mode, relayId = `relay-${mode}`) {
  const child = fork(worker, [mode, f.database, join(f.directory, 'effects.txt'), relayId, String(process.pid)],
    { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const [first] = await Promise.race([once(child, 'message'), exit.then(([code]) => { throw new Error(`worker exited before readiness: ${code}; ${stderr}`); })]);
  if (mode === 'migration-failure') return { child, first, exit, stderr: () => stderr };
  assert.equal(first.type, 'ready');
  return { child, first, exit, stderr: () => stderr };
}
async function runProcess(f, mode, relayId, input = 'go') {
  const p = await processFixture(f, mode, relayId); p.child.send(input);
  const [code] = await p.exit; assert.equal(code, mode === 'crash-before-start' ? 17 : mode === 'crash-after-start' ? 18 : mode === 'crash-after-effect' ? 19 : 0, p.stderr());
  return p;
}

test.each(['outcome-first-race', 'start-first-race'])('I3: independent generation/%s workers permit exactly one separate new effect', async mode => {
  const f = fixture(); body(f.store, 'process-pending', f.now);
  const old = mode === 'start-first-race' ? f.store.reserveManagedWake({ ...target, ...reservation(f) }, f.now).attempt : begin(f, f.now);
  const raced = await Promise.all(['old-operation', 'new-generation'].map(id => processFixture(f, 'wake-transition', id)));
  const results = raced.map(p => once(p.child, 'message'));
  raced[0].child.send({ kind: mode === 'start-first-race' ? 'start' : 'outcome', attempt: old, now: f.now + 5 });
  raced[1].child.send({ kind: 'generation', now: f.now + 15_000 });
  const values = await Promise.all(results);
  for (const p of raced) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  if (mode === 'start-first-race' && values[0][0].result.dispatch) {
    assert.equal(f.store.recordManagedWakeOutcome(values[0][0].result.attempt, TRANSIENT, BASE, f.now + 6), true);
  }
  const current = { ...target, instanceId: 'instance-2', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } };
  f.store.startPresence(current, f.now + 40_000);
  assert.equal(f.store.presence(target, f.now + 40_000).state, 'online');
  // The generation worker's lease ended at +30s; the two effect workers now race for an unowned lease.
  assert.equal(f.store.liveRelay(target, current.transport, f.now + 40_000), null);
  const effects = await Promise.all(['new-effect-one', 'new-effect-two'].map(id => processFixture(f, 'wake-transition', id)));
  for (const p of effects) p.child.send({ kind: 'effect', instanceId: current.instanceId, now: f.now + 40_000 });
  for (const p of effects) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  assert.equal(readFileSync(join(f.directory, 'effects.txt'), 'utf8').trim().split('\n').length, 1);
  assert.equal(attemptRow(f.store, old).state, 'not-delivered');
  assert.notEqual(f.store.managedWakeStatus(target, f.now + 40_003).attemptId, old.attemptId);
  assert.equal(f.store.recordManagedWakeOutcome(old, HANDED, BASE, f.now + 40_003), false);
  assert.equal(f.store.startManagedWake(old, BASE, f.now + 40_003).dispatch, false);
  assert.equal(f.store.pendingCount(target, f.now + 40_003), 1);
});

test('I2: a verified old arrival in another process claims nothing and one new effect follows', async () => {
  const f = fixture(5); body(f.store, 'old-body', f.now);
  const attempt = begin(f, f.now);
  f.store.recordManagedWakeOutcome(attempt, HANDED, BASE, f.now + 2);
  const claimed = f.store.claim(target, f.now + 3); f.store.acknowledge(target, ['old-body'], f.now + 4, receipts(claimed));
  f.store.startPresence({ ...target, instanceId: 'instance-2', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, hostPid: HOST_PID }, f.now + 5);
  body(f.store, 'new-body', f.now + 6);
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', join(f.directory, 'trust.sqlite3'));
  const observed = await processFixture(f, 'observe-wake');
  const received = once(observed.child, 'message'); observed.child.send({ nonce: attempt.nonce });
  const [{ result }] = await received;
  const [code] = await observed.exit; assert.equal(code, 0, observed.stderr());
  assert.equal(result.recognized, false); assert.deepEqual(result.messages, []); assert.equal(result.binding, null);
  assert.equal(f.store.pendingCount(target), 1);
  assert.equal(f.store.managedWakeStatus(target).state, 'released');
  const relays = await Promise.all(['current-relay', 'replacement-current-relay'].map(id => processFixture(f, 'relay', id)));
  const relayAt = Math.max(Date.now(), f.now + 6);
  assert.equal(f.store.liveRelay(target, 'portable', relayAt), null);
  for (const relay of relays) relay.child.send({ instanceId: 'instance-2', now: relayAt });
  for (const relay of relays) { const [relayCode] = await relay.exit; assert.equal(relayCode, 0, relay.stderr()); }
  assert.equal(readFileSync(join(f.directory, 'effects.txt'), 'utf8').trim().split('\n').length, 1);
  assert.notEqual(f.store.managedWakeStatus(target).attemptId, attempt.attemptId);
  assert.equal(f.store.pendingCount(target), 1);
});

test('Codex running body claim in another process prevents the external queue call before start', async () => {
  const f = fixture(); body(f.store, 'running-body', f.now);
  let calls = 0;
  const called = await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId,
    { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'user-message' }, resendBaseMs: 20 * 60_000,
      dispatch: async () => { calls++; return HANDED; } },
    async (operation, payload) => {
      if (operation === 'start-wake') await runProcess(f, 'claim-and-ack');
      return dispatch(f.store, operation, payload);
    });
  assert.equal(called, false); assert.equal(calls, 0);
  assert.equal(f.store.managedWakeStatus(target).state, 'not-delivered');
});

test('Codex post-start claim in another process leaves one marker and a verified empty discard', async () => {
  const f = fixture(); body(f.store, 'racing-body', f.now);
  let calls = 0;
  await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, f.relayId,
    { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'user-message' }, resendBaseMs: 20 * 60_000,
      dispatch: async () => { await runProcess(f, 'claim-and-ack'); calls++; return HANDED; } },
    async (operation, payload) => dispatch(f.store, operation, payload));
  const row = f.store.database.prepare("SELECT nonce FROM wake_nonces WHERE state = 'handed-off'").get();
  assert.equal(calls, 1);
  const result = hostClaim(f, observe(f, { nonce: row.nonce }, Date.now()), Date.now());
  assert.equal(result.recognized, true); assert.ok(result.binding); assert.deepEqual(result.messages, []);
  assert.equal(f.store.managedWakeStatus(target).state, 'observed');
});

test('I3: independent senders and relay processes perform exactly one external call', async () => {
  const f = fixture(1);
  const senders = await Promise.all(['sender-one', 'sender-two'].map(id => processFixture(f, 'sender', id)));
  for (const p of senders) p.child.send('go');
  for (const p of senders) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  const relays = await Promise.all(['process-one', 'process-two'].map(id => processFixture(f, 'relay', id)));
  const relayAt = Math.max(Date.now(), f.now + 1);
  assert.equal(f.store.liveRelay(target, 'portable', relayAt), null);
  for (const p of relays) p.child.send({ now: relayAt });
  for (const p of relays) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  assert.equal(readFileSync(join(f.directory, 'effects.txt'), 'utf8').trim().split('\n').length, 1);
  assert.equal(f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE state IN ${ACTIVE}`).get().n, 1);
  assert.equal(f.store.pendingCount(target), 2);
});

test('I4: an independent process crash before start recovers the same attempt; after start it never resends before the timeout', async () => {
  for (const mode of ['crash-before-start', 'crash-after-start', 'crash-after-effect']) {
    const f = fixture(1); body(f.store, 'body-0001', f.now);
    assert.equal(f.store.liveRelay(target, 'portable', f.now + 1), null);
    await runProcess(f, mode, 'crashed-relay', { now: f.now + 1 });
    const initial = f.store.managedWakeStatus(target, f.now + 1);
    assert.equal(initial.state, mode === 'crash-before-start' ? 'reserved' : 'started');
    assert.equal(f.store.liveRelay(target, 'portable', f.now + 15_001), null);
    await runProcess(f, 'relay', 'replacement-relay', { now: f.now + 15_001 });
    const final = f.store.managedWakeStatus(target, f.now + 15_001);
    assert.equal(final.attemptId, initial.attemptId);
    // A started attempt is never resent by a replacement relay; only WAKE_START_TIMEOUT_MS turns it unknown (2.2).
    assert.equal(final.state, mode === 'crash-before-start' ? 'handed-off' : 'started');
    const path = join(f.directory, 'effects.txt');
    const count = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
    assert.equal(count, mode === 'crash-after-start' ? 0 : 1);
  }
});

test('W05-r2 independent migration failure rolls back the wake rebuild and preserves legacy bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r2-rollback-')); const database = join(directory, 'old.sqlite3');
  legacyDatabase(database); const f = { directory, database }; resources.push({ directory, stores: [] });
  const p = await processFixture(f, 'migration-failure'); const [code] = await p.exit;
  assert.equal(code, 0, p.stderr()); assert.match(p.first.error, /migration failure/);
  const db = new DatabaseSync(database);
  try {
    assert.deepEqual(db.prepare('PRAGMA table_info(wake_nonces)').all().map(row => row.name), ['nonce_digest', 'host', 'session_id', 'expires_at', 'consumed_at']);
    assert.equal(db.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1);
  } finally { db.close(); }
});

test('public wake binding requires a fresh presence birth after lease expiry', () => {
  const f = fixture(); const expiry = f.now + 21_000;
  assert.equal(f.store.heartbeatPresence(target, 'instance-1', expiry), false);
  f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, expiry + 1);
  assert.notEqual(f.store.presence(target, expiry + 1).startedAt, new Date(f.now).toISOString());
});

function observedThenCurrent(f) {
  body(f.store, 'already-observed-body', f.now);
  const old = begin(f, f.now);
  f.store.recordManagedWakeOutcome(old, HANDED, BASE, f.now + 2);
  const oldReceipt = observe(f, old, f.now + 3);
  const claimed = hostClaim(f, oldReceipt, f.now + 4).messages;
  assert.deepEqual(claimed.map(message => message.messageId), ['already-observed-body']);
  f.store.acknowledge(target, ['already-observed-body'], f.now + 5, receipts(claimed));
  f.store.clearDeferred(target, f.now + 5); // The woken turn ends (3.5.2: a wake opens a turn and its turn-end hook closes it).
  const oldRow = attemptRow(f.store, old);
  assert.equal(oldRow.state, 'observed');
  body(f.store, 'current-body', f.now + 6);
  // The hook arrival at +4 was a claim boundary; the next ring waits for quiet.
  const quiet = f.now + 4 + WAKE_QUIET_MS + 1;
  keepAlive(f, quiet);
  const current = begin(f, quiet, reservation(f, 'current-after-observed-nonce-abcdefghijklmnop'));
  f.store.recordManagedWakeOutcome(current, HANDED, BASE, quiet + 2);
  return { old, current, oldRow, oldReceipt, at: quiet + 3 };
}

// Kept from CI step 07e (removed in cc71b9c3): an observed, consumed marker A and the current marker B in one receipt.
test('fresh verified observed A plus current B receipt claims only B once and preserves A', () => {
  const f = fixture(); const { old, current, oldRow, at } = observedThenCurrent(f);
  const mixed = observe(f, current, at, {
    prompt: '[agent-governance-suite:wake:' + old.nonce + ']\n[agent-governance-suite:wake:' + current.nonce + ']',
  });
  const claimed = hostClaim(f, mixed, at + 1);
  assert.equal(claimed.recognized, true);
  // Only B's pending body, once; A's acknowledged body is never claimed again.
  assert.deepEqual(claimed.messages.map(message => message.messageId), ['current-body']);
  assert.equal(attemptRow(f.store, current).state, 'observed');
  // A keeps its observed record; its repeated arrival is evidence only (late_observed_at, set once).
  const oldAfter = attemptRow(f.store, old);
  assert.deepEqual(without(oldAfter, ['late_observed_at']), without(oldRow, ['late_observed_at']));
  assert.deepEqual(hostClaim(f, mixed, at + 2).messages, []);
  assert.deepEqual(hostClaim(f, observe(f, current, at + 3), at + 4).messages, []);
  assert.deepEqual(attemptRow(f.store, old), oldAfter);
  const delivered = f.store.database.prepare("SELECT message_id, delivery_attempts FROM messages ORDER BY message_id").all();
  assert.deepEqual(delivered.map(row => [row.message_id, row.delivery_attempts]), [['already-observed-body', 1], ['current-body', 1]]);
});

test.each(['unknown', 'stale-receipt', 'digest-mismatch', 'wrong-target', 'native-input', 'old-generation'])('I1/I2: observed A cannot grant body authority when B is invalid: %s', variant => {
  const f = fixture(); const { old, current, oldRow, oldReceipt, at } = observedThenCurrent(f);
  let prompt = '[agent-governance-suite:wake:' + old.nonce + ']\n[agent-governance-suite:wake:'
    + (variant === 'unknown' ? 'unknown-current-nonce-abcdefghijklmnop' : current.nonce) + ']';
  if (variant === 'native-input') prompt += '\nordinary user text';
  if (variant === 'old-generation') {
    f.store.endPresence(target, 'fixture rebirth', 'instance-1', at);
    f.store.startPresence({ ...target, instanceId: 'instance-2', transport: 'portable',
      wakeVisibility: 'silent', canWakeSilently: true,
      deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, at + 1);
  }
  const received = variant === 'native-input'
    ? { observation: adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
      agent_id: '', prompt }, target.host).observation, sourceReceiptId: oldReceipt.sourceReceiptId }
    : observe(f, current, at + 2, { prompt });
  if (variant === 'stale-receipt') received.sourceReceiptId = oldReceipt.sourceReceiptId;
  if (variant === 'digest-mismatch') received.observation = { ...received.observation, wakeCandidates: [old.nonce, 'forged-current-nonce-abcdefghijklmnop'] };
  const result = variant === 'wrong-target'
    ? f.store.claimHostWake({ ...target, sessionId: 'wrong-target' }, received.observation, received.sourceReceiptId, wakeHookObservationReader, at + 3)
    : hostClaim(f, received, at + 3);
  assert.equal(result.recognized, false);
  assert.deepEqual(result.messages, []);
  assert.equal(f.store.pendingCount(target, at + 3), 1);
  const oldAfter = attemptRow(f.store, old);
  if (variant === 'old-generation') assert.deepEqual(without(oldAfter, ['late_observed_at']), without(oldRow, ['late_observed_at']));
  else assert.deepEqual(oldAfter, oldRow);
  if (variant !== 'old-generation') assert.equal(attemptRow(f.store, current).state, 'handed-off');
});
