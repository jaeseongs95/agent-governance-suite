import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

import { extractNodeBinary, verifyNodeRelease } from '../../../scripts/qualification/v06-b3-linux-release.mjs';
import * as install from '../../../scripts/qualification/v06-b3-linux-install.mjs';

const { GATE_ENV, PINNED } = install;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
const FIXTURE_PARENT = process.env.AGS_V06_B3B_FIXTURE_PARENT;
const fixtureReady = linuxRoot && Boolean(FIXTURE_PARENT);
const PACKAGE_SOURCE = process.env.AGS_V06_B3B_R1_PACKAGE_SOURCE;
const liveReady = linuxRoot && process.env[GATE_ENV] === '1' && Boolean(process.env.AGS_V06_B3A_INPUT_DIR
  && process.env.AGS_V06_B3A_GPGV && process.env.AGS_V06_B3A_TAR && PACKAGE_SOURCE
  && process.env.AGS_V06_B3B_R1_MANIFEST && process.env.AGS_V06_B3B_R1_PARENT_MANIFEST);
const LEGACY_ROOT = `/usr/lib/agent-governance-suite/protected-runtime/${PINNED.releaseSha256}`;

// Independent reading of ags-protected-node-closure/v2 (linux-x64); shares no code with the installer.
function expectedReleaseId(nodeVersion, archiveSha256, hostIntegrationSha256) {
  return sha(Buffer.from(['ags-protected-node-closure/v2', 'linux-x64', nodeVersion, archiveSha256, hostIntegrationSha256, '']
    .join('\n'), 'utf8'));
}

function walk(dir, prefix = '') {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    const stat = lstatSync(path.posix.join(dir, name));
    out.push({ rel, stat });
    if (stat.isDirectory()) out.push(...walk(path.posix.join(dir, name), rel));
  }
  return out;
}

function contractViolations(installRoot, { nodeVersion, archiveSha256, nodeSha256 }) {
  const violations = [];
  const hostFile = path.posix.join(installRoot, 'package', 'host-integration.json');
  const hostBytes = existsSync(hostFile) ? readFileSync(hostFile) : null;
  if (!hostBytes || path.posix.basename(installRoot) !== expectedReleaseId(nodeVersion, archiveSha256, sha(hostBytes))) {
    violations.push('root-id');
  }
  const nodePath = path.posix.join(installRoot, 'bin', 'node');
  const nodeStat = existsSync(nodePath) ? lstatSync(nodePath) : null;
  if (!nodeStat?.isFile() || sha(readFileSync(nodePath)) !== nodeSha256 || (nodeStat.mode & 0o7222) || nodeStat.nlink !== 1
    || nodeStat.uid !== 0) violations.push('node-path');
  if (!hostBytes) violations.push('package');
  else {
    const manifest = JSON.parse(hostBytes.toString('utf8'));
    const expected = new Map([['host-integration.json', sha(hostBytes)],
      ...manifest.artifacts.map((item) => [item.path, item.sha256.slice(7)])]);
    const files = walk(path.posix.join(installRoot, 'package')).filter(({ stat }) => !stat.isDirectory());
    const exact = files.length === expected.size && files.every(({ rel, stat }) => stat.isFile() && stat.nlink === 1
      && stat.uid === 0 && !(stat.mode & 0o7222) && expected.get(rel) === sha(readFileSync(path.posix.join(installRoot, 'package', rel))));
    if (!exact) violations.push('package');
  }
  const top = readdirSync(installRoot).sort();
  if (JSON.stringify(top) !== '["bin","package"]') violations.push('root-entries');
  return violations;
}

const ARCHIVE = 'b'.repeat(64);
const NODE_VERSION = '24.21.0';

test('combined v2 release id follows releaseIdInputs order with LF joins and a trailing LF', () => {
  const host = 'c'.repeat(64);
  const id = install.releaseIdV2({ nodeVersion: NODE_VERSION, archiveSha256: ARCHIVE, hostIntegrationSha256: host });
  assert.equal(id, expectedReleaseId(NODE_VERSION, ARCHIVE, host));
  assert.notEqual(id, ARCHIVE);
  assert.equal(install.releaseIdV2({ nodeVersion: '24.21.0', archiveSha256: PINNED.releaseSha256,
    hostIntegrationSha256: '648dddda453db17832a776a6d381a747d7af851c2594762bd2f2a494628ce70c' }),
  expectedReleaseId('24.21.0', PINNED.releaseSha256, '648dddda453db17832a776a6d381a747d7af851c2594762bd2f2a494628ce70c'));
  assert.throws(() => install.releaseIdV2({ nodeVersion: 'v24.21.0', archiveSha256: ARCHIVE, hostIntegrationSha256: host }), /semver/);
  assert.throws(() => install.releaseIdV2({ nodeVersion: '22.0.0', archiveSha256: ARCHIVE, hostIntegrationSha256: host }), /semver/);
  assert.throws(() => install.releaseIdV2({ nodeVersion: NODE_VERSION, archiveSha256: `sha256:${ARCHIVE}`, hostIntegrationSha256: host }), /hex/);
  const paths = install.runtimePaths('/usr/lib', id);
  assert.deepEqual([paths.installRoot, paths.nodePath, paths.packageRoot], [`/usr/lib/agent-governance-suite/protected-runtime/${id}`,
    `/usr/lib/agent-governance-suite/protected-runtime/${id}/bin/node`, `/usr/lib/agent-governance-suite/protected-runtime/${id}/package`]);
});

test('v2 install keeps the /usr gate first, then linux-only, before reading the package source', () => {
  const base = { baseDir: '/usr/lib', nodeVersion: NODE_VERSION, archiveSha256: ARCHIVE, nodeBytes: Buffer.from('x'),
    expectedNodeSha256: sha('x'), packageSource: '/nonexistent-ags-r1-source' };
  assert.throws(() => install.installProtectedRuntime({ ...base, env: {}, platform: 'win32' }), new RegExp(`requires ${GATE_ENV}=1`));
  assert.throws(() => install.installProtectedRuntime({ ...base, env: { [GATE_ENV]: '1' }, platform: 'win32' }), /linux-only.*platform=win32/);
  assert.throws(() => install.installProtectedRuntime({ ...base, env: { [GATE_ENV]: '1' }, platform: 'linux', expectedNodeSha256: sha('y') }),
    /node bytes do not match/);
});

function packageFixture(top) {
  const src = path.join(top, 'src');
  const artifacts = { 'entry/a.mjs': 'export const a = 1;\n', 'entry/b.mjs': 'b\n', 'lib/deep/c.json': '{"c":1}\n', 'd.txt': 'd\n' };
  for (const [name, text] of Object.entries(artifacts)) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    writeFileSync(path.join(src, name), text);
  }
  const ids = ['mcp-server', 'scope-baseline', 'scope-compare', 'acceptance-cli'];
  const manifest = { format: 'agent-governance-suite.host-integration.v1',
    artifacts: Object.entries(artifacts).map(([name, text]) => ({ path: name, sha256: `sha256:${sha(text)}` })),
    entryPoints: ids.map((id, i) => ({ id, path: i % 2 ? 'entry/b.mjs' : 'entry/a.mjs', executionClosure: ['entry/a.mjs', 'lib/deep/c.json'] })) };
  const hostBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(path.join(src, 'host-integration.json'), hostBytes);
  writeFileSync(path.join(src, 'not-in-manifest.txt'), 'ignored\n');
  // The installer checks the V03-i v1 and v2 contract pins inside the trusted source (V06-b3b-r2).
  for (const name of [install.TRUST_PINS.v03i.manifestPath, install.TRUST_PINS.v2.docPath]) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    copyFileSync(path.join(import.meta.dirname, '../../..', name), path.join(src, name));
    chmodSync(path.join(src, name), 0o644);
  }
  return { src, hostSha256: sha(hostBytes), count: Object.keys(artifacts).length + 1 };
}

function fixture() {
  const top = mkdtempSync(path.join(FIXTURE_PARENT, 'r1-'));
  chmodSync(top, 0o755);
  const baseDir = path.join(top, 'usr', 'lib');
  mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  const nodeBytes = readFileSync(process.execPath);
  return { top, baseDir, nodeBytes, nodeSha256: sha(nodeBytes), pkg: packageFixture(top) };
}
const installFx = (fx, extra = {}) => install.installProtectedRuntime({ baseDir: fx.baseDir, nodeVersion: NODE_VERSION,
  archiveSha256: ARCHIVE, nodeBytes: fx.nodeBytes, expectedNodeSha256: fx.nodeSha256, packageSource: fx.pkg.src,
  trustedHostIntegrationSha256s: [fx.pkg.hostSha256], ...extra });
const verifyFx = (fx, releaseSha256, extra = {}) => install.verifyProtectedRuntime({ baseDir: fx.baseDir, nodeVersion: NODE_VERSION,
  archiveSha256: ARCHIVE, expectedNodeSha256: fx.nodeSha256, releaseSha256, trustedHostIntegrationSha256s: [fx.pkg.hostSha256], ...extra });
// Parent reuse needs a root-only manifest file whose sha256 the caller pins through the library option.
function pinnedManifest(fx, text) {
  const dir = mkdtempSync(path.join(fx.top, 'pm-'));
  chmodSync(dir, 0o700);
  const file = path.join(dir, 'manifest.txt');
  writeFileSync(file, text, { mode: 0o600 });
  return { parentManifestFile: file, trustedParentManifestSha256s: [sha(readFileSync(file))] };
}

test.skipIf(!fixtureReady)('fixture v2 install: combined-id root, bin/node bytes, exact package, use-time recheck', () => {
  const fx = fixture();
  try {
    const manifestFile = path.join(fx.top, 'manifest.txt');
    const { record, created } = installFx(fx, { manifestFile });
    const id = expectedReleaseId(NODE_VERSION, ARCHIVE, fx.pkg.hostSha256);
    assert.equal(record.releaseSha256, id);
    assert.equal(record.paths.nodePath, path.posix.join(fx.baseDir, 'agent-governance-suite/protected-runtime', id, 'bin/node'));
    assert.deepEqual(contractViolations(record.paths.installRoot, { nodeVersion: NODE_VERSION, archiveSha256: ARCHIVE, nodeSha256: fx.nodeSha256 }), []);
    assert.equal(record.package.files.length, fx.pkg.count);
    assert.equal(existsSync(path.join(record.paths.packageRoot, 'not-in-manifest.txt')), false);
    assert.equal(readFileSync(manifestFile, 'utf8').trim().split('\n').length, created.length);
    const used = install.runVerifiedRuntime(record, ['--version']);
    assert.deepEqual([used.fdSha256, used.stdout], [fx.nodeSha256, process.version]);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!fixtureReady)('contract violations are refused: archive-sha root id, root/node path, package extra/missing/changed/symlink/alias', () => {
  const fx = fixture();
  try {
    const legacy = install.installProtectedNode({ baseDir: fx.baseDir, releaseSha256: ARCHIVE, nodeBytes: fx.nodeBytes,
      expectedNodeSha256: fx.nodeSha256 });
    const legacyManifest = legacy.created.map((entry) => JSON.stringify(entry)).join('\n');
    assert.throws(() => verifyFx(fx, ARCHIVE), /entries|combined release id|bin/);
    assert.deepEqual(contractViolations(legacy.paths.releaseDir, { nodeVersion: NODE_VERSION, archiveSha256: ARCHIVE, nodeSha256: fx.nodeSha256 }),
      ['root-id', 'node-path', 'package', 'root-entries']);
    const { record } = installFx(fx, pinnedManifest(fx, `${legacyManifest}\n`));
    const id = record.releaseSha256;
    const pkg = record.paths.packageRoot;
    const expectFail = (mutate, undo, pattern, extra = {}) => {
      mutate();
      try { assert.throws(() => verifyFx(fx, id, extra), pattern); } finally { undo(); }
      verifyFx(fx, id);
    };
    const rootNode = path.join(record.paths.installRoot, 'node');
    expectFail(() => writeFileSync(rootNode, fx.nodeBytes), () => unlinkSync(rootNode), /install root entries/);
    const extra = path.join(pkg, 'extra.txt');
    expectFail(() => writeFileSync(extra, 'x', { mode: 0o444 }), () => unlinkSync(extra), /extra or missing package file/);
    const moved = path.join(record.paths.installRoot, 'd.txt.moved');
    expectFail(() => { writeFileSync(moved, readFileSync(path.join(pkg, 'd.txt'))); unlinkSync(path.join(pkg, 'd.txt')); },
      () => { writeFileSync(path.join(pkg, 'd.txt'), readFileSync(moved), { mode: 0o444 }); unlinkSync(moved); },
      /install root entries|extra or missing package file/);
    const target = path.join(pkg, 'lib/deep/c.json');
    const original = readFileSync(target);
    expectFail(() => { chmodSync(target, 0o644); writeFileSync(target, '{"c":2}\n'); chmodSync(target, 0o444); },
      () => { chmodSync(target, 0o644); writeFileSync(target, original); chmodSync(target, 0o444); }, /artifact digest mismatch/);
    const link = path.join(pkg, 'lib/alias.json');
    expectFail(() => symlinkSync('deep/c.json', link), () => unlinkSync(link), /symlink/);
    const hard = path.join(fx.top, 'hard');
    expectFail(() => linkSync(target, hard), () => unlinkSync(hard), /nlink=2/);
    const hostFile = path.join(pkg, 'host-integration.json');
    const hostBytes = readFileSync(hostFile);
    expectFail(() => { chmodSync(hostFile, 0o644); writeFileSync(hostFile, Buffer.concat([hostBytes, Buffer.from('\n')])); chmodSync(hostFile, 0o444); },
      () => { chmodSync(hostFile, 0o644); writeFileSync(hostFile, hostBytes); chmodSync(hostFile, 0o444); }, /combined release id/,
      { trustedHostIntegrationSha256s: [fx.pkg.hostSha256, sha(Buffer.concat([hostBytes, Buffer.from('\n')]))] });
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!fixtureReady)('existing protected parents are reused only when they match their install manifest', () => {
  const fx = fixture();
  try {
    const suite = path.join(fx.baseDir, 'agent-governance-suite');
    mkdirSync(path.join(suite, 'protected-runtime'), { recursive: true, mode: 0o755 });
    assert.throws(() => installFx(fx), /existing protected parent does not match/);
    const entries = [suite, path.join(suite, 'protected-runtime')].map((dir) => ({ path: dir, ino: lstatSync(dir, { bigint: true }).ino.toString(),
      type: 'dir', uid: 0, mode: '755' }));
    const text = (list) => `${list.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    assert.throws(() => installFx(fx, pinnedManifest(fx, text([{ ...entries[0], ino: '1' }, entries[1]]))), /existing protected parent does not match/);
    assert.deepEqual(readdirSync(path.join(suite, 'protected-runtime')), []);
    const { record, created } = installFx(fx, pinnedManifest(fx, text(entries)));
    assert.equal(created.some((entry) => entry.path === suite), false);
    assert.equal(existsSync(record.paths.nodePath), true);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!(linuxRoot && existsSync(LEGACY_ROOT)))('the V06-b3b root (archive-sha id, root/node, no package) violates v2 in the three reported ways', () => {
  assert.deepEqual(contractViolations(LEGACY_ROOT, { nodeVersion: PINNED.version, archiveSha256: PINNED.releaseSha256,
    nodeSha256: PINNED.nodeSha256 }), ['root-id', 'node-path', 'package', 'root-entries']);
});

const NOBODY_PROBE = `const fs=require('fs');const r={};const [link,...specs]=process.argv.slice(1);
const t=(k,f)=>{try{f();r[k]='ALLOWED'}catch(e){r[k]=e.code}};
for (const s of specs){const [kind,p]=s.split('=');
 if(kind==='create')t('create:'+p,()=>fs.closeSync(fs.openSync(p+'/intruder','wx')));
 if(kind==='write')t('write:'+p,()=>fs.closeSync(fs.openSync(p,'r+')));
 if(kind==='rename')t('rename:'+p,()=>fs.renameSync(p,p+'.moved'));
 if(kind==='replace'){const src=link+'.rep';fs.writeFileSync(src,'x');t('replace:'+p,()=>fs.renameSync(src,p));try{fs.unlinkSync(src)}catch{}}
 if(kind==='hardlink')t('hardlink:'+p,()=>fs.linkSync(p,link));}
process.stdout.write(JSON.stringify(r));`;

test.skipIf(!liveReady)('live: v2 root under /usr/lib with combined id, bin/node, exact package; nobody writes refused; legacy root intact', () => {
  const inputDir = process.env.AGS_V06_B3A_INPUT_DIR;
  const release = verifyNodeRelease(inputDir, PINNED.version, process.env.AGS_V06_B3A_GPGV, PINNED.keyringSha256);
  assert.equal(release.archiveHash, PINNED.releaseSha256);
  const { nodeBytes, nodeSha256 } = extractNodeBinary(path.join(inputDir, release.archiveName), process.env.AGS_V06_B3A_TAR, PINNED.version);
  assert.equal(nodeSha256, PINNED.nodeSha256);
  const hostSha256 = sha(readFileSync(path.join(PACKAGE_SOURCE, 'host-integration.json')));
  const id = expectedReleaseId(PINNED.version, release.archiveHash, hostSha256);
  const legacyBefore = lstatSync(path.posix.join(LEGACY_ROOT, 'node'), { bigint: true });
  assert.deepEqual(contractViolations(LEGACY_ROOT, { nodeVersion: PINNED.version, archiveSha256: release.archiveHash, nodeSha256 }),
    ['root-id', 'node-path', 'package', 'root-entries']);
  const inputs = { baseDir: '/usr/lib', nodeVersion: PINNED.version, archiveSha256: release.archiveHash };
  if (!existsSync(install.runtimePaths('/usr/lib', id).installRoot)) {
    install.installProtectedRuntime({ ...inputs, nodeBytes, expectedNodeSha256: nodeSha256, packageSource: PACKAGE_SOURCE,
      manifestFile: process.env.AGS_V06_B3B_R1_MANIFEST, parentManifestFile: process.env.AGS_V06_B3B_R1_PARENT_MANIFEST });
  }
  const record = install.verifyProtectedRuntime({ ...inputs, expectedNodeSha256: nodeSha256, releaseSha256: id });
  assert.equal(record.releaseSha256, id);
  assert.equal(record.hostIntegrationSha256, hostSha256);
  assert.deepEqual(contractViolations(record.paths.installRoot, { nodeVersion: PINNED.version, archiveSha256: release.archiveHash, nodeSha256 }), []);
  assert.deepEqual(record.ancestors.map((entry) => entry.path), ['/', '/usr', '/usr/lib', '/usr/lib/agent-governance-suite',
    '/usr/lib/agent-governance-suite/protected-runtime', record.paths.installRoot]);
  assert.ok(record.ancestors.every((entry) => entry.uid === 0 && (parseInt(entry.mode, 8) & 0o022) === 0));
  assert.deepEqual([record.node.identity.uid, record.node.identity.mode, record.node.identity.nlink], [0, '555', 1]);
  const used = install.runVerifiedRuntime(record, ['--version']);
  assert.deepEqual([used.fdSha256, used.stdout], [nodeSha256, `v${PINNED.version}`]);

  const { installRoot, binDir, nodePath, packageRoot } = record.paths;
  const sample = path.posix.join(packageRoot, 'mcp-server/dist/server.mjs');
  const subdir = path.posix.join(packageRoot, 'contracts');
  const specs = [
    ...['/usr/lib/agent-governance-suite', '/usr/lib/agent-governance-suite/protected-runtime', installRoot, binDir, packageRoot, subdir]
      .map((dir) => `create=${dir}`),
    `write=${nodePath}`, `write=${path.posix.join(packageRoot, 'host-integration.json')}`, `write=${sample}`,
    ...[installRoot, binDir, nodePath, packageRoot, subdir, sample].map((file) => `rename=${file}`),
    `replace=${nodePath}`, `replace=${sample}`, `hardlink=${nodePath}`, `hardlink=${sample}`,
  ];
  const link = `/tmp/ags-b3b-r1-hl-${process.pid}`;
  const probe = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', nodePath, '-e', NOBODY_PROBE, link, ...specs],
    { encoding: 'utf8' });
  const linked = existsSync(link);
  if (linked) unlinkSync(link);
  assert.equal(probe.status, 0, probe.stderr);
  const denied = JSON.parse(probe.stdout);
  process.stdout.write(`V06-b3b-r1 live ${JSON.stringify({ releaseSha256: id, hostIntegrationSha256: hostSha256,
    ancestors: record.ancestors, node: record.node, packageFiles: record.package.files.length, denied })}\n`);
  assert.equal(linked, false);
  assert.equal(Object.keys(denied).length, specs.length);
  for (const [key, code] of Object.entries(denied)) assert.match(code, /^(EACCES|EPERM)$/, key);
  const legacyAfter = lstatSync(path.posix.join(LEGACY_ROOT, 'node'), { bigint: true });
  assert.deepEqual([legacyAfter.ino, legacyAfter.ctimeNs, legacyAfter.nlink], [legacyBefore.ino, legacyBefore.ctimeNs, legacyBefore.nlink]);
  assert.equal(sha(readFileSync(path.posix.join(LEGACY_ROOT, 'node'))), PINNED.nodeSha256);
});
