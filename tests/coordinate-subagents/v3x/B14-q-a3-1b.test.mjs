import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, test, vi } from 'vitest';
import { buildTwice, compareBuilds, inputOf, verifyToolchain } from '../../../runtime/issuer/windows/build/csc-build.mjs';

// B14-q-a3-1b: FIXTURE refutations plus SAME_USER_SMOKE builds on the isolated Roslyn when this host has it.
// spawnSync is wrapped (still real) so every test can count compiler calls. Throwaway copies live under
// os.tmpdir() (prefix ags-b14qa31-) and are deleted in finally.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});
const { spawnSync: realSpawnSync } = await vi.importActual('node:child_process');
const spawnSpy = vi.mocked(childProcess.spawnSync);
const compilerCalls = () => spawnSpy.mock.calls.filter(([command]) => /(csc|vbc)\.exe$/i.test(String(command))).length;
beforeEach(() => { spawnSpy.mockReset(); spawnSpy.mockImplementation(realSpawnSync); });

const buildDir = new URL('../../../runtime/issuer/windows/build/', import.meta.url);
const lock = JSON.parse(readFileSync(new URL('roslyn.lock.json', buildDir), 'utf8'));
const toolchain = 'D:/codex/거버전스 3.0/ags-toolchain/roslyn';
const winPs = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0';
const coreModules = 'C:\\Program Files\\PowerShell\\7\\Modules';
const inBoxCsc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const mscorlib = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const program = 'class P { static void Main() { System.Console.WriteLine("ags"); } }\n';

async function inTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ags-b14qa31-'));
  try { return await run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function fixtureToolchain(root) {
  const files = { 'package/tasks/net472/csc.exe': Buffer.from('MZ fixture compiler') };
  const nupkg = Buffer.from('fixture nupkg');
  mkdirSync(join(root, '5.9.0', 'package', 'tasks', 'net472'), { recursive: true });
  writeFileSync(join(root, '5.9.0', 'fixture.nupkg'), nupkg);
  for (const [path, bytes] of Object.entries(files)) writeFileSync(join(root, '5.9.0', path), bytes);
  return { ...lock, nupkg: { ...lock.nupkg, file: 'fixture.nupkg', sha512: sha512(nupkg) },
    files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes), authenticode: lock.files[lock.compiler].authenticode }])) };
}
// An attacker toolchain: the in-box csc copied into the NuGet layout with a lock that agrees with it in every field.
function inBoxCopyToolchain(root) {
  const csc = join(root, lock.version, lock.compiler);
  mkdirSync(join(csc, '..'), { recursive: true });
  copyFileSync(inBoxCsc, csc);
  writeFileSync(join(root, lock.version, 'fixture.nupkg'), 'fixture nupkg');
  const script = `$s = Get-AuthenticodeSignature -LiteralPath '${csc}'; [pscustomobject]@{ status = [string]$s.Status; signer = $s.SignerCertificate.Subject } | ConvertTo-Json -Compress`;
  const signature = JSON.parse(realSpawnSync(join(winPs, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', env: { ...process.env, PSModulePath: join(winPs, 'Modules') } }).stdout);
  return { ...lock, nupkg: { ...lock.nupkg, file: 'fixture.nupkg', sha512: sha512(Buffer.from('fixture nupkg')) },
    files: { [lock.compiler]: { sha256: sha256(readFileSync(csc)), authenticode: signature } } };
}
const request = (dir, extra = {}) => ({ sources: [join(dir, 'P.cs')], references: [mscorlib], cwd: dir, out: join(dir, 'out', 'P.exe'), keepDir: join(dir, 'keep'), ...extra });
const signedFiles = Object.keys(lock.files).filter((path) => lock.files[path].authenticode);

test('B14-q-a3-1b (1b) the lock check refuses a compiler that differs from the lock by one byte', () => inTemp((dir) => {
  const fixtureLock = fixtureToolchain(join(dir, 'roslyn'));
  const csc = join(dir, 'roslyn', '5.9.0', fixtureLock.compiler);
  const bytes = readFileSync(csc);
  bytes[0] ^= 1;
  writeFileSync(csc, bytes);
  assert.throws(() => verifyToolchain({ root: join(dir, 'roslyn'), lock: fixtureLock }), /csc\.exe does not match the lock/);
}));

test('B14-q-a3-1b (2) a PATH or in-box compiler is refused before any compiler runs', () => inTemp((dir) => {
  writeFileSync(join(dir, 'P.cs'), program);
  for (const compiler of ['csc.exe', 'csc', inBoxCsc, 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe']) {
    assert.throws(() => buildTwice({ compiler, ...request(dir) }), /callers cannot pass compiler/, compiler);
  }
  // A lock whose compiler entry is not one of its hashed, signed files is refused by the lock check too.
  assert.throws(() => verifyToolchain({ root: toolchain, lock: { ...lock, compiler: '../../../../Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' } }), /compiler/);
  assert.equal(compilerCalls(), 0);
}));

// F1: the build uses only the committed lock and the approved root; a caller's lock or root never reaches the compiler.
const callerLocks = {
  '(a) one signed entry dropped from the lock': () => ({ root: toolchain, lock: { ...lock, files: { ...lock.files, [signedFiles.find((path) => path !== lock.compiler)]: { sha256: lock.files[signedFiles.find((path) => path !== lock.compiler)].sha256 } } } }),
  '(b) the lock compiler switched to vbc.exe': () => ({ root: toolchain, lock: { ...lock, compiler: 'package/tasks/net472/vbc.exe' } }),
  '(c) an in-box csc copy in the NuGet layout with a matching lock': (dir) => ({ root: join(dir, 'attacker'), lock: inBoxCopyToolchain(join(dir, 'attacker')) }),
};
for (const [name, callerInput] of Object.entries(callerLocks)) {
  // (c) copies the real in-box csc, which exists only on Windows; (a) and (b) are refused before any file is read.
  const run = name.startsWith('(c)') && process.platform !== 'win32' ? test.skip : test;
  run(`B14-q-a3-1b (F1) ${name} is refused with no compiler call`, () => inTemp((dir) => {
    writeFileSync(join(dir, 'P.cs'), program);
    assert.throws(() => buildTwice({ ...callerInput(dir), ...request(dir) }), /callers cannot pass/);
    assert.equal(compilerCalls(), 0);
    assert.ok(!existsSync(join(dir, 'keep')) && !existsSync(join(dir, 'out', 'P.exe')), 'nothing is built');
  }), 60000);
}

test('B14-q-a3-1b (F1) a roslyn.lock.json beside the module that is not the committed lock is refused', () => inTemp(async (dir) => {
  writeFileSync(join(dir, 'P.cs'), program);
  for (const [name, changed] of Object.entries({ dropped: { ...lock, files: { ...lock.files, [signedFiles[1]]: { sha256: lock.files[signedFiles[1]].sha256 } } }, vbc: { ...lock, compiler: 'package/tasks/net472/vbc.exe' } })) {
    const copy = join(dir, name);
    mkdirSync(copy);
    for (const file of ['csc-build.mjs', 'fetch-roslyn.mjs']) copyFileSync(new URL(file, buildDir), join(copy, file));
    writeFileSync(join(copy, 'roslyn.lock.json'), `${JSON.stringify(changed, null, 2)}\n`);
    const { buildTwice: copiedBuild } = await import(pathToFileURL(join(copy, 'csc-build.mjs')).href);
    assert.throws(() => copiedBuild(request(dir)), /not the committed lock/, name);
  }
  assert.equal(compilerCalls(), 0);
  assert.ok(!existsSync(join(dir, 'keep')));
}));

test('B14-q-a3-1b (F3) a keepDir that already exists is refused and its earlier originals stay unchanged', () => inTemp((dir) => {
  writeFileSync(join(dir, 'P.cs'), program);
  const earlier = join(dir, 'keep', 'run-1', 'P.exe');
  mkdirSync(join(earlier, '..'), { recursive: true });
  writeFileSync(earlier, 'earlier original');
  assert.throws(() => buildTwice(request(dir)), /already exists/);
  assert.equal(sha256(readFileSync(earlier)), sha256(Buffer.from('earlier original')));
  assert.deepEqual(readdirSync(join(dir, 'keep'), { recursive: true }).sort(), ['run-1', join('run-1', 'P.exe')]);
  assert.equal(compilerCalls(), 0);
}));

test('B14-q-a3-1b (4) a one-byte source change or another /out name is not the same input', () => inTemp((dir) => {
  const fixtureLock = fixtureToolchain(join(dir, 'roslyn'));
  const csc = join(dir, 'roslyn', '5.9.0', fixtureLock.compiler);
  writeFileSync(join(dir, 'P.cs'), program);
  writeFileSync(join(dir, 'Q.cs'), program.replace('ags', 'agt'));
  // Fixture reference bytes keep this input check independent of the Windows framework directory.
  writeFileSync(join(dir, 'ref.dll'), 'fixture reference');
  const req = (extra = {}) => request(dir, { references: [join(dir, 'ref.dll')], ...extra });
  const base = inputOf({ compiler: csc, ...req() });
  const record = (input) => ({ input, sha256: 'a'.repeat(64) });
  assert.doesNotThrow(() => compareBuilds(record(base), record(inputOf({ compiler: csc, ...req() }))));
  const oneByte = inputOf({ compiler: csc, ...req({ sources: [join(dir, 'Q.cs')] }) });
  const sameNameOneByte = (() => { writeFileSync(join(dir, 'P.cs'), program.replace('ags', 'agt')); return inputOf({ compiler: csc, ...req() }); })();
  const otherOut = inputOf({ compiler: csc, ...req({ out: join(dir, 'out', 'Q.exe') }) });
  for (const other of [oneByte, sameNameOneByte, otherOut]) {
    assert.throws(() => compareBuilds(record(base), record(other)), /not the same input/);
  }
}));

const smoke = existsSync(join(toolchain, lock.version, lock.compiler)) ? test : test.skip;

// FIXTURE of the reported failure: an inherited module path whose Microsoft.PowerShell.Security 7.0.0 shadows the
// in-box one and yields an empty status (this host has no PowerShell 7 install; a real one is added when present).
smoke('B14-q-a3-1b SAME_USER_SMOKE: an inherited module path that shadows Microsoft.PowerShell.Security still reads the in-box Authenticode', () => inTemp((dir) => {
  const shadow = join(dir, 'Microsoft.PowerShell.Security', '7.0.0');
  mkdirSync(shadow, { recursive: true });
  writeFileSync(join(shadow, 'Microsoft.PowerShell.Security.psd1'), "@{ ModuleVersion = '7.0.0'; RootModule = 'shadow.psm1'; FunctionsToExport = @('Get-AuthenticodeSignature') }\n");
  writeFileSync(join(shadow, 'shadow.psm1'), "function Get-AuthenticodeSignature { param([string]$LiteralPath) [pscustomobject]@{ Status = ''; SignerCertificate = $null } }\n");
  const inherited = process.env.PSModulePath;
  process.env.PSModulePath = [dir, ...(existsSync(coreModules) ? [coreModules] : []), inherited ?? ''].join(';');
  try {
    assert.equal(verifyToolchain({ root: toolchain, lock }), join(toolchain, lock.version, lock.compiler));
  } finally {
    process.env.PSModulePath = inherited;
  }
  const [, , options] = spawnSpy.mock.calls.find(([command]) => /powershell\.exe$/i.test(command));
  const passed = Object.entries(options.env).filter(([name]) => name.toUpperCase() === 'PSMODULEPATH');
  assert.deepEqual(passed, [['PSModulePath', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')]]);
}), 60000);

// A failed or incomplete lookup is a lookup failure, never a signature verdict, and no compiler runs.
const rewrite = (real, change) => ({ ...real, stdout: JSON.stringify(change([JSON.parse(real.stdout)].flat())) });
const failedLookups = {
  'a nonzero exit': () => ({ pid: 0, output: [], status: 1, signal: null, stdout: '', stderr: 'lookup failed' }),
  'output that is not JSON': () => ({ pid: 0, output: [], status: 0, signal: null, stdout: 'not json', stderr: '' }),
  'the empty status a PowerShell 7 module gave': (real) => rewrite(real, (rows) => rows.map((row) => ({ ...row, status: '', signer: null }))),
  'a missing file': (real) => rewrite(real, (rows) => rows.slice(1)),
  'a duplicated file': (real) => rewrite(real, (rows) => [...rows, rows[0]]),
};
for (const [name, inject] of Object.entries(failedLookups)) {
  smoke(`B14-q-a3-1b SAME_USER_SMOKE: ${name} from the Authenticode lookup is refused as a lookup failure with no compiler call`, () => inTemp((dir) => {
    writeFileSync(join(dir, 'P.cs'), program);
    spawnSpy.mockImplementationOnce((command, args, options) => inject(realSpawnSync(command, args, options)));
    assert.throws(() => buildTwice(request(dir)), /Authenticode lookup failed/);
    assert.equal(compilerCalls(), 0);
    assert.ok(!existsSync(join(dir, 'keep')));
  }), 60000);
}

smoke('B14-q-a3-1b SAME_USER_SMOKE: two /deterministic builds of the same input match, both originals stay, and a reused keepDir is refused', () => inTemp((dir) => {
  writeFileSync(join(dir, 'P.cs'), program);
  const result = buildTwice(request(dir));
  assert.equal(result.runs.length, 2);
  assert.ok(result.runs.every((run) => existsSync(run.path) && sha256(readFileSync(run.path)) === run.sha256));
  assert.notEqual(result.runs[0].path, result.runs[1].path);
  assert.equal(result.runs[0].sha256, result.runs[1].sha256);
  assert.ok(result.args.includes('/deterministic+'));
  assert.equal(compilerCalls(), 2);
  // Reusing the same keepDir is refused and both originals keep their bytes.
  assert.throws(() => buildTwice(request(dir)), /already exists/);
  assert.ok(result.runs.every((run) => sha256(readFileSync(run.path)) === run.sha256));
  assert.equal(compilerCalls(), 2);
  // A valid lookup whose subject differs from the lock is a signature mismatch.
  const signed = signedFiles.find((path) => path !== lock.compiler);
  const tampered = { ...lock, files: { ...lock.files, [signed]: { ...lock.files[signed], authenticode: { status: 'Valid', signer: 'CN=Someone, O=Microsoft Corporation' } } } };
  assert.throws(() => verifyToolchain({ root: toolchain, lock: tampered }), /Authenticode differs from the lock/);
}), 120000);
