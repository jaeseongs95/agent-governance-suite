import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation } from '../../../mcp-server/src/session-message-broker.ts';

const stores = [];
const directories = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w04-'));
  directories.push(directory);
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  stores.push(store);
  return { store, database };
}
const session = { host: 'portable', sessionId: 'session-1' };
const actor = { ...session, instanceId: 'instance-1' };
const proof = 'verified-host-proof';
function start(store, instanceId = actor.instanceId, at = 1_000) {
  store.startPresence({ ...session, instanceId, transport: 'portable-relay',
    wakeVisibility: 'none', canWakeSilently: false }, at);
}
function observed(activity, revision, at, source = 'host-observed', identity = actor) {
  return { schemaVersion: '1.0.0', kind: 'activity-observation', actor: identity,
    revision, activity, source, observedAt: new Date(at).toISOString(), authorityEffect: 'none' };
}
function reader(identity = actor, turn = 'turn-1', source = 'host-observed', expected = null) {
  return { verifyActivityReporter: (event, _turn, presentedProof) => presentedProof === proof
    ? { authenticatedActor: identity, currentInstanceId: identity.instanceId,
      verifiedTurnId: turn, observedSource: source,
      verifiedRevision: (expected ?? event).revision, verifiedActivity: (expected ?? event).activity,
      verifiedObservedAt: (expected ?? event).observedAt } : null };
}

test('W04 online alone is unknown; only start then observed end of the same turn becomes idle', () => {
  const { store } = fixture();
  start(store);
  assert.equal(store.activityStatus(session, 1_001).activity, 'unknown');
  assert.deepEqual(store.recordActivity(observed('idle', 1, 1_002), 'turn-1', proof, reader(), 1_002),
    { duplicate: false, activity: 'unknown' });
  assert.deepEqual(store.recordActivity(observed('idle', 1, 1_002), 'turn-1', proof, reader(), 1_002),
    { duplicate: true, activity: 'unknown' });
  assert.equal(store.activityStatus(session, 1_002).activity, 'unknown');
  assert.deepEqual(store.recordActivity(observed('busy', 2, 1_003), 'turn-1', proof, reader(), 1_003),
    { duplicate: false, activity: 'busy' });
  assert.deepEqual(store.recordActivity(observed('idle', 3, 1_004), 'turn-1', proof, reader(), 1_004),
    { duplicate: false, activity: 'idle' });
  assert.equal(store.activityStatus(session, 1_004).activity, 'idle');
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM task_outcomes').get().n, 0);
});

test('W04 mismatched turn, self-report and missing end remain unknown', () => {
  const { store } = fixture();
  start(store);
  store.recordActivity(observed('busy', 1, 1_001), 'turn-1', proof, reader(), 1_001);
  assert.equal(store.activityStatus(session, 1_001).activity, 'busy');
  assert.equal(store.recordActivity(observed('idle', 2, 1_002), 'turn-2', proof,
    reader(actor, 'turn-2'), 1_002).activity, 'unknown');
  store.recordActivity(observed('busy', 3, 1_003), 'turn-3', proof, reader(actor, 'turn-3'), 1_003);
  assert.equal(store.recordActivity(observed('idle', 4, 1_004, 'self-reported'), 'turn-3', proof,
    reader(actor, 'turn-3', 'self-reported'), 1_004).activity, 'unknown');
  assert.equal(store.activityStatus(session, 1_004).activity, 'unknown');
  store.recordActivity(observed('busy', 5, 1_005), 'turn-4', proof, reader(actor, 'turn-4'), 1_005);
  store.recordActivity(observed('busy', 6, 1_006, 'self-reported'), 'turn-5', proof,
    reader(actor, 'turn-5', 'self-reported'), 1_006);
  assert.equal(store.recordActivity(observed('idle', 7, 1_007), 'turn-5', proof,
    reader(actor, 'turn-5'), 1_007).activity, 'unknown');
  store.recordActivity(observed('busy', 8, 1_008), 'turn-6', proof, reader(actor, 'turn-6'), 1_008);
  store.heartbeatPresence(session, actor.instanceId, 19_000);
  assert.equal(store.presence(session, 22_000).state, 'online');
  assert.equal(store.activityStatus(session, 22_000).activity, 'unknown');
});

test('W04 exact retry is idempotent; same revision conflict is unknown and stale revision cannot overwrite', () => {
  const { store } = fixture();
  start(store);
  const busy = observed('busy', 1, 1_001);
  assert.equal(store.recordActivity(busy, 'turn-1', proof, reader(), 1_001).activity, 'busy');
  assert.deepEqual(store.recordActivity(busy, 'turn-1', proof, reader(), 1_002),
    { duplicate: true, activity: 'busy' });
  assert.deepEqual(store.recordActivity(observed('idle', 1, 1_002), 'turn-1', proof, reader(), 1_002),
    { duplicate: false, activity: 'unknown' });
  assert.equal(store.activityStatus(session, 1_002).activity, 'unknown');
  assert.throws(() => store.recordActivity(observed('idle', 0, 1_003), 'turn-1', proof, reader(), 1_003));
  assert.equal(store.activityStatus(session, 1_003).activity, 'unknown');
});

test('W04 new instance and reused ended instance start unknown; late old event cannot overwrite', () => {
  const { store, database } = fixture();
  start(store);
  store.recordActivity(observed('busy', 1, 1_001), 'turn-1', proof, reader(), 1_001);
  const next = { ...session, instanceId: 'instance-2' };
  start(store, next.instanceId, 1_100);
  assert.deepEqual(store.activityStatus(session, 1_101), { actor: next, activity: 'unknown',
    turnId: null, revision: 0, observedAt: null, source: null });
  assert.throws(() => store.recordActivity(observed('idle', 2, 1_102), 'turn-1', proof,
    reader(), 1_102), /INSTANCE_OR_LEASE_STALE/);
  const peer = new SessionMessageStore(database);
  stores.push(peer);
  assert.equal(peer.activityStatus(session, 1_102).activity, 'unknown');
  peer.recordActivity(observed('busy', 1, 1_103, 'host-observed', next), 'turn-2', proof,
    reader(next, 'turn-2'), 1_103);
  assert.equal(store.activityStatus(session, 1_103).activity, 'busy');
  store.endPresence(session, 'ended', next.instanceId, 1_200);
  assert.equal(store.activityStatus(session, 1_201).activity, 'unknown');
  start(store, next.instanceId, 1_300);
  assert.equal(store.activityStatus(session, 1_301).activity, 'unknown');
});

test('W04 proof, source, turn and lease are verified; product broker has no activity provider', () => {
  const { store } = fixture();
  start(store);
  const busy = observed('busy', 1, 1_001);
  assert.throws(() => store.recordActivity(busy, 'turn-1', 'forged', reader(), 1_001), /UNVERIFIED/);
  assert.throws(() => store.recordActivity(busy, 'turn-1', proof, reader(actor, 'other-turn'), 1_001), /UNVERIFIED/);
  assert.throws(() => store.recordActivity(busy, 'turn-1', proof, reader(actor, 'turn-1', 'self-reported'), 1_001), /UNVERIFIED/);
  assert.throws(() => store.recordActivity({ ...busy, activity: 'idle' }, 'turn-1', proof,
    reader(actor, 'turn-1', 'host-observed', busy), 1_001), /UNVERIFIED/);
  assert.throws(() => store.recordActivity({ ...busy, revision: 2 }, 'turn-1', proof,
    reader(actor, 'turn-1', 'host-observed', busy), 1_001), /UNVERIFIED/);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'record-session-activity',
    { event: busy, turnId: 'turn-1', reporterProof: proof }), /reporter is unavailable/);
  assert.equal(store.activityStatus(session, 1_001).activity, 'unknown');
  assert.equal(store.recordActivity(busy, 'turn-1', proof, reader(), 1_001).activity, 'busy');
  assert.equal(store.activityStatus(session, 21_001).activity, 'unknown');
});

test('W04 broker without a host provider does not expose persisted idle as current', () => {
  const { store } = fixture();
  const liveNow = Date.now();
  start(store, actor.instanceId, liveNow - 100);
  store.recordActivity(observed('busy', 1, liveNow - 50), 'turn-1', proof, reader(), liveNow - 50);
  store.recordActivity(observed('idle', 2, liveNow - 40), 'turn-1', proof, reader(), liveNow - 40);
  assert.equal(store.activityStatus(session, liveNow).activity, 'idle');
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'session-activity', { target: session }).activity.activity, 'unknown');
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'session-activity', { target: session },
    undefined, undefined, reader()).activity.activity, 'idle');
});

test('W04 SQLite lock race leaves activity unchanged', () => {
  const { store, database } = fixture();
  start(store);
  const peer = new SessionMessageStore(database);
  stores.push(peer);
  const busy = observed('busy', 1, 1_001);
  store.database.exec('BEGIN IMMEDIATE');
  peer.database.exec('PRAGMA busy_timeout = 1');
  assert.throws(() => peer.recordActivity(busy, 'turn-1', proof, reader(), 1_001), /locked/);
  store.database.exec('ROLLBACK');
  assert.equal(store.activityStatus(session, 1_001).activity, 'unknown');
  assert.equal(peer.recordActivity(busy, 'turn-1', proof, reader(), 1_001).activity, 'busy');
});

test('W04 expired same-instance restart and regressed observation time cannot claim idle', () => {
  const { store } = fixture();
  start(store);
  store.recordActivity(observed('busy', 1, 1_010), 'turn-1', proof, reader(), 1_010);
  assert.equal(store.recordActivity(observed('idle', 2, 1_005), 'turn-1', proof,
    reader(), 1_011).activity, 'unknown');
  assert.deepEqual(store.recordActivity(observed('idle', 2, 1_005), 'turn-1', proof,
    reader(), 1_012), { duplicate: true, activity: 'unknown' });
  assert.equal(store.activityStatus(session, 1_011).activity, 'unknown');
  start(store, actor.instanceId, 22_000);
  assert.equal(store.activityStatus(session, 22_001).activity, 'unknown');
  assert.equal(store.activityStatus(session, 22_001).revision, 0);
  assert.equal(store.recordActivity(observed('busy', 1, 22_002), 'turn-2', proof,
    reader(actor, 'turn-2'), 22_002).activity, 'busy');
});

test('W04 future observation is unknown until its verified timestamp', () => {
  const { store } = fixture();
  start(store);
  store.recordActivity(observed('busy', 1, 1_004), 'turn-1', proof, reader(), 1_001);
  assert.equal(store.activityStatus(session, 1_001).activity, 'unknown');
  assert.equal(store.activityStatus(session, 1_004).activity, 'busy');
});

test('W04 expired heartbeat cannot resurrect prior idle across a lease gap', () => {
  const { store } = fixture();
  start(store);
  store.recordActivity(observed('busy', 1, 19_999), 'turn-1', proof, reader(), 19_999);
  store.recordActivity(observed('idle', 2, 20_000), 'turn-1', proof, reader(), 20_000);
  assert.equal(store.activityStatus(session, 20_001).activity, 'idle');
  assert.equal(store.heartbeatPresence(session, actor.instanceId, 22_000), false);
  assert.equal(store.activityStatus(session, 22_001).activity, 'unknown');
  start(store, actor.instanceId, 22_002);
  assert.equal(store.activityStatus(session, 22_003).activity, 'unknown');
  assert.equal(store.recordActivity(observed('busy', 1, 22_004), 'turn-2', proof,
    reader(actor, 'turn-2'), 22_004).activity, 'busy');
});
