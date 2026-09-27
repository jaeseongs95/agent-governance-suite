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
const pipeSource = join(serverDir, 'host', 'IssuerPipe.cs'); // the 3a pipe policy, shared by the listener and the server (3b-2)
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
    product = build('product', [listenerSource, pipeSource, coreSource], serverDir);
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
    // Test-only controls built from the pipe policy source: never shipped and not a listener option.
    const source = readFileSync(pipeSource, 'utf8');
    const deny = 'const string DenyNetwork = "(D;;GA;;;NU)";';
    const reject = 'const uint RejectRemoteClients = 0x8u;';
    assert.ok(source.includes(deny) && source.includes(reject), 'the pipe policy declares its NU deny and REJECT bit');
    const results = {};
    for (const [variant, bit] of [['rejectOff', '0x0u'], ['rejectOn', '0x8u']]) {
      const src = join(dir, variant, 'src');
      mkdirSync(src, { recursive: true });
      writeFileSync(join(src, 'IssuerPipe.cs'), source.replace(deny, 'const string DenyNetwork = "";').replace(reject, `const uint RejectRemoteClients = ${bit};`));
      writeFileSync(join(src, 'PipeListener.cs'), readFileSync(listenerSource));
      writeFileSync(join(src, 'IssuerCore.cs'), readFileSync(coreSource));
      const variantBuild = build(variant, ['PipeListener.cs', 'IssuerPipe.cs', 'IssuerCore.cs'].map((file) => join(src, file)), src);
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

// B14-q-a3-3b-2 SAME_USER_SMOKE: IssuerServer = the 3a pipe policy + RunAsClient + the 3b-1 adapter + the a3-2 core, as an
// independent server process. The synthetic SIDs are canonical but nobody's; an allow reached with receiver = the current
// user only checks the path and is never evidence for a protected principal. Late bytes on a live pipe are observed here.
describe('B14-q-a3-3b-2 issuer server over the pipe', () => {
  const fixture = smoke;
  const DEADLINE = 2000; // the plan's fixed per-connection deadline (not read from the C# source)
  const ajv = new Ajv2020({ allErrors: true });
  addFormats(ajv);
  const frameValid = ajv.compile(JSON.parse(readFileSync(new URL('../../../runtime/issuer/windows/contract/ipc-frame.schema.json', import.meta.url), 'utf8')));
  const serverFiles = ['host/IssuerServer.cs', 'host/IssuerPipe.cs', 'host/FrameAdapter.cs', 'core/IssuerCore.cs'];
  const n = (c) => c.repeat(32);
  const otherReceiver = 'S-1-5-21-1000-2000-3000-1001';
  const otherCaller = 'S-1-5-21-1000-2000-3000-1002';
  const issue = (extra = {}) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId: n('1'), epoch: n('0'), operation: 'issue',
    audience: 'peer-receiver/v1', receiverInstance: 'receiver-1', ...extra });
  const epochRequest = (requestId) => ({ schemaVersion: '1.0.0', kind: 'issuer-request', requestId, epoch: null, operation: 'epoch' });
  const frame = (value) => Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let dir;
  let server;
  let me;
  const running = new Set();
  const holders = new Set();
  const build = (name, sources, cwd) => buildTwice({ sources, references, cwd,
    out: join(dir, name, 'out', 'ags-issuer-server.exe'), keepDir: join(dir, name, 'keep') });
  // A test-only build of the server with some source lines replaced; never shipped and not a server option.
  function variant(name, changes) {
    const src = join(dir, name, 'src');
    mkdirSync(src, { recursive: true });
    for (const file of serverFiles) {
      let text = readFileSync(join(serverDir, file), 'utf8');
      for (const [from, to] of changes[file] ?? []) {
        assert.ok(text.includes(from), `${file} declares: ${from}`);
        text = text.replace(from, to);
      }
      writeFileSync(join(src, file.split('/').pop()), text);
    }
    return build(name, serverFiles.map((file) => join(src, file.split('/').pop())), src);
  }

  beforeAll(() => {
    if (!existsSync(compiler)) return;
    dir = mkdtempSync(join(tmpdir(), 'ags-b14qa33b2-'));
    me = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' }).stdout.trim().split(',').pop().replaceAll('"', '');
    assert.match(me, /^S-1-5-21-/);
    server = build('server', serverFiles.map((file) => join(serverDir, file)), serverDir);
  }, 120000);
  afterEach(async () => {
    for (const child of running) await halt(child);
    for (const holder of holders) await new Promise((resolve) => holder.close(resolve));
    holders.clear();
  });
  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  function launch(exe, name, receiver = me, caller = otherCaller) {
    const child = spawn(exe, [name, receiver, caller], { stdio: ['pipe', 'pipe', 'pipe'] });
    running.add(child);
    child.log = { out: '', err: '' };
    child.stderr.on('data', (data) => { child.log.err += data; });
    child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
    child.ready = new Promise((resolve) => {
      child.stdout.on('data', (data) => { child.log.out += data; if (child.log.out.includes('listening')) resolve('listening'); });
      child.on('exit', (code) => resolve(`exit ${code}`));
    });
    return child;
  }
  async function halt(child) {
    running.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 3000);
    await child.exited;
    clearTimeout(timer);
  }
  async function started(name, receiver, caller, exe = server.runs[0].path) {
    const child = launch(exe, name, receiver, caller);
    assert.equal(await child.ready, 'listening', child.log.err);
    return child;
  }
  // One stderr line per finished connection, and nothing but the enum and counters.
  async function lines(child, count, timeout = 8000) {
    const until = Date.now() + timeout;
    for (;;) {
      const done = child.log.err.split(/\r?\n/).filter(Boolean);
      if (done.length >= count || Date.now() > until) {
        assert.equal(done.length, count, child.log.err);
        return done.map((line) => {
          const m = /^outcome (response|close|fail-closed|timeout) end (client-closed|deadline|server-closed|cancel-stuck|revert-failed|accept-failed) core-calls (\d+) late-bytes (\d+)$/.exec(line);
          assert.ok(m, `stderr carries only the enum and counters: ${line}`);
          return { outcome: m[1], end: m[2], coreCalls: Number(m[3]), lateBytes: Number(m[4]) };
        });
      }
      await sleep(50);
    }
  }
  // A Node client: writes the chunks (pause between them), reads until the first LF, then closes at once ('now'),
  // keeps the pipe open ('open'), or never reads (read: false). `after` is written once the response has arrived.
  function talk(name, chunks, { pause = 0, read = true, close = 'now', after, wait = 6000 } = {}) {
    return new Promise((resolve) => {
      const begun = Date.now();
      const socket = net.connect(pipePath('.', name));
      let bytes = Buffer.alloc(0);
      let response;
      let finished = false;
      const finish = (why) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        socket.destroy();
        resolve({ why, response, bytes, elapsed: Date.now() - begun });
      };
      const timer = setTimeout(() => finish('client-wait-over'), wait);
      socket.on('error', (error) => finish(`error ${error.code}`));
      socket.on('end', () => finish('eof'));
      socket.on('connect', async () => {
        if (!read) socket.pause();
        for (const [i, chunk] of chunks.entries()) {
          if (i > 0 && pause) await sleep(pause);
          if (!finished) socket.write(chunk);
        }
      });
      socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        const lf = bytes.indexOf(0x0a);
        if (lf >= 0 && response === undefined) {
          response = JSON.parse(bytes.subarray(0, lf).toString('utf8'));
          if (after) socket.write(after);
          if (close === 'now') finish('closed-by-client');
        }
      });
    });
  }
  // A server-side DisconnectNamedPipe reaches a Node client as EOF or as EPIPE.
  const serverClosed = (result) => result.why === 'eof' || result.why === 'error EPIPE';
  async function epochOf(name, requestId) {
    const result = await talk(name, [frame(epochRequest(requestId))]);
    assert.ok(result.response && frameValid(result.response), JSON.stringify(result));
    assert.equal(result.response.status, 'ok');
    return result.response.epoch;
  }
  const probe = (path) => new Promise((resolve) => {
    const socket = net.connect(path);
    const timer = setTimeout(() => { socket.destroy(); resolve({ ok: false, code: 'TIMEOUT' }); }, 5000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve({ ok: true }); });
    socket.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, code: error.code, errno: error.errno }); });
  });
  function powershellClient(name, level, request) {
    const script = `$ErrorActionPreference = 'Stop'; $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeDirection]::InOut, [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::${level}); $c.Connect(5000); $b = [Text.Encoding]::UTF8.GetBytes('${JSON.stringify(request)}' + [char]10); $c.Write($b, 0, $b.Length); $c.Flush(); $r = New-Object System.IO.StreamReader($c); $line = $r.ReadLine(); $c.Dispose(); if ($null -eq $line) { 'NO-RESPONSE' } else { $line }`;
    const result = spawnSync(join(winPs, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, PSModulePath: join(winPs, 'Modules') } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  function daclOf(name) {
    const script = `$ErrorActionPreference = 'Stop'; $c = New-Object System.IO.Pipes.NamedPipeClientStream('.', '${name}', [System.IO.Pipes.PipeAccessRights]'ReadData, ReadPermissions', [System.IO.Pipes.PipeOptions]::None, [System.Security.Principal.TokenImpersonationLevel]::Identification, [System.IO.HandleInheritability]::None); $c.Connect(5000); $sddl = $c.GetAccessControl().GetSecurityDescriptorSddlForm('Access'); $c.Dispose(); $raw = New-Object System.Security.AccessControl.RawSecurityDescriptor($sddl); ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ sddl = $sddl; aces = @($raw.DiscretionaryAcl | ForEach-Object { [pscustomobject]@{ type = [string]$_.AceType; sid = $_.SecurityIdentifier.Value } }) })`;
    const result = spawnSync(join(winPs, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, PSModulePath: join(winPs, 'Modules') } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  }

  fixture('(1) allowed-SID mismatch: a peer whose token SID is not the recorded receiver gets peer-identity-rejected', async () => {
    const name = uniqueName('b2-mismatch');
    const child = await started(name, otherReceiver, otherCaller);
    const epoch = await epochOf(name, n('a'));
    const result = await talk(name, [frame(issue({ requestId: n('b'), epoch }))]);
    assert.ok(frameValid(result.response), JSON.stringify(result));
    assert.deepEqual([result.response.status, result.response.error?.code], ['rejected', 'peer-identity-rejected']);
    assert.deepEqual((await lines(child, 2)).map((line) => line.coreCalls), [1, 1]);
  });

  fixture('(2) replay: the same requestId on a second connection is refused', async () => {
    const name = uniqueName('b2-replay');
    const child = await started(name);
    const epoch = await epochOf(name, n('a'));
    const first = await talk(name, [frame(issue({ requestId: n('c'), epoch }))]);
    const again = await talk(name, [frame(issue({ requestId: n('c'), epoch }))]);
    assert.deepEqual([first.response?.status, first.response?.error?.code], ['unavailable', 'service-unavailable']);
    assert.deepEqual([again.response?.status, again.response?.error?.code], ['rejected', 'replay']);
    await lines(child, 3);
  });

  fixture('(3) each start has its own epoch and an epoch from before a restart is refused', async () => {
    const name = uniqueName('b2-epoch');
    const first = await started(name);
    const before = await epochOf(name, n('a'));
    await halt(first);
    await started(name);
    const after = await epochOf(name, n('b'));
    assert.notEqual(before, after);
    const result = await talk(name, [frame(issue({ requestId: n('c'), epoch: before }))]);
    assert.deepEqual([result.response?.status, result.response?.error?.code], ['rejected', 'epoch-mismatch']);
  });

  fixture('(4) r51 on the OS path: the caller gets no peer-receiver/v1, and resource-caller/v1 is refused before a receiving principal is bound', async () => {
    const name = uniqueName('b2-r51');
    const child = await started(name, otherReceiver, me);
    const epoch = await epochOf(name, n('a'));
    const receiverAudience = await talk(name, [frame(issue({ requestId: n('b'), epoch }))]);
    const resourceAudience = await talk(name, [frame(issue({ requestId: n('c'), epoch, audience: 'resource-caller/v1' }))]);
    assert.deepEqual([receiverAudience.response?.status, receiverAudience.response?.error?.code], ['rejected', 'peer-identity-rejected']);
    assert.deepEqual([resourceAudience.response?.status, resourceAudience.response?.error?.code], ['rejected', 'audience-mismatch']);
    await halt(child);
    await started(name);
    const epoch2 = await epochOf(name, n('d'));
    const asReceiver = await talk(name, [frame(issue({ requestId: n('e'), epoch: epoch2, audience: 'resource-caller/v1' }))]);
    assert.deepEqual([asReceiver.response?.status, asReceiver.response?.error?.code], ['rejected', 'audience-mismatch']);
  });

  fixture('(5) RunAsClient: an Anonymous-level client gets no response and no core call; an Identification-level client is served', async () => {
    const name = uniqueName('b2-level');
    const child = await started(name);
    assert.equal(powershellClient(name, 'Anonymous', epochRequest(n('a'))), 'NO-RESPONSE');
    const identified = JSON.parse(powershellClient(name, 'Identification', epochRequest(n('b'))));
    assert.ok(frameValid(identified));
    assert.equal(identified.status, 'ok');
    const seen = await lines(child, 2);
    assert.deepEqual([seen[0].outcome, seen[0].coreCalls], ['fail-closed', 0]);
    assert.deepEqual([seen[1].outcome, seen[1].coreCalls], ['response', 1]);
  });

  fixture('(6) epoch is schema-valid ok and an allowed issue is schema-valid unavailable with no credential', async () => {
    const name = uniqueName('b2-schema');
    await started(name);
    const epoch = await epochOf(name, n('a'));
    const result = await talk(name, [frame(issue({ requestId: n('b'), epoch }))]);
    assert.ok(frameValid(result.response), JSON.stringify(frameValid.errors));
    assert.deepEqual([result.response.status, result.response.error.code, 'credential' in result.response], ['unavailable', 'service-unavailable', false]);
    assert.ok(!/credential|grant|receiverSid|S-1-/.test(result.bytes.toString('utf8')));
  });

  fixture('(7)/T5 one request per connection: a frame sent after the response gets no core call and no second response', async () => {
    const name = uniqueName('b2-one');
    const child = await started(name);
    const result = await talk(name, [frame(epochRequest(n('a')))], { close: 'open', after: frame(epochRequest(n('b'))) });
    assert.equal(result.response?.status, 'ok');
    assert.equal(result.bytes.toString('utf8').split('\n').length - 1, 1, 'exactly one response line');
    const [line] = await lines(child, 1);
    assert.deepEqual([line.outcome, line.end, line.coreCalls], ['response', 'deadline', 1]);
    assert.ok(line.lateBytes > 0);
  });

  fixture('T1 an idle client is closed at the deadline and the next client is served', async () => {
    const name = uniqueName('b2-idle');
    const child = await started(name);
    const idle = await talk(name, [], { close: 'open' });
    assert.equal(idle.response, undefined);
    assert.ok(serverClosed(idle) && idle.elapsed >= DEADLINE - 500 && idle.elapsed <= DEADLINE + 1500, JSON.stringify(idle));
    await epochOf(name, n('a'));
    const seen = await lines(child, 2);
    assert.deepEqual([seen[0].outcome, seen[0].end, seen[0].coreCalls], ['timeout', 'deadline', 0]);
  });

  fixture('T2 pieces inside the deadline are one frame; pieces past it time out with no core call', async () => {
    const name = uniqueName('b2-pieces');
    const child = await started(name);
    const whole = frame(epochRequest(n('a')));
    const inside = await talk(name, [whole.subarray(0, 20), whole.subarray(20)], { pause: 300 });
    assert.equal(inside.response?.status, 'ok');
    const late = await talk(name, [whole.subarray(0, 20), whole.subarray(20)], { pause: DEADLINE + 500, close: 'open' });
    assert.equal(late.response, undefined);
    const seen = await lines(child, 2);
    assert.deepEqual([seen[1].outcome, seen[1].coreCalls], ['timeout', 0]);
  });

  fixture('T3 exactly 4096 bytes with the LF is served; 4097 bytes are closed with no core call', async () => {
    const name = uniqueName('b2-size');
    const child = await started(name);
    const body = JSON.stringify(epochRequest(n('a')));
    const padded = (total) => Buffer.from(`${body}${' '.repeat(total - Buffer.byteLength(body) - 1)}\n`);
    assert.equal((await talk(name, [padded(4096)])).response?.status, 'ok');
    const over = await talk(name, [padded(4097)], { close: 'open' });
    assert.equal(over.response, undefined);
    const seen = await lines(child, 2);
    assert.deepEqual([seen[1].outcome, seen[1].coreCalls], ['close', 0]);
  });

  fixture('T4 two frames in one write are closed with no core call and no response', async () => {
    const name = uniqueName('b2-coalesced');
    const child = await started(name);
    const result = await talk(name, [Buffer.concat([frame(epochRequest(n('a'))), frame(epochRequest(n('b')))])], { close: 'open' });
    assert.equal(result.response, undefined);
    const [line] = await lines(child, 1);
    assert.deepEqual([line.outcome, line.coreCalls], ['close', 0]);
  });

  fixture('T6 a client that never reads is disconnected at the deadline (consumption not observed) and the next client is served', async () => {
    const name = uniqueName('b2-noread');
    const child = await started(name);
    const quiet = await talk(name, [frame(epochRequest(n('a')))], { read: false, close: 'open', wait: DEADLINE + 1500 });
    assert.equal(quiet.response, undefined);
    const next = Date.now();
    await epochOf(name, n('b'));
    assert.ok(Date.now() - next < 1000);
    const seen = await lines(child, 2);
    assert.deepEqual([seen[0].outcome, seen[0].end, seen[0].coreCalls], ['response', 'deadline', 1]);
  });

  fixture('B1 a client that closes on the LF response ends the connection at once; the next client is served within 1000 ms', async () => {
    const name = uniqueName('b2-b1');
    const child = await started(name);
    const begun = Date.now();
    const result = await talk(name, [frame(epochRequest(n('a')))]);
    assert.ok(frameValid(result.response));
    await epochOf(name, n('b'));
    assert.ok(Date.now() - begun < 1000, `${Date.now() - begun} ms`);
    const seen = await lines(child, 2);
    assert.deepEqual([seen[0].outcome, seen[0].end], ['response', 'client-closed']);
  });

  fixture('B2 a client that keeps the pipe open after the response is closed at the deadline, not counted as a normal close', async () => {
    const name = uniqueName('b2-b2');
    const child = await started(name);
    const result = await talk(name, [frame(epochRequest(n('a')))], { close: 'open' });
    assert.ok(frameValid(result.response));
    assert.ok(serverClosed(result) && result.elapsed >= DEADLINE - 500 && result.elapsed <= DEADLINE + 1500, JSON.stringify(result));
    const [line] = await lines(child, 1);
    assert.deepEqual([line.outcome, line.end], ['response', 'deadline']);
  });

  fixture('T8 a client that connects and leaves at once, even before the first accept, does not stop the server', async () => {
    const exits = [];
    for (let i = 0; i < 20; i++) {
      const name = uniqueName(`b2-leave${i}`);
      const child = launch(server.runs[0].path, name);
      await child.ready;
      await probe(pipePath('.', name));
      await sleep(150);
      exits.push(child.exitCode);
      if (i === 19) assert.ok((await epochOf(name, n('a'))).length === 32);
      await halt(child);
    }
    assert.deepEqual(exits.filter((code) => code !== null), [], JSON.stringify(exits));
  }, 60000);

  fixture('F1 FIXTURE: when a cancelled I/O is not seen to complete, the server stops without reusing anything (test-only build)', async () => {
    const stuck = variant('stuck', { 'host/IssuerServer.cs': [['bool cancelled = ev.WaitOne(CancelGraceMs);', 'bool cancelled = false;']] });
    const name = uniqueName('b2-stuck');
    const child = await started(name, me, otherCaller, stuck.runs[0].path);
    await talk(name, [], { close: 'open' });
    assert.equal(await child.exited, 5);
    assert.deepEqual((await lines(child, 1)).map((line) => line.end), ['cancel-stuck']);
    assert.equal((await probe(pipePath('.', name))).code, 'ENOENT');
  }, 120000);

  fixture('F2 FIXTURE: when impersonation cannot be reverted, the server stops at once (test-only build)', async () => {
    const stuck = variant('revert', { 'host/IssuerServer.cs': [['if (!RevertToSelf()) Stop(', 'if (RevertToSelf()) Stop(']] });
    const name = uniqueName('b2-revert');
    const child = await started(name, me, otherCaller, stuck.runs[0].path);
    await talk(name, [frame(epochRequest(n('a')))], { close: 'open' });
    assert.equal(await child.exited, 6);
    assert.deepEqual((await lines(child, 1)).map((line) => line.end), ['revert-failed']);
    assert.equal((await probe(pipePath('.', name))).code, 'ENOENT');
  }, 120000);

  fixture('3a on the server exe: held name, DACL, forbidden or equal SIDs, loopback refused and the REJECT bit decides it', async (ctx) => {
    const held = uniqueName('b2-held');
    const holder = net.createServer((socket) => socket.end());
    holders.add(holder);
    await new Promise((resolve) => holder.listen(pipePath('.', held), resolve));
    const squatted = launch(server.runs[0].path, held);
    assert.equal(await squatted.ready, 'exit 3');
    assert.match(squatted.log.err, /create-failed 5\b/);
    for (const [receiver, caller] of [['S-1-1-0', otherCaller], [me, 'S-1-5-7'], [me, me], ['S-1-5-21-1000-2000-3000-01', otherCaller]]) {
      const refused = launch(server.runs[0].path, uniqueName('b2-badsid'), receiver, caller);
      assert.equal(await refused.ready, 'exit 2', `${receiver} ${caller}`);
    }
    const name = uniqueName('b2-dacl');
    await started(name, otherReceiver, me);
    const dacl = daclOf(name);
    const sids = dacl.aces.map((ace) => ace.sid);
    assert.ok(!sids.includes('S-1-1-0') && !sids.includes('S-1-5-7'), dacl.sddl);
    assert.match(dacl.sddl, /^D:P/);
    assert.equal(`${dacl.aces[0].type} ${dacl.aces[0].sid}`, 'AccessDenied S-1-5-2');
    assert.ok(sids.every((sid) => ['S-1-5-2', 'S-1-5-18', me, otherReceiver].includes(sid)) && sids.includes(otherReceiver), dacl.sddl);
    const observations = { dacl: dacl.sddl, loopback: await probe(pipePath('localhost', name)), local: await probe(pipePath('.', name)) };
    for (const [label, bit] of [['serverRejectOff', '0x0u'], ['serverRejectOn', '0x8u']]) {
      const control = variant(label, { 'host/IssuerPipe.cs': [['const string DenyNetwork = "(D;;GA;;;NU)";', 'const string DenyNetwork = "";'], ['const uint RejectRemoteClients = 0x8u;', `const uint RejectRemoteClients = ${bit};`]] });
      const controlName = uniqueName(label);
      const controlChild = await started(controlName, me, otherCaller, control.runs[0].path);
      // The single instance is busy until the server has finished a connection, so probe again only after its line
      // (a real request always ends with one; a client that leaves before the accept is dropped without a line).
      const local = { ok: (await epochOf(controlName, n('f'))).length === 32 };
      await lines(controlChild, 1);
      observations[label] = { sha256: control.runs[0].sha256, local, loopback: await probe(pipePath('localhost', controlName)) };
    }
    console.log(JSON.stringify({ check: 'b2-server-3a', ...observations }));
    assert.equal(observations.loopback.ok, false);
    assert.equal(observations.local.ok, true);
    if (!observations.serverRejectOff.loopback.ok) { console.log('NOT_RUN: the same DACL with the REJECT bit off is refused too'); ctx.skip(); }
    assert.equal(observations.serverRejectOn.loopback.ok, false);
  }, 180000);
});
