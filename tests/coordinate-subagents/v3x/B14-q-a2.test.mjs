import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { IssuerEndpointUnavailable, WINDOWS_ISSUER_INSTALL_RECORD_PATH, WindowsIssuerClient,
  validateWindowsIssuerInstallRecord } from '../../../mcp-server/src/session-principal-windows.ts';

// B14-q-a2: the transport below is a same-process FIXTURE. It proves the client's framing and fail-closed
// mapping only; no real pipe, SCM service, token or cross-principal denial is observed here (NOT_RUN).
const issuerSid = 'S-1-5-80-1-2-3-4-5';
const pipeName = '\\\\.\\pipe\\ags-issuer-1';
const root = 'C:\\ProgramData\\agent-governance-suite';
const admins = 'S-1-5-32-544';
const digest = (c) => `sha256:${c.repeat(64)}`;
const service = (name, sid) => ({ accountKind: 'virtual-service-account', accountName: `NT SERVICE\\${name}`,
  observedSid: sid, groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: ['SeChangeNotifyPrivilege'] } });
const user = { accountKind: 'interactive-user', accountName: 'HOST\\user', observedSid: 'S-1-5-21-1-2-3-1001',
  groupPolicy: { forbiddenSids: [admins] }, privilegePolicy: { allowed: [] } };
const validRecord = () => ({
  contractId: 'ags-windows-issuer-install/v1', revision: 1, os: 'windows', installId: 'install-1',
  contractDigests: { provisioning: digest('a'), nativePrincipalIssuer: digest('b'), nativePrincipalIssuerFixture: digest('c') },
  principals: {
    installer: { accountKind: 'local-system', accountName: 'NT AUTHORITY\\SYSTEM', observedSid: 'S-1-5-18',
      groupPolicy: { forbiddenSids: [] }, privilegePolicy: { allowed: [] } },
    issuer: service('ags-issuer', issuerSid), receiver: service('ags-receiver', 'S-1-5-80-6-7-8-9-10'),
    caller: { ...user }, worker: { ...user },
  },
  services: {
    issuer: { serviceName: 'ags-issuer', sidType: 'restricted', startType: 'auto', binaryPath: `${root}\\issuer\\bin\\ags-issuer.exe` },
    receiver: { serviceName: 'ags-receiver', sidType: 'restricted', startType: 'auto', binaryPath: `${root}\\issuer\\bin\\ags-receiver.exe` },
  },
  paths: { protectedRoot: root, installRecord: WINDOWS_ISSUER_INSTALL_RECORD_PATH,
    registry: `${root}\\issuer\\state\\registry.json`, stateDirectory: `${root}\\issuer\\state` },
  endpoint: { pipeName },
  build: { buildDigest: digest('d'), closureDigest: digest('e') },
});
const epochA = 'a'.repeat(32);
const epochB = 'b'.repeat(32);
const args = { audience: 'peer-receiver/v1', receiverInstance: 'receiver-1' };
const credential = { credentialId: 'cred-1', ...args, expiresAt: '2026-09-26T12:00:00.000Z', secret: 'A'.repeat(43) };

/** Fixture issuer: answers from `reply(request)`; records every frame and pipe it was handed. */
function fixture(reply, serverSid = issuerSid) {
  const calls = [];
  const transport = async (pipe, bytes) => {
    const request = JSON.parse(bytes.toString('utf8'));
    calls.push({ pipe, request });
    const body = reply(request, calls.length);
    return { response: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), serverSid };
  };
  return { calls, transport };
}
const ok = (request, extra = {}) => ({ schemaVersion: '1.0.0', kind: 'issuer-response', requestId: request.requestId,
  operation: request.operation, epoch: epochA, status: 'ok',
  ...(request.operation === 'issue' ? { credential } : {}), ...extra });
const refusal = (request, epoch, status, code) => ({ schemaVersion: '1.0.0', kind: 'issuer-response', requestId: request.requestId,
  operation: request.operation, epoch, status, error: { code } });
const client = (transport, overrides = {}) => new WindowsIssuerClient({ platform: 'win32',
  readRecord: async () => validRecord(), transport, ...overrides });

test('B14-q-a2 issues only after learning the epoch, over the pipe named by the protected record', async () => {
  const { calls, transport } = fixture((request) => ok(request));
  const issuer = client(transport);
  assert.deepEqual(await issuer.issue(args), { verdict: 'UNAVAILABLE', code: 'epoch-unknown' });
  assert.equal(calls.length, 0);
  assert.deepEqual(await issuer.refreshEpoch(), { verdict: 'OK', code: 'epoch-current', epoch: epochA });
  assert.deepEqual(await issuer.issue(args), { verdict: 'OK', code: 'issued', epoch: epochA, credential });
  assert.deepEqual(calls.map((call) => call.pipe), [pipeName, pipeName]);
  assert.deepEqual(Object.keys(calls[1].request).sort(), ['audience', 'epoch', 'kind', 'operation', 'receiverInstance', 'requestId', 'schemaVersion']);
  assert.equal(calls[1].request.epoch, epochA);
  assert.notEqual(calls[0].request.requestId, calls[1].request.requestId);
});

test('B14-q-a2 fails closed before any I/O on platform, transport, record and caller fields', async () => {
  const { calls, transport } = fixture((request) => ok(request));
  assert.deepEqual(await client(transport, { platform: 'linux' }).refreshEpoch(), { verdict: 'UNSUPPORTED', code: 'platform-unsupported' });
  assert.deepEqual(await new WindowsIssuerClient({ platform: 'win32', readRecord: async () => validRecord() }).refreshEpoch(),
    { verdict: 'UNAVAILABLE', code: 'server-identity-transport-missing' });
  const broken = {
    missing: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    'missing field': () => { const r = validRecord(); delete r.build; return r; },
    'issuer shares worker SID': () => { const r = validRecord(); r.principals.worker.observedSid = issuerSid; return r; },
    'issuer shares receiver SID': () => { const r = validRecord(); r.principals.receiver.observedSid = issuerSid; return r; },
    'issuer shares caller SID': () => { const r = validRecord(); r.principals.caller.observedSid = issuerSid; return r; },
    'same service twice': () => { const r = validRecord(); r.services.receiver.serviceName = 'ags-issuer'; r.principals.receiver.accountName = 'NT SERVICE\\ags-issuer'; return r; },
    'account of another service': () => { const r = validRecord(); r.principals.issuer.accountName = 'NT SERVICE\\ags-receiver'; return r; },
    'local-system installer with a user SID': () => { const r = validRecord(); r.principals.installer.observedSid = 'S-1-5-21-1-2-3-500'; return r; },
    'registry is the install record (case-folded)': () => { const r = validRecord(); r.paths.registry = `${root}\\issuer\\Install-Record.json`; return r; },
    'issuer and receiver share one binary': () => { const r = validRecord(); r.services.receiver.binaryPath = r.services.issuer.binaryPath; return r; },
    'binaries inside mutable state': () => { const r = validRecord(); r.paths.stateDirectory = `${root}\\issuer\\BIN`; return r; },
    'DOS device segment': () => { const r = validRecord(); r.paths.registry = `${root}\\issuer\\state\\nul.json`; return r; },
    'DOS device binary': () => { const r = validRecord(); r.services.issuer.binaryPath = `${root}\\issuer\\bin\\CON.exe`; return r; },
    'binary under the state directory': () => { const r = validRecord(); r.services.issuer.binaryPath = `${root}\\issuer\\state\\ags-issuer.exe`; return r; },
  };
  for (const [label, read] of Object.entries(broken)) {
    assert.deepEqual(await client(transport, { readRecord: async () => read() }).refreshEpoch(),
      { verdict: 'UNAVAILABLE', code: 'install-record-invalid' }, label);
  }
  assert.throws(() => validateWindowsIssuerInstallRecord({ ...validRecord(), os: 'linux' }));
  const issuer = client(transport);
  await issuer.refreshEpoch();
  const before = calls.length;
  for (const field of ['pipeName', 'path', 'secret', 'expectedSid', 'brokerToken', 'role']) {
    assert.deepEqual(await issuer.issue({ ...args, [field]: 'x' }), { verdict: 'REJECTED', code: 'caller-field-forbidden' }, field);
  }
  assert.deepEqual(await issuer.issue({ audience: args.audience }), { verdict: 'REJECTED', code: 'caller-field-forbidden' });
  assert.deepEqual(await issuer.issue(null), { verdict: 'REJECTED', code: 'caller-field-forbidden' });
  assert.deepEqual(await issuer.issue({ ...args, audience: 'resource-owner/v1' }), { verdict: 'REJECTED', code: 'caller-field-invalid' });
  assert.equal(calls.length, before, 'no forbidden or invalid caller request reaches the pipe');
});

test('B14-q-a2 environment variables cannot redirect the install record', async (context) => {
  if (existsSync(WINDOWS_ISSUER_INSTALL_RECORD_PATH)) context.skip('a real install record exists on this host');
  const { calls, transport } = fixture((request) => ok(request));
  // A valid record at a caller-controlled location must never be picked up.
  const directory = await mkdtemp(join(tmpdir(), 'ags-b14qa2-'));
  const planted = join(directory, 'install-record.json');
  await writeFile(planted, JSON.stringify(validRecord()));
  const names = ['AGS_ISSUER_INSTALL_RECORD', 'AGS_ISSUER_PIPE', 'PROGRAMDATA', 'ALLUSERSPROFILE'];
  const saved = names.map((name) => [name, process.env[name]]);
  try {
    for (const name of names) process.env[name] = name.startsWith('AGS_') ? planted : directory;
    const issuer = new WindowsIssuerClient({ platform: 'win32', transport });
    assert.deepEqual(await issuer.refreshEpoch(), { verdict: 'UNAVAILABLE', code: 'install-record-invalid' });
    assert.equal(calls.length, 0);
  } finally {
    for (const [name, value] of saved) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await rm(directory, { recursive: true, force: true });
  }
});

test('B14-q-a2 never reports success for an unauthenticated, replayed, malformed or lost reply', async () => {
  const run = async (reply, serverSid) => {
    const { transport } = fixture((request, n) => (n === 1 ? ok(request) : reply(request)), serverSid);
    const issuer = client(transport);
    if (serverSid === undefined) assert.equal((await issuer.refreshEpoch()).verdict, 'OK');
    return serverSid === undefined ? issuer.issue(args) : issuer.refreshEpoch();
  };
  assert.deepEqual(await run((request) => ok(request), 'S-1-5-21-1-2-3-1001'), { verdict: 'REJECTED', code: 'server-identity-mismatch' });
  assert.deepEqual(await run((request) => ok(request), 'S-1-5-80-6-7-8-9-10'), { verdict: 'REJECTED', code: 'server-identity-mismatch' });
  let earlier;
  const replay = fixture((request, n) => { if (n === 1) { earlier = ok(request); return earlier; } return { ...earlier, operation: 'issue', credential }; });
  const replayed = client(replay.transport);
  await replayed.refreshEpoch();
  assert.deepEqual(await replayed.issue(args), { verdict: 'UNKNOWN', code: 'response-mismatch' });
  assert.deepEqual(await run((request) => ({ ...ok(request), operation: 'epoch', credential: undefined })), { verdict: 'UNKNOWN', code: 'response-mismatch' });
  assert.deepEqual(await run(() => Buffer.from('{not json')), { verdict: 'UNKNOWN', code: 'response-malformed' });
  // Otherwise valid reply padded past the cap: the size limit alone must reject it.
  assert.deepEqual(await run((request) => Buffer.from(JSON.stringify(ok(request)).padEnd(16 * 1024 + 1, ' '))), { verdict: 'UNKNOWN', code: 'response-malformed' });
  assert.deepEqual(await run((request) => ({ ...ok(request), status: 'unknown' })), { verdict: 'UNKNOWN', code: 'response-malformed' });
  // The issuer already acted on these: a mismatched credential is unknown, never a clean refusal.
  assert.deepEqual(await run((request) => ({ ...ok(request), credential: { ...credential, audience: 'resource-caller/v1' } })),
    { verdict: 'UNKNOWN', code: 'response-mismatch' });
  assert.deepEqual(await run((request) => ({ ...ok(request), credential: { ...credential, receiverInstance: 'receiver-2' } })),
    { verdict: 'UNKNOWN', code: 'response-mismatch' });

  const lost = client(async () => { throw new Error('pipe broken after write'); });
  assert.deepEqual(await lost.refreshEpoch(), { verdict: 'UNKNOWN', code: 'transport-uncertain' });
  const slow = client((_pipe, _bytes, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))), { timeoutMs: 20 });
  assert.deepEqual(await slow.refreshEpoch(), { verdict: 'UNKNOWN', code: 'transport-uncertain' });
  // The client's own deadline holds even when a transport ignores the signal or blames the endpoint after it.
  const deaf = client(() => new Promise(() => {}), { timeoutMs: 20 });
  assert.deepEqual(await deaf.refreshEpoch(), { verdict: 'UNKNOWN', code: 'transport-uncertain' });
  const late = client((_pipe, _bytes, signal) => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(new IssuerEndpointUnavailable('gave up')))), { timeoutMs: 20 });
  assert.deepEqual(await late.refreshEpoch(), { verdict: 'UNKNOWN', code: 'transport-uncertain' });
  const absent = client(async () => { throw new IssuerEndpointUnavailable('no pipe'); });
  assert.deepEqual(await absent.refreshEpoch(), { verdict: 'UNAVAILABLE', code: 'endpoint-unavailable' });
});

test('B14-q-a2 an issuer restart invalidates the epoch until it is learned again', async () => {
  let epoch = epochA;
  const { transport } = fixture((request) => ok(request, { epoch }));
  const issuer = client(transport);
  await issuer.refreshEpoch();
  epoch = epochB;
  // An ok reply from another epoch is outside the protocol: the issuer may have issued, so it is unknown.
  assert.deepEqual(await issuer.issue(args), { verdict: 'UNKNOWN', code: 'response-mismatch' });
  assert.deepEqual(await issuer.issue(args), { verdict: 'UNAVAILABLE', code: 'epoch-unknown' });
  assert.deepEqual(await issuer.refreshEpoch(), { verdict: 'OK', code: 'epoch-current', epoch: epochB });
  assert.equal((await issuer.issue(args)).verdict, 'OK');

  const denied = fixture((request, n) => (n === 1 ? ok(request) : refusal(request, epochB, 'unavailable', 'epoch-mismatch')));
  const stale = client(denied.transport);
  await stale.refreshEpoch();
  assert.deepEqual(await stale.issue(args), { verdict: 'UNAVAILABLE', code: 'epoch-mismatch' });
  assert.deepEqual(await stale.issue(args), { verdict: 'UNAVAILABLE', code: 'epoch-unknown' });
  const rejected = fixture((request, n) => (n === 1 ? ok(request) : refusal(request, epochA, 'rejected', 'replay')));
  const replayedRequest = client(rejected.transport);
  await replayedRequest.refreshEpoch();
  assert.deepEqual(await replayedRequest.issue(args), { verdict: 'REJECTED', code: 'replay' });
});

test('B14-q-a2 a reply is judged against the epoch its request carried, not a concurrent refresh', async () => {
  const cases = [
    ['ok from the newer epoch', (request) => ok(request, { epoch: epochB }), { verdict: 'UNKNOWN', code: 'response-mismatch' }],
    ['ok from the carried epoch', (request) => ok(request), { verdict: 'OK', code: 'issued', epoch: epochA, credential }],
    ['epoch-mismatch refusal', (request) => refusal(request, epochB, 'unavailable', 'epoch-mismatch'), { verdict: 'UNAVAILABLE', code: 'epoch-mismatch' }],
  ];
  for (const [label, issueReply, expected] of cases) {
    let current = epochA;
    let arrived;
    let release;
    const reached = new Promise((resolve) => { arrived = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const requests = [];
    const transport = async (_pipe, bytes) => {
      const request = JSON.parse(bytes.toString('utf8'));
      requests.push(request);
      if (request.operation === 'issue' && requests.filter((r) => r.operation === 'issue').length === 1) { arrived(); await gate; }
      const body = request.operation === 'epoch' ? ok(request, { epoch: current }) : issueReply(request);
      return { response: Buffer.from(JSON.stringify(body)), serverSid: issuerSid };
    };
    const issuer = client(transport);
    await issuer.refreshEpoch();
    const pending = issuer.issue(args);
    await reached;
    current = epochB;
    assert.deepEqual(await issuer.refreshEpoch(), { verdict: 'OK', code: 'epoch-current', epoch: epochB }, label);
    release();
    assert.deepEqual(await pending, expected, label);
    // The epoch learned meanwhile survives the older request's reply.
    await issuer.issue(args);
    assert.deepEqual([requests.at(-1).operation, requests.at(-1).epoch], ['issue', epochB], label);
  }
});
