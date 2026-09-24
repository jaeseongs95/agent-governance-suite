import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation } from '../../../mcp-server/src/session-message-broker.ts';

const openStores = [];
const directories = [];
afterEach(() => {
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
const input = { request, body: 'Please do the delegated task and callback.', messageId: 'original-message-0001', ttlSeconds: 600 };

test('W02 request, callback address and original message ID commit atomically and survive ACK/TTL', () => {
  const { store, database } = fixture();
  const first = store.registerTaskRequest(input, now);
  assert.deepEqual(first, { requestId: request.requestId, messageId: input.messageId,
    messageCreatedAt: new Date(now).toISOString(), messageExpiresAt: new Date(now + 600_000).toISOString(),
    requestExpiresAt: request.expiresAt, duplicate: false });
  assert.deepEqual(store.taskRequest(request.requestId), {
    request, messageId: input.messageId, ttlSeconds: 600, registeredAt: new Date(now).toISOString(),
  });
  assert.deepEqual(store.claim(recipient, now + 1).map(message => message.messageId), [input.messageId]);
  assert.equal(store.acknowledge(recipient, [input.messageId], now + 2), 1);
  store.prune(now + 3_600_003);
  assert.equal(store.status(sender, input.messageId, now + 3_600_003), null);
  const reopened = new SessionMessageStore(database);
  openStores.push(reopened);
  assert.deepEqual(reopened.taskRequest(request.requestId)?.request, request);
  assert.deepEqual(reopened.registerTaskRequest(input, now + 86_400_001), { ...first, duplicate: true });
  assert.throws(() => reopened.send({ sender, target: recipient, messageId: input.messageId, body: 'new ordinary body' }, now + 86_400_001), /reserved by a task request/);
  assert.equal(reopened.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('W02 same request ID is idempotent only for the same sender, target, body, revision and message ID', () => {
  const { store, database } = fixture();
  const peer = new SessionMessageStore(database);
  openStores.push(peer);
  const first = store.registerTaskRequest(input, now);
  assert.deepEqual(peer.registerTaskRequest(input, now + 1), { ...first, duplicate: true });
  for (const variant of [
    { ...input, body: 'different' },
    { ...input, request: { ...request, recipient: { ...recipient, sessionId: 'other' } } },
    { ...input, request: { ...request, sender: { ...sender, instanceId: 'instance-2' } } },
    { ...input, request: { ...request, revision: 2 } },
    { ...input, messageId: 'other-message-0001' },
  ]) assert.throws(() => peer.registerTaskRequest(variant, now + 2), /different task request|contract is invalid/);
  assert.deepEqual(store.taskRequest(request.requestId)?.request, request);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('W02 rolls back both records when message enqueue or request recording fails', () => {
  const { store } = fixture();
  store.database.exec("CREATE TRIGGER fail_message BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'message failed'); END;");
  assert.throws(() => store.registerTaskRequest(input, now), /message failed/);
  assert.equal(store.taskRequest(request.requestId), null);
  store.database.exec('DROP TRIGGER fail_message');
  store.database.exec("CREATE TRIGGER fail_request BEFORE INSERT ON task_requests BEGIN SELECT RAISE(ABORT, 'request failed'); END;");
  assert.throws(() => store.registerTaskRequest(input, now), /request failed/);
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  store.database.exec('DROP TRIGGER fail_request');
  assert.equal(store.registerTaskRequest(input, now).duplicate, false);
});

test('W02 never attaches a task to an ordinary message or partially commits during a second-connection lock', () => {
  const { store, database } = fixture();
  const peer = new SessionMessageStore(database);
  openStores.push(peer);
  store.send({ messageId: input.messageId, sender, target: recipient, body: input.body, ttlSeconds: 600 }, now);
  assert.throws(() => peer.registerTaskRequest(input, now + 1), /different message/);
  assert.equal(peer.taskRequest(request.requestId), null);
  store.database.exec('BEGIN IMMEDIATE');
  peer.database.exec('PRAGMA busy_timeout = 1');
  const second = { ...input, messageId: 'original-message-0002' };
  assert.throws(() => peer.registerTaskRequest(second, now + 2), /locked/);
  store.database.exec('ROLLBACK');
  assert.equal(peer.taskRequest(request.requestId), null);
  assert.equal(peer.registerTaskRequest(second, now + 3).duplicate, false);
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
  ]) assert.throws(() => store.registerTaskRequest({ ...input, request: invalid }, now));
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('W02 broker operation rejects forged callback and does not grant execution authority', () => {
  const { store } = fixture();
  const brokerNow = Date.now();
  const brokerRequest = { ...request, requestedAt: new Date(brokerNow).toISOString(),
    expiresAt: new Date(brokerNow + 86_400_000).toISOString() };
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'ping', {}).capabilities.includes('task-request-register-v1'), false);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'register-task-request', {
    ...input, request: { ...brokerRequest, callbackTarget: recipient },
  }), /callback target/);
  assert.equal(store.taskRequest(request.requestId), null);
  const registered = dispatchSessionMessageBrokerOperation(store, 'register-task-request', { ...input, request: brokerRequest });
  assert.equal(registered.requestId, request.requestId);
  assert.equal(registered.messageId, input.messageId);
  assert.equal(registered.requestExpiresAt, brokerRequest.expiresAt);
  assert.equal(registered.duplicate, false);
  assert.equal(store.taskRequest(request.requestId)?.request.authorityEffect, 'none');
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'start-task', { requestId: request.requestId }), /Unknown broker operation/);
  const ordinary = store.send({ sender, target: recipient, messageId: 'ordinary-message-1', body: 'ordinary' }, now + 1);
  assert.equal(ordinary.duplicate, false);
});
