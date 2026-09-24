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

const stores = [];
const directories = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-'));
  directories.push(directory);
  const database = join(directory, 'messages.sqlite3');
  const store = new SessionMessageStore(database);
  stores.push(store);
  return { store, database };
}
const sender = { host: 'portable', sessionId: 'sender-1' };
const target = { host: 'portable', sessionId: 'target-1' };
const actor = { ...target, instanceId: 'instance-1' };
const base = 1_000;
const proof = 'host-proof';
function start(store, at = base, injection = ['tool-boundary'], idleWake = 'silent') {
  store.startPresence({ ...target, instanceId: actor.instanceId, transport: 'portable',
    wakeVisibility: idleWake, canWakeSilently: idleWake === 'silent',
    deliveryCapabilities: { supportedInjection: injection, idleWake } }, at);
}
function event(activity, revision, at, turnId = 'turn-1') {
  return { event: { schemaVersion: '1.0.0', kind: 'activity-observation', actor, revision,
    activity, source: 'host-observed', observedAt: new Date(at).toISOString(), authorityEffect: 'none' }, turnId };
}
const reader = { verifyActivityReporter: (observed, turnId, presented) => presented === proof ? {
  authenticatedActor: actor, currentInstanceId: actor.instanceId, verifiedTurnId: turnId,
  observedSource: observed.source, verifiedRevision: observed.revision,
  verifiedActivity: observed.activity, verifiedObservedAt: observed.observedAt,
} : null };
function observe(store, activity, revision, at, turnId = 'turn-1') {
  const value = event(activity, revision, at, turnId);
  return store.recordActivity(value.event, value.turnId, proof, reader, at);
}
function contact(messageId = 'contact-0001', revision = 1) {
  return { messageId, sender, target, body: 'Please report by callback',
    expectedActor: actor, expectedTurnId: 'turn-1', expectedRevision: revision };
}

test('W05 busy contact queues for boundary without wake; observed idle permits one wake', () => {
  const { store } = fixture();
  start(store);
  observe(store, 'busy', 1, base + 1);
  const sent = store.contact(contact(), true, base + 2);
  assert.equal(sent.state, 'queued');
  assert.equal(sent.reason, 'busy');
  assert.equal(store.reserveWake(target, 'nonce-aaaaaaaaaaaaaaaa', base + 3, true), false);
  assert.equal(store.pendingCount(target, base + 3), 1);
  observe(store, 'idle', 2, base + 4);
  assert.equal(store.reserveWake(target, 'nonce-bbbbbbbbbbbbbbbb', base + 5, true), true);
  assert.equal(store.reserveWake(target, 'nonce-cccccccccccccccc', base + 5, true), false);
  assert.equal(store.status(sender, sent.messageId, base + 5).state, 'queued');
  assert.equal(store.taskOutcome('task:any'), null);
});

test('W05 stale instance, turn or revision cannot enqueue; unknown and unsupported hold', () => {
  const { store } = fixture();
  start(store);
  observe(store, 'busy', 1, base + 1);
  assert.equal(store.contact(contact('contact-0001', 2), true, base + 2).reason, 'observation-changed');
  assert.equal(store.contact({ ...contact(), expectedTurnId: 'old-turn' }, true, base + 2).state, 'held');
  assert.equal(store.contact(contact(), false, base + 2).reason, 'activity-unavailable');
  store.endPresence(target, 'end', actor.instanceId, base + 3);
  assert.equal(store.contact(contact(), true, base + 4).reason, 'observation-changed');
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  start(store, base + 10, [], 'none');
  observe(store, 'busy', 1, base + 11);
  assert.equal(store.contact(contact(), true, base + 12).reason, 'injection-unsupported');
  observe(store, 'idle', 2, base + 13);
  assert.equal(store.contact(contact('contact-0002', 2), true, base + 14).reason, 'wake-unsupported');
});

test('W05 broker rejects forged activity and preserves unknown without provider', () => {
  const { store } = fixture();
  start(store);
  observe(store, 'busy', 1, base + 1);
  const payload = { ...contact(), expectedActor: actor, expectedTurnId: 'turn-1', expectedRevision: 1 };
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'session-activity', { target }).activity.activity, 'unknown');
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'contact-session', payload).state, 'held');
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
});

test('W05 task request registration holds without trusted state and commits contact atomically', () => {
  const { store } = fixture();
  const now = Date.now();
  start(store, now);
  observe(store, 'busy', 1, now + 1);
  const request = { schemaVersion: '1.0.0', kind: 'request', requestId: 'request-0003', taskId: 'task-3',
    sender: { ...sender, instanceId: 'sender-instance' }, recipient: target, callbackTarget: sender,
    revision: 1, requestedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 3_600_000).toISOString(), authorityEffect: 'none' };
  const payload = { request, body: 'Delegated task', ttlSeconds: 600,
    reconcileToken: 'a'.repeat(43),
    expectedActor: actor, expectedTurnId: 'turn-1', expectedRevision: 1 };
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request', payload).state, 'held');
  assert.equal(store.taskRequest(request.requestId), null);
  assert.equal(dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    { ...payload, expectedRevision: 2 }, undefined, undefined, reader).reason, 'observation-changed');
  const recorded = dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    payload, undefined, undefined, reader);
  assert.equal(recorded.state, 'queued');
  assert.equal(store.taskRequest(request.requestId).messageId, recorded.messageId);
  assert.throws(() => dispatchSessionMessageBrokerOperation(store, 'register-contact-task-request',
    { ...payload, reconcileToken: 'z'.repeat(43) }, undefined, undefined, reader), /token does not match/);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM contact_messages').get().n, 1);
  assert.equal(store.reserveWake(target, 'nonce-ffffffffffffffff', now + 2, true), false);
});

test('W05 contact rolls back when enqueue fails and duplicate wake survives reconnect', () => {
  const { store, database } = fixture();
  start(store);
  observe(store, 'busy', 1, base + 1);
  observe(store, 'idle', 2, base + 2);
  store.database.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON contact_messages BEGIN SELECT RAISE(ABORT, 'contact failed'); END;");
  assert.throws(() => store.contact(contact('contact-0002', 2), true, base + 3), /contact failed/);
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 0);
  store.database.exec('DROP TRIGGER fail_contact');
  const first = store.contact(contact('contact-0002', 2), true, base + 3);
  assert.equal(first.state, 'queued');
  const peer = new SessionMessageStore(database);
  stores.push(peer);
  assert.equal(peer.reserveWake(target, 'nonce-dddddddddddddddd', base + 4, true), true);
  assert.equal(store.reserveWake(target, 'nonce-eeeeeeeeeeeeeeee', base + 4, true), false);
});

test('W05 existing spool survives contact table migration and SQLite lock contention', () => {
  const { store, database } = fixture();
  const legacy = store.send({ sender, target, body: 'Earlier message', messageId: 'legacy-0001' }, base);
  store.database.exec('DROP TABLE contact_messages');
  store.database.exec('ALTER TABLE task_requests DROP COLUMN reconcile_token_digest');
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const migrated = new SessionMessageStore(database);
  stores.push(migrated);
  assert.equal(migrated.status(sender, legacy.messageId, base + 1).state, 'queued');
  assert.ok(migrated.database.prepare('PRAGMA table_info(task_requests)').all()
    .some((column) => column.name === 'reconcile_token_digest'));
  start(migrated);
  observe(migrated, 'busy', 1, base + 1);
  const peer = new SessionMessageStore(database);
  stores.push(peer);
  migrated.database.exec('BEGIN IMMEDIATE');
  peer.database.exec('PRAGMA busy_timeout = 1');
  assert.throws(() => peer.contact(contact(), true, base + 2), /locked/);
  migrated.database.exec('ROLLBACK');
  assert.equal(migrated.database.prepare('SELECT count(*) AS n FROM contact_messages').get().n, 0);
  assert.equal(peer.contact(contact(), true, base + 2).state, 'queued');
});

test('W05 deadline reconciliation cannot replace callback or expose another request outcome', () => {
  const { store } = fixture();
  const token = 'b'.repeat(43);
  start(store);
  observe(store, 'busy', 1, base + 1);
  const recipient = { host: target.host, sessionId: target.sessionId };
  const request = { schemaVersion: '1.0.0', kind: 'request', requestId: 'request-0001', taskId: 'task-1',
    sender: { ...sender, instanceId: 'sender-instance' }, recipient, callbackTarget: sender,
    revision: 1, requestedAt: new Date(base).toISOString(),
    expiresAt: new Date(base + 90_000).toISOString(), authorityEffect: 'none' };
  store.registerTaskRequest({ request, body: 'Task', ttlSeconds: 60 }, base + 2,
    { expectedActor: actor, expectedTurnId: 'turn-1', expectedRevision: 1,
      trustedActivity: true, reconcileToken: token });
  assert.equal(store.reconcileTaskRequest(sender, request.requestId, token, base + 3).state, 'deadline-pending');
  assert.equal(store.reconcileTaskRequest(sender, request.requestId, token, base + 90_000).state, 'outcome-missing');
  assert.throws(() => store.reconcileTaskRequest({ host: 'other', sessionId: 'stranger' }, request.requestId, token, base + 90_000));
  assert.throws(() => store.reconcileTaskRequest(sender, request.requestId, 'c'.repeat(43), base + 90_000));
  const outcome = { schemaVersion: '1.0.0', kind: 'terminal-outcome', requestId: request.requestId,
    taskId: request.taskId, actor, callbackTarget: sender, revision: 1, result: 'COMPLETED',
    evidenceRefs: [], reportedAt: new Date(base + 100).toISOString(), authorityEffect: 'none' };
  const binding = { verifyTerminalReporter: () => ({ authenticatedActor: actor,
    currentInstanceId: actor.instanceId, revisionStream: 'task', currentRevision: 0,
    boundTaskId: request.taskId, trustedDelegation: { requestId: request.requestId, callbackTarget: sender } }) };
  const recorded = store.recordTaskOutcome(outcome, proof, binding, base + 100);
  assert.equal(store.reconcileTaskRequest(sender, request.requestId, token, base + 90_000).state, 'outcome-recorded');
  assert.equal(store.reconcileTaskRequest(sender, request.requestId, token, base + 90_000).outcome.acceptance, 'unverified');
  assert.equal(store.claim(sender, base + 101).length, 1);
  store.acknowledge(sender, [recorded.callbackMessageId], base + 102);
  assert.equal(store.reconcileTaskRequest(sender, request.requestId, token, base + 90_000).outcome.acceptance, 'unverified');
});

test('W05 MCP exposes bound portable contact and callback tools', async () => {
  const server = createMcpServer({}, {});
  const client = new Client({ name: 'w05-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    for (const name of ['get_session_contact_state', 'contact_session',
      'register_session_task_request', 'record_session_task_outcome', 'reconcile_session_task_request']) {
      const tool = tools.find((entry) => entry.name === name);
      assert.ok(tool, `${name} is registered`);
      assert.ok(tool.inputSchema.properties._sessionBinding, `${name} permits host binding`);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test('W05 host hook matchers bind every new tool and deny observed subagents', async () => {
  const names = ['get_session_contact_state', 'contact_session', 'register_session_task_request',
    'record_session_task_outcome', 'reconcile_session_task_request'];
  const hosts = [
    ['codex', 'hooks/hooks.json', 'mcp__agent-governance-suite__'],
    ['claude-code', 'claude-overlay/hooks/hooks.json', 'mcp__plugin_agent-governance-suite_agent-governance-suite__'],
  ];
  for (const [host, filename, prefix] of hosts) {
    const hooks = JSON.parse(readFileSync(new URL(`../../../${filename}`, import.meta.url), 'utf8'));
    const matcher = hooks.hooks.PreToolUse.flatMap((entry) => entry.matcher ? [entry.matcher] : [])
      .find((pattern) => pattern.includes('send_session_message'));
    assert.ok(matcher, `${host} PreToolUse matcher exists`);
    for (const name of names) {
      const toolName = `${prefix}${name}`;
      assert.match(toolName, new RegExp(matcher));
      const output = await handleSessionMessageHook({ hook_event_name: 'PreToolUse',
        session_id: 'parent-session', tool_name: toolName,
        tool_input: { _sessionBinding: { host: 'forged', sessionId: 'forged' } } }, host);
      assert.deepEqual(output.hookSpecificOutput.updatedInput._sessionBinding,
        { host, sessionId: 'parent-session' });
      const denied = await handleSessionMessageHook({ hook_event_name: 'PreToolUse',
        session_id: 'parent-session', agent_id: 'subagent-1', tool_name: toolName,
        tool_input: {} }, host);
      assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    }
  }
});
