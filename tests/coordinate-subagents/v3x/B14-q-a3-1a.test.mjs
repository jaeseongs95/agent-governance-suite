import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { verifyRoslyn } from '../../../runtime/issuer/windows/build/fetch-roslyn.mjs';

// B14-q-a3-1a: the lock pins one isolated Roslyn. These tests use FIXTURE files in a throwaway
// os.tmpdir() copy (prefix ags-b14qa31-) and delete it in finally; the real toolchain is observed in the evidence.
const lock = JSON.parse(readFileSync(new URL('../../../runtime/issuer/windows/build/roslyn.lock.json', import.meta.url), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sha512 = (bytes) => createHash('sha512').update(bytes).digest('base64');

function withFixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'ags-b14qa31-'));
  try {
    const files = { 'package/tasks/net472/csc.exe': Buffer.from('MZ fixture compiler'), 'package/tasks/net472/csc.exe.config': Buffer.from('<configuration/>') };
    const nupkg = Buffer.from('fixture nupkg');
    const dir = join(root, '5.9.0');
    for (const [path, bytes] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true });
      writeFileSync(join(dir, path), bytes);
    }
    writeFileSync(join(dir, 'fixture.nupkg'), nupkg);
    const fixtureLock = { package: 'Microsoft.Net.Compilers.Toolset', version: '5.9.0', compiler: 'package/tasks/net472/csc.exe',
      nupkg: { file: 'fixture.nupkg', sha512: sha512(nupkg) },
      files: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, { sha256: sha256(bytes) }])) };
    return run({ root, dir, fixtureLock });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('B14-q-a3-1a the committed lock pins exactly Microsoft.Net.Compilers.Toolset 5.9.0 from nuget.org', () => {
  assert.equal(lock.package, 'Microsoft.Net.Compilers.Toolset');
  assert.equal(lock.version, '5.9.0');
  assert.equal(lock.source, 'https://api.nuget.org/v3-flatcontainer/microsoft.net.compilers.toolset/5.9.0/microsoft.net.compilers.toolset.5.9.0.nupkg');
  assert.equal(lock.compiler, 'package/tasks/net472/csc.exe');
  assert.match(lock.nupkg.sha512, /^[A-Za-z0-9+/]{86}==$/);
  assert.equal(lock.nupkg.sha512, lock.nupkg.publishedSha512, 'the download must match the hash nuget.org publishes');
  const entries = Object.entries(lock.files);
  assert.ok(entries.length > 10 && entries.every(([, file]) => /^[0-9a-f]{64}$/.test(file.sha256)));
  const pe = entries.filter(([, file]) => file.authenticode);
  assert.ok(pe.some(([path]) => path === lock.compiler), 'the compiler is a signed PE file');
  for (const [path, file] of pe) {
    assert.equal(file.authenticode.status, 'Valid', path);
    assert.match(file.authenticode.signer, /O=Microsoft Corporation/, path);
  }
});

test('B14-q-a3-1a verification accepts only files that match the lock byte for byte', () => {
  withFixture(({ root, dir, fixtureLock }) => {
    assert.equal(verifyRoslyn({ root, version: '5.9.0', lock: fixtureLock }), join(dir, 'package/tasks/net472/csc.exe'));
    // (1) A compiler copy that differs from the lock by one byte is refused.
    const csc = join(dir, 'package/tasks/net472/csc.exe');
    const bytes = readFileSync(csc);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(csc, bytes);
    assert.throws(() => verifyRoslyn({ root, version: '5.9.0', lock: fixtureLock }), /csc\.exe/);
  });
});

test('B14-q-a3-1a verification refuses a version the lock does not pin', () => {
  withFixture(({ root, dir, fixtureLock }) => {
    // (3) The same bytes under another version folder, or a lock for another version, are refused.
    cpSync(dir, join(root, '5.8.0'), { recursive: true });
    assert.throws(() => verifyRoslyn({ root, version: '5.8.0', lock: fixtureLock }), /5\.8\.0/);
    assert.throws(() => verifyRoslyn({ root, version: '5.9.0', lock: { ...fixtureLock, version: '5.9.1' } }));
    assert.throws(() => verifyRoslyn({ root, version: 'latest', lock: fixtureLock }));
  });
});

test('B14-q-a3-1a verification refuses extra, missing or re-hashed package files', () => {
  withFixture(({ root, dir, fixtureLock }) => {
    writeFileSync(join(dir, 'package/tasks/net472/extra.dll'), 'MZ planted');
    assert.throws(() => verifyRoslyn({ root, version: '5.9.0', lock: fixtureLock }), /extra\.dll/);
  });
  withFixture(({ root, dir, fixtureLock }) => {
    rmSync(join(dir, 'package/tasks/net472/csc.exe.config'));
    assert.throws(() => verifyRoslyn({ root, version: '5.9.0', lock: fixtureLock }), /csc\.exe\.config/);
  });
  withFixture(({ root, dir, fixtureLock }) => {
    writeFileSync(join(dir, 'fixture.nupkg'), 'another nupkg');
    assert.throws(() => verifyRoslyn({ root, version: '5.9.0', lock: fixtureLock }), /nupkg/);
  });
});
