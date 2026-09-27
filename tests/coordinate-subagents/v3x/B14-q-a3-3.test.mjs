import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { buildTwice } from '../../../runtime/issuer/windows/build/csc-build.mjs';

// B14-q-a3-3: the Windows issuer named-pipe host. SAME_USER_SMOKE with an independent server process on this PC.
// "Loopback" is the same user's SMB loopback path (\\localhost\pipe), never another PC or another principal.
const serverDir = fileURLToPath(new URL('../../../runtime/issuer/windows/server/', import.meta.url));
const listenerSource = join(serverDir, 'host', 'PipeListener.cs');
const coreSource = join(serverDir, 'core', 'IssuerCore.cs');
const framework = 'C:/Windows/Microsoft.NET/Framework64/v4.0.30319';
const references = ['mscorlib.dll', 'System.dll'].map((file) => join(framework, file));
const compiler = 'D:/codex/거버전스 3.0/ags-toolchain/roslyn/5.9.0/package/tasks/net472/csc.exe';
const smoke = process.platform === 'win32' && existsSync(compiler) ? test : test.skip;
const winPs = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0');
const pipePath = (host, name) => '\\\\' + host + '\\pipe\\' + name;
const uniqueName = (tag) => `ags-b14qa33a-${tag}-${process.pid}-${Date.now()}`;

describe('B14-q-a3-3a listener, DACL, single instance, remote refusal', () => {
  let dir;
  let product;
  let currentSid;
  const running = new Set();
  const servers = new Set();
  const build = (name, sources, cwd) => buildTwice({ sources, references, cwd,
    out: join(dir, name, 'out', 'ags-issuer-pipe-listener.exe'), keepDir: join(dir, name, 'keep') });

  beforeAll(() => {
    if (!existsSync(compiler)) return;
    dir = mkdtempSync(join(tmpdir(), 'ags-b14qa33a-'));
    const whoami = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe');
    currentSid = spawnSync(whoami, ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim().split(',').pop().replaceAll('"', '');
    assert.match(currentSid, /^S-1-5-21-/);
    product = build('product', [listenerSource, coreSource], serverDir);
  }, 120000);
  afterEach(async () => {
    for (const child of running) await stop(child);
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    servers.clear();
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function start(exe, name, allowed = [currentSid]) {
    const child = spawn(exe, [name, ...allowed], { stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);
    child.log = { out: '', err: '' };
    child.stderr.on('data', (data) => { child.log.err += data; });
    child.ready = new Promise((resolve) => {
      child.stdout.on('data', (data) => { child.log.out += data; if (child.log.out.includes('listening')) resolve('listening'); });
      child.on('exit', (code) => resolve(`exit ${code}`));
    });
    return child;
  }
  async function stop(child) {
    running.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await exited;
    clearTimeout(timer);
  }
  const connect = (path) => new Promise((resolve) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve({ path, ok: false, code: 'TIMEOUT' }); }, 5000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ path, ok: true }); });
    socket.once('error', (error) => { clearTimeout(timer); resolve({ path, ok: false, code: error.code, errno: error.errno, message: error.message }); });
  });
  const listen = (name) => new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    servers.add(server);
    server.once('error', reject);
    server.listen(pipePath('.', name), () => resolve(server));
  });
  // Reads the live pipe's DACL from outside the listener: a client opened with READ_CONTROL.
  function readDacl(name) {
    const script = `$ErrorActionPreference = 'Stop'; $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions', [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None); $c.Connect(5000); $sddl = $c.GetAccessControl().GetSecurityDescriptorSddlForm('Access'); $c.Dispose(); $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl); ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ sddl = $sddl; aces = @($raw.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ type = [string]$_.AceType; sid = $_.SecurityIdentifier.Value; mask = $_.AccessMask } }) })`;
    const result = spawnSync(join(winPs, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, PSModulePath: join(winPs, 'Modules') } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  smoke('(1) a pipe name another process already holds is refused (FILE_FLAG_FIRST_PIPE_INSTANCE)', async () => {
    const name = uniqueName('squat');
    await listen(name);
    const listener = start(product.runs[0].path, name);
    assert.equal(await listener.ready, 'exit 3', listener.log.out);
    assert.match(listener.log.err, /create-failed 5\b/);
    console.log(JSON.stringify({ check: 'squat', exit: listener.exitCode, stderr: listener.log.err.trim() }));
  });

  smoke('(2) the live pipe DACL is protected and has no Everyone (S-1-1-0) or Anonymous (S-1-5-7) entry', async () => {
    const name = uniqueName('dacl');
    const listener = start(product.runs[0].path, name);
    assert.equal(await listener.ready, 'listening', listener.log.err);
    const dacl = readDacl(name);
    console.log(JSON.stringify({ check: 'dacl', ...dacl }));
    const sids = dacl.aces.map((ace) => ace.sid);
    assert.ok(!sids.includes('S-1-1-0') && !sids.includes('S-1-5-7'), dacl.sddl);
    assert.match(dacl.sddl, /^D:P/);
    assert.equal(`${dacl.aces[0].type} ${dacl.aces[0].sid}`, 'AccessDenied S-1-5-2');
    assert.ok(sids.every((sid) => ['S-1-5-2', 'S-1-5-18', currentSid].includes(sid)), dacl.sddl);
  });

  smoke('(3) the listener refuses the SMB loopback path and accepts the local path of the same user', async (ctx) => {
    const control = uniqueName('control');
    await listen(control);
    const reach = await connect(pipePath('localhost', control));
    const name = uniqueName('remote');
    const listener = start(product.runs[0].path, name);
    assert.equal(await listener.ready, 'listening', listener.log.err);
    const loopback = await connect(pipePath('localhost', name));
    const local = await connect(pipePath('.', name));
    console.log(JSON.stringify({ check: 'remote-product', nodeDefaultDaclControlLoopback: reach, loopback, local }));
    if (!reach.ok) { console.log('NOT_RUN: the SMB loopback path is not reachable here'); ctx.skip(); }
    assert.equal(loopback.ok, false);
    assert.equal(local.ok, true);
  });

  smoke('(4) with the same DACL minus the NU deny, only the REJECT bit decides the loopback result (test-only builds)', async (ctx) => {
    // Test-only controls built from the listener source: never shipped and not a listener option.
    const source = readFileSync(listenerSource, 'utf8');
    const deny = 'const string DenyNetwork = "(D;;GA;;;NU)";';
    const reject = 'const uint RejectRemoteClients = 0x8u;';
    assert.ok(source.includes(deny) && source.includes(reject), 'the listener declares its NU deny and REJECT bit');
    const results = {};
    for (const [variant, bit] of [['rejectOff', '0x0u'], ['rejectOn', '0x8u']]) {
      const src = join(dir, variant, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'PipeListener.cs'), source.replace(deny, 'const string DenyNetwork = "";').replace(reject, `const uint RejectRemoteClients = ${bit};`));
      writeFileSync(join(src, 'IssuerCore.cs'), readFileSync(coreSource));
      const variantBuild = build(variant, ['PipeListener.cs', 'IssuerCore.cs'].map((file) => join(src, file)), src);
      const name = uniqueName(variant);
      const listener = start(variantBuild.runs[0].path, name);
      assert.equal(await listener.ready, 'listening', listener.log.err);
      results[variant] = { sha256: variantBuild.runs[0].sha256, dacl: readDacl(name).sddl, loopback: await connect(pipePath('localhost', name)), local: await connect(pipePath('.', name)) };
      await stop(listener);
    }
    console.log(JSON.stringify({ check: 'remote-cause', ...results }));
    if (!results.rejectOff.loopback.ok) { console.log('NOT_RUN: the same DACL with the REJECT bit off is refused too'); ctx.skip(); }
    assert.equal(results.rejectOn.loopback.ok, false);
    assert.equal(results.rejectOn.local.ok, true);
    assert.equal(results.rejectOff.local.ok, true);
  }, 120000);

  smoke('(6) Everyone (S-1-1-0) or Anonymous (S-1-5-7) as an allowed SID, alone or mixed with a valid SID, is refused before any pipe exists', async () => {
    for (const allowed of [['S-1-1-0'], ['S-1-5-7'], [currentSid, 'S-1-1-0'], [currentSid, 'S-1-5-7']]) {
      const name = uniqueName('broad');
      const refused = start(product.runs[0].path, name, allowed);
      assert.equal(await refused.ready, 'exit 2', `${allowed.join(' ')}: ${refused.log.out}`);
      assert.equal((await connect(pipePath('.', name))).code, 'ENOENT', allowed.join(' '));
    }
  });

  smoke('(5) a non-canonical allowed SID is refused before any pipe exists, and stopping ends the process and the pipe', async () => {
    const refused = start(product.runs[0].path, uniqueName('badsid'), ['S-1-5-21-1000-2000-3000-01']);
    assert.equal(await refused.ready, 'exit 2');
    const name = uniqueName('stop');
    const listener = start(product.runs[0].path, name);
    assert.equal(await listener.ready, 'listening', listener.log.err);
    await stop(listener);
    assert.ok(listener.exitCode !== null || listener.signalCode !== null);
    assert.equal((await connect(pipePath('.', name))).code, 'ENOENT');
  });
});

// B14-q-a3-3b-1 FIXTURE: the restricted issuer-request parser and the wire adapter through a harness, no pipe or token.
// The LF-trailing check covers the bytes handed to the harness only; late bytes on a live pipe are B14-q-a3-3b-2.
describe('B14-q-a3-3b-1 strict frame parser and wire adapter', () => {
  const fixture = smoke; // needs the isolated Roslyn on Windows; the result is FIXTURE, not a pipe or token observation
  const CAP = 4096; // the plan's contract: at most 4096 bytes including the LF (not read from the C# source)
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const frameValid = ajv.compile(JSON.parse(readFileSync(new URL('../../../runtime/issuer/windows/contract/ipc-frame.schema.json', import.meta.url), 'utf8')));
  const n = (c) => c.repeat(32);
  const receiverSid = 'S-1-5-21-1000-2000-3000-1001';
  const callerSid = 'S-1-5-21-1000-2000-3000-1002';
  const record = { currentEpoch: n('e'), receiverSid, callerSid };
  const issue = (extra = {}) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId: n('1'), epoch: n('e'), operation: 'issue',
    audience: 'peer-receiver/v1', receiverInstance: 'receiver-1', ...extra });
  const epochRequest = (requestId) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId, epoch: null, operation: 'epoch' });
  const line = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  let dir;
  let harness;

  beforeAll(() => {
    if (!existsSync(compiler)) return;
    dir = mkdtempSync(join(tmpdir(), 'ags-b14qa33b1-'));
    harness = buildTwice({ sources: [join(serverDir, 'host', 'FrameHarness.cs'), join(serverDir, 'host', 'FrameAdapter.cs'), coreSource],
      references: ['mscorlib.dll', 'System.dll', 'System.Web.Extensions.dll'].map((file) => join(framework, file)),
      cwd: serverDir, out: join(dir, 'out', 'ags-issuer-frame-harness.exe'), keepDir: join(dir, 'keep') });
  }, 120000);
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function run(frames, { peerSid = receiverSid, state = record } = {}) {
    const result = spawnSync(harness.runs[0].path, [], { encoding: 'utf8',
      input: JSON.stringify({ state, peerSid, frames: frames.map((frame) => Buffer.from(frame).toString('base64')) }) });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stderr.trim().split(/\r?\n/);
    assert.equal(lines.length, frames.length, result.stderr);
    return JSON.parse(result.stdout).map((outcome, i) => {
      const diagnostic = /^outcome (response|close|fail-closed) core-calls (\d+)$/.exec(lines[i]);
      assert.ok(diagnostic, `stderr carries only an enum and a counter: ${lines[i]}`);
      assert.equal(diagnostic[1], outcome.outcome);
      const raw = outcome.response === undefined ? undefined : Buffer.from(outcome.response, 'base64');
      return { outcome: outcome.outcome, coreCalls: Number(diagnostic[2]), raw, frame: raw && JSON.parse(raw.toString('utf8')) };
    });
  }
  const closedWithoutCore = (results, label) => results.forEach((result, i) => {
    assert.equal(result.outcome, 'close', `${label} ${i}`);
    assert.equal(result.coreCalls, 0, `${label} ${i}`);
  });
  function response(result, expected) {
    assert.equal(result.outcome, 'response');
    assert.ok(frameValid(result.frame), JSON.stringify(frameValid.errors));
    assert.ok(result.raw.at(-1) === 0x0a && result.raw.indexOf(0x0a) === result.raw.length - 1, 'one frame and its LF');
    assert.deepEqual(Object.keys(result.frame).filter((key) => !['schemaVersion', 'kind', 'requestId', 'operation', 'epoch', 'status', 'error'].includes(key)), []);
    assert.equal(result.frame.epoch, n('e'));
    for (const [key, value] of Object.entries(expected)) assert.deepEqual(result.frame[key], value, key);
  }

  fixture('b1-1 invalid UTF-8, an overlong form, a lone surrogate or a BOM is closed without calling the core', () => {
    const body = JSON.stringify(issue());
    const inject = (bytes) => Buffer.concat([Buffer.from(`${body.slice(0, -1)},"x":"`), Buffer.from(bytes), Buffer.from('"}\n')]);
    closedWithoutCore(run([inject([0xc3, 0x28]), inject([0xc0, 0xaf]), inject([0xed, 0xa0, 0x80]), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), line(issue())])]), 'utf8');
  });

  fixture('b1-2 exactly 4096 bytes with the LF is read; 4097 bytes or no LF is closed without calling the core', () => {
    const body = JSON.stringify(issue());
    const padded = (total) => Buffer.from(`${body}${' '.repeat(total - Buffer.byteLength(body) - 1)}\n`);
    assert.equal(padded(CAP).length, 4096);
    assert.equal(padded(CAP + 1).length, 4097);
    const [atCap, overCap, noLf] = run([padded(CAP), padded(CAP + 1), Buffer.from(body)]);
    response(atCap, { status: 'unavailable', error: { code: 'service-unavailable' } });
    assert.equal(atCap.coreCalls, 1);
    closedWithoutCore([overCap, noLf], 'size');
  });

  fixture('b1-3 a value that is not one object, or a request value outside string/null, is closed without calling the core', () => {
    const body = JSON.stringify(issue());
    closedWithoutCore(run(['[]\n', '"x"\n', '1\n', 'null\n', `${body.slice(0, -1)},"x":1}\n`, `${body.slice(0, -1)},"x":true}\n`, `${body.slice(0, -1)},"x":{"y":"z"}}\n`, `${body.slice(0, -1)},"x":["y"]}\n`]), 'shape');
  });

  fixture('b1-4 a second value, trailing text or bytes after the LF are closed without calling the core', () => {
    const body = JSON.stringify(issue());
    closedWithoutCore(run([`${body} ${body}\n`, `${body}x\n`, Buffer.concat([line(issue()), Buffer.from('more')])]), 'trailing');
  });

  fixture('b1-5 a duplicate key, also one spelled with an escape, is closed without calling the core', () => {
    const body = JSON.stringify(issue());
    closedWithoutCore(run([`{"requestId":"${n('2')}",${body.slice(1)}\n`, `${body.slice(0, -1)},"epoch":"${n('e')}"}\n`, `{"request\\u0049d":"${n('2')}",${body.slice(1)}\n`]), 'duplicate');
  });

  fixture('b1-6 epoch is ok with the server epoch, an allowed issue is unavailable, core refusals keep their code; all match ipc-frame.v1', () => {
    response(run([line(epochRequest(n('a')))], { peerSid: callerSid })[0], { status: 'ok', requestId: n('a'), operation: 'epoch' });
    const [allowed, replay, oldEpoch, audience] = run([line(issue({ requestId: n('b') })), line(issue({ requestId: n('b') })),
      line(issue({ requestId: n('c'), epoch: n('f') })), line(issue({ requestId: n('d'), audience: 'resource-caller/v1' }))]);
    response(allowed, { status: 'unavailable', requestId: n('b'), operation: 'issue', error: { code: 'service-unavailable' } });
    response(replay, { status: 'rejected', error: { code: 'replay' } });
    response(oldEpoch, { status: 'rejected', error: { code: 'epoch-mismatch' } });
    response(audience, { status: 'rejected', error: { code: 'audience-mismatch' } });
    response(run([line(issue({ requestId: n('7') }))], { peerSid: callerSid })[0], { status: 'rejected', error: { code: 'peer-identity-rejected' } });
    assert.ok([allowed, replay, oldEpoch, audience].every((result) => !/credential|grant|receiverSid|S-1-/.test(result.raw.toString('utf8'))));
  });

  fixture('b1-7 an unknown or ambiguous requestId/operation is closed, a correlated malformed request is refused, an invalid record fails closed', () => {
    const [upper, short, badOperation, extra] = run([line(issue({ requestId: 'A'.repeat(32) })), line(issue({ requestId: '1'.repeat(31) })),
      line(issue({ requestId: n('8'), operation: 'revoke' })), line({ ...issue({ requestId: n('9') }), extra: 'x' })]);
    for (const result of [upper, short, badOperation]) assert.equal(result.outcome, 'close');
    response(extra, { status: 'rejected', requestId: n('9'), operation: 'issue', error: { code: 'malformed-request' } });
    const [invalid] = run([line(issue())], { state: { ...record, receiverSid: callerSid } });
    assert.equal(invalid.outcome, 'fail-closed');
    assert.equal(invalid.raw, undefined);
  });

  fixture('b1-8 a requestId spent on an unavailable issue stays spent', () => {
    const [first, again] = run([line(issue({ requestId: n('0') })), line(issue({ requestId: n('0') }))]);
    response(first, { status: 'unavailable', error: { code: 'service-unavailable' } });
    response(again, { status: 'rejected', error: { code: 'replay' } });
  });

  fixture('b1-9 stderr has one enum and counter line per frame and never a SID, requestId or input', () => {
    const result = spawnSync(harness.runs[0].path, [], { encoding: 'utf8', input: JSON.stringify({ state: record, peerSid: receiverSid,
      frames: [line(issue({ requestId: n('5') })), Buffer.from('{"x":\n'), line(epochRequest(n('6')))].map((frame) => frame.toString('base64')) }) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stderr.trim().split(/\r?\n/), ['outcome response core-calls 1', 'outcome close core-calls 0', 'outcome response core-calls 1']);
    assert.ok(!/S-1-|5{32}|6{32}|receiver-1/.test(result.stderr));
  });
});
