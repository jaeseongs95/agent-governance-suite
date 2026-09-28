import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_TTL_MS } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as brokerDispatch } from '../../mcp-server/src/session-message-broker.ts';
import { dispatchManagedWake } from '../../mcp-server/src/session-message-relay.ts';
import { adaptHostInput } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, wakeHookObservationReader, transportDeliveryCapabilities } from '../../mcp-server/src/session-message-wake-port.ts';
import { TrustStore } from '../../mcp-server/src/trust-store.ts';

const dispatch = (store, operation, payload, _model, _task, _activity, reader) => brokerDispatch(store, operation, payload, reader);
const resources = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, stores } of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
const target = { host: 'portable', sessionId: 'wake-target' };
const sender = { host: 'portable', sessionId: 'wake-sender' };
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r2-'));
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  resources.push({ directory, stores: [store] });
  const now = Date.now();
  store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable',
    wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' } }, now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
  return { directory, database, store, now };
}
function reservation(nonce = 'managed-wake-nonce-abcdefghijklmnop') {
  return { target, nonce, instanceId: 'instance-1', transport: 'portable', relayId: 'relay-1' };
}

test('W05-r2 body claim and ACK cannot authorize another unobserved managed wake', () => {
  const { store } = fixture();
  store.send({ sender, target, messageId: 'first-body', body: 'first' });
  assert.equal(dispatch(store, 'reserve-wake', reservation()).dispatch, true);
  store.claim(target);
  store.acknowledge(target, ['first-body']);
  store.send({ sender, target, messageId: 'second-body', body: 'second-body' });
  assert.equal(dispatch(store, 'reserve-wake', reservation('another-wake-nonce-abcdefghijklmnop')).dispatch, false);
});

test('W05-r2 board ownership check has no nonce state effect', () => {
  const { store } = fixture();
  store.send({ sender, target, messageId: 'owned-body', body: 'body-0001' });
  const input = reservation();
  assert.equal(dispatch(store, 'reserve-wake', input).dispatch, true);
  store.claim(target);
  assert.equal(store.consumeWake(target, input.nonce), true);
  assert.equal(store.database.prepare('SELECT consumed_at FROM wake_nonces').get().consumed_at, null);
});

test.each(['claimDeferred', 'claimTurnEnd'])('W05-r2 %s and ACK leave the managed notification fenced', (method) => {
  const f = fixture(); body(f.store, 'boundary-body', f.now);
  const attempt = begin(f.store, f.now);
  assert.equal(f.store[method](target, f.now + 2).length, 1);
  f.store.acknowledge(target, ['boundary-body'], f.now + 3);
  body(f.store, 'new-boundary-body', f.now + 4);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation('second-nonce-abcdefghijklmnop') }, f.now + 5).dispatch, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 5).attemptId, attempt.attemptId);
});

function begin(store, now, input = reservation()) {
  const reserved = store.reserveManagedWake({ ...input.target, ...input }, now);
  assert.equal(reserved.dispatch, true);
  const started = store.startManagedWake(reserved.attempt, now + 1);
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

test('W05-r2 start rechecks claim/ACK and persists no-effect retirement', () => {
  const f = fixture(); body(f.store, 'before-start', f.now);
  const reserved = f.store.reserveManagedWake({ ...target, ...reservation() }, f.now);
  f.store.claim(target, f.now + 1); f.store.acknowledge(target, ['before-start'], f.now + 2);
  assert.equal(f.store.startManagedWake(reserved.attempt, f.now + 3).dispatch, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 3).state, 'not-submitted');
  body(f.store, 'next-body', f.now + 4);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation('next-nonce-abcdefghijklmnop') }, f.now + 5).dispatch, true);
});

test('W05-r2 claim after start keeps one fence until the actual hook, including an empty batch', () => {
  const f = fixture(); body(f.store, 'after-start', f.now);
  const attempt = begin(f.store, f.now);
  f.store.claim(target, f.now + 2); f.store.acknowledge(target, ['after-start'], f.now + 3);
  f.store.recordManagedWakeOutcome(attempt, 'submitted', f.now + 4);
  body(f.store, 'next-body', f.now + 5);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation('next-nonce-abcdefghijklmnop') }, f.now + 6).dispatch, false);
  f.store.claim(target, f.now + 7); f.store.acknowledge(target, ['next-body'], f.now + 8);
  const result = hostClaim(f, observe(f, attempt, f.now + 9), f.now + 10);
  assert.equal(result.recognized, true); assert.deepEqual(result.messages, []);
  assert.equal(f.store.managedWakeStatus(target, f.now + 10).state, 'observed');
  assert.equal(f.store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', f.now + 11), false);
});

test('W05-r2 reserved crash recovery keeps the nonce/attempt and rejects replaced lease CAS', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const first = f.store.reserveManagedWake({ ...target, ...reservation() }, f.now).attempt;
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer);
  peer.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-2', pid: process.pid, parentPid: process.pid }, f.now + 1);
  const recovered = peer.reserveManagedWake({ ...target, ...reservation(), relayId: 'relay-2', resume: true }, f.now + 2).attempt;
  assert.equal(recovered.nonce, first.nonce); assert.equal(recovered.attemptId, first.attemptId);
  assert.equal(f.store.startManagedWake(first, f.now + 3).dispatch, false);
  assert.equal(peer.startManagedWake(recovered, f.now + 4).dispatch, true);
  assert.equal(peer.startManagedWake(recovered, f.now + 4).dispatch, false);
});

test('W05-r2 transport remains part of the exact stored attempt binding', () => {
  const f = fixture(); body(f.store, 'exact-binding-body', f.now);
  const reserved = f.store.reserveManagedWake({ ...target, ...reservation() }, f.now).attempt;
  f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'other-port', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + 1);
  f.store.acquireRelay({ ...target, transport: 'other-port', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, f.now + 1);
  assert.equal(f.store.startManagedWake({ ...reserved, transport: 'other-port' }, f.now + 2).dispatch, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 2).state, 'reserved');
  f.store.startPresence({ ...target, instanceId: 'instance-1', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + 3);
  const started = f.store.startManagedWake(reserved, f.now + 4).attempt;
  assert.ok(started);
  assert.equal(f.store.recordManagedWakeOutcome({ ...started, transport: 'other-port' }, 'definite-failure', f.now + 5), false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 5).state, 'started');
});

test('W05-r2 definite failure uses durable backoff and exact dispatch epoch for late results', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const first = begin(f.store, f.now);
  assert.equal(f.store.recordManagedWakeOutcome(first, 'definite-failure', f.now + 2), true);
  const later = f.now + 30_003;
  f.store.database.prepare('UPDATE session_presence SET lease_until = ?').run(new Date(later + 60_000).toISOString());
  f.store.heartbeatRelay({ ...target, transport: 'portable', relayId: 'relay-1' }, later);
  assert.equal(f.store.reserveManagedWake({ ...target, ...reservation(), resume: true }, f.now + 3).dispatch, false);
  const retried = f.store.reserveManagedWake({ ...target, ...reservation(), resume: true }, later).attempt;
  assert.equal(retried.attemptId, first.attemptId);
  const second = f.store.startManagedWake(retried, later + 1).attempt;
  assert.equal(second.dispatchEpoch, first.dispatchEpoch + 1);
  assert.equal(f.store.recordManagedWakeOutcome(first, 'submitted', later + 2), false);
  assert.equal(f.store.recordManagedWakeOutcome(second, 'accepted-or-unknown', later + 3), true);
  assert.equal(f.store.managedWakeStatus(target, later + 3).state, 'unknown');
});

test('W05-r2 unknown survives restart, both TTLs, ordinary claim, ACK and generation replacement', () => {
  const f = fixture(); body(f.store, 'short-body', f.now, 30);
  const attempt = begin(f.store, f.now);
  f.store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', f.now + 2);
  const peer = new SessionMessageStore(f.database); resources.at(-1).stores.push(peer);
  peer.prune(f.now + WAKE_TTL_MS + 1);
  assert.equal(peer.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.equal(peer.managedWakeStatus(target, f.now + WAKE_TTL_MS + 1).observation, 'observation-overdue');
  assert.equal(peer.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1);
  body(peer, 'ordinary-expired-fence', f.now + WAKE_TTL_MS + 1);
  assert.equal(peer.reserveWake(target, 'legacy-bypass-nonce-abcdefghijklmnop', f.now + WAKE_TTL_MS + 1), false);
  assert.equal(peer.status(sender, 'ordinary-expired-fence', f.now + WAKE_TTL_MS + 1).wake.observation, 'observation-overdue');
  peer.startPresence({ ...target, instanceId: 'instance-2', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, f.now + WAKE_TTL_MS + 2);
  peer.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-2', pid: process.pid, parentPid: process.pid }, f.now + WAKE_TTL_MS + 2);
  body(peer, 'new-body', f.now + WAKE_TTL_MS + 3);
  assert.equal(peer.reserveManagedWake({ ...target, ...reservation(), instanceId: 'instance-2', relayId: 'relay-2', resume: true }, f.now + WAKE_TTL_MS + 4).dispatch, false);
});

test('W05-r2 ordinary peer provenance, expired hook receipts and changed observation digests cannot release a fence', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f.store, f.now); const observed = observe(f, attempt, f.now + 2);
  const trust = new TrustStore(join(f.directory, 'trust.sqlite3'));
  let ordinary;
  try {
    const hook = trust.getInputSource(observed.sourceReceiptId);
    ordinary = trust.recordInputSource({ originKind: 'peer', host: hook.host, sessionId: hook.sessionId,
      eventId: 'ordinary-peer-0001', contentDigest: hook.contentDigest, observedAt: hook.observedAt, expiresAt: hook.expiresAt,
      authorityEffect: 'none', attestation: { kind: 'broker-peer-envelope', adapter: 'session-message-hook', capabilityVersion: '1.0.0' } });
  } finally { trust.close(); }
  assert.equal(hostClaim(f, { ...observed, sourceReceiptId: ordinary.receiptId }, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, { ...observed, observation: { ...observed.observation, actor: { ...observed.observation.actor, kind: 'unknown' } } }, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, observed, f.now + 30_003).recognized, false);
  assert.equal(f.store.managedWakeStatus(target, f.now + 30_003).state, 'started');
});

test('W05-r2 observation holds the SQLite generation lock and notices a generation change during verification', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f.store, f.now); const observed = observe(f, attempt);
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
  assert.equal(f.store.managedWakeStatus(target, f.now + 4).state, 'unknown');
});

test('W05-r2 lost committed outcome response never dispatches again', async () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  let calls = 0;
  const request = async (operation, payload) => {
    const result = dispatch(f.store, operation, payload);
    if (operation === 'record-wake-outcome') throw new Error('fixture response lost after commit');
    return result;
  };
  const port = { capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, dispatch: async () => { calls++; return 'submitted'; } };
  await assert.rejects(dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', port, request), /response lost/);
  assert.equal(f.store.managedWakeStatus(target).state, 'submitted');
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', port,
    async (operation, payload) => dispatch(f.store, operation, payload)), false);
  assert.equal(calls, 1);
});

test('W05-r2 forged nonce, caller approved and normalized observation cannot observe without the hook receipt', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const attempt = begin(f.store, f.now);
  const observed = observe(f, attempt, f.now + 2);
  assert.deepEqual(f.store.claimWake(target, [attempt.nonce], f.now + 3), { recognized: false, messages: [] });
  assert.equal(f.store.consumeWake(target, attempt.nonce, f.now + 3), true);
  assert.equal(f.store.releaseWake(target, attempt.nonce), false);
  assert.equal(f.store.claimHostWake(target, observed.observation, '', wakeHookObservationReader, f.now + 3).recognized, false);
  assert.equal(f.store.claimHostWake(target, observed.observation, observed.sourceReceiptId, undefined, f.now + 3).recognized, false);
  assert.throws(() => dispatch(f.store, 'claim-host-wake', { target, ...observed, approved: true }, undefined, undefined, undefined, wakeHookObservationReader), /source receipt/);
  assert.equal(f.store.managedWakeStatus(target, f.now + 3).state, 'started');
  assert.equal(f.store.claimHostWake(target, { ...observed.observation, wakeCandidates: ['forged-nonce-abcdefghijklmnop'] },
    observed.sourceReceiptId, wakeHookObservationReader, f.now + 3).recognized, false);
  assert.equal(hostClaim(f, observed, f.now + 4).recognized, true);
  assert.equal(hostClaim(f, observed, f.now + 5).recognized, false);
});

test('W05-r2 expired/old-generation hook records only late observation and preserves the current fence', () => {
  for (const variant of ['expired', 'new-instance', 'same-instance-new-birth']) {
    const f = fixture(); body(f.store, 'old-body', f.now);
    const attempt = begin(f.store, f.now);
    f.store.recordManagedWakeOutcome(attempt, 'submitted', f.now + 2);
    f.store.claim(target, f.now + 3); f.store.acknowledge(target, ['old-body'], f.now + 4);
    let at = f.now + 5;
    if (variant === 'expired') at = f.now + WAKE_TTL_MS + 1;
    else f.store.endPresence(target, 'fixture', 'instance-1', at);
    f.store.startPresence({ ...target, instanceId: variant === 'new-instance' ? 'instance-2' : 'instance-1', transport: 'portable',
      wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, at + 1);
    body(f.store, 'new-body', at + 2);
    const observed = observe(f, attempt, at + 3);
    assert.equal(hostClaim(f, observed, at + 4).recognized, false);
    assert.equal(f.store.pendingCount(target, at + 4), 1);
    const state = f.store.managedWakeStatus(target, at + 4);
    assert.equal(state.state, 'unknown'); assert.ok(state.lateObservedAt); assert.equal(state.observedAt, null);
    assert.equal(f.store.recordManagedWakeOutcome(attempt, 'definite-failure', at + 5), false);
    assert.equal(f.store.managedWakeStatus(target, at + 5).state, 'unknown');
  }
});

test('W05-r2 batch/ACK-loss redelivery and hook rollback preserve exact nonce consumption', () => {
  const f = fixture(); body(f.store, 'body-one', f.now); body(f.store, 'body-two', f.now);
  const attempt = begin(f.store, f.now); const observed = observe(f, attempt);
  assert.throws(() => hostClaim(f, observed, f.now + 4, { maxBodyChars: 1 }), /claim budget/);
  assert.equal(f.store.managedWakeStatus(target, f.now + 4).state, 'started');
  const first = hostClaim(f, observed, f.now + 5, { maxMessages: 1 });
  assert.equal(first.messages.length, 1); assert.equal(first.messages[0].messageId, 'body-one');
  assert.equal(hostClaim(f, observed, f.now + 6).recognized, false);
  assert.equal(f.store.claim(target, f.now + 7)[0].messageId, 'body-two');
  assert.equal(f.store.claim(target, f.now + 120_006)[0].messageId, 'body-one');
  assert.equal(f.store.managedWakeStatus(target, f.now + 120_006).state, 'observed');
});

test('W05-r2 hook-before-outcome, adapter exception and new vendor use the same core', async () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  let calls = 0;
  const request = async (operation, payload) => dispatch(f.store, operation, payload);
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', {
    capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' },
    dispatch: async () => {
      calls++;
      const row = f.store.database.prepare("SELECT * FROM wake_nonces WHERE state = 'started'").get();
      assert.ok(row); const observation = observe(f, { nonce: row.nonce }, Date.now());
      assert.equal(hostClaim(f, observation, Date.now()).recognized, true);
      return 'submitted';
    },
  }, request), true);
  assert.equal(calls, 1); assert.equal(f.store.managedWakeStatus(target).state, 'observed');
  f.store.acknowledge(target, ['body-0001']); body(f.store, 'second-body');
  await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', {
    capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, dispatch: async () => { calls++; throw new Error('lost adapter result'); },
  }, request);
  assert.equal(f.store.managedWakeStatus(target).state, 'unknown'); assert.equal(calls, 2);
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', {
    capabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' }, dispatch: async () => { calls++; return 'submitted'; },
  }, request), false);
  assert.equal(calls, 2);
  const relaySource = readFileSync(new URL('../../mcp-server/src/session-message-relay.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(relaySource, /codex-queue|codex-deferred|claude-inbox|ringCodex\(/);
});

test('W05-r2 both host capabilities preserve submission/observation distinction and deferred idle wake zero', async () => {
  assert.deepEqual(transportDeliveryCapabilities('claude-inbox'), { supportedInjection: ['peer-wake', 'tool-boundary', 'turn-end'], idleWake: 'silent' });
  assert.deepEqual(transportDeliveryCapabilities('codex-queue'), { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'user-message' });
  assert.deepEqual(transportDeliveryCapabilities('codex-deferred'), { supportedInjection: ['tool-boundary'], idleWake: 'none' });
  assert.throws(() => transportDeliveryCapabilities('missing-adapter'), /unavailable/);
  let calls = 0;
  assert.equal(await dispatchManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable' }, 'relay-1', {
    capabilities: { supportedInjection: ['tool-boundary'], idleWake: 'none' }, dispatch: async () => { calls++; return 'submitted'; },
  }, async () => { throw new Error('deferred must not request a reservation'); }), false);
  assert.equal(calls, 0);
});

function legacyDatabase(database) {
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE wake_nonces (nonce_digest TEXT PRIMARY KEY, host TEXT NOT NULL, session_id TEXT NOT NULL, expires_at TEXT NOT NULL, consumed_at TEXT) STRICT');
  db.prepare('INSERT INTO wake_nonces VALUES (?, ?, ?, ?, ?)').run('legacy-digest', 'portable', 'old', new Date(Date.now() + WAKE_TTL_MS).toISOString(), new Date().toISOString());
  db.close();
}
test('W05-r2 additive legacy migration never imports old consumed_at as observed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r2-migrate-')); const database = join(directory, 'old.sqlite3');
  legacyDatabase(database); const store = new SessionMessageStore(database); resources.push({ directory, stores: [store] });
  const row = store.database.prepare('SELECT state, observed_at, consumed_at FROM wake_nonces').get();
  assert.equal(row.state, 'legacy'); assert.equal(row.observed_at, null); assert.ok(row.consumed_at);
  assert.equal(store.managedWakeStatus({ host: 'portable', sessionId: 'old' }), null);
});

test('W05-r2 active budget overflow is an explicit rejection and does not remove unknowns', () => {
  const f = fixture(); body(f.store, 'body-0001', f.now);
  const insert = f.store.database.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state) VALUES (?, 'portable', ?, ?, 'unknown')");
  for (let i = 0; i < 1000; i++) insert.run(`digest-${i}`, `target-${i}`, new Date(f.now - 1).toISOString());
  assert.throws(() => f.store.reserveManagedWake({ ...target, ...reservation() }, f.now), /active wake store is full/);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'unknown'").get().n, 1000);
});

test('W05-r2 terminal observation retention is bounded while unresolved rows are retained', () => {
  const f = fixture();
  const insert = f.store.database.prepare("INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, observed_at) VALUES (?, 'portable', ?, ?, 'observed', ?)");
  for (let i = 0; i < 1005; i++) insert.run(`terminal-${i}`, `target-${i}`, new Date(f.now + WAKE_TTL_MS).toISOString(), new Date(f.now + i).toISOString());
  f.store.prune(f.now + 1006);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1000);
  f.store.prune(f.now + WAKE_TTL_MS + 1006);
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
async function runProcess(f, mode, relayId) {
  const p = await processFixture(f, mode, relayId); p.child.send('go');
  const [code] = await p.exit; assert.equal(code, mode === 'crash-before-start' ? 17 : mode === 'crash-after-start' ? 18 : mode === 'crash-after-effect' ? 19 : 0, p.stderr());
  return p;
}

test('W05-r2 independent senders and relay processes perform exactly one external call', async () => {
  const f = fixture();
  const senders = await Promise.all(['sender-one', 'sender-two'].map(id => processFixture(f, 'sender', id)));
  for (const p of senders) p.child.send('go');
  for (const p of senders) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  const relays = await Promise.all(['process-one', 'process-two'].map(id => processFixture(f, 'relay', id)));
  for (const p of relays) p.child.send('go');
  for (const p of relays) { const [code] = await p.exit; assert.equal(code, 0, p.stderr()); }
  assert.equal(readFileSync(join(f.directory, 'effects.txt'), 'utf8').trim().split('\n').length, 1);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved','started','submitted','unknown')").get().n, 1);
  assert.equal(f.store.pendingCount(target), 2);
});

test('W05-r2 independent process crash before start recovers the same attempt; after effect never resends', async () => {
  for (const mode of ['crash-before-start', 'crash-after-start', 'crash-after-effect']) {
    const f = fixture(); body(f.store, 'body-0001', f.now);
    await runProcess(f, mode, 'crashed-relay');
    const initial = f.store.managedWakeStatus(target);
    assert.equal(initial.state, mode === 'crash-before-start' ? 'reserved' : 'started');
    await runProcess(f, 'relay', 'replacement-relay');
    const final = f.store.managedWakeStatus(target);
    assert.equal(final.attemptId, initial.attemptId);
    assert.equal(final.state, mode === 'crash-before-start' ? 'submitted' : 'unknown');
    const path = join(f.directory, 'effects.txt');
    const count = existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').length : 0;
    assert.equal(count, mode === 'crash-after-start' ? 0 : 1);
  }
});

test('W05-r2 independent migration failure rolls back every added nonce column and preserves legacy bytes', async () => {
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
