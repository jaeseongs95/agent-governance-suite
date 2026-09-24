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
  const directory = mkdtempSync(join(tmpdir(), 'ags-w03-'));
  directories.push(directory);
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  stores.push(store);
  return { store, database };
}

const sender = { host: 'portable', sessionId: 'sender-1', instanceId: 'instance-1' };
const actor = { host: 'generic', sessionId: 'recipient-1', instanceId: 'instance-2' };
const callbackTarget = { host: sender.host, sessionId: sender.sessionId };
const now = 1_000;
const proof = 'owning-runtime-proof';
const request = {
  schemaVersion: '1.0.0', kind: 'request', requestId: 'request-0001', taskId: 'task-1',
  sender, recipient: { host: actor.host, sessionId: actor.sessionId }, callbackTarget,
  revision: 1, requestedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86_400_000).toISOString(),
  authorityEffect: 'none',
};
const outcome = {
  schemaVersion: '1.0.0', kind: 'terminal-outcome', requestId: request.requestId,
  taskId: request.taskId, actor, callbackTarget, revision: 2, result: 'COMPLETED',
  evidenceRefs: ['handoff:task-1'], reportedAt: new Date(now + 100).toISOString(), authorityEffect: 'none',
};
function binding(overrides = {}) {
  return { verifyTerminalReporter: (_outcome, presentedProof) => presentedProof === proof ? ({
    authenticatedActor: actor, currentInstanceId: actor.instanceId, revisionStream: 'task',
    currentRevision: 1, boundTaskId: request.taskId, ...overrides,
  }) : null };
}
function register(store) {
  store.registerTaskRequest({ request, body: 'Task request', ttlSeconds: 600 }, now);
}

test('W03 delegated outcome and callback commit together; ACK remains separate from acceptance', () => {
  const { store, database } = fixture();
  register(store);
  const saved = store.recordTaskOutcome(outcome, proof, binding(), now + 100);
  assert.equal(saved.duplicate, false);
  assert.match(saved.callbackMessageId, /^[0-9a-f-]{36}$/);
  const key = `request:${request.requestId}`;
  assert.deepEqual(store.taskOutcome(key), { outcome, callbackMessageId: saved.callbackMessageId,
    callbackAcknowledgedAt: null, acceptance: 'unverified' });
  const messages = store.claim(callbackTarget, now + 101);
  assert.equal(messages.length, 1);
  assert.deepEqual(JSON.parse(messages[0].body), { schemaVersion: '1.0.0', kind: 'task-outcome-callback',
    requestId: request.requestId, taskId: outcome.taskId, result: outcome.result, outcomeKey: key });
  assert.equal(store.acknowledge(callbackTarget, [saved.callbackMessageId], now + 102), 1);
  assert.equal(store.taskOutcome(key).callbackAcknowledgedAt, new Date(now + 102).toISOString());
  assert.equal(store.taskOutcome(key).acceptance, 'unverified');
  const reopened = new SessionMessageStore(database);
  stores.push(reopened);
  assert.equal(reopened.taskOutcome(key).callbackAcknowledgedAt, new Date(now + 102).toISOString());
});

test('W03 exact retry has one callback, conflicting outcome is rejected', () => {
  const { store } = fixture();
  register(store);
  const first = store.recordTaskOutcome(outcome, proof, binding(), now + 100);
  assert.deepEqual(store.recordTaskOutcome(outcome, proof, binding(), now + 200), { ...first, duplicate: true });
  assert.throws(() => store.recordTaskOutcome({ ...outcome, result: 'BLOCKED' }, proof, binding(), now + 300), /TERMINAL_CONFLICT/);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM task_outcomes').get().n, 1);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages WHERE message_id = ?').get(first.callbackMessageId).n, 1);
});

test('W03 requires registered request plus separate live owning-runtime binding', () => {
  const { store } = fixture();
  assert.throws(() => store.recordTaskOutcome(outcome, proof, binding(), now + 100), /Registered task request/);
  register(store);
  for (const reader of [null, { verifyTerminalReporter: () => null }, binding({ boundTaskId: 'other' }),
    binding({ authenticatedActor: { ...actor, sessionId: 'other' } }), binding({ currentInstanceId: 'old-instance' }),
    binding({ currentRevision: 2 })]) {
    assert.throws(() => store.recordTaskOutcome(outcome, proof, reader, now + 100));
  }
  assert.throws(() => store.recordTaskOutcome(outcome, 'forged-proof', binding(), now + 100), /binding is unavailable/);
  assert.equal(store.taskOutcome(`request:${request.requestId}`), null);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
});

test('W03 standalone terminal outcome has no callback and also requires current binding', () => {
  const { store } = fixture();
  const standalone = { ...outcome, requestId: undefined, callbackTarget: undefined, revision: 1 };
  delete standalone.requestId;
  delete standalone.callbackTarget;
  const current = binding({ currentRevision: 0 });
  assert.deepEqual(store.recordTaskOutcome(standalone, proof, current, now + 100), { duplicate: false, callbackMessageId: null });
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  assert.deepEqual(store.recordTaskOutcome(standalone, proof, current, now + 200), { duplicate: true, callbackMessageId: null });
  assert.throws(() => store.recordTaskOutcome({ ...standalone, callbackTarget }, proof, current, now + 300), /Standalone/);
});

test('W03 callback enqueue failure rolls back outcome; public broker has no trusted reader', () => {
  const { store } = fixture();
  register(store);
  store.database.exec("CREATE TRIGGER fail_callback BEFORE INSERT ON messages BEGIN SELECT RAISE(ABORT, 'callback failed'); END;");
  assert.throws(() => store.recordTaskOutcome(outcome, proof, binding(), now + 100), /callback failed/);
  assert.equal(store.taskOutcome(`request:${request.requestId}`), null);
  store.database.exec('DROP TRIGGER fail_callback');
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'record-task-outcome', { outcome }), /binding is unavailable/);
  assert.equal(store.taskOutcome(`request:${request.requestId}`), null);
  assert.equal(store.recordTaskOutcome(outcome, proof, binding(), now + 100).duplicate, false);
});

test('W03 outcome insert failure rolls back callback and a trusted broker port can submit', () => {
  const { store } = fixture();
  register(store);
  store.database.exec("CREATE TRIGGER fail_outcome BEFORE INSERT ON task_outcomes BEGIN SELECT RAISE(ABORT, 'outcome failed'); END;");
  assert.throws(() => store.recordTaskOutcome(outcome, proof, binding(), now + 100), /outcome failed/);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  store.database.exec('DROP TRIGGER fail_outcome');
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'record-task-outcome', { outcome, reporterProof: proof }, undefined, binding()).duplicate, false);
});

test('W03 old instance and malformed evidence cannot displace the current terminal report', () => {
  const { store } = fixture();
  register(store);
  assert.throws(() => store.recordTaskOutcome({ ...outcome, actor: { ...actor, instanceId: 'old-instance' } }, proof, binding(), now + 100), /STALE_OR_UNAUTHENTICATED/);
  assert.throws(() => store.recordTaskOutcome({ ...outcome, evidenceRefs: ['same', 'same'] }, proof, binding(), now + 100), /shape is invalid/);
  assert.throws(() => store.recordTaskOutcome({ ...outcome, reportedAt: '2026-02-31T00:00:00Z' }, proof, binding(), now + 100), /timestamp is invalid/);
  assert.equal(store.taskOutcome(`request:${request.requestId}`), null);
});
