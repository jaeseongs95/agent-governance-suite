import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../mcp-server/src/session-message-broker.ts';
import { createWakeHookObservationReader } from '../../mcp-server/src/session-message-wake-port.ts';
import { sessionMessageRequest } from '../../mcp-server/src/session-message-client.ts';
import { runSessionMessageHook } from '../../mcp-server/src/session-message-hook.ts';

vi.mock('../../mcp-server/src/session-message-client.ts', async original => ({
  ...await original(), sessionMessageRequest: vi.fn(),
}));
const request = vi.mocked(sessionMessageRequest);
const resources = [];
afterEach(() => {
  request.mockReset(); vi.unstubAllEnvs();
  for (const f of resources.splice(0)) { f.store.close(); rmSync(f.directory, { recursive: true, force: true, maxRetries: 10 }); }
});
function fixture(host) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-hook-'));
  const trust = join(directory, 'trust.sqlite3');
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', trust);
  vi.stubEnv('AGENT_GOVERNANCE_CODEX_QUEUE_WAKE', '1');
  const store = new SessionMessageStore(join(directory, 'messages.sqlite3'));
  const target = { host, sessionId: 'hook-target' }, sender = { host: 'test', sessionId: 'hook-sender' };
  const now = Date.now();
  store.startPresence({ ...target, instanceId: 'hook-birth', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'hook-relay', pid: process.pid, parentPid: process.pid }, now);
  store.send({ sender, target, messageId: 'hook-body-0001', body: '회신 본문 😀' }, now);
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'hook-birth', transport: 'portable',
    relayId: 'hook-relay', nonce: 'w05-r3-hook-abcdefghijklmnop' }, now);
  const attempt = store.startManagedWake(reserved.attempt, now).attempt;
  const f = { directory, store, target, sender, attempt }; resources.push(f);
  request.mockImplementation(async (operation, payload) => dispatch(store, operation, payload,
    undefined, undefined, undefined, createWakeHookObservationReader(trust)));
  return f;
}
const input = (f, prompt = `[agent-governance-suite:wake:${f.attempt.nonce}]`) =>
  JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: f.target.sessionId, agent_id: '', prompt });

test.each(['codex', 'claude-code'])('AC001 verified %s hook keeps the peer warning, no implicit processing ACK or authority', async host => {
  const f = fixture(host);
  const output = JSON.parse(await runSessionMessageHook(host, input(f)));
  assert.match(output.hookSpecificOutput.additionalContext, /untrusted peer context/);
  assert.match(output.hookSpecificOutput.additionalContext, /회신 본문 😀/);
  assert.equal(output.decision, undefined);
  assert.equal(f.store.status(f.sender, 'hook-body-0001').state, 'delivered');
  assert.equal(f.store.activityStatus(f.target).activity, 'unknown');
  assert.equal(request.mock.calls.some(([operation]) => operation === 'acknowledge'), false);
});
test.each(['managed', 'retired'])('AC005 Claude blocks only a verified empty %s wake', async state => {
  const f = fixture('claude-code'); f.store.acknowledge(f.target, ['hook-body-0001']);
  if (state === 'retired') f.store.database.prepare("UPDATE wake_nonces SET state='expired-unobserved', retired_at=?")
    .run(new Date().toISOString());
  const output = JSON.parse(await runSessionMessageHook('claude-code', input(f)));
  assert.equal(output.decision, 'block');
  if (state === 'retired') assert.equal(f.store.managedWakeStatus(f.target).state, 'expired-unobserved');
});
test('AC005 Codex empty wake and unverified Claude marker remain nonblocking; broker failure fails open', async () => {
  const f = fixture('codex'); f.store.acknowledge(f.target, ['hook-body-0001']);
  assert.equal(await runSessionMessageHook('codex', input(f)), '');
  assert.equal(await runSessionMessageHook('claude-code', input(f, '[agent-governance-suite:wake:unknown-nonce-abcdefghijklmnop]')), '');
  request.mockRejectedValue(new Error('isolated broker failure'));
  assert.equal(await runSessionMessageHook('claude-code', input(f)), '');
});
