import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SessionMessageStore } from '../../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation } from '../../../mcp-server/src/session-message-broker.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';
import { handleSessionMessageHook } from '../../../mcp-server/src/session-message-hook.ts';
import { SessionMessageService } from '../../../mcp-server/src/session-message-service.ts';

const resources = [];
afterEach(() => {
  for (const resource of resources.splice(0)) {
    for (const store of resource.stores) store.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r1-'));
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  resources.push({ directory, stores: [store] });
  return { store, database };
}
const sender = { host: 'portable', sessionId: 'sender-1' };
const target = { host: 'portable', sessionId: 'target-1' };
const actor = { ...target, instanceId: 'instance-1' };
function request(now, id = 'request-0001') {
  return { schemaVersion: '1.0.0', kind: 'request', requestId: id, taskId: 'task-1',
    sender: { ...sender, instanceId: 'sender-instance' }, recipient: target, callbackTarget: sender,
    revision: 1, requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(), authorityEffect: 'none' };
}
function active(store, now) {
  store.startPresence({ ...target, instanceId: actor.instanceId, transport: 'portable',
    wakeVisibility: 'silent', canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ['tool-boundary'], idleWake: 'silent' } }, now);
  const event = { schemaVersion: '1.0.0', kind: 'activity-observation', actor, revision: 1,
    activity: 'busy', source: 'host-observed', observedAt: new Date(now + 1).toISOString(),
    authorityEffect: 'none' };
  const reader = { verifyActivityReporter: () => ({ authenticatedActor: actor,
    currentInstanceId: actor.instanceId, verifiedTurnId: 'turn-1',
    verifiedRevision: 1, verifiedActivity: 'busy', verifiedObservedAt: event.observedAt,
    observedSource: 'host-observed' }) };
  store.recordActivity(event, 'turn-1', 'proof', reader, now + 1);
  return reader;
}
function registration(input, token) {
  return { ...input, reconcileToken: token, expectedActor: actor,
    expectedTurnId: 'turn-1', expectedRevision: 1 };
}
function count(store, table) {
  return store.database.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

test('W05-r1 lost preparation response can rotate only before registration; registration requires issued token', () => {
  const { store } = fixture();
  const now = Date.now();
  const input = { request: request(now), body: 'Task body', ttlSeconds: 60 };
  const first = store.prepareTaskRequest(input, now);
  assert.match(first.reconcileToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(count(store, 'messages'), 0);
  assert.equal(count(store, 'task_requests'), 0);
  const second = store.prepareTaskRequest(input, now + 1);
  assert.notEqual(second.reconcileToken, first.reconcileToken);
  assert.throws(() => store.registerTaskRequest(input, now + 2,
    { ...registration(input, first.reconcileToken), trustedActivity: true }), /broker-issued/);
  assert.throws(() => store.prepareTaskRequest({ ...input, body: 'Changed body' }, now + 2), /different task preparation/);
  assert.equal(count(store, 'messages'), 0);
  const reader = active(store, now);
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    registration(input, second.reconcileToken), undefined, undefined, reader).state, 'queued');
  assert.throws(() => store.prepareTaskRequest(input, now + 3), /cannot issue another/);
  assert.equal(count(store, 'messages'), 1);
});

test('W05-r1 service rejects omitted token and forged bound sender before persistence', async () => {
  const { store } = fixture();
  const input = { request: request(Date.now()), body: 'Task body', ttlSeconds: 60 };
  const service = new SessionMessageService();
  const forged = await service.prepareTaskRequest({ ...input,
    _sessionBinding: { host: sender.host, sessionId: 'other' } });
  assert.equal(forged.error.code, 'INVALID_INPUT');
  const omitted = await service.registerTaskRequest({ ...input, _sessionBinding: sender });
  assert.equal(omitted.error.code, 'INVALID_INPUT');
  assert.equal(count(store, 'task_preparations'), 0);
  assert.equal(count(store, 'task_requests'), 0);
  assert.equal(count(store, 'messages'), 0);
});

test('W05-r1 store rejects tokenless direct registration before persisting either record', () => {
  const { store } = fixture();
  const input = { request: request(Date.now()), body: 'Task body', ttlSeconds: 60 };
  assert.throws(() => store.registerTaskRequest(input), /broker-issued reconciliation token/);
  assert.equal(count(store, 'task_requests'), 0);
  assert.equal(count(store, 'messages'), 0);
});

test('W05-r1 lost registration response returns original receipt despite changed target activity', () => {
  const { store, database } = fixture();
  const now = Date.now();
  const reader = active(store, now);
  const input = { request: request(now), body: 'Task body', ttlSeconds: 60 };
  const token = store.prepareTaskRequest(input, now).reconcileToken;
  const payload = registration(input, token);
  const first = dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    payload, undefined, undefined, reader);
  assert.equal(first.state, 'queued');
  const peer = new SessionMessageStore(database);
  resources[0].stores.push(peer);
  store.endPresence(target, 'ended', actor.instanceId, now + 2);
  const retry = dispatchSessionMessageBrokerOperation(peer, 'receipt-task-request', inputWithToken(input, token));
  assert.equal(retry.state, 'duplicate');
  assert.equal(retry.messageId, first.messageId);
  assert.equal(retry.messageCreatedAt, first.messageCreatedAt);
  assert.equal(retry.messageExpiresAt, first.messageExpiresAt);
  assert.equal(count(peer, 'messages'), 1);
  assert.equal(count(peer, 'task_requests'), 1);
  assert.equal(count(peer, 'wake_nonces'), 0);
  assert.equal(peer.status(sender, first.messageId, now + 3).state, 'queued');
  peer.claim(target, now + 3);
  peer.acknowledge(target, [first.messageId], now + 4);
  assert.equal(dispatchSessionMessageBrokerOperation(peer, 'receipt-task-request', inputWithToken(input, token)).state, 'duplicate');
  assert.equal(peer.status(sender, first.messageId, now + 5).state, 'acknowledged');
  assert.equal(count(peer, 'task_outcomes'), 0);
});

function inputWithToken(input, reconcileToken) { return { ...input, reconcileToken }; }

test('W05-r1 mismatched token, content, sender and target never reveal a receipt or enqueue', () => {
  const { store } = fixture();
  const now = Date.now();
  const reader = active(store, now);
  const input = { request: request(now), body: 'Task body', ttlSeconds: 60 };
  const token = store.prepareTaskRequest(input, now).reconcileToken;
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'receipt-task-request', inputWithToken(input, 'a'.repeat(43))), /broker-issued/);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    registration(input, 'a'.repeat(43)), undefined, undefined, reader), /broker-issued/);
  const first = dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    registration(input, token), undefined, undefined, reader);
  assert.throws(() => store.registerTaskRequest(input, now + 1), /broker-issued reconciliation token/);
  for (const changed of [
    inputWithToken(input, 'a'.repeat(43)),
    inputWithToken({ ...input, body: 'changed' }, token),
    inputWithToken({ ...input, request: { ...input.request, recipient: { host: 'portable', sessionId: 'target-2' } } }, token),
    inputWithToken({ ...input, request: { ...input.request, sender: { ...input.request.sender, sessionId: 'other' } } }, token),
  ]) assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'receipt-task-request', changed));
  assert.equal(count(store, 'messages'), 1);
  assert.equal(store.taskRequest(input.request.requestId).messageId, first.messageId);
});

test('W05-r1 expired preparation cannot authorize registration and can be reissued before registration', () => {
  const { store } = fixture();
  const now = Date.now();
  const input = { request: request(now), body: 'Task body', ttlSeconds: 60 };
  const first = store.prepareTaskRequest(input, now);
  assert.throws(() => store.registerTaskRequest(input, now + 600_001,
    { ...registration(input, first.reconcileToken), trustedActivity: true }), /broker-issued/);
  const second = store.prepareTaskRequest(input, now + 600_002);
  assert.notEqual(second.reconcileToken, first.reconcileToken);
  assert.equal(count(store, 'task_requests'), 0);
});

test('W05-r1 preparation prunes expiry and bounds active rows', () => {
  const { store } = fixture();
  const now = Date.now();
  const first = { request: request(now, 'request-0001'), body: 'Task body', ttlSeconds: 60 };
  store.prepareTaskRequest(first, now);
  store.database.prepare('UPDATE task_preparations SET expires_at = ? WHERE request_id = ?')
    .run(new Date(now - 1).toISOString(), first.request.requestId);
  store.prepareTaskRequest({ ...first, request: request(now, 'request-0002') }, now);
  assert.equal(count(store, 'task_preparations'), 1);
  const insert = store.database.prepare(`INSERT INTO task_preparations
    (request_id, request_digest, token_digest, expires_at) VALUES (?, ?, ?, ?)`);
  for (let i = 2; i < 1001; i++) {
    insert.run(`filler-${i}`, 'digest', 'digest', new Date(now + 600_000).toISOString());
  }
  assert.equal(count(store, 'task_preparations'), 1000);
  assert.throws(() => store.prepareTaskRequest({ ...first, request: request(now, 'request-0003') }, now), /spool is full/);
  assert.equal(count(store, 'task_preparations'), 1000);
});

test('W05-r1 SQLite lock and rollback preserve preparation and single enqueue', () => {
  const { store, database } = fixture();
  const now = Date.now();
  const reader = active(store, now);
  const peer = new SessionMessageStore(database);
  resources[0].stores.push(peer);
  const input = { request: request(now), body: 'Task body', ttlSeconds: 60 };
  store.database.exec('BEGIN IMMEDIATE');
  peer.database.exec('PRAGMA busy_timeout = 1');
  assert.throws(() => peer.prepareTaskRequest(input, now), /locked/);
  store.database.exec('ROLLBACK');
  const token = peer.prepareTaskRequest(input, now).reconcileToken;
  store.database.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON contact_messages BEGIN SELECT RAISE(ABORT, 'contact failed'); END;");
  assert.throws(() => dispatchSessionMessageBrokerOperation(peer, 'register-contact-task-request',
    registration(input, token), undefined, undefined, reader), /contact failed/);
  assert.equal(count(peer, 'messages'), 0);
  assert.equal(count(peer, 'task_requests'), 0);
  assert.equal(count(peer, 'task_preparations'), 1);
  store.database.exec('DROP TRIGGER fail_contact');
  assert.equal(dispatchSessionMessageBrokerOperation(peer, 'register-contact-task-request',
    registration(input, token), undefined, undefined, reader).state, 'queued');
  assert.equal(count(peer, 'task_preparations'), 0);
});

test('W05-r1 MCP and both hook matchers expose protected preparation tool', async () => {
  const server = createMcpServer({}, {});
  const client = new Client({ name: 'w05-r1-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const prepare = tools.find((tool) => tool.name === 'prepare_session_task_request');
    const register = tools.find((tool) => tool.name === 'register_session_task_request');
    assert.ok(prepare);
    assert.ok(prepare.inputSchema.properties._sessionBinding);
    assert.ok(register.inputSchema.required.includes('reconcileToken'));
    assert.equal(prepare.inputSchema.properties.reconcileToken, undefined);
  } finally { await client.close(); await server.close(); }
  for (const [host, filename, prefix] of [
    ['codex', 'hooks/hooks.json', 'mcp__agent-governance-suite__'],
    ['claude-code', 'claude-overlay/hooks/hooks.json', 'mcp__plugin_agent-governance-suite_agent-governance-suite__'],
  ]) {
    const hooks = JSON.parse(readFileSync(new URL(`../../../${filename}`, import.meta.url), 'utf8'));
    const matcher = hooks.hooks.PreToolUse.find((entry) => entry.matcher?.includes('send_session_message')).matcher;
    const toolName = `${prefix}prepare_session_task_request`;
    assert.match(toolName, new RegExp(matcher));
    const bound = await handleSessionMessageHook({ hook_event_name: 'PreToolUse',
      session_id: 'real-sender', tool_name: toolName,
      tool_input: { _sessionBinding: { host: 'forged', sessionId: 'other' } } }, host);
    assert.deepEqual(bound.hookSpecificOutput.updatedInput._sessionBinding, { host, sessionId: 'real-sender' });
    const denied = await handleSessionMessageHook({ hook_event_name: 'PreToolUse',
      session_id: 'real-sender', agent_id: 'child', tool_name: toolName, tool_input: {} }, host);
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
  }
});
