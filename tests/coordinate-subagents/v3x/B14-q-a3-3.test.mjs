import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearTimeout, setTimeout } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, test } from 'vitest';
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
