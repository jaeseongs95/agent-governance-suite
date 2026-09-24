import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

import { extractNodeBinary, verifyNodeRelease } from '../../../scripts/qualification/v06-b3-linux-release.mjs';
import { GATE_ENV, PINNED, assessComponent, inspectAncestors, installProtectedNode, protectedPaths,
  runVerifiedNode, verifyInstalledNode } from '../../../scripts/qualification/v06-b3-linux-install.mjs';

const sha = (value) => createHash('sha256').update(value).digest('hex');
const RELEASE = 'a'.repeat(64);
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
// Fixture trees must sit under an ancestor chain that is itself safe (never a sticky /tmp).
const FIXTURE_PARENT = process.env.AGS_V06_B3B_FIXTURE_PARENT;
const fixtureReady = linuxRoot && Boolean(FIXTURE_PARENT);
const liveReady = linuxRoot && process.env[GATE_ENV] === '1' && Boolean(process.env.AGS_V06_B3A_INPUT_DIR
  && process.env.AGS_V06_B3A_GPGV && process.env.AGS_V06_B3A_TAR && process.env.AGS_V06_B3B_MANIFEST);

function fixture(bytes = Buffer.from('test-only node bytes')) {
  const top = mkdtempSync(path.join(FIXTURE_PARENT, 'fx-'));
  chmodSync(top, 0o755);
  const baseDir = path.join(top, 'usr', 'lib');
  mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  return { top, baseDir, bytes, digest: sha(bytes) };
}
const install = (fx, extra = {}) => installProtectedNode({ baseDir: fx.baseDir, releaseSha256: RELEASE,
  nodeBytes: fx.bytes, expectedNodeSha256: fx.digest, ...extra });

test('component assessment rejects symlink, non-directory, untrusted owner and group/other write', () => {
  const stat = (over) => ({ isSymbolicLink: () => false, isDirectory: () => true, uid: 0, mode: 0o40755, ...over });
  assert.doesNotThrow(() => assessComponent('/ok', stat({})));
  assert.throws(() => assessComponent('/l', stat({ isSymbolicLink: () => true })), /symlink/);
  assert.throws(() => assessComponent('/f', stat({ isDirectory: () => false })), /not a directory/);
  assert.throws(() => assessComponent('/u', stat({ uid: 65534 })), /trusted uid/);
  assert.throws(() => assessComponent('/g', stat({ mode: 0o40775 })), /group\/other writable/);
  assert.throws(() => assessComponent('/o', stat({ mode: 0o41777 })), /group\/other writable/);
  assert.throws(() => protectedPaths('relative', RELEASE), /absolute/);
  assert.throws(() => protectedPaths('/usr/lib', 'latest'), /64 lowercase hex/);
});

test('a /usr install is refused without the explicit gate env', () => {
  assert.throws(() => installProtectedNode({ baseDir: '/usr/lib', releaseSha256: RELEASE, nodeBytes: Buffer.from('x'),
    expectedNodeSha256: sha('x'), env: {} }), new RegExp(`requires ${GATE_ENV}=1`));
});

test.skipIf(!fixtureReady)('fixture install places root-owned 0555 nlink=1 node whose bytes match and use-time fd hash agrees', () => {
  const fx = fixture(readFileSync(process.execPath));
  try {
    const manifestFile = path.join(fx.top, 'manifest.txt');
    const { record, created } = install(fx, { manifestFile });
    assert.equal(created.length, 4);
    assert.equal(readFileSync(manifestFile, 'utf8').trim().split('\n').length, 4);
    assert.deepEqual([record.identity.uid, record.identity.mode, record.identity.nlink], [0, '555', 1]);
    assert.equal(record.sha256, fx.digest);
    assert.equal(sha(readFileSync(record.paths.nodeFile)), fx.digest);
    const used = runVerifiedNode(record, ['--version']);
    assert.equal(used.fdSha256, fx.digest);
    assert.equal(used.stdout, process.version);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!fixtureReady)('symlinked, group/other-writable or non-root-owned ancestors are refused before any write', () => {
  const cases = {
    symlink: (fx) => { const real = path.join(fx.top, 'real'); renameSync(fx.baseDir, real); symlinkSync(real, fx.baseDir); },
    writable: (fx) => chmodSync(path.join(fx.top, 'usr'), 0o777),
    owner: (fx) => chownSync(path.join(fx.top, 'usr'), 65534, 65534),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const fx = fixture();
    try {
      mutate(fx);
      assert.throws(() => install(fx), /symlink|writable|trusted uid/, name);
      assert.equal(existsSync(path.join(fx.baseDir, 'agent-governance-suite')), false, name);
    } finally { rmSync(fx.top, { recursive: true, force: true }); }
  }
});

test.skipIf(!fixtureReady)('an existing target, wrong bytes and a failed post-install check are refused fail-closed', () => {
  const fx = fixture();
  try {
    const paths = protectedPaths(fx.baseDir, RELEASE);
    mkdirSync(paths.releaseDir, { recursive: true, mode: 0o755 });
    writeFileSync(paths.nodeFile, 'foreign');
    assert.throws(() => install(fx), /install target already exists/);
    assert.equal(readFileSync(paths.nodeFile, 'utf8'), 'foreign');
    rmSync(paths.suiteDir, { recursive: true });
    assert.throws(() => install(fx, { expectedNodeSha256: sha('other') }), /do not match the expected/);
    assert.equal(existsSync(paths.suiteDir), false);
    assert.throws(() => install(fx, { trustedUids: [1] }), /trusted uid/);
    assert.equal(existsSync(paths.suiteDir), false);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!fixtureReady)('extra hardlinks, changed bytes and a swapped inode after verification are refused', () => {
  const fx = fixture();
  try {
    const { record } = install(fx);
    const extra = path.join(record.paths.releaseDir, 'extra');
    linkSync(record.paths.nodeFile, extra);
    assert.throws(() => verifyInstalledNode({ baseDir: fx.baseDir, releaseSha256: RELEASE, expectedNodeSha256: fx.digest }), /nlink=2/);
    assert.throws(() => runVerifiedNode(record, ['--version']), /nlink=2/);
    unlinkSync(extra);

    const swap = path.join(record.paths.releaseDir, 'swap');
    writeFileSync(swap, fx.bytes, { mode: 0o555 });
    renameSync(swap, record.paths.nodeFile);
    const swapped = verifyInstalledNode({ baseDir: fx.baseDir, releaseSha256: RELEASE, expectedNodeSha256: fx.digest });
    assert.notEqual(swapped.identity.ino, record.identity.ino);
    assert.throws(() => runVerifiedNode(record, ['--version']), /identity changed after verification: ino/);

    chmodSync(record.paths.nodeFile, 0o755);
    writeFileSync(record.paths.nodeFile, 'tampered bytes');
    chmodSync(record.paths.nodeFile, 0o555);
    assert.throws(() => verifyInstalledNode({ baseDir: fx.baseDir, releaseSha256: RELEASE, expectedNodeSha256: fx.digest }), /sha256 does not match/);
    chmodSync(record.paths.nodeFile, 0o755);
    assert.throws(() => verifyInstalledNode({ baseDir: fx.baseDir, releaseSha256: RELEASE, expectedNodeSha256: fx.digest }), /write or special mode/);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

const NOBODY_PROBE = `const fs=require('fs');const [dir,node,link]=process.argv.slice(1);const r={};
const t=(k,f)=>{try{f();r[k]='ALLOWED'}catch(e){r[k]=e.code}};
t('create',()=>fs.closeSync(fs.openSync(dir+'/intruder','wx')));
t('overwrite',()=>fs.closeSync(fs.openSync(node,'r+')));
t('rename',()=>fs.renameSync(node,dir+'/node.moved'));
t('hardlink',()=>fs.linkSync(node,link));
process.stdout.write(JSON.stringify(r));`;

test.skipIf(!liveReady)('candidate host: pinned archive node installed under /usr/lib, identity verified, nobody writes refused', () => {
  const inputDir = process.env.AGS_V06_B3A_INPUT_DIR;
  const release = verifyNodeRelease(inputDir, PINNED.version, process.env.AGS_V06_B3A_GPGV, PINNED.keyringSha256);
  assert.equal(release.archiveHash, PINNED.releaseSha256);
  const { nodeBytes, nodeSha256 } = extractNodeBinary(path.join(inputDir, release.archiveName), process.env.AGS_V06_B3A_TAR, PINNED.version);
  assert.equal(nodeSha256, PINNED.nodeSha256);
  const paths = protectedPaths('/usr/lib', release.archiveHash);
  if (!existsSync(paths.suiteDir)) {
    installProtectedNode({ baseDir: '/usr/lib', releaseSha256: release.archiveHash, nodeBytes, expectedNodeSha256: nodeSha256,
      manifestFile: process.env.AGS_V06_B3B_MANIFEST });
  }
  const record = verifyInstalledNode({ baseDir: '/usr/lib', releaseSha256: release.archiveHash, expectedNodeSha256: nodeSha256 });
  const ancestors = inspectAncestors(paths.releaseDir);
  assert.deepEqual(ancestors.map((entry) => entry.path), ['/', '/usr', '/usr/lib', paths.suiteDir, paths.runtimeDir, paths.releaseDir]);
  assert.ok(ancestors.every((entry) => entry.uid === 0 && (parseInt(entry.mode, 8) & 0o022) === 0));
  assert.deepEqual([record.identity.uid, record.identity.mode, record.identity.nlink], [0, '555', 1]);
  assert.equal(record.sha256, nodeSha256);
  const used = runVerifiedNode(record, ['--version']);
  assert.equal(used.fdSha256, nodeSha256);
  assert.equal(used.stdout, `v${PINNED.version}`);

  const link = `/tmp/ags-b3b-hl-${process.pid}`;
  const probe = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', paths.nodeFile, '-e', NOBODY_PROBE,
    paths.releaseDir, paths.nodeFile, link], { encoding: 'utf8' });
  const linked = existsSync(link) && lstatSync(link).ino.toString() === record.identity.ino;
  if (linked) unlinkSync(link);
  assert.equal(probe.status, 0, probe.stderr);
  const denied = JSON.parse(probe.stdout);
  process.stdout.write(`V06-b3b nobody probe ${JSON.stringify(denied)} ancestors ${JSON.stringify(ancestors)} identity ${JSON.stringify(record.identity)}\n`);
  assert.equal(linked, false);
  for (const key of ['create', 'overwrite', 'rename', 'hardlink']) assert.match(denied[key], /^(EACCES|EPERM)$/, key);
  assert.equal(readFileSync('/proc/sys/fs/protected_hardlinks', 'utf8').trim(), '1');
  assert.deepEqual(verifyInstalledNode({ baseDir: '/usr/lib', releaseSha256: release.archiveHash, expectedNodeSha256: nodeSha256 }).identity,
    record.identity);
});
