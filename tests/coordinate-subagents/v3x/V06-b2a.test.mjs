import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { archiveDigestFromSignedChecksums, inspectPackage, releaseId,
  verifyArchiveBytes, verifyNodeRelease, verifyPinnedKeyring } from '../../../scripts/qualification/v06-b2a-windows-stage.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');

test('release ID binds exact Node version, signed archive digest and AGS manifest digest', () => {
  const first = releaseId('24.19.0', 'a'.repeat(64), 'b'.repeat(64));
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, releaseId('24.19.1', 'a'.repeat(64), 'b'.repeat(64)));
  assert.notEqual(first, releaseId('24.19.0', 'c'.repeat(64), 'b'.repeat(64)));
  assert.notEqual(first, releaseId('24.19.0', 'a'.repeat(64), 'c'.repeat(64)));
  assert.throws(() => releaseId('23.9.0', 'a'.repeat(64), 'b'.repeat(64)), /Node >=24/);
  assert.throws(() => releaseId('24.19.0-extra', 'a'.repeat(64), 'b'.repeat(64)));
});

test('only the exact signed checksum entry and matching archive bytes pass the digest step', () => {
  const bytes = Buffer.from('test-only archive bytes');
  const line = `${sha(bytes)}  node-v24.19.0-win-x64.zip`;
  assert.equal(archiveDigestFromSignedChecksums(`${line}\n`, '24.19.0'), sha(bytes));
  assert.equal(verifyArchiveBytes(`${line}\n`, '24.19.0', bytes), sha(bytes));
  assert.throws(() => verifyArchiveBytes(`${line}\n`, '24.19.0', Buffer.from('tampered')), /archive digest mismatch/);
  assert.throws(() => archiveDigestFromSignedChecksums(`${line}\n`, '24.20.0'), /missing/);
  assert.throws(() => archiveDigestFromSignedChecksums(`${line}\n${line}\n`, '24.19.0'), /duplicated/);
  assert.throws(() => verifyPinnedKeyring(Buffer.from('untrusted key')), /untrusted release keyring/);
});

test('staged package requires the precise manifest file set and artifact bytes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b2a-test-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
  const root = path.join(dir, 'package');
  mkdirSync(root);
  try {
    const script = Buffer.from('test-only module bytes');
    const manifest = {
      format: 'agent-governance-suite.host-integration.v1',
      artifacts: [{ path: 'app/entry.mjs', sha256: `sha256:${sha(script)}` }],
      entryPoints: ['mcp-server', 'scope-baseline', 'scope-compare', 'acceptance-cli']
        .map((id) => ({ id, path: 'app/entry.mjs', executionClosure: ['app/entry.mjs'] })),
    };
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    mkdirSync(path.join(root, 'app'));
    writeFileSync(path.join(root, 'app', 'entry.mjs'), script);
    writeFileSync(path.join(root, 'host-integration.json'), manifestBytes);
    assert.equal(inspectPackage(root, sha(manifestBytes), true).files.length, 2);
    writeFileSync(path.join(root, 'extra.mjs'), 'unexpected');
    assert.throws(() => inspectPackage(root, sha(manifestBytes), true), /extra or missing/);
    rmSync(path.join(root, 'extra.mjs'));
    writeFileSync(path.join(root, 'app', 'entry.mjs'), 'changed');
    assert.throws(() => inspectPackage(root, sha(manifestBytes), true), /artifact digest mismatch/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (process.env.AGS_V06_B2A_INPUT_DIR && process.env.AGS_V06_B2A_GPGV) {
  test('real signed release rejects modified signature, archive, keyring and wrong version', () => {
    const source = process.env.AGS_V06_B2A_INPUT_DIR;
    const gpgv = process.env.AGS_V06_B2A_GPGV;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b2a-signed-'));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    const files = ['nodejs-release-keyring.kbx', 'SHASUMS256.txt', 'SHASUMS256.txt.sig', 'node-v24.19.0-win-x64.zip'];
    try {
      for (const file of files) copyFileSync(path.join(source, file), path.join(dir, file));
      const release = verifyNodeRelease(dir, '24.19.0', gpgv);
      assert.equal(sha(release.archiveBytes), release.archiveHash);
      assert.throws(() => verifyNodeRelease(dir, '23.0.0', gpgv), /Node >=24/);
      assert.throws(() => verifyNodeRelease(dir, '24.20.0', gpgv), /ENOENT/);
      for (const [file, message] of [
        ['SHASUMS256.txt', /signature invalid/],
        ['SHASUMS256.txt.sig', /signature invalid/],
        ['node-v24.19.0-win-x64.zip', /archive digest mismatch/],
        ['nodejs-release-keyring.kbx', /untrusted release keyring/],
      ]) {
        const target = path.join(dir, file);
        const changed = readFileSync(target);
        changed[0] ^= 1;
        writeFileSync(target, changed);
        assert.throws(() => verifyNodeRelease(dir, '24.19.0', gpgv), message, file);
        copyFileSync(path.join(source, file), target);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
