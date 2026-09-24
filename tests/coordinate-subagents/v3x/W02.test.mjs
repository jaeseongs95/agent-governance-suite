import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation } from '../../../mcp-server/src/session-message-broker.ts';

const openStores = [];
const directories = [];
const tokens = new Map();
afterEach(() => {
  tokens.clear();
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w02-'));
  directories.push(directory);
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  openStores.push(store);
  return { store, database };
}

const now = 1_000;
const sender = { host: 'portable', sessionId: 'sender-1', instanceId: 'instance-1' };
const recipient = { host: 'generic', sessionId: 'recipient-1' };
const request = {
  schemaVersion: '1.0.0', kind: 'request', requestId: 'request-0001', taskId: 'W02',
  sender, recipient, callbackTarget: { host: sender.host, sessionId: sender.sessionId },
  revision: 1, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
  authorityEffect: 'none',
};
const input = { request, body: 'Please do the delegated task and callback.', ttlSeconds: 600 };

function register(store, value, at) {
  let token = tokens.get(value.request.requestId);
  if (!token) {
    token = store.prepareTaskRequest(value, at).reconcileToken;
    tokens.set(value.request.requestId, token);
  }
  const actor = { ...value.request.recipient, instanceId: `recipient-${at}` };
  store.startPresence({ ...actor, transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['tool-boundary'], idleWake: 'silent' } }, at - 1);
  const event = { schemaVersion: '1.0.0', kind: 'activity-observation', actor,
    revision: 1, activity: 'busy', source: 'host-observed',
    observedAt: new Date(at - 1).toISOString(), authorityEffect: 'none' };
  const reader = { verifyActivityReporter: () => ({ authenticatedActor: actor,
    currentInstanceId: actor.instanceId, verifiedTurnId: 'turn-1',
    observedSource: 'host-observed', verifiedRevision: 1, verifiedActivity: 'busy',
    verifiedObservedAt: event.observedAt }) };
  store.recordActivity(event, 'turn-1', 'proof', reader, at - 1);
  return store.registerTaskRequest(value, at, { expectedActor: actor, expectedTurnId: 'turn-1',
    expectedRevision: 1, trustedActivity: true, reconcileToken: token });
}

test('W02 request, callback address and original message ID commit atomically and survive ACK/TTL', () => {
  const { store, database } = fixture();
  const first = register(store, input, now);
  assert.match(first.messageId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(first, { requestId: request.requestId, messageId: first.messageId,
    messageCreatedAt: new Date(now).toISOString(), messageExpiresAt: new Date(now + 600_000).toISOString(),
    requestExpiresAt: request.expiresAt, duplicate: false, state: 'queued' });
  assert.deepEqual(store.taskRequest(request.requestId), {
    request, messageId: first.messageId, ttlSeconds: 600, registeredAt: new Date(now).toISOString(),
  });
  assert.deepEqual(store.claim(recipient, now + 1).map(message => message.messageId), [first.messageId]);
  assert.equal(store.acknowledge(recipient, [first.messageId], now + 2), 1);
  store.prune(now + 3_600_003);
  assert.equal(store.status(sender, first.messageId, now + 3_600_003), null);
  const reopened = new SessionMessageStore(database);
  openStores.push(reopened);
  assert.deepEqual(reopened.taskRequest(request.requestId)?.request, request);
  assert.deepEqual(register(reopened, input, now + 86_400_001), { ...first, duplicate: true, state: 'duplicate' });
  assert.throws(() => reopened.send({ sender, target: recipient, messageId: first.messageId, body: 'new ordinary body' }, now + 86_400_001), /reserved by a task request/);
  assert.equal(reopened.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('W02 same request ID is idempotent only for the same sender, target, body and revision', () => {
  const { store, database } = fixture();
  const peer = new SessionMessageStore(database);
  openStores.push(peer);
  const first = register(store, input, now);
  assert.deepEqual(register(peer, input, now + 1), { ...first, duplicate: true, state: 'duplicate' });
  for (const variant of [
    { ...input, body: 'different' },
    { ...input, request: { ...request, recipient: { ...recipient, sessionId: 'other' } } },
    { ...input, request: { ...request, sender: { ...sender, instanceId: 'instance-2' } } },
    { ...input, request: { ...request, revision: 2 } },
  ]) assert.throws(() => register(peer, variant, now + 2), /different task request|contract is invalid/);
  assert.throws(() => register(peer, { ...input, messageId: 'caller-choice-0001' }, now + 2), /broker-assigned/);
  assert.deepEqual(store.taskRequest(request.requestId)?.request, request);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('W02 rolls back both records when message enqueue or request recording fails', () => {
  const { store } = fixture();
  store.database.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message failed'); END;");
  assert.throws(() => register(store, input, now), /message failed/);
  assert.equal(store.taskRequest(request.requestId), null);
  store.database.exec('DROP TRIGGER fail_message');
  store.database.exec("CREATE TRIGGER fail_request BEFORE INSERT ON task_requests BEGIN SELECT RAISE(ABORT, 'request failed'); END;");
  assert.throws(() => register(store, input, now), /request failed/);
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  store.database.exec('DROP TRIGGER fail_request');
  assert.equal(register(store, input, now).duplicate, false);
});

test('W02 rejects caller-selected expired ordinary message ID without partial registration', () => {
  const { store, database } = fixture();
  const peer = new SessionMessageStore(database);
  openStores.push(peer);
  const oldMessageId = 'ordinary-expired-0001';
  store.send({ messageId: oldMessageId, sender, target: recipient, body: input.body, ttlSeconds: 600 }, now);
  store.prune(now + 600_001);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.throws(() => register(peer, { ...input, messageId: oldMessageId }, now + 600_002), /broker-assigned/);
  assert.equal(peer.taskRequest(request.requestId), null);
  assert.equal(peer.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  const registered = register(peer, input, now + 600_003);
  assert.notEqual(registered.messageId, oldMessageId);
});

test('W02 second-connection lock cannot leave either record behind', () => {
  const { store, database } = fixture();
  const peer = new SessionMessageStore(database);
  openStores.push(peer);
  store.database.exec('BEGIN IMMEDIATE');
  peer.database.exec('PRAGMA busy_timeout = 1');
  assert.throws(() => register(peer, input, now + 2), /locked/);
  store.database.exec('ROLLBACK');
  assert.equal(peer.taskRequest(request.requestId), null);
  assert.equal(register(peer, input, now + 3).duplicate, false);
});

test('W02 rejects malformed contract claims before writing either table', () => {
  const { store } = fixture();
  for (const invalid of [
    { ...request, requestedAt: 'not-a-date' },
    { ...request, requestedAt: '2026-02-31T00:00:00Z' },
    { ...request, expiresAt: request.requestedAt },
    { ...request, expiresAt: new Date(now + 30_000).toISOString() },
    { ...request, sender: { ...sender, instanceId: '' } },
    { ...request, recipient: { host: 2, sessionId: recipient.sessionId } },
    { ...request, unexpectedPermission: 'start-task' },
  ]) assert.throws(() => register(store, { ...input, request: invalid }, now));
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('W02 broker does not expose legacy registration without current contact checks', () => {
  const { store } = fixture();
  const brokerNow = Date.now();
  const brokerRequest = { ...request, requestedAt: new Date(brokerNow).toISOString(),
    expiresAt: new Date(brokerNow + 86_400_000).toISOString() };
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'ping', {}).capabilities.includes('task-request-register-v1'), false);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'register-task-request',
    { ...input, request: brokerRequest }), /Unknown broker operation/);
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'start-task', { requestId: request.requestId }), /Unknown broker operation/);
  const ordinary = store.send({ sender, target: recipient, messageId: 'ordinary-message-1', body: 'ordinary' }, now + 1);
  assert.equal(ordinary.duplicate, false);
});
