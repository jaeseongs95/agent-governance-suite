import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, readSync, rmdirSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { extractNodeBinary, verifyNodeRelease } from './v06-b3-linux-release.mjs';

const CONTRACT_ID = 'ags-protected-node-install/v1';
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

export function protectedPaths(baseDir, releaseSha256) {
  if (!path.isAbsolute(baseDir)) fail('base dir must be absolute');
  if (!HEX64.test(releaseSha256)) fail('release sha256 must be 64 lowercase hex');
  const suiteDir = path.join(path.resolve(baseDir), 'agent-governance-suite');
  const runtimeDir = path.join(suiteDir, 'protected-runtime');
  const releaseDir = path.join(runtimeDir, releaseSha256);
  return { baseDir: path.resolve(baseDir), suiteDir, runtimeDir, releaseDir, nodeFile: path.join(releaseDir, 'node') };
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

export function inspectAncestors(dir, { trustedUids = TRUSTED_UIDS } = {}) {
  const resolved = path.resolve(dir);
  const mounts = mountPoints();
  const chain = [];
  let current = '/';
  for (const part of ['', ...resolved.split('/').filter(Boolean)]) {
    current = part ? path.join(current, part) : '/';
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
  trustedUids = TRUSTED_UIDS, env = process.env }) {
  const paths = protectedPaths(baseDir, releaseSha256);
  if ((paths.baseDir === '/usr' || paths.baseDir.startsWith('/usr/')) && env[GATE_ENV] !== '1') {
    fail(`protected system install requires ${GATE_ENV}=1`);
  }
  if (sha256(nodeBytes) !== expectedNodeSha256) fail('node bytes do not match the expected archive-extracted sha256');
  inspectAncestors(paths.baseDir, { trustedUids });
  if (lstatOrNull(paths.releaseDir)) fail(`install target already exists: ${paths.releaseDir}`);
  const created = [];
  try {
    ensureDir(paths.suiteDir, created, manifestFile, trustedUids);
    ensureDir(paths.runtimeDir, created, manifestFile, trustedUids);
    inspectAncestors(paths.runtimeDir, { trustedUids });
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
    return { paths, created, record: verifyInstalledNode({ baseDir, releaseSha256, expectedNodeSha256, trustedUids }) };
  } catch (error) {
    const rollback = rollbackCreated(created);
    error.message = `${error.message} (rollback ${rollback.removed ? 'removed created paths' : `refused: ${rollback.mismatch} changed`})`;
    throw error;
  }
}

// Verification-time record: full ancestor chain, node identity, and sha256 of the installed bytes.
export function verifyInstalledNode({ baseDir, releaseSha256, expectedNodeSha256, trustedUids = TRUSTED_UIDS }) {
  const paths = protectedPaths(baseDir, releaseSha256);
  const ancestors = inspectAncestors(paths.releaseDir, { trustedUids });
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
export function runVerifiedNode(record, args, { trustedUids = TRUSTED_UIDS } = {}) {
  inspectAncestors(record.paths.releaseDir, { trustedUids });
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

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 10 || args.some((value, i) => i % 2 === 0 && !value.startsWith('--'))) {
      fail('expected --base-dir --input-dir --gpgv --tar --manifest');
    }
    const options = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    const { 'base-dir': baseDir, 'input-dir': inputDir, gpgv, tar, manifest } = options;
    if ([baseDir, inputDir, gpgv, tar, manifest].some((value) => !value)) fail('missing option');
    const release = verifyNodeRelease(inputDir, PINNED.version, gpgv, PINNED.keyringSha256);
    if (release.archiveHash !== PINNED.releaseSha256) fail('archive sha256 differs from the pinned release');
    const { nodeBytes, nodeSha256 } = extractNodeBinary(path.join(inputDir, release.archiveName), tar, PINNED.version);
    if (nodeSha256 !== PINNED.nodeSha256) fail('extracted node sha256 differs from the pinned value');
    const { record } = installProtectedNode({ baseDir, releaseSha256: release.archiveHash, nodeBytes,
      expectedNodeSha256: nodeSha256, manifestFile: manifest });
    const used = runVerifiedNode(record, ['--version']);
    process.stdout.write(`${JSON.stringify({ contractId: CONTRACT_ID, status: 'CANDIDATE_HOST_INSTALLED',
      nodeFile: record.paths.nodeFile, identity: record.identity, archiveNodeSha256: nodeSha256, installedSha256: record.sha256,
      fdSha256: used.fdSha256, version: used.stdout,
      limitations: ['candidate-host-only', 'not-production-host-qualified', 'no-fresh-disk-or-secure-erase-claim'] })}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
