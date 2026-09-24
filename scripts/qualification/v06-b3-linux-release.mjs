import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONTRACT_ID = 'ags-protected-node-closure/v2';
const TARGET = 'linux-x64';
const DIST_BASE = 'https://nodejs.org/dist';
const SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';
const ARCHIVE_URL_RE = /^https:\/\/nodejs\.org\/dist\/v(\d+\.\d+\.\d+)\/node-v(\d+\.\d+\.\d+)-linux-x64\.tar\.xz$/;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (reason) => { throw new Error(reason); };

function assertExactVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) fail('exact Node semver required, not an alias such as "latest"');
  if (Number(version.split('.')[0]) < 24) fail('Node >=24 required');
}

export function nodeReleaseUrls(version) {
  assertExactVersion(version);
  const dir = `${DIST_BASE}/v${version}`;
  const archiveName = `node-v${version}-linux-x64.tar.xz`;
  return {
    archiveName,
    archiveUrl: `${dir}/${archiveName}`,
    checksumsUrl: `${dir}/SHASUMS256.txt`,
    signatureUrl: `${dir}/SHASUMS256.txt.sig`,
  };
}

export function assertVersionedArchiveUrl(url, version) {
  assertExactVersion(version);
  const match = ARCHIVE_URL_RE.exec(url);
  if (!match || match[1] !== version || match[2] !== version) {
    fail('archive URL must be the exact versioned nodejs.org linux-x64 release, not a "latest" alias or a mismatched version/arch/OS URL');
  }
  return url;
}

export function verifyPinnedKeyring(bytes, expectedKeyringSha256) {
  if (sha256(bytes) !== expectedKeyringSha256) fail('untrusted release keyring');
}

export function archiveDigestFromSignedChecksums(checksums, version) {
  const name = `node-v${version}-linux-x64.tar.xz`;
  const matches = checksums.split(/\r?\n/).filter((line) => line.endsWith(`  ${name}`));
  if (matches.length !== 1) fail('archive checksum entry missing or duplicated');
  const match = /^([a-f0-9]{64}) {2}(node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz)$/.exec(matches[0]);
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

export function verifyNodeRelease(inputDir, version, gpgv, expectedKeyringSha256) {
  assertExactVersion(version);
  const keyringBytes = regularFile(path.join(inputDir, 'nodejs-release-keyring.kbx'));
  verifyPinnedKeyring(keyringBytes, expectedKeyringSha256);
  const checksumBytes = regularFile(path.join(inputDir, 'SHASUMS256.txt'));
  const checksums = checksumBytes.toString('utf8');
  const signatureBytes = regularFile(path.join(inputDir, 'SHASUMS256.txt.sig'));
  const result = spawnSync(gpgv, ['--status-fd', '1', '--keyring', './nodejs-release-keyring.kbx',
    './SHASUMS256.txt.sig', '-'], { cwd: inputDir, input: checksumBytes, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const signatures = [...(result.stdout ?? '').matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/gm)];
  if (result.status !== 0 || signatures.length !== 1 || signatures[0][1] !== SIGNER) fail('release checksum signature invalid or signer untrusted');
  const archiveName = `node-v${version}-linux-x64.tar.xz`;
  const archiveBytes = regularFile(path.join(inputDir, archiveName));
  const archiveHash = verifyArchiveBytes(checksums, version, archiveBytes);
  return { archiveName, archiveHash, archiveBytes, checksumBytes, signatureBytes, keyringBytes, signerFingerprint: SIGNER };
}

export function extractNodeBinary(archiveFile, tar, version) {
  assertExactVersion(version);
  const entry = `node-v${version}-linux-x64/bin/node`;
  const extracted = spawnSync(tar, ['-xJOf', archiveFile, entry], { maxBuffer: 256 * 1024 * 1024 });
  if (extracted.status !== 0 || !extracted.stdout?.length) fail('bin/node archive entry missing or extraction failed');
  const nodeBytes = extracted.stdout;
  return { nodeBytes, nodeSha256: sha256(nodeBytes) };
}

export function runExtractedNode(nodeFile, args) {
  const result = spawnSync(nodeFile, ['--no-addons', '--no-global-search-paths', ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.status !== 0) fail(`extracted node execution failed: ${result.stderr ?? ''}`);
  return result.stdout.trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 8 || args.some((value, i) => i % 2 === 0 && !value.startsWith('--'))) {
      fail('expected --input-dir --version --gpgv --keyring-sha256');
    }
    const options = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    if (Object.keys(options).length !== 4) fail('duplicate option');
    const { 'input-dir': inputDir, version, gpgv, 'keyring-sha256': keyringSha256 } = options;
    if ([inputDir, version, gpgv, keyringSha256].some((value) => !value)) fail('missing option');
    const urls = nodeReleaseUrls(version);
    assertVersionedArchiveUrl(urls.archiveUrl, version);
    const release = verifyNodeRelease(inputDir, version, gpgv, keyringSha256);
    const report = {
      contractId: CONTRACT_ID, target: TARGET, status: 'CANDIDATE_VERIFIED_LIVE_PENDING',
      nodeVersion: version, archiveUrl: urls.archiveUrl, archiveName: release.archiveName,
      archiveSha256: release.archiveHash, signerFingerprint: release.signerFingerprint,
      limitations: ['signed-release-verification-only', 'no-protected-installation', 'no-elf-closure-measurement'],
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
