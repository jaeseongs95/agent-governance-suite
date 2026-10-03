import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { adaptHostInput } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation } from '../../mcp-server/src/session-message-wake-port.ts';
import { sessionMessageLineReader } from '../../mcp-server/src/session-message-protocol.ts';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const resources = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const f of resources.splice(0)) {
    if (f.child.exitCode === null && f.child.signalCode === null) {
      const exited = once(f.child, 'exit'); f.child.kill(); await exited;
    }
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 10 });
  }
});
function paddedRequest(token, size, operation = 'ping', payload = {}) {
  const request = { protocolVersion: '1.0.0', token, operation, payload: { ...payload, padding: '' } };
  let raw = `${JSON.stringify(request)}\n`;
  const prefix = Buffer.byteLength(raw.slice(0, raw.indexOf('"padding":"') + 11));
  request.payload.padding = `${'x'.repeat(16383 - prefix)}한😀`;
  raw = `${JSON.stringify(request)}\n`;
  request.payload.padding += 'x'.repeat(size - Buffer.byteLength(raw));
  return Buffer.from(`${JSON.stringify(request)}\n`);
}
async function launch(bundled = false) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-wire-'));
  const state = join(directory, 'state'); const install = join(directory, 'install');
  const home = join(directory, 'home'); mkdirSync(home);
  const bundleRoot = bundled === 'claude' ? join(root, 'claude-plugin') : root;
  if (bundled) {
    mkdirSync(join(install, 'mcp-server'), { recursive: true });
    cpSync(join(bundleRoot, 'mcp-server/dist'), join(install, 'mcp-server/dist'), { recursive: true });
    cpSync(join(bundleRoot, 'contracts'), join(install, 'contracts'), { recursive: true });
    assert.equal(existsSync(join(install, 'node_modules')), false);
  }
  const environment = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: join(directory, 'local'),
    XDG_STATE_HOME: join(directory, 'xdg'), AGENT_GOVERNANCE_SHARED_STATE_DIR: join(directory, 'shared'),
    AGENT_GOVERNANCE_TRUST_DB_PATH: join(directory, 'trust.sqlite3'),
    AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state, AGS_W05_WIRE_OBSERVATIONS: join(directory, 'wire.json') };
  const broker = bundled ? join(install, 'mcp-server/dist/session-message-broker.mjs') : join(root, 'mcp-server/src/session-message-broker.ts');
  const args = [...(bundled ? [] : ['--import', 'tsx']), '--import', new URL('./fixtures/w05-r3-wire.mjs', import.meta.url).href,
    broker, '--state-directory', state];
  const child = spawn(process.execPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: environment });
  const f = { directory, state, install, child, environment }; resources.push(f);
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  try { await waitForSessionMessageBrokerReady(state, child, 5000); } catch (error) { throw new Error(stderr, { cause: error }); }
  return f;
}
async function rawRequest(f, frame, includeRaw = false) {
  const endpoint = JSON.parse(readFileSync(join(f.state, 'endpoint.json'), 'utf8'));
  const certificate = readFileSync(join(f.state, 'broker-cert.pem'), 'utf8');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = tls.connect({ host: '127.0.0.1', servername: 'localhost', port: endpoint.port, ca: certificate,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, () => socket.write(frame));
    socket.setTimeout(5000, () => socket.destroy(new Error('isolated TLS timeout')));
    socket.on('data', c => chunks.push(c)); socket.once('error', reject);
    socket.once('end', () => {
      const raw = Buffer.concat(chunks), answer = JSON.parse(raw.toString('utf8'));
      resolve(includeRaw ? { raw, answer } : answer);
    });
  });
}
test('AC006 raw framing decodes every Unicode split, exact limit and newline-inclusive limit+1', () => {
  const frame = Buffer.from('한😀\n');
  for (let split = 1; split < frame.length; split++) {
    const reader = sessionMessageLineReader(frame.length);
    assert.equal(reader(frame.subarray(0, split)), null);
    assert.equal(reader(frame.subarray(split)), '한😀');
  }
  assert.equal(sessionMessageLineReader(32768)(Buffer.from(`${'x'.repeat(32767)}\n`)).length, 32767);
  assert.throws(() => sessionMessageLineReader(32768)(Buffer.from(`${'x'.repeat(32768)}\n`)), RangeError);
  assert.throws(() => sessionMessageLineReader(32768)(Buffer.alloc(32769)), RangeError);
});
test.each([false, true])('AC006 actual TLS source/bundle=%s crosses UTF8 record boundary and rejects request+1 before effects', async bundled => {
  const f = await launch(bundled); const token = readFileSync(join(f.state, 'broker.token'), 'utf8').trim();
  const exact = paddedRequest(token, 32768);
  assert.equal(exact.length, 32768); assert.equal(exact[16383], 0xed);
  assert.equal((await rawRequest(f, exact)).ok, true);
  const observations = JSON.parse(readFileSync(join(f.directory, 'wire.json'), 'utf8'));
  const measured = observations.find(o => o.requestBytes === 32768);
  assert.ok(measured.requestChunks.length > 1); assert.equal(measured.requestChunks[0], 16384);
  const sender = { host: 'test', sessionId: 'sender' }, target = { host: 'test', sessionId: 'recipient' };
  const oversized = paddedRequest(token, 32769, 'prepare', { sender, target, body: 'must not draft' });
  const rejected = await rawRequest(f, oversized);
  assert.equal(rejected.ok, false); assert.match(rejected.error, /limit/);
  const db = new DatabaseSync(join(f.state, 'session-messages.sqlite3'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM prepared_messages').get().n, 0); }
  finally { db.close(); }
  const answer = await requestSessionMessageOnce('ping', { responseBytes: 32768 }, f.state);
  assert.ok(answer.padding.includes('한😀')); assert.equal(answer.padding.includes('\ufffd'), false);
  await assert.rejects(requestSessionMessageOnce('ping', { responseBytes: 32769 }, f.state), /limit/);
  assert.ok(JSON.parse(readFileSync(join(f.directory, 'wire.json'), 'utf8')).some(o => o.responseBytes === 32768));
});
test('AC006 a second frame in the same TLS write never causes a second preparation', async () => {
  const f = await launch(); const token = readFileSync(join(f.state, 'broker.token'), 'utf8').trim();
  const request = { protocolVersion: '1.0.0', token, operation: 'prepare', payload: {
    sender: { host: 'test', sessionId: 'frame-sender' }, target: { host: 'test', sessionId: 'frame-target' }, body: 'one frame' } };
  const frame = Buffer.from(`${JSON.stringify(request)}\n${JSON.stringify(request)}\n`);
  assert.equal((await rawRequest(f, frame)).ok, true);
  const db = new DatabaseSync(join(f.state, 'session-messages.sqlite3'), { readOnly: true });
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM prepared_messages').get().n, 1); }
  finally { db.close(); }
});
test('AC006 bundled CLI cleanroom preserves Unicode body bytes over a multi-record claim and duplicate send', async () => {
  const f = await launch(true);
  const sender = { host: 'test', sessionId: 'cli-sender' }, target = { host: 'test', sessionId: 'cli-target' };
  const body = '한😀'.repeat(580);
  const cli = (operation, payload) => {
    const result = spawnSync(process.execPath, [join(f.install, 'mcp-server/dist/session-message-cli.mjs')], {
      input: JSON.stringify({ operation, payload }), encoding: 'utf8', timeout: 5000, windowsHide: true,
      cwd: f.install, env: f.environment });
    assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout); assert.equal(output.ok, true);
    return output.data;
  };
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const { messageId } = cli('prepare', { sender, target, body }); ids.push(messageId);
    cli('send', { sender, messageId }); assert.equal(cli('send', { sender, messageId }).duplicate, true);
  }
  const claimed = cli('claim', { target }); assert.equal(claimed.messages.length, 5);
  for (const message of claimed.messages) assert.deepEqual(Buffer.from(message.body), Buffer.from(body));
  assert.equal(cli('acknowledge', { target, messageIds: ids }).acknowledged, 5);
  assert.equal(cli('pending', { target }).count, 0);
  const wire = JSON.parse(readFileSync(join(f.directory, 'wire.json'), 'utf8'));
  assert.ok(wire.some(o => o.operation === 'claim' && o.responseBytes > 16384 && o.responseBytes <= 32768));
});

async function authenticatedWire(f, operation, payload) {
  const token = readFileSync(join(f.state, 'broker.token'), 'utf8').trim();
  return rawRequest(f, Buffer.from(JSON.stringify({ protocolVersion: '1.0.0', token, operation, payload }) + '\n'), true);
}
function wireState(f) {
  const db = new DatabaseSync(join(f.state, 'session-messages.sqlite3'), { readOnly: true });
  try { return Object.fromEntries(['messages', 'wake_nonces', 'input_observations', 'wake_activity']
    .map(table => [table, db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()])); }
  finally { db.close(); }
}
// Literal oracle is independent of the production frame/sizing implementation.
const literalFrame = data => Buffer.from(JSON.stringify({ ok: true, data }) + '\n');
test.each([false, true, 'claude'].flatMap(bundled => [32768, 32769, 32783].map(bytes => [bundled, bytes])))
('AC005/006 F1 actual TLS bundle=%s managed full frame=%i, rollback and excluded-row bytes', async (bundled, bytes) => {
  const f = await launch(bundled);
  const sender = { host: 'portable', sessionId: 'f1-wire-sender' }, target = { host: 'portable', sessionId: 'f1-wire-target' };
  const ok = async (operation, payload) => { const result = await authenticatedWire(f, operation, payload);
    assert.equal(result.answer.ok, true, result.answer.error); return result.answer.data; };
  const stamp = new Date().toISOString();
  const projected = Array.from({ length: 8 }, () => ({ messageId: '00000000-0000-0000-0000-000000000000', sender,
    recipient: target, body: '한😀"\\\n'.repeat(20), createdAt: stamp, expiresAt: stamp, deliveryAttempt: 1, firstDeliveredAt: stamp }));
  let remaining = bytes - literalFrame({ recognized: true, messages: projected, managed: true }).length;
  assert.ok(remaining >= 0);
  for (const message of projected) {
    const added = Math.min(remaining, 4096 - Buffer.byteLength(message.body));
    message.body += 'x'.repeat(added); remaining -= added;
    assert.ok(Buffer.byteLength(message.body) <= 4096);
    const draft = await ok('prepare', { sender, target, body: message.body, ttlSeconds: 86400 });
    assert.equal(draft.messageId.length, message.messageId.length); message.messageId = draft.messageId;
    await ok('send', { sender, messageId: draft.messageId });
  }
  assert.equal(remaining, 0); assert.equal(projected.length <= 10, true);
  await ok('presence-start', { target, instanceId: 'f1-wire-birth', transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' });
  assert.equal((await ok('acquire-relay', { target, transport: 'portable', relayId: 'f1-wire-relay', pid: process.pid,
    parentPid: process.pid })).acquired, true);
  const nonce = 'f1-wire-nonce-abcdefghijklmnop';
  const reserved = await ok('reserve-wake', { target, instanceId: 'f1-wire-birth', transport: 'portable', relayId: 'f1-wire-relay', nonce });
  assert.equal(reserved.dispatch, true);
  const started = await ok('start-wake', { attempt: reserved.attempt }); assert.equal(started.dispatch, true);
  assert.equal((await ok('record-wake-outcome', { attempt: started.attempt, outcome: 'accepted-or-unknown' })).recorded, true);
  // This is a disposable signed observation, not native-host qualification or user authority.
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', f.environment.AGENT_GOVERNANCE_TRUST_DB_PATH);
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: '[agent-governance-suite:wake:' + nonce + ']' }, target.host).observation;
  const sourceReceiptId = recordWakeHookObservation(observation);
  const before = wireState(f);
  for (const [i, row] of before.messages.entries()) {
    projected[i].createdAt = row.created_at; projected[i].expiresAt = row.expires_at;
  }
  assert.equal(literalFrame({ recognized: true, messages: projected, managed: true }).length, bytes);
  if (bytes === 32783) {
    assert.equal(literalFrame({ recognized: true, messages: projected }).length, 32768);
    assert.equal(literalFrame({ messages: projected }).length, 32750);
  }
  const rejected = await authenticatedWire(f, 'claim-host-wake', { target, observation, sourceReceiptId, maxBodyChars: 1 });
  assert.equal(rejected.answer.ok, false); assert.match(rejected.answer.error, /caller claim budget/);
  assert.deepEqual(wireState(f), before); assert.equal(before.wake_nonces[0].state, 'unknown');
  const delivered = await authenticatedWire(f, 'claim-host-wake', { target, observation, sourceReceiptId,
    ...(bytes === 32768 ? {} : { maxMessages: 10, maxBodyChars: 32768 }) });
  assert.equal(delivered.answer.ok, true, delivered.answer.error);
  const data = delivered.answer.data, count = bytes === 32768 ? 8 : 7;
  assert.equal(data.recognized, true); assert.equal(data.managed, true); assert.equal(Object.hasOwn(data, 'retired'), false);
  assert.equal(data.messages.length, count);
  assert.deepEqual(delivered.raw, literalFrame(data)); assert.equal(delivered.raw.at(-1), 10);
  assert.ok(delivered.raw.length <= 32768);
  if (bytes === 32768) assert.equal(delivered.raw.length, 32768);
  const after = wireState(f);
  for (const [i, row] of after.messages.entries()) {
    if (i >= count) assert.deepEqual(row, before.messages[i]);
    else {
      const actual = data.messages[i];
      assert.deepEqual(actual, { ...projected[i], firstDeliveredAt: actual.firstDeliveredAt });
      assert.deepEqual(Buffer.from(actual.body), Buffer.from(projected[i].body));
      assert.equal(row.delivery_attempts, 1); assert.equal(row.first_delivered_at, actual.firstDeliveredAt);
      assert.equal(row.claimed_at, actual.firstDeliveredAt); assert.ok(row.claim_until > row.claimed_at);
    }
  }
  assert.equal(after.wake_nonces[0].state, 'observed'); assert.ok(after.wake_nonces[0].consumed_at);
  const replay = await ok('claim-host-wake', { target, observation, sourceReceiptId });
  assert.deepEqual(replay, { recognized: false, messages: [], managed: false });
  assert.equal((await ok('acknowledge', { target, messageIds: data.messages.map(m => m.messageId) })).acknowledged, count);
  if (count < projected.length) {
    // Existing bundled CLI drains the excluded body; wake operations stay on the authenticated TLS surface.
    let rest;
    if (bundled) {
      const result = spawnSync(process.execPath, [join(f.install, 'mcp-server/dist/session-message-cli.mjs')], {
        input: JSON.stringify({ operation: 'claim', payload: { target } }), encoding: 'utf8', timeout: 5000,
        windowsHide: true, cwd: f.install, env: f.environment });
      assert.equal(result.status, 0, result.stderr); const answer = JSON.parse(result.stdout); assert.equal(answer.ok, true);
      rest = answer.data;
    } else rest = await ok('claim', { target });
    assert.equal(rest.messages.length, 1); assert.equal(rest.messages[0].messageId, projected[7].messageId);
    assert.equal(rest.messages[0].deliveryAttempt, 1);
    assert.deepEqual(Buffer.from(rest.messages[0].body), Buffer.from(projected[7].body));
    await ok('acknowledge', { target, messageIds: [rest.messages[0].messageId] });
  }
  assert.equal((await ok('pending', { target })).count, 0);
});
