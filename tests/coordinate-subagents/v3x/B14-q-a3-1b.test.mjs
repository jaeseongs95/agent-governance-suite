import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { buildTwice, compareBuilds, inputOf } from '../../../runtime/issuer/windows/build/csc-build.mjs';

// B14-q-a3-1b: FIXTURE refutations plus one SAME_USER_SMOKE double build on the isolated Roslyn when this
// host has it. Throwaway copies live under os.tmpdir() (prefix ags-b14qa31-) and are deleted in finally.
const lock = JSON.parse(readFileSync(new URL('../../../runtime/issuer/windows/build/roslyn.lock.json', import.meta.url), 'utf8'));
const toolchain = 'D:/codex/거버전스 3.0/ags-toolchain/roslyn';
const inBoxCsc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const mscorlib = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');
const program = 'class P { static void Main() { System.Console.WriteLine("ags"); } }\n';

function inTemp(run) {
  const dir = mkdtempSync(join(tmpdir(), 'ags-b14qa31-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
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
const request = (dir, extra = {}) => ({ sources: [join(dir, 'P.cs')], references: [mscorlib], cwd: dir, out: join(dir, 'out', 'P.exe'), keepDir: join(dir, 'keep'), ...extra });

test('B14-q-a3-1b (1b) a compiler that differs from the lock by one byte is refused before building', () => {
  inTemp((dir) => {
    const fixtureLock = fixtureToolchain(join(dir, 'roslyn'));
    writeFileSync(join(dir, 'P.cs'), program);
    const csc = join(dir, 'roslyn', '5.9.0', 'package', 'tasks', 'net472', 'csc.exe');
    const bytes = readFileSync(csc);
    bytes[0] ^= 1;
    writeFileSync(csc, bytes);
    assert.throws(() => buildTwice({ root: join(dir, 'roslyn'), lock: fixtureLock, ...request(dir) }), /csc\.exe does not match the lock/);
    assert.ok(!existsSync(join(dir, 'keep')), 'nothing is built');
  });
});

test('B14-q-a3-1b (2) a PATH or in-box compiler is refused', () => {
  inTemp((dir) => {
    writeFileSync(join(dir, 'P.cs'), program);
    for (const compiler of ['csc.exe', 'csc', inBoxCsc, 'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe']) {
      assert.throws(() => buildTwice({ root: toolchain, lock, compiler, ...request(dir) }), /lock-verified/, compiler);
    }
    // A lock whose compiler entry is not one of its hashed, signed files is refused too.
    assert.throws(() => buildTwice({ root: toolchain, lock: { ...lock, compiler: '../../../../Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe' }, ...request(dir) }), /compiler/);
  });
});

test('B14-q-a3-1b (4) a one-byte source change or another /out name is not the same input', () => {
  inTemp((dir) => {
    const fixtureLock = fixtureToolchain(join(dir, 'roslyn'));
    const csc = join(dir, 'roslyn', '5.9.0', fixtureLock.compiler);
    writeFileSync(join(dir, 'P.cs'), program);
    writeFileSync(join(dir, 'Q.cs'), program.replace('ags', 'agt'));
    const base = inputOf({ compiler: csc, ...request(dir) });
    const record = (input) => ({ input, sha256: 'a'.repeat(64) });
    assert.doesNotThrow(() => compareBuilds(record(base), record(inputOf({ compiler: csc, ...request(dir) }))));
    const oneByte = inputOf({ compiler: csc, ...request(dir, { sources: [join(dir, 'Q.cs')] }) });
    const sameNameOneByte = (() => { writeFileSync(join(dir, 'P.cs'), program.replace('ags', 'agt')); return inputOf({ compiler: csc, ...request(dir) }); })();
    const otherOut = inputOf({ compiler: csc, ...request(dir, { out: join(dir, 'out', 'Q.exe') }) });
    for (const other of [oneByte, sameNameOneByte, otherOut]) {
      assert.throws(() => compareBuilds(record(base), record(other)), /not the same input/);
    }
  });
});

const smoke = existsSync(join(toolchain, lock.version, lock.compiler)) ? test : test.skip;
smoke('B14-q-a3-1b SAME_USER_SMOKE: two /deterministic builds of the same input match and both originals stay', () => {
  inTemp((dir) => {
    writeFileSync(join(dir, 'P.cs'), program);
    const result = buildTwice({ root: toolchain, lock, ...request(dir) });
    assert.equal(result.runs.length, 2);
    assert.ok(result.runs.every((run) => existsSync(run.path) && sha256(readFileSync(run.path)) === run.sha256));
    assert.notEqual(result.runs[0].path, result.runs[1].path);
    assert.equal(result.runs[0].sha256, result.runs[1].sha256);
    assert.ok(result.args.includes('/deterministic+'));
    // A lock that records another signer subject for one signed file is refused before building.
    const signed = Object.keys(lock.files).find((path) => lock.files[path].authenticode && path !== lock.compiler);
    const tampered = { ...lock, files: { ...lock.files, [signed]: { ...lock.files[signed], authenticode: { status: 'Valid', signer: 'CN=Someone, O=Microsoft Corporation' } } } };
    assert.throws(() => buildTwice({ root: toolchain, lock: tampered, ...request(dir, { keepDir: join(dir, 'keep2') }) }), /Authenticode/);
    assert.ok(!existsSync(join(dir, 'keep2')));
  });
}, 120000);
