import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, test } from 'vitest';
import { buildTwice } from '../../../runtime/issuer/windows/build/csc-build.mjs';

// B14-q-a3-2 FIXTURE: the C# decision core is built twice with the a3-1b tool (committed lock, fixed root) and fed
// JSON through its harness; no pipe, token or secret. Without the isolated Roslyn on this host the tests are skipped.
const core = fileURLToPath(new URL('../../../runtime/issuer/windows/server/core/', import.meta.url));
const framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319';
const compiler = 'D:/codex/거버전스 3.0/ags-toolchain/roslyn/5.9.0/package/tasks/net472/csc.exe';
const fixture = existsSync(compiler) ? test : test.skip;

const harnessBuild = (dir) => buildTwice({
  sources: ['IssuerCore.cs', 'Harness.cs'].map((file) => join(core, file)),
  references: ['mscorlib.dll', 'System.dll', 'System.Web.Extensions.dll'].map((file) => join(framework, file)),
  cwd: core, out: join(dir, 'out', 'ags-issuer-core-harness.exe'), keepDir: join(dir, 'keep'),
});

let dir;
let build;
beforeAll(() => {
  if (!existsSync(compiler)) return;
  dir = mkdtempSync(join(tmpdir(), 'ags-b14qa32-'));
  build = harnessBuild(dir);
}, 120000);
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const nonce = (c) => c.repeat(32);
const receiverSid = 'S-1-5-21-1000-2000-3000-1001';
const callerSid = 'S-1-5-21-1000-2000-3000-1002';
const record = { currentEpoch: nonce('e'), receiverSid, callerSid };
const issue = (requestId, extra = {}) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId, epoch: nonce('e'),
  operation: 'issue', audience: 'peer-receiver/v1', receiverInstance: 'receiver-1', ...extra });
const epoch = (requestId) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId, epoch: null, operation: 'epoch' });
function decide(requests, recordChange = {}) {
  const result = spawnSync(build.runs[0].path, [], { input: JSON.stringify({ state: { ...record, ...recordChange }, requests }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const outcomes = (decisions) => decisions.map((d) => (d.status === 'ok' ? 'ok' : `${d.status}:${d.error?.code}`));

fixture('B14-q-a3-2 the harness is built twice with the a3-1b tool and both builds have the same sha256', () => {
  assert.equal(build.identical, true);
  assert.equal(build.runs[0].sha256, build.runs[1].sha256);
  assert.ok(build.args.includes('/deterministic+'));
});

fixture('B14-q-a3-2 the recorded receiver on the current epoch with a fresh requestId gets peer-receiver/v1; anyone may read the epoch', () => {
  const decisions = decide([{ peerSid: receiverSid, request: issue(nonce('1')) }, { peerSid: callerSid, request: epoch(nonce('2')) }]);
  assert.deepEqual(outcomes(decisions), ['ok', 'ok']);
  assert.deepEqual(decisions[0].grant, { audience: 'peer-receiver/v1', receiverInstance: 'receiver-1', receiverSid });
  assert.equal(decisions[1].epoch, nonce('e'));
  assert.equal(decisions[1].grant, undefined);
});

fixture('B14-q-a3-2 a SID with sub-authority 01 or 9999999999 is never used in a decision (upper bound 4294967295)', () => {
  const at = (last) => `S-1-5-21-1000-2000-3000-${last}`;
  for (const bad of ['01', '9999999999', '4294967296']) {
    // Recorded and presented as the same string: a plain string match would issue.
    assert.deepEqual(outcomes(decide([{ peerSid: at(bad), request: issue(nonce('1')) }], { receiverSid: at(bad) })), ['rejected:install-record-invalid'], bad);
    assert.deepEqual(outcomes(decide([{ peerSid: at(bad), request: issue(nonce('1')) }])), ['rejected:peer-identity-rejected'], bad);
  }
  assert.deepEqual(outcomes(decide([{ peerSid: `${receiverSid}\n`, request: issue(nonce('1')) }])), ['rejected:peer-identity-rejected']);
  assert.deepEqual(outcomes(decide([{ peerSid: at('4294967295'), request: issue(nonce('1')) }], { receiverSid: at('4294967295') })), ['ok']);
  assert.deepEqual(outcomes(decide([{ peerSid: at('0'), request: issue(nonce('1')) }], { receiverSid: at('0') })), ['ok']);
});

fixture('B14-q-a3-2 an issue that does not carry the current epoch is refused', () => {
  assert.deepEqual(outcomes(decide([{ peerSid: receiverSid, request: issue(nonce('1'), { epoch: nonce('f') }) }])), ['rejected:epoch-mismatch']);
});

fixture('B14-q-a3-2 a reused requestId is refused, also after an allowed or refused first use', () => {
  assert.deepEqual(outcomes(decide([{ peerSid: receiverSid, request: issue(nonce('1')) }, { peerSid: receiverSid, request: issue(nonce('1')) }])), ['ok', 'rejected:replay']);
  assert.deepEqual(outcomes(decide([{ peerSid: receiverSid, request: issue(nonce('2'), { epoch: nonce('f') }) }, { peerSid: receiverSid, request: issue(nonce('2')) }])), ['rejected:epoch-mismatch', 'rejected:replay']);
  assert.deepEqual(outcomes(decide([{ peerSid: callerSid, request: epoch(nonce('3')) }, { peerSid: receiverSid, request: issue(nonce('3')) }])), ['ok', 'rejected:replay']);
});

fixture('B14-q-a3-2 peer-receiver/v1 goes only to the recorded receiver: another SID or the caller is refused', () => {
  assert.deepEqual(outcomes(decide([{ peerSid: 'S-1-5-21-1000-2000-3000-1003', request: issue(nonce('1')) }])), ['rejected:peer-identity-rejected']);
  assert.deepEqual(outcomes(decide([{ peerSid: callerSid, request: issue(nonce('1')) }])), ['rejected:peer-identity-rejected']);
  // A record that names the caller as the receiver allows nothing.
  assert.deepEqual(outcomes(decide([{ peerSid: callerSid, request: issue(nonce('1')) }, { peerSid: callerSid, request: epoch(nonce('2')) }], { receiverSid: callerSid })), ['rejected:install-record-invalid', 'rejected:install-record-invalid']);
});

fixture('B14-q-a3-2 resource-caller/v1 stays refused before a receiving principal is bound; the caller is not its default receiver', () => {
  const decisions = decide([{ peerSid: callerSid, request: issue(nonce('1'), { audience: 'resource-caller/v1' }) }, { peerSid: receiverSid, request: issue(nonce('2'), { audience: 'resource-caller/v1' }) }]);
  assert.deepEqual(outcomes(decisions), ['rejected:audience-mismatch', 'rejected:audience-mismatch']);
  assert.ok(decisions.every((d) => d.grant === undefined));
});

fixture('B14-q-a3-2 a malformed request or harness input is refused', () => {
  for (const request of [{ ...issue(nonce('1')), extra: true }, issue('A'.repeat(32)), { ...epoch(nonce('1')), epoch: nonce('e') }, issue(nonce('1'), { operation: 'revoke' }), issue(nonce('1'), { receiverInstance: '' }), null]) {
    assert.deepEqual(outcomes(decide([{ peerSid: receiverSid, request }])), ['rejected:malformed-request'], JSON.stringify(request));
  }
  const result = spawnSync(build.runs[0].path, [], { input: '{"requests":[]}', encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});
