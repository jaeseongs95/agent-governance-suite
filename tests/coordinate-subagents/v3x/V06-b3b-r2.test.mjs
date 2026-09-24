import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';

import * as install from '../../../scripts/qualification/v06-b3-linux-install.mjs';

const { GATE_ENV, PINNED } = install;
const sha = (value) => createHash('sha256').update(value).digest('hex');
const linuxRoot = process.platform === 'linux' && process.getuid?.() === 0;
const FIXTURE_PARENT = process.env.AGS_V06_B3B_FIXTURE_PARENT;
const fixtureReady = linuxRoot && Boolean(FIXTURE_PARENT);
const R2_SOURCE = process.env.AGS_V06_B3B_R2_PACKAGE_SOURCE;
const liveReady = linuxRoot && Boolean(R2_SOURCE && process.env.AGS_V06_B3B_R2_PARENT_MANIFEST);
const LIVE_ID = '32a825d9da1c613e097e6246cf282b89777cc13d043fda3dd68113c1fc208edd';
const REPO = path.resolve(import.meta.dirname, '../../..');
const CONTRACT_FILES = ['tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json',
  'docs/implementation-3x/protected-node-closure-v2.ko.md'];
const ARCHIVE = 'b'.repeat(64);

test('trust pins are code constants: 0724bb2b host-integration, V03-i v1 manifest, v2 contract, b3b parent manifest', () => {
  assert.deepEqual(install.TRUST_PINS.hostIntegrationSha256s, ['648dddda453db17832a776a6d381a747d7af851c2594762bd2f2a494628ce70c']);
  assert.deepEqual(install.TRUST_PINS.parentManifestSha256s, ['857bad43df354eb2022fcc3355257cd37adaa0a4acca506f2a2a9add0721ce9f']);
  assert.equal(install.TRUST_PINS.v03i.manifestSha256, sha(readFileSync(path.join(REPO, CONTRACT_FILES[0]))));
  assert.deepEqual([install.TRUST_PINS.v03i.contractId, install.TRUST_PINS.v03i.revision], ['ags-vm-protected-host-installation/v1', '1']);
  assert.deepEqual([install.TRUST_PINS.v2.contractId, install.TRUST_PINS.v2.revision], ['ags-protected-node-closure/v2', '2']);
  assert.equal(sha(readFileSync(path.join(REPO, 'host-integration.json'))), install.TRUST_PINS.hostIntegrationSha256s[0]);
});

function fixture() {
  const top = mkdtempSync(path.join(FIXTURE_PARENT, 'r2-'));
  chmodSync(top, 0o755);
  const src = path.join(top, 'src');
  const artifacts = { 'entry/a.mjs': 'a\n', 'entry/b.mjs': 'b\n', 'lib/deep/c.json': '{}\n' };
  for (const [name, text] of Object.entries(artifacts)) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    writeFileSync(path.join(src, name), text, { mode: 0o644 });
  }
  for (const name of CONTRACT_FILES) {
    mkdirSync(path.join(src, path.dirname(name)), { recursive: true, mode: 0o755 });
    copyFileSync(path.join(REPO, name), path.join(src, name));
    chmodSync(path.join(src, name), 0o644);
  }
  const ids = ['mcp-server', 'scope-baseline', 'scope-compare', 'acceptance-cli'];
  const hostBytes = Buffer.from(JSON.stringify({ format: 'agent-governance-suite.host-integration.v1',
    artifacts: Object.entries(artifacts).map(([name, text]) => ({ path: name, sha256: `sha256:${sha(text)}` })),
    entryPoints: ids.map((id) => ({ id, path: 'entry/a.mjs', executionClosure: ['entry/a.mjs'] })) }));
  writeFileSync(path.join(src, 'host-integration.json'), hostBytes, { mode: 0o644 });
  const baseDir = path.join(top, 'usr', 'lib');
  mkdirSync(baseDir, { recursive: true, mode: 0o755 });
  const nodeBytes = Buffer.from('fixture node bytes');
  return { top, src, baseDir, nodeBytes, hostSha256: sha(hostBytes) };
}
const pins = (fx, extra = {}) => ({ trustedHostIntegrationSha256s: [fx.hostSha256], ...extra });
const installFx = (fx, extra = {}) => install.installProtectedRuntime({ baseDir: fx.baseDir, nodeVersion: '24.21.0',
  archiveSha256: ARCHIVE, nodeBytes: fx.nodeBytes, expectedNodeSha256: sha(fx.nodeBytes), packageSource: fx.src, ...pins(fx), ...extra });
const untouched = (fx) => assert.equal(existsSync(path.join(fx.baseDir, 'agent-governance-suite')), false);

test.skipIf(!fixtureReady)('writable, foreign-owned, symlinked or aliased source inputs are refused before any host write', () => {
  const cases = {
    'manifest 0666': (fx) => chmodSync(path.join(fx.src, 'host-integration.json'), 0o666),
    'artifact 0666': (fx) => chmodSync(path.join(fx.src, 'entry/b.mjs'), 0o666),
    'subdir 0777': (fx) => chmodSync(path.join(fx.src, 'lib/deep'), 0o777),
    'subdir group-writable': (fx) => chmodSync(path.join(fx.src, 'lib'), 0o775),
    'artifact owned by nobody': (fx) => chownSync(path.join(fx.src, 'lib/deep/c.json'), 65534, 65534),
    'artifact symlink': (fx) => { renameSync(path.join(fx.src, 'entry/b.mjs'), path.join(fx.top, 'b.real')); symlinkSync(path.join(fx.top, 'b.real'), path.join(fx.src, 'entry/b.mjs')); },
    'subdir symlink': (fx) => { renameSync(path.join(fx.src, 'lib'), path.join(fx.top, 'lib.real')); symlinkSync(path.join(fx.top, 'lib.real'), path.join(fx.src, 'lib')); },
    'artifact hardlink alias': (fx) => linkSync(path.join(fx.src, 'entry/a.mjs'), path.join(fx.top, 'a.alias')),
    'V03-i manifest 0666': (fx) => chmodSync(path.join(fx.src, CONTRACT_FILES[0]), 0o666),
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const fx = fixture();
    try {
      mutate(fx);
      assert.throws(() => installFx(fx), /untrusted source input/, name);
      untouched(fx);
    } finally { rmSync(fx.top, { recursive: true, force: true }); }
  }
});

test.skipIf(!fixtureReady)('source digests and contract pins are checked against code pins, not the source itself', () => {
  const fx = fixture();
  try {
    assert.throws(() => installFx(fx, { trustedHostIntegrationSha256s: undefined }), /not a trusted AGS release pin/);
    untouched(fx);
    const v03i = path.join(fx.src, CONTRACT_FILES[0]);
    const original = readFileSync(v03i);
    writeFileSync(v03i, Buffer.concat([original, Buffer.from(' ')]));
    assert.throws(() => installFx(fx), /V03-i v1 manifest digest/);
    writeFileSync(v03i, original);
    const doc = path.join(fx.src, CONTRACT_FILES[1]);
    const docText = readFileSync(doc, 'utf8');
    writeFileSync(doc, docText.replace('"revision": "2"', '"revision": "3"'));
    assert.throws(() => installFx(fx), /v2 contract/);
    writeFileSync(doc, docText.replace('"releaseIdInputs": ["contractId", "targetId"', '"releaseIdInputs": ["targetId", "contractId"'));
    assert.throws(() => installFx(fx), /v2 contract/);
    writeFileSync(doc, docText);
    untouched(fx);
    const { record } = installFx(fx);
    assert.equal(record.releaseSha256, install.releaseIdV2({ nodeVersion: '24.21.0', archiveSha256: ARCHIVE, hostIntegrationSha256: fx.hostSha256 }));
    assert.throws(() => install.verifyProtectedRuntime({ baseDir: fx.baseDir, nodeVersion: '24.21.0', archiveSha256: ARCHIVE,
      expectedNodeSha256: sha(fx.nodeBytes), releaseSha256: record.releaseSha256 }), /not a trusted AGS release pin/);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test.skipIf(!fixtureReady)('existing parents are reused only through a pinned, root-only parent manifest file, never caller JSON', () => {
  const fx = fixture();
  try {
    const suite = path.join(fx.baseDir, 'agent-governance-suite');
    const runtime = path.join(suite, 'protected-runtime');
    mkdirSync(runtime, { recursive: true, mode: 0o755 });
    chmodSync(suite, 0o755);
    const lines = [suite, runtime].map((dir) => JSON.stringify({ path: dir, ino: lstatSync(dir, { bigint: true }).ino.toString(),
      type: 'dir', uid: 0, mode: '755' })).join('\n');
    const secret = path.join(fx.top, 'secret');
    mkdirSync(secret, { mode: 0o700 });
    const manifestFile = path.join(secret, 'manifest.txt');
    writeFileSync(manifestFile, `${lines}\n`, { mode: 0o600 });
    const manifestSha256 = sha(readFileSync(manifestFile));
    assert.throws(() => installFx(fx, { parentManifestEntries: JSON.parse(`[${lines.split('\n').join(',')}]`) }),
      /caller-supplied parent entries are not accepted/);
    assert.throws(() => installFx(fx, { parentManifestFile: manifestFile }), /parent manifest is not a trusted install pin/);
    chmodSync(manifestFile, 0o666);
    assert.throws(() => installFx(fx, { parentManifestFile: manifestFile, trustedParentManifestSha256s: [manifestSha256] }), /untrusted parent manifest/);
    chmodSync(manifestFile, 0o600);
    chmodSync(secret, 0o777);
    assert.throws(() => installFx(fx, { parentManifestFile: manifestFile, trustedParentManifestSha256s: [manifestSha256] }), /untrusted parent manifest|writable/);
    chmodSync(secret, 0o700);
    const { created } = installFx(fx, { parentManifestFile: manifestFile, trustedParentManifestSha256s: [manifestSha256] });
    assert.equal(created.some((entry) => entry.path === suite || entry.path === runtime), false);
  } finally { rmSync(fx.top, { recursive: true, force: true }); }
});

test('a non-x64 arch is refused after the /usr gate and linux-only checks, before any host access', () => {
  const base = { baseDir: '/usr/lib', nodeVersion: '24.21.0', archiveSha256: ARCHIVE, nodeBytes: Buffer.from('x'),
    expectedNodeSha256: sha('x'), packageSource: '/nonexistent-ags-r2-source' };
  assert.throws(() => install.installProtectedRuntime({ ...base, env: {}, platform: 'linux', arch: 'arm64' }), new RegExp(`requires ${GATE_ENV}=1`));
  assert.throws(() => install.installProtectedRuntime({ ...base, env: { [GATE_ENV]: '1' }, platform: 'win32', arch: 'arm64' }), /linux-only/);
  assert.throws(() => install.installProtectedRuntime({ ...base, env: { [GATE_ENV]: '1' }, platform: 'linux', arch: 'arm64' }),
    /linux-x64 only \(arch=arm64\)/);
  const verify = { baseDir: '/nonexistent-ags-r2-base', nodeVersion: '24.21.0', archiveSha256: ARCHIVE, expectedNodeSha256: sha('x'),
    releaseSha256: 'c'.repeat(64) };
  assert.throws(() => install.verifyProtectedRuntime({ ...verify, platform: 'linux', arch: 'arm64' }), /linux-x64 only \(arch=arm64\)/);
  assert.throws(() => install.runVerifiedRuntime({ paths: { installRoot: '/nonexistent-ags-r2-base' } }, ['--version'],
    { platform: 'linux', arch: 'ia32' }), /linux-x64 only \(arch=ia32\)/);
});

test('the CLI accepts no pin overrides', () => {
  const source = readFileSync(path.join(REPO, 'scripts/qualification/v06-b3-linux-install.mjs'), 'utf8');
  const cli = source.slice(source.indexOf('if (process.argv[1] && import.meta.url'));
  const names = JSON.parse(/const names = (\[[^\]]+\]);/.exec(cli)[1].replaceAll("'", '"'));
  assert.deepEqual(names, ['base-dir', 'input-dir', 'gpgv', 'tar', 'manifest', 'package-source', 'parent-manifest']);
  assert.doesNotMatch(cli, /trusted[A-Za-z]*Sha256s/);
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

test.skipIf(!liveReady)('live read-only: pinned 0724bb2b source yields the existing root id; existing root re-verified, not reinstalled', () => {
  const source = install.readPackageSource(R2_SOURCE);
  assert.equal(source.hostIntegrationSha256, install.TRUST_PINS.hostIntegrationSha256s[0]);
  assert.equal(source.files.size, 179);
  const id = install.releaseIdV2({ nodeVersion: PINNED.version, archiveSha256: PINNED.releaseSha256, hostIntegrationSha256: source.hostIntegrationSha256 });
  assert.equal(id, LIVE_ID);
  const parents = install.readTrustedParentManifest(process.env.AGS_V06_B3B_R2_PARENT_MANIFEST);
  assert.deepEqual(parents.map((entry) => entry.path).slice(0, 2), ['/usr/lib/agent-governance-suite', '/usr/lib/agent-governance-suite/protected-runtime']);
  const nodeBefore = lstatSync(install.runtimePaths('/usr/lib', id).nodePath, { bigint: true });
  const record = install.verifyProtectedRuntime({ baseDir: '/usr/lib', nodeVersion: PINNED.version, archiveSha256: PINNED.releaseSha256,
    expectedNodeSha256: PINNED.nodeSha256, releaseSha256: id });
  for (const dir of ['/usr/lib/agent-governance-suite', '/usr/lib/agent-governance-suite/protected-runtime']) {
    const entry = parents.find((item) => item.path === dir);
    assert.equal(lstatSync(dir, { bigint: true }).ino.toString(), entry.ino, dir);
  }
  assert.equal(record.package.files.length, 179);
  assert.deepEqual([record.node.identity.uid, record.node.identity.mode, record.node.identity.nlink, record.node.identity.ino],
    [0, '555', 1, nodeBefore.ino.toString()]);
  const used = install.runVerifiedRuntime(record, ['--version']);
  assert.deepEqual([used.fdSha256, used.stdout], [PINNED.nodeSha256, `v${PINNED.version}`]);
  const { installRoot, binDir, nodePath, packageRoot } = record.paths;
  const sample = path.posix.join(packageRoot, 'mcp-server/dist/server.mjs');
  const specs = [...['/usr/lib/agent-governance-suite', '/usr/lib/agent-governance-suite/protected-runtime', installRoot, binDir, packageRoot,
    path.posix.join(packageRoot, 'contracts')].map((dir) => `create=${dir}`),
  `write=${nodePath}`, `write=${path.posix.join(packageRoot, 'host-integration.json')}`, `write=${sample}`,
  ...[installRoot, binDir, nodePath, packageRoot, sample].map((file) => `rename=${file}`),
  `replace=${nodePath}`, `replace=${sample}`, `hardlink=${nodePath}`, `hardlink=${sample}`];
  const link = `/tmp/ags-b3b-r2-hl-${process.pid}`;
  const probe = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', nodePath, '-e', NOBODY_PROBE, link, ...specs], { encoding: 'utf8' });
  const linked = existsSync(link);
  if (linked) unlinkSync(link);
  assert.equal(probe.status, 0, probe.stderr);
  const denied = JSON.parse(probe.stdout);
  process.stdout.write(`V06-b3b-r2 live ${JSON.stringify({ id, hostIntegrationSha256: source.hostIntegrationSha256, contracts: source.contracts,
    node: record.node, packageFiles: record.package.files.length, denied })}\n`);
  assert.equal(linked, false);
  assert.equal(Object.keys(denied).length, specs.length);
  for (const [key, code] of Object.entries(denied)) assert.match(code, /^(EACCES|EPERM)$/, key);
  const nodeAfter = lstatSync(nodePath, { bigint: true });
  assert.deepEqual([nodeAfter.ino, nodeAfter.ctimeNs], [nodeBefore.ino, nodeBefore.ctimeNs]);
  assert.equal(GATE_ENV, 'AGS_V06_B3B_PROTECTED_INSTALL');
});
