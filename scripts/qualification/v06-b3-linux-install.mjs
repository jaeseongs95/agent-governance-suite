import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, readdirSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractNodeBinary, verifyNodeRelease } from './v06-b3-linux-release.mjs';
import { inspectPackage } from './v06-b2a-windows-stage.mjs';

const CONTRACT_ID = 'ags-protected-node-install/v1';
const CLOSURE_CONTRACT_ID = 'ags-protected-node-closure/v2';
const TARGET_ID = 'linux-x64';
const PACKAGE_FILE_MODE = 0o444;
// Trust anchors live in code, never in caller input. hostIntegrationSha256s: host-integration.json of AGS release
// commit 0724bb2bc452626aba546a57d1db5c407d32feb0. parentManifestSha256s: the V06-b3b install manifest that created
// /usr/lib/agent-governance-suite and protected-runtime. v03i/v2: the frozen contract bytes and ids the v2 layout extends.
export const TRUST_PINS = Object.freeze({
  hostIntegrationSha256s: Object.freeze(['648dddda453db17832a776a6d381a747d7af851c2594762bd2f2a494628ce70c']),
  parentManifestSha256s: Object.freeze(['857bad43df354eb2022fcc3355257cd37adaa0a4acca506f2a2a9add0721ce9f']),
  v03i: Object.freeze({ contractId: 'ags-vm-protected-host-installation/v1', revision: '1',
    manifestPath: 'tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json',
    manifestSha256: '0c5bfc700c37cd22b7c15c06f00c916948f1b170a7a0f8cd9da7768eb39ccb19' }),
  v2: Object.freeze({ contractId: 'ags-protected-node-closure/v2', revision: '2', docPath: 'docs/implementation-3x/protected-node-closure-v2.ko.md' }),
});
const RELEASE_ID_INPUTS = Object.freeze(['contractId', 'targetId', 'nodeVersion', 'archiveSha256Hex', 'hostIntegrationSha256Hex']);
export const PINNED = Object.freeze({
  version: '24.21.0',
  releaseSha256: 'fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6',
  keyringSha256: '140f2ad5260fd62773b6243ce8e1d3009645d558f121b8262c55e383dc285932',
  nodeSha256: '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c',
});
export const GATE_ENV = 'AGS_V06_B3B_PROTECTED_INSTALL';
// Directories: root-owned 0755 (no group/other write). Node: root-owned 0555, no write bit for anyone.
const DIR_MODE = 0o755;
const NODE_MODE = 0o555;
const TRUSTED_UIDS = Object.freeze([0]);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(reason); };
const HEX64 = /^[a-f0-9]{64}$/;
// The protected root is a Linux path whatever OS evaluates it, so path math is POSIX only.
const posix = path.posix;

// Linux-only leaf: refuse other platforms before /proc, the ancestor walk or any install write.
function assertLinux(platform) {
  if (platform !== 'linux') fail(`protected runtime install is linux-only (platform=${platform})`);
}

// linux-x64 target only (contract step 1 "exact OS/arch"): checked right after linux-only, before any host access.
function assertX64(arch) {
  if (arch !== 'x64') fail(`protected runtime target is linux-x64 only (arch=${arch})`);
}

export function protectedPaths(baseDir, releaseSha256) {
  if (!posix.isAbsolute(baseDir)) fail('base dir must be absolute');
  if (!HEX64.test(releaseSha256)) fail('release sha256 must be 64 lowercase hex');
  const suiteDir = posix.join(posix.resolve(baseDir), 'agent-governance-suite');
  const runtimeDir = posix.join(suiteDir, 'protected-runtime');
  const releaseDir = posix.join(runtimeDir, releaseSha256);
  return { baseDir: posix.resolve(baseDir), suiteDir, runtimeDir, releaseDir, nodeFile: posix.join(releaseDir, 'node') };
}

function mountPoints() {
  const points = new Set();
  for (const line of readFileSync('/proc/self/mountinfo', 'utf8').split('\n')) {
    const field = line.split(' ')[4];
    if (field) points.add(field.replace(/\\([0-7]{3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8))));
  }
  return points;
}

// Rejects any component that can be swapped by a non-trusted principal: symlink, non-directory,
// untrusted owner, or group/other write. Mount boundaries are recorded for evidence.
export function assessComponent(file, stat, trustedUids = TRUSTED_UIDS) {
  if (stat.isSymbolicLink()) fail(`ancestor is a symlink: ${file}`);
  if (!stat.isDirectory()) fail(`ancestor is not a directory: ${file}`);
  if (!trustedUids.includes(Number(stat.uid))) fail(`ancestor not owned by a trusted uid: ${file}`);
  if (Number(stat.mode) & 0o022) fail(`ancestor is group/other writable: ${file}`);
}

export function inspectAncestors(dir, { trustedUids = TRUSTED_UIDS, platform = process.platform } = {}) {
  assertLinux(platform);
  const resolved = posix.resolve(dir);
  const mounts = mountPoints();
  const chain = [];
  let current = '/';
  for (const part of ['', ...resolved.split('/').filter(Boolean)]) {
    current = part ? posix.join(current, part) : '/';
    const stat = lstatSync(current, { bigint: true });
    assessComponent(current, stat, trustedUids);
    chain.push({ path: current, uid: Number(stat.uid), gid: Number(stat.gid), mode: (Number(stat.mode) & 0o7777).toString(8),
      dev: Number(stat.dev), ino: Number(stat.ino), mountPoint: mounts.has(current) });
  }
  return chain;
}

function identityOf(stat) {
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString(), mode: (Number(stat.mode) & 0o7777).toString(8),
    uid: Number(stat.uid), gid: Number(stat.gid), nlink: Number(stat.nlink), mtimeNs: stat.mtimeNs.toString(), ctimeNs: stat.ctimeNs.toString() };
}

function assessNodeStat(file, stat, trustedUids) {
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`installed node is not a regular file: ${file}`);
  if (!trustedUids.includes(Number(stat.uid))) fail(`installed node not owned by a trusted uid: ${file}`);
  if (Number(stat.mode) & 0o7222) fail(`installed node has write or special mode bits: ${file}`);
  if (Number(stat.nlink) !== 1) fail(`installed node has extra hardlinks (nlink=${stat.nlink}): ${file}`);
}

function readFd(fd, size) {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const read = readSync(fd, buffer, offset, size - offset, offset);
    if (read === 0) fail('installed node truncated while reading');
    offset += read;
  }
  if (readSync(fd, Buffer.alloc(1), 0, 1, size) !== 0) fail('installed node grew while reading');
  return buffer;
}

function lstatOrNull(file) {
  try { return lstatSync(file, { bigint: true }); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function recordCreated(manifestFile, created, file) {
  const stat = lstatSync(file, { bigint: true });
  const entry = { path: file, ino: stat.ino.toString(), type: stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other',
    uid: Number(stat.uid), mode: (Number(stat.mode) & 0o7777).toString(8) };
  created.push(entry);
  if (manifestFile) appendFileSync(manifestFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

// Removes only what this run created, and only while every entry still matches the manifest.
export function rollbackCreated(created) {
  for (const entry of created) {
    const stat = lstatOrNull(entry.path);
    const type = stat && (stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other');
    if (!stat || stat.ino.toString() !== entry.ino || type !== entry.type || Number(stat.uid) !== entry.uid
      || (Number(stat.mode) & 0o7777).toString(8) !== entry.mode) {
      return { removed: false, mismatch: entry.path };
    }
  }
  for (const entry of [...created].reverse()) (entry.type === 'dir' ? rmdirSync : unlinkSync)(entry.path);
  return { removed: true };
}

function ensureDir(dir, created, manifestFile, trustedUids) {
  const existing = lstatOrNull(dir);
  if (existing) { assessComponent(dir, existing, trustedUids); return; }
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, DIR_MODE);
  recordCreated(manifestFile, created, dir);
}

export function installProtectedNode({ baseDir, releaseSha256, nodeBytes, expectedNodeSha256, manifestFile,
  trustedUids = TRUSTED_UIDS, env = process.env, platform = process.platform }) {
  const paths = protectedPaths(baseDir, releaseSha256);
  // Order is part of the contract: /usr gate, then platform, then bytes, and only then host access.
  if ((paths.baseDir === '/usr' || paths.baseDir.startsWith('/usr/')) && env[GATE_ENV] !== '1') {
    fail(`protected system install requires ${GATE_ENV}=1`);
  }
  assertLinux(platform);
  if (sha256(nodeBytes) !== expectedNodeSha256) fail('node bytes do not match the expected archive-extracted sha256');
  inspectAncestors(paths.baseDir, { trustedUids, platform });
  if (lstatOrNull(paths.releaseDir)) fail(`install target already exists: ${paths.releaseDir}`);
  const created = [];
  try {
    ensureDir(paths.suiteDir, created, manifestFile, trustedUids);
    ensureDir(paths.runtimeDir, created, manifestFile, trustedUids);
    inspectAncestors(paths.runtimeDir, { trustedUids, platform });
    mkdirSync(paths.releaseDir, { mode: 0o700 });
    chmodSync(paths.releaseDir, DIR_MODE);
    recordCreated(manifestFile, created, paths.releaseDir);
    const fd = openSync(paths.nodeFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o500);
    try {
      fchmodSync(fd, NODE_MODE);
      recordCreated(manifestFile, created, paths.nodeFile);
      let offset = 0;
      while (offset < nodeBytes.length) offset += writeSync(fd, nodeBytes, offset, nodeBytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    const dirFd = openSync(paths.releaseDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return { paths, created, record: verifyInstalledNode({ baseDir, releaseSha256, expectedNodeSha256, trustedUids, platform }) };
  } catch (error) {
    const rollback = rollbackCreated(created);
    error.message = `${error.message} (rollback ${rollback.removed ? 'removed created paths' : `refused: ${rollback.mismatch} changed`})`;
    throw error;
  }
}

// Verification-time record: full ancestor chain, node identity, and sha256 of the installed bytes.
export function verifyInstalledNode({ baseDir, releaseSha256, expectedNodeSha256, trustedUids = TRUSTED_UIDS,
  platform = process.platform }) {
  const paths = protectedPaths(baseDir, releaseSha256);
  const ancestors = inspectAncestors(paths.releaseDir, { trustedUids, platform });
  const fd = openSync(paths.nodeFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assessNodeStat(paths.nodeFile, stat, trustedUids);
    const digest = sha256(readFd(fd, Number(stat.size)));
    if (digest !== expectedNodeSha256) fail('installed node sha256 does not match the archive-extracted bytes');
    return { paths, ancestors, identity: identityOf(stat), sha256: digest };
  } finally { closeSync(fd); }
}

// Use-time check: reopen, compare identity with the verification record, rehash the same fd,
// and execute that exact open file through its /proc fd link so no path swap can intervene.
export function runVerifiedNode(record, args, { trustedUids = TRUSTED_UIDS, platform = process.platform } = {}) {
  inspectAncestors(record.paths.releaseDir, { trustedUids, platform });
  const fd = openSync(record.paths.nodeFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assessNodeStat(record.paths.nodeFile, stat, trustedUids);
    const now = identityOf(stat);
    for (const key of Object.keys(record.identity)) {
      if (now[key] !== record.identity[key]) fail(`installed node identity changed after verification: ${key}`);
    }
    const fdSha256 = sha256(readFd(fd, Number(stat.size)));
    if (fdSha256 !== record.sha256) fail('installed node bytes changed after verification');
    const result = spawnSync(`/proc/${process.pid}/fd/${fd}`, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 });
    if (result.status !== 0) fail(`verified node execution failed: ${result.stderr ?? result.error?.message ?? ''}`);
    return { fdSha256, stdout: result.stdout.trim() };
  } finally { closeSync(fd); }
}

// ags-protected-node-closure/v2 layout: <installRoot>/bin/node and <installRoot>/package, where the root name is
// SHA-256 over the releaseIdInputs joined by LF with a trailing LF. The functions above keep the V06-b3b layout
// (archive-sha root, <root>/node) only so its evidence root stays verifiable; it is not a v2 candidate.
function assertNodeVersion(nodeVersion) {
  if (typeof nodeVersion !== 'string' || !/^\d+\.\d+\.\d+$/.test(nodeVersion) || Number(nodeVersion.split('.')[0]) < 24) {
    fail('exact Node semver >=24 without a leading v required');
  }
}

export function releaseIdV2({ nodeVersion, archiveSha256, hostIntegrationSha256 }) {
  assertNodeVersion(nodeVersion);
  if (!HEX64.test(archiveSha256) || !HEX64.test(hostIntegrationSha256)) fail('release id inputs must be 64 lowercase hex');
  const preimage = `${[CLOSURE_CONTRACT_ID, TARGET_ID, nodeVersion, archiveSha256, hostIntegrationSha256].join('\n')}\n`;
  return sha256(Buffer.from(preimage, 'utf8'));
}

export function runtimePaths(baseDir, releaseSha256) {
  const { baseDir: base, suiteDir, runtimeDir, releaseDir: installRoot } = protectedPaths(baseDir, releaseSha256);
  const binDir = posix.join(installRoot, 'bin');
  return { baseDir: base, suiteDir, runtimeDir, installRoot, binDir, nodePath: posix.join(binDir, 'node'),
    packageRoot: posix.join(installRoot, 'package') };
}

function readRegularNoFollow(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile()) fail(`not a regular file: ${file}`);
    return { stat, bytes: readFd(fd, Number(stat.size)) };
  } finally { closeSync(fd); }
}

// Source inputs must be unchangeable by anyone but a trusted uid: every directory from the source root to the file
// and the file itself are lstat-checked (no symlink, trusted owner, no group/other write; files regular, nlink 1),
// then read through an O_NOFOLLOW fd whose dev/ino must match the lstat.
function readTrustedSourceFile(sourceRoot, rel, trustedUids) {
  const parts = rel.split('/');
  if (!parts.length || parts.some((part) => !part || part === '.' || part === '..')) fail(`untrusted source input path: ${rel}`);
  let current = sourceRoot;
  for (const part of parts.slice(0, -1)) {
    current = posix.join(current, part);
    try { assessComponent(current, lstatSync(current, { bigint: true }), trustedUids); } catch (error) { fail(`untrusted source input: ${error.message}`); }
  }
  const file = posix.join(sourceRoot, rel);
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || !trustedUids.includes(Number(stat.uid)) || (Number(stat.mode) & 0o022) || Number(stat.nlink) !== 1) {
    fail(`untrusted source input: ${rel} must be a regular trusted-owner file without group/other write and nlink 1`);
  }
  const read = readRegularNoFollow(file);
  if (read.stat.dev !== stat.dev || read.stat.ino !== stat.ino) fail(`untrusted source input changed while reading: ${rel}`);
  return read.bytes;
}

function contractBlock(markdown) {
  const match = /<!-- protected-node-closure-contract -->\s*```json\n([\s\S]*?)\n```/.exec(markdown);
  if (!match) fail('v2 contract block missing');
  return JSON.parse(match[1]);
}

// Contract step 1: the V03-i v1 pin and the v2 id/revision/layout are read from the trusted source and compared
// with the code pins before any package byte is trusted.
function verifyContractPins(sourceRoot, trustedUids) {
  const v03iBytes = readTrustedSourceFile(sourceRoot, TRUST_PINS.v03i.manifestPath, trustedUids);
  if (sha256(v03iBytes) !== TRUST_PINS.v03i.manifestSha256) fail('V03-i v1 manifest digest does not match its pin');
  const v03i = JSON.parse(v03iBytes.toString('utf8'));
  if (v03i.contractId !== TRUST_PINS.v03i.contractId || v03i.revision !== TRUST_PINS.v03i.revision) fail('V03-i v1 id or revision mismatch');
  const v2 = contractBlock(readTrustedSourceFile(sourceRoot, TRUST_PINS.v2.docPath, trustedUids).toString('utf8'));
  const target = v2.targets?.[TARGET_ID];
  if (v2.contractId !== TRUST_PINS.v2.contractId || v2.revision !== TRUST_PINS.v2.revision
    || v2.extends?.contractId !== TRUST_PINS.v03i.contractId || v2.extends?.revision !== TRUST_PINS.v03i.revision
    || JSON.stringify(v2.releaseIdInputs) !== JSON.stringify(RELEASE_ID_INPUTS) || v2.nodeEngine !== '>=24'
    || target?.os !== 'linux' || target?.arch !== 'x64' || target?.node !== 'bin/node' || target?.package !== 'package'
    || target?.installRoot !== '/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>') {
    fail('v2 contract id, revision, release id inputs or linux-x64 layout differ from the pinned contract');
  }
  return { v03i: { contractId: v03i.contractId, revision: v03i.revision, manifestSha256: TRUST_PINS.v03i.manifestSha256 },
    v2: { contractId: v2.contractId, revision: v2.revision } };
}

function assertTrustedHostIntegration(hostIntegrationSha256, trusted) {
  if (!Array.isArray(trusted) || !trusted.includes(hostIntegrationSha256)) {
    fail(`host-integration.json sha256 ${hostIntegrationSha256} is not a trusted AGS release pin`);
  }
}

// Trusted source: a root-only tree holding the exact AGS release bytes. The host-integration digest is computed from
// those bytes and must equal a code pin; no caller-supplied digest is accepted.
export function readPackageSource(sourceRoot, { trustedUids = TRUSTED_UIDS, platform = process.platform,
  trustedHostIntegrationSha256s = TRUST_PINS.hostIntegrationSha256s } = {}) {
  if (typeof sourceRoot !== 'string' || !posix.isAbsolute(sourceRoot)) fail('package source must be absolute');
  inspectAncestors(sourceRoot, { trustedUids, platform });
  const contracts = verifyContractPins(sourceRoot, trustedUids);
  const hostBytes = readTrustedSourceFile(sourceRoot, 'host-integration.json', trustedUids);
  const hostIntegrationSha256 = sha256(hostBytes);
  assertTrustedHostIntegration(hostIntegrationSha256, trustedHostIntegrationSha256s);
  const listed = JSON.parse(hostBytes.toString('utf8')).artifacts;
  if (!Array.isArray(listed)) fail('invalid AGS manifest');
  const files = new Map([['host-integration.json', hostBytes]]);
  for (const item of listed) files.set(item.path, readTrustedSourceFile(sourceRoot, String(item.path), trustedUids));
  // Every input is now known to be root-only; the shared package check then validates paths, entry points and digests.
  const { manifest } = inspectPackage(sourceRoot, hostIntegrationSha256, false);
  for (const item of manifest.artifacts) {
    if (sha256(files.get(item.path)) !== item.sha256.slice(7)) fail(`artifact digest mismatch: ${item.path}`);
  }
  if (sha256(readTrustedSourceFile(sourceRoot, 'host-integration.json', trustedUids)) !== hostIntegrationSha256) {
    fail('host-integration.json changed while reading the package source');
  }
  return { hostIntegrationSha256, manifest, files, contracts };
}

// Parent reuse evidence: a root-only install manifest file (trusted owner, no group/other write, nlink 1, under a
// trusted ancestor chain containing a directory closed to group/other) whose sha256 is a code pin.
export function readTrustedParentManifest(file, { trustedUids = TRUSTED_UIDS, platform = process.platform,
  trustedParentManifestSha256s = TRUST_PINS.parentManifestSha256s } = {}) {
  if (typeof file !== 'string' || !posix.isAbsolute(file)) fail('untrusted parent manifest: path must be absolute');
  let chain;
  try { chain = inspectAncestors(posix.dirname(file), { trustedUids, platform }); } catch (error) {
    fail(`untrusted parent manifest: ${error.message}`);
  }
  if (!chain.some((entry) => (parseInt(entry.mode, 8) & 0o077) === 0)) fail('untrusted parent manifest: no root-only (0700) ancestor');
  const stat = lstatSync(file, { bigint: true });
  if (!stat.isFile() || !trustedUids.includes(Number(stat.uid)) || (Number(stat.mode) & 0o022) || Number(stat.nlink) !== 1) {
    fail('untrusted parent manifest: must be a regular trusted-owner file without group/other write and nlink 1');
  }
  const { stat: opened, bytes } = readRegularNoFollow(file);
  if (opened.ino !== stat.ino || opened.dev !== stat.dev) fail('untrusted parent manifest: changed while reading');
  if (!Array.isArray(trustedParentManifestSha256s) || !trustedParentManifestSha256s.includes(sha256(bytes))) {
    fail('parent manifest is not a trusted install pin');
  }
  return bytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function ensureParent(dir, created, manifestFile, trustedUids, parentEntries) {
  const existing = lstatOrNull(dir);
  if (!existing) { ensureDir(dir, created, manifestFile, trustedUids); return; }
  assessComponent(dir, existing, trustedUids);
  const entry = parentEntries.find((item) => item.path === dir);
  if (!entry || entry.type !== 'dir' || entry.ino !== existing.ino.toString() || entry.uid !== Number(existing.uid)
    || entry.mode !== (Number(existing.mode) & 0o7777).toString(8)) {
    fail(`existing protected parent does not match its install manifest: ${dir}`);
  }
}

function makeDir(dir, created, manifestFile) {
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, DIR_MODE);
  recordCreated(manifestFile, created, dir);
}

function writeProtectedFile(file, bytes, mode, created, manifestFile) {
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
  try {
    fchmodSync(fd, mode);
    recordCreated(manifestFile, created, file);
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally { closeSync(fd); }
}

export function installProtectedRuntime({ baseDir, nodeVersion, archiveSha256, nodeBytes, expectedNodeSha256, packageSource,
  manifestFile, parentManifestFile, parentManifestEntries, trustedHostIntegrationSha256s = TRUST_PINS.hostIntegrationSha256s,
  trustedParentManifestSha256s = TRUST_PINS.parentManifestSha256s, trustedUids = TRUSTED_UIDS, env = process.env,
  platform = process.platform, arch = process.arch }) {
  // Order is part of the contract: /usr gate, then platform, then pure input checks, and only then host access.
  if (typeof baseDir !== 'string' || !posix.isAbsolute(baseDir)) fail('base dir must be absolute');
  const base = posix.resolve(baseDir);
  if ((base === '/usr' || base.startsWith('/usr/')) && env[GATE_ENV] !== '1') fail(`protected system install requires ${GATE_ENV}=1`);
  assertLinux(platform);
  assertX64(arch);
  if (parentManifestEntries !== undefined) fail('caller-supplied parent entries are not accepted; pass a pinned parentManifestFile');
  assertNodeVersion(nodeVersion);
  if (!HEX64.test(archiveSha256)) fail('archive sha256 must be 64 lowercase hex');
  if (sha256(nodeBytes) !== expectedNodeSha256) fail('node bytes do not match the expected archive-extracted sha256');
  const source = readPackageSource(packageSource, { trustedUids, platform, trustedHostIntegrationSha256s });
  const parents = parentManifestFile === undefined ? []
    : readTrustedParentManifest(parentManifestFile, { trustedUids, platform, trustedParentManifestSha256s });
  const releaseSha256 = releaseIdV2({ nodeVersion, archiveSha256, hostIntegrationSha256: source.hostIntegrationSha256 });
  const paths = runtimePaths(base, releaseSha256);
  inspectAncestors(paths.baseDir, { trustedUids, platform });
  if (lstatOrNull(paths.installRoot)) fail(`install target already exists: ${paths.installRoot}`);
  const created = [];
  try {
    ensureParent(paths.suiteDir, created, manifestFile, trustedUids, parents);
    ensureParent(paths.runtimeDir, created, manifestFile, trustedUids, parents);
    inspectAncestors(paths.runtimeDir, { trustedUids, platform });
    makeDir(paths.installRoot, created, manifestFile);
    makeDir(paths.binDir, created, manifestFile);
    writeProtectedFile(paths.nodePath, nodeBytes, NODE_MODE, created, manifestFile);
    makeDir(paths.packageRoot, created, manifestFile);
    const dirs = new Set();
    for (const name of [...source.files.keys()].sort()) {
      const parts = name.split('/');
      for (let i = 1; i < parts.length; i += 1) {
        const dir = parts.slice(0, i).join('/');
        if (!dirs.has(dir)) { dirs.add(dir); makeDir(posix.join(paths.packageRoot, dir), created, manifestFile); }
      }
      writeProtectedFile(posix.join(paths.packageRoot, name), source.files.get(name), PACKAGE_FILE_MODE, created, manifestFile);
    }
    const dirFd = openSync(paths.installRoot, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    return { paths, created, record: verifyProtectedRuntime({ baseDir: base, nodeVersion, archiveSha256, expectedNodeSha256,
      releaseSha256, trustedHostIntegrationSha256s, trustedUids, platform, arch }), source: { hostIntegrationSha256: source.hostIntegrationSha256,
      contracts: source.contracts } };
  } catch (error) {
    const rollback = rollbackCreated(created);
    error.message = `${error.message} (rollback ${rollback.removed ? 'removed created paths' : `refused: ${rollback.mismatch} changed`})`;
    throw error;
  }
}

function assertEntries(dir, expected) {
  const found = readdirSync(dir).sort();
  if (JSON.stringify(found) !== JSON.stringify(expected)) fail(`install root entries differ from ${JSON.stringify(expected)}: ${dir}`);
}

function assessPackageFile(file, stat, trustedUids) {
  if (!stat.isFile()) fail(`package entry is not a regular file: ${file}`);
  if (!trustedUids.includes(Number(stat.uid))) fail(`package file not owned by a trusted uid: ${file}`);
  if (Number(stat.mode) & 0o7222) fail(`package file has write or special mode bits: ${file}`);
  if (Number(stat.nlink) !== 1) fail(`package file has extra hardlinks (nlink=${stat.nlink}): ${file}`);
}

function walkPackage(root, trustedUids) {
  const dirs = [];
  const files = [];
  const visit = (dir, prefix) => {
    for (const name of readdirSync(dir).sort()) {
      const rel = prefix ? `${prefix}/${name}` : name;
      const full = posix.join(dir, name);
      const stat = lstatSync(full, { bigint: true });
      if (stat.isSymbolicLink()) fail(`package symlink: ${rel}`);
      if (stat.isDirectory()) { assessComponent(full, stat, trustedUids); dirs.push(rel); visit(full, rel); }
      else if (stat.isFile()) files.push(rel);
      else fail(`special package file: ${rel}`);
    }
  };
  visit(root, '');
  return { dirs, files };
}

// Verification-time record: recomputed root id, ancestors, bin/node identity and bytes, and the exact package set.
export function verifyProtectedRuntime({ baseDir, nodeVersion, archiveSha256, expectedNodeSha256, releaseSha256,
  trustedHostIntegrationSha256s = TRUST_PINS.hostIntegrationSha256s, trustedUids = TRUSTED_UIDS, platform = process.platform,
  arch = process.arch }) {
  assertLinux(platform);
  assertX64(arch);
  const paths = runtimePaths(baseDir, releaseSha256);
  const ancestors = inspectAncestors(paths.installRoot, { trustedUids, platform });
  assertEntries(paths.installRoot, ['bin', 'package']);
  for (const dir of [paths.binDir, paths.packageRoot]) assessComponent(dir, lstatSync(dir, { bigint: true }), trustedUids);
  assertEntries(paths.binDir, ['node']);
  const host = readRegularNoFollow(posix.join(paths.packageRoot, 'host-integration.json'));
  const hostIntegrationSha256 = sha256(host.bytes);
  assertTrustedHostIntegration(hostIntegrationSha256, trustedHostIntegrationSha256s);
  if (releaseIdV2({ nodeVersion, archiveSha256, hostIntegrationSha256 }) !== releaseSha256) {
    fail('install root name does not match the combined release id');
  }
  const { manifest } = inspectPackage(paths.packageRoot, hostIntegrationSha256, true);
  const { files } = walkPackage(paths.packageRoot, trustedUids);
  const packageFiles = files.map((rel) => {
    const { stat, bytes } = readRegularNoFollow(posix.join(paths.packageRoot, rel));
    assessPackageFile(rel, stat, trustedUids);
    const digest = sha256(bytes);
    const expected = rel === 'host-integration.json' ? hostIntegrationSha256
      : manifest.artifacts.find((item) => item.path === rel)?.sha256.slice(7);
    if (digest !== expected) fail(`artifact digest mismatch: ${rel}`);
    return { path: rel, identity: identityOf(stat), sha256: digest };
  });
  if (packageFiles.length !== manifest.artifacts.length + 1) fail('extra or missing package file');
  const fd = openSync(paths.nodePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assessNodeStat(paths.nodePath, stat, trustedUids);
    const digest = sha256(readFd(fd, Number(stat.size)));
    if (digest !== expectedNodeSha256) fail('installed node sha256 does not match the archive-extracted bytes');
    return { paths, releaseSha256, releaseIdInputs: { contractId: CLOSURE_CONTRACT_ID, targetId: TARGET_ID, nodeVersion,
      archiveSha256Hex: archiveSha256, hostIntegrationSha256Hex: hostIntegrationSha256 }, hostIntegrationSha256, ancestors,
    node: { identity: identityOf(stat), sha256: digest }, package: { files: packageFiles } };
  } finally { closeSync(fd); }
}

function sameIdentity(now, recorded, label) {
  for (const key of Object.keys(recorded)) if (now[key] !== recorded[key]) fail(`${label} identity changed after verification: ${key}`);
}

// Use-time check: re-verify ancestors, every package file and bin/node against the record by identity and hash,
// then execute the verified node fd with the contract flags and an empty environment.
export function runVerifiedRuntime(record, args, { trustedUids = TRUSTED_UIDS, platform = process.platform,
  arch = process.arch } = {}) {
  assertLinux(platform);
  assertX64(arch);
  inspectAncestors(record.paths.installRoot, { trustedUids, platform });
  for (const file of record.package.files) {
    const { stat, bytes } = readRegularNoFollow(posix.join(record.paths.packageRoot, file.path));
    assessPackageFile(file.path, stat, trustedUids);
    sameIdentity(identityOf(stat), file.identity, `package file ${file.path}`);
    if (sha256(bytes) !== file.sha256) fail(`package file bytes changed after verification: ${file.path}`);
  }
  const fd = openSync(record.paths.nodePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    assessNodeStat(record.paths.nodePath, stat, trustedUids);
    sameIdentity(identityOf(stat), record.node.identity, 'installed node');
    const fdSha256 = sha256(readFd(fd, Number(stat.size)));
    if (fdSha256 !== record.node.sha256) fail('installed node bytes changed after verification');
    const result = spawnSync(`/proc/${process.pid}/fd/${fd}`, ['--no-addons', '--no-global-search-paths', ...args],
      { encoding: 'utf8', env: {}, maxBuffer: 1024 * 1024 });
    if (result.status !== 0) fail(`verified node execution failed: ${result.stderr ?? result.error?.message ?? ''}`);
    return { fdSha256, stdout: result.stdout.trim() };
  } finally { closeSync(fd); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const names = ['base-dir', 'input-dir', 'gpgv', 'tar', 'manifest', 'package-source', 'parent-manifest'];
    if (args.length !== names.length * 2 || args.some((value, i) => i % 2 === 0 && !names.includes(value.slice(2)))) {
      fail(`expected ${names.map((name) => `--${name}`).join(' ')}`);
    }
    const options = Object.fromEntries(Array.from({ length: names.length }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    if (Object.keys(options).length !== names.length || names.some((name) => !options[name])) fail('missing or duplicate option');
    const { 'base-dir': baseDir, 'input-dir': inputDir, gpgv, tar, manifest, 'package-source': packageSource } = options;
    const release = verifyNodeRelease(inputDir, PINNED.version, gpgv, PINNED.keyringSha256);
    if (release.archiveHash !== PINNED.releaseSha256) fail('archive sha256 differs from the pinned release');
    const { nodeBytes, nodeSha256 } = extractNodeBinary(path.join(inputDir, release.archiveName), tar, PINNED.version);
    if (nodeSha256 !== PINNED.nodeSha256) fail('extracted node sha256 differs from the pinned value');
    const { record } = installProtectedRuntime({ baseDir, nodeVersion: PINNED.version, archiveSha256: release.archiveHash,
      nodeBytes, expectedNodeSha256: nodeSha256, packageSource, manifestFile: manifest, parentManifestFile: options['parent-manifest'] });
    const used = runVerifiedRuntime(record, ['--version']);
    process.stdout.write(`${JSON.stringify({ contractId: CLOSURE_CONTRACT_ID, installContractId: CONTRACT_ID,
      status: 'CANDIDATE_HOST_INSTALLED', releaseSha256: record.releaseSha256, releaseIdInputs: record.releaseIdInputs,
      installRoot: record.paths.installRoot, nodePath: record.paths.nodePath, packageRoot: record.paths.packageRoot,
      nodeIdentity: record.node.identity, archiveNodeSha256: nodeSha256, installedSha256: record.node.sha256,
      packageFileCount: record.package.files.length, fdSha256: used.fdSha256, version: used.stdout,
      limitations: ['candidate-host-only', 'not-production-host-qualified', 'no-fresh-disk-or-secure-erase-claim',
        'no-loader-closure-measurement'] })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
