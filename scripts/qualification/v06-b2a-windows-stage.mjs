import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT_ID = 'ags-protected-node-closure/v2';
const TARGET = 'windows-x64';
const SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';
const KEYRING_SHA256 = '610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00';
const HOST_MANIFEST_SHA256 = '4b19b56646bcb7021b7f0084dceebcea42ffcf0480674ace47978ad804bd9241';
const GPGV_SHA256 = 'f4d13204d77fdf63c02b0e6742230f83a833128c28f7b715709c2c63a96c427b';
const TAR_SHA256 = '4e598a8cec84af779e3377442fce2b94b976f614ed4c6e5a665e19308fd1e379';
const HASH = /^[a-f0-9]{64}$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(reason); };

export function verifyPinnedKeyring(bytes) {
  if (sha256(bytes) !== KEYRING_SHA256) fail('untrusted release keyring');
}

export function releaseId(version, archiveHash, manifestHash) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number(version.split('.')[0]) >= 24, 'Node >=24 required');
  assert.match(archiveHash, HASH);
  assert.match(manifestHash, HASH);
  return sha256(Buffer.from([CONTRACT_ID, TARGET, version, archiveHash, manifestHash, ''].join('\n')));
}

export function archiveDigestFromSignedChecksums(checksums, version) {
  const name = `node-v${version}-win-x64.zip`;
  const matches = checksums.split(/\r?\n/).filter((line) => line.endsWith(`  ${name}`));
  if (matches.length !== 1) fail('archive checksum entry missing or duplicated');
  const match = /^([a-f0-9]{64}) {2}(node-v\d+\.\d+\.\d+-win-x64\.zip)$/.exec(matches[0]);
  if (!match || match[2] !== name) fail('invalid archive checksum entry');
  return match[1];
}

export function verifyArchiveBytes(checksums, version, bytes) {
  const digest = sha256(bytes);
  if (digest !== archiveDigestFromSignedChecksums(checksums, version)) fail('archive digest mismatch');
  return digest;
}

function regularFile(file) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`not a regular file: ${file}`);
  return readFileSync(file);
}

function relativeFile(name) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name) || name.startsWith('/')
    || name.split('/').some((part) => !part || part === '.' || part === '..' || part.endsWith('.')
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail(`unsafe artifact path: ${name}`);
  return name;
}

export function inspectPackage(root, expectedManifestHash = HOST_MANIFEST_SHA256, exact = false) {
  const manifestBytes = regularFile(path.join(root, 'host-integration.json'));
  if (sha256(manifestBytes) !== expectedManifestHash) fail('AGS manifest digest mismatch');
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.format !== 'agent-governance-suite.host-integration.v1' || !Array.isArray(manifest.artifacts)) fail('invalid AGS manifest');
  const expected = new Set(['host-integration.json']);
  const names = new Set(['host-integration.json']);
  for (const item of manifest.artifacts) {
    const name = relativeFile(item.path);
    const folded = name.toLowerCase();
    if (names.has(folded) || !/^sha256:[a-f0-9]{64}$/.test(item.sha256)) fail('duplicate artifact path or invalid digest');
    names.add(folded);
    expected.add(name);
    let cursor = root;
    for (const part of name.split('/').slice(0, -1)) {
      cursor = path.join(cursor, part);
      const stat = lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`unsafe artifact parent: ${name}`);
    }
    if (sha256(regularFile(path.join(root, ...name.split('/')))) !== item.sha256.slice(7)) fail(`artifact digest mismatch: ${name}`);
  }
  const requiredIds = ['mcp-server', 'scope-baseline', 'scope-compare', 'acceptance-cli'];
  if (JSON.stringify(manifest.entryPoints?.map(({ id }) => id)) !== JSON.stringify(requiredIds)) fail('entry point set mismatch');
  for (const entry of manifest.entryPoints) {
    if (!expected.has(entry.path) || !Array.isArray(entry.executionClosure)
      || entry.executionClosure.some((name) => !expected.has(name))) fail('entry closure is not in package');
  }
  if (exact) {
    const found = [];
    const visit = (dir, prefix = '') => {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const name = prefix ? `${prefix}/${item.name}` : item.name;
        if (item.isSymbolicLink()) fail(`package symlink: ${name}`);
        if (item.isDirectory()) visit(path.join(dir, item.name), name);
        else if (item.isFile()) found.push(name);
        else fail(`special package file: ${name}`);
      }
    };
    visit(root);
    if (found.length !== expected.size || found.some((name) => !expected.has(name))) fail('extra or missing package file');
  }
  return { manifest, manifestHash: sha256(manifestBytes), files: [...expected].sort() };
}

export function verifyNodeRelease(inputDir, version, gpgv) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || Number(version.split('.')[0]) < 24) fail('Node >=24 required');
  if (sha256(regularFile(gpgv)) !== GPGV_SHA256) fail('untrusted gpgv executable');
  const keyringBytes = regularFile(path.join(inputDir, 'nodejs-release-keyring.kbx'));
  verifyPinnedKeyring(keyringBytes);
  const checksumBytes = regularFile(path.join(inputDir, 'SHASUMS256.txt'));
  const checksums = checksumBytes.toString('utf8');
  const signatureBytes = regularFile(path.join(inputDir, 'SHASUMS256.txt.sig'));
  const result = spawnSync(gpgv, ['--status-fd', '1', '--keyring', './nodejs-release-keyring.kbx',
    './SHASUMS256.txt.sig', '-'], { cwd: inputDir, input: checksumBytes, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const signatures = [...(result.stdout ?? '').matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/gm)];
  if (result.status !== 0 || signatures.length !== 1 || signatures[0][1] !== SIGNER) fail('release checksum signature invalid or signer untrusted');
  const archiveName = `node-v${version}-win-x64.zip`;
  const archive = path.join(inputDir, archiveName);
  const archiveBytes = regularFile(archive);
  const archiveHash = verifyArchiveBytes(checksums, version, archiveBytes);
  return { archiveName, archiveHash, archiveBytes, checksumBytes, signatureBytes, keyringBytes, signerFingerprint: SIGNER };
}

export function stageWindowsCandidate({ inputDir, packageRoot, outputDir, version, gpgv, tar }) {
  if (process.platform !== 'win32') fail('Windows producer only');
  if (sha256(regularFile(tar)) !== TAR_SHA256) fail('untrusted tar executable');
  const release = verifyNodeRelease(inputDir, version, gpgv);
  const pkg = inspectPackage(packageRoot);
  const id = releaseId(version, release.archiveHash, pkg.manifestHash);
  for (const source of [packageRoot, inputDir]) {
    const relation = path.relative(path.resolve(source), path.resolve(outputDir));
    if (!relation || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation))) fail('output overlaps source');
  }
  mkdirSync(outputDir);
  for (const [name, bytes] of [['nodejs-release-keyring.kbx', release.keyringBytes],
    ['SHASUMS256.txt', release.checksumBytes], ['SHASUMS256.txt.sig', release.signatureBytes],
    [release.archiveName, release.archiveBytes]]) writeFileSync(path.join(outputDir, name), bytes, { flag: 'wx' });
  const nodeEntry = `node-v${version}-win-x64/node.exe`;
  const stagedArchive = path.join(outputDir, release.archiveName);
  if (sha256(regularFile(stagedArchive)) !== release.archiveHash) fail('staged archive digest mismatch');
  const extracted = spawnSync(tar, ['-xOf', stagedArchive, nodeEntry], { maxBuffer: 128 * 1024 * 1024 });
  if (extracted.status !== 0 || !extracted.stdout?.length) fail('node.exe archive entry missing or extraction failed');
  writeFileSync(path.join(outputDir, 'node.exe'), extracted.stdout, { flag: 'wx' });
  const nodeHash = sha256(extracted.stdout);
  const nodeResult = spawnSync(path.join(outputDir, 'node.exe'), ['--no-addons', '--no-global-search-paths', '--version'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
  if (nodeResult.status !== 0 || nodeResult.stdout.trim() !== `v${version}`) fail('extracted Node version or required flags mismatch');
  const stagePackage = path.join(outputDir, 'package');
  mkdirSync(stagePackage);
  for (const name of pkg.files) {
    const target = path.join(stagePackage, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(packageRoot, ...name.split('/')), target);
  }
  inspectPackage(stagePackage, pkg.manifestHash, true);
  if (verifyNodeRelease(outputDir, version, gpgv).archiveHash !== release.archiveHash
    || sha256(regularFile(path.join(outputDir, 'node.exe'))) !== nodeHash) fail('staged release bytes changed');
  const evidence = {
    contractId: CONTRACT_ID, revision: '2', status: 'PREPARED', os: 'win32', arch: 'x64',
    nodeVersion: version, archiveName: release.archiveName, archiveSha256: release.archiveHash,
    nodeSha256: nodeHash, signerFingerprint: release.signerFingerprint,
    keyringSha256: KEYRING_SHA256, keyringSourceCommit: '481637f813e912c4aa3622d7964ab426c97b8e8d',
    gpgvSha256: GPGV_SHA256, tarSha256: TAR_SHA256,
    hostIntegrationSha256: pkg.manifestHash, artifactCount: pkg.manifest.artifacts.length,
    releaseSha256: id,
    intendedInstallRoot: `C:\\ProgramData\\agent-governance-suite\\protected-runtime\\${id}`,
    limitations: ['user-writable staging', 'no protected installation', 'no DLL closure', 'no live host qualification'],
  };
  writeFileSync(path.join(outputDir, 'prepared.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 12 || args.some((value, i) => i % 2 === 0 && !value.startsWith('--'))) fail('expected --input-dir --package-root --output-dir --version --gpgv --tar');
    const options = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    if (Object.keys(options).length !== 6) fail('duplicate option');
    const { 'input-dir': inputDir, 'package-root': packageRoot, 'output-dir': outputDir, version, gpgv, tar } = options;
    if ([inputDir, packageRoot, outputDir, version, gpgv, tar].some((value) => !value)) fail('missing option');
    process.stdout.write(`${JSON.stringify(stageWindowsCandidate({ inputDir, packageRoot, outputDir, version, gpgv, tar }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
