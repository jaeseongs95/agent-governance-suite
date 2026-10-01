import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'vitest';
import { sessionMessageLineReader } from '../../mcp-server/src/session-message-protocol.ts';
import { requestSessionMessageOnce, waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));
const resources = [];
afterEach(async () => {
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
  if (bundled) {
    mkdirSync(join(install, 'mcp-server'), { recursive: true });
    cpSync(join(root, 'mcp-server/dist'), join(install, 'mcp-server/dist'), { recursive: true });
    cpSync(join(root, 'contracts'), join(install, 'contracts'), { recursive: true });
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
async function rawRequest(f, frame) {
  const endpoint = JSON.parse(readFileSync(join(f.state, 'endpoint.json'), 'utf8'));
  const certificate = readFileSync(join(f.state, 'broker-cert.pem'), 'utf8');
  return new Promise((resolve, reject) => {
    const chunks = [];
    const socket = tls.connect({ host: '127.0.0.1', servername: 'localhost', port: endpoint.port, ca: certificate,
      minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' }, () => socket.write(frame));
    socket.setTimeout(5000, () => socket.destroy(new Error('isolated TLS timeout')));
    socket.on('data', c => chunks.push(c)); socket.once('error', reject);
    socket.once('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))));
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
