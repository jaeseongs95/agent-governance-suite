import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { archiveDigestFromSignedChecksums, assertVersionedArchiveUrl, extractNodeBinary,
  nodeReleaseUrls, runExtractedNode, verifyArchiveBytes, verifyNodeRelease,
  verifyPinnedKeyring } from '../../../scripts/qualification/v06-b3-linux-release.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const KEYRING = 'nodejs-release-keyring.kbx';
const missing = (file) => new RegExp(`required release input missing: ${file.replaceAll('.', '\\.')}$`);

test('release URLs are exact nodejs.org versioned linux-x64 paths, never a latest alias', () => {
  const urls = nodeReleaseUrls('24.21.0');
  assert.equal(urls.archiveName, 'node-v24.21.0-linux-x64.tar.xz');
  assert.equal(urls.archiveUrl, 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz');
  assert.equal(urls.checksumsUrl, 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt');
  assert.equal(urls.signatureUrl, 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt.sig');
  assert.throws(() => nodeReleaseUrls('latest'), /exact Node semver/);
  assert.throws(() => nodeReleaseUrls('23.9.0'), /Node >=24/);
  assert.throws(() => nodeReleaseUrls('24.21.0-extra'), /exact Node semver/);
});

test('only the exact versioned linux-x64 archive URL is accepted; latest alias, version and arch/OS confusion are rejected', () => {
  const good = 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz';
  assert.equal(assertVersionedArchiveUrl(good, '24.21.0'), good);
  const rejections = [
    'https://nodejs.org/dist/latest-v24.x/node-v24.21.0-linux-x64.tar.xz',
    'https://nodejs.org/dist/latest/node-v24.21.0-linux-x64.tar.xz',
    'https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz',
    'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-arm64.tar.xz',
    'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',
    'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-x64.tar.gz',
    'http://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
    'https://evil.example/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz',
    'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz.bak',
  ];
  for (const url of rejections) assert.throws(() => assertVersionedArchiveUrl(url, '24.21.0'), /versioned/, url);
  assert.throws(() => assertVersionedArchiveUrl(good, '24.20.0'), /versioned/);
});

test('only the exact signed checksum entry and matching archive bytes pass the digest step', () => {
  const bytes = Buffer.from('test-only archive bytes');
  const line = `${sha(bytes)}  node-v24.21.0-linux-x64.tar.xz`;
  assert.equal(archiveDigestFromSignedChecksums(`${line}\n`, '24.21.0'), sha(bytes));
  assert.equal(verifyArchiveBytes(`${line}\n`, '24.21.0', bytes), sha(bytes));
  assert.throws(() => verifyArchiveBytes(`${line}\n`, '24.21.0', Buffer.from('tampered')), /archive digest mismatch/);
  assert.throws(() => archiveDigestFromSignedChecksums(`${line}\n`, '24.22.0'), /missing/);
  assert.throws(() => archiveDigestFromSignedChecksums(`${line}\n${line}\n`, '24.21.0'), /duplicated/);
  assert.throws(() => verifyPinnedKeyring(Buffer.from('untrusted key'), sha(Buffer.from('trusted key'))), /untrusted release keyring/);
});

test('missing keyring, checksum or signature input is rejected before gpgv runs', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b3a-missing-'));
  const keyring = Buffer.from('test-only keyring bytes');
  const noGpgv = path.join(dir, 'gpgv-must-not-run');
  try {
    assert.throws(() => verifyNodeRelease(dir, '24.21.0', noGpgv, sha(keyring)), missing(KEYRING));
    writeFileSync(path.join(dir, KEYRING), keyring);
    assert.throws(() => verifyNodeRelease(dir, '24.21.0', noGpgv, sha(keyring)), missing('SHASUMS256.txt'));
    writeFileSync(path.join(dir, 'SHASUMS256.txt'), 'test-only checksums\n');
    assert.throws(() => verifyNodeRelease(dir, '24.21.0', noGpgv, sha(keyring)), missing('SHASUMS256.txt.sig'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

if (process.env.AGS_V06_B3A_INPUT_DIR && process.env.AGS_V06_B3A_GPGV
  && process.env.AGS_V06_B3A_VERSION && process.env.AGS_V06_B3A_KEYRING_SHA256) {
  test('real signed Linux release rejects modified signature, archive, keyring and wrong version', () => {
    const source = process.env.AGS_V06_B3A_INPUT_DIR;
    const gpgv = process.env.AGS_V06_B3A_GPGV;
    const version = process.env.AGS_V06_B3A_VERSION;
    const keyringSha256 = process.env.AGS_V06_B3A_KEYRING_SHA256;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b3a-signed-'));
    assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
    const files = [KEYRING, 'SHASUMS256.txt', 'SHASUMS256.txt.sig', `node-v${version}-linux-x64.tar.xz`];
    try {
      for (const file of files) copyFileSync(path.join(source, file), path.join(dir, file));
      const url = nodeReleaseUrls(version);
      assert.equal(assertVersionedArchiveUrl(url.archiveUrl, version), url.archiveUrl);
      const release = verifyNodeRelease(dir, version, gpgv, keyringSha256);
      assert.equal(sha(release.archiveBytes), release.archiveHash);
      assert.throws(() => verifyNodeRelease(dir, '23.0.0', gpgv, keyringSha256), /Node >=24/);
      assert.throws(() => verifyNodeRelease(dir, '24.20.0', gpgv, keyringSha256), missing('node-v24.20.0-linux-x64.tar.xz'));
      for (const [file, message] of [
        ['SHASUMS256.txt', /signature invalid/],
        ['SHASUMS256.txt.sig', /signature invalid/],
        [`node-v${version}-linux-x64.tar.xz`, /archive digest mismatch/],
        [KEYRING, /untrusted release keyring/],
      ]) {
        const target = path.join(dir, file);
        const changed = readFileSync(target);
        changed[0] ^= 1;
        writeFileSync(target, changed);
        assert.throws(() => verifyNodeRelease(dir, version, gpgv, keyringSha256), message, file);
        copyFileSync(path.join(source, file), target);
      }
      assert.throws(() => verifyNodeRelease(dir, version, gpgv, sha(Buffer.from('wrong keyring'))), /untrusted release keyring/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('real signed Linux release rejects absent keyring, signer key, archive, checksum and signature', () => {
    const source = process.env.AGS_V06_B3A_INPUT_DIR;
    const gpgv = process.env.AGS_V06_B3A_GPGV;
    const version = process.env.AGS_V06_B3A_VERSION;
    const keyringSha256 = process.env.AGS_V06_B3A_KEYRING_SHA256;
    const archive = `node-v${version}-linux-x64.tar.xz`;
    const files = [KEYRING, 'SHASUMS256.txt', 'SHASUMS256.txt.sig', archive];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b3a-absent-'));
    const gnupgHome = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b3a-gnupg-'));
    const gpg = path.join(path.dirname(gpgv), 'gpg');
    const gpgvStatus = () => spawnSync(gpgv, ['--status-fd', '1', '--keyring', `./${KEYRING}`, './SHASUMS256.txt.sig', '-'],
      { cwd: dir, input: readFileSync(path.join(dir, 'SHASUMS256.txt')), encoding: 'utf8' });
    try {
      const restore = () => { for (const file of files) copyFileSync(path.join(source, file), path.join(dir, file)); };
      restore();
      assert.equal(verifyNodeRelease(dir, version, gpgv, keyringSha256).signerFingerprint, '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356');

      for (const file of files) {
        rmSync(path.join(dir, file));
        assert.throws(() => verifyNodeRelease(dir, version, gpgv, keyringSha256), missing(file), file);
        restore();
      }

      const generated = spawnSync(gpg, ['--batch', '--homedir', gnupgHome, '--pinentry-mode', 'loopback', '--passphrase', '',
        '--quick-gen-key', 'AGS V06-b3a unrelated test key <test@invalid>', 'ed25519', 'sign', 'never'], { encoding: 'utf8' });
      assert.equal(generated.status, 0, generated.stderr);
      const exported = spawnSync(gpg, ['--batch', '--homedir', gnupgHome, '--export'], { maxBuffer: 1024 * 1024 });
      assert.equal(exported.status, 0);
      assert.ok(exported.stdout.length > 0);
      for (const [label, keyring] of [['unrelated key only', exported.stdout], ['empty keyring', Buffer.alloc(0)]]) {
        writeFileSync(path.join(dir, KEYRING), keyring);
        const status = gpgvStatus();
        assert.notEqual(status.status, 0, label);
        assert.match(status.stdout, /^\[GNUPG:\] NO_PUBKEY 20B1A390B168D356$/m, label);
        assert.doesNotMatch(status.stdout, /VALIDSIG/, label);
        assert.throws(() => verifyNodeRelease(dir, version, gpgv, sha(keyring)), /signature invalid or signer untrusted/, label);
        assert.throws(() => verifyNodeRelease(dir, version, gpgv, keyringSha256), /untrusted release keyring/, label);
        restore();
      }
    } finally {
      spawnSync(path.join(path.dirname(gpgv), 'gpgconf'), ['--homedir', gnupgHome, '--kill', 'all']);
      rmSync(dir, { recursive: true, force: true });
      rmSync(gnupgHome, { recursive: true, force: true });
    }
  });

  if (process.env.AGS_V06_B3A_TAR) {
    test('the extracted bin/node from the verified archive reports the exact pinned version', () => {
      const source = process.env.AGS_V06_B3A_INPUT_DIR;
      const version = process.env.AGS_V06_B3A_VERSION;
      const tar = process.env.AGS_V06_B3A_TAR;
      const archive = path.join(source, `node-v${version}-linux-x64.tar.xz`);
      const { nodeBytes, nodeSha256 } = extractNodeBinary(archive, tar, version);
      assert.match(nodeSha256, /^[a-f0-9]{64}$/);
      const dir = mkdtempSync(path.join(os.tmpdir(), 'ags-v06-b3a-node-'));
      assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep));
      try {
        const nodeFile = path.join(dir, 'node');
        writeFileSync(nodeFile, nodeBytes, { mode: 0o755 });
        assert.equal(sha(readFileSync(nodeFile)), nodeSha256);
        assert.equal(runExtractedNode(nodeFile, ['--version']), `v${version}`);
        assert.ok(Number(version.split('.')[0]) >= 24);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
