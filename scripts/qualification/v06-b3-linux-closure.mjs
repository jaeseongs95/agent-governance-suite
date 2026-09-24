import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { inspectPackage } from './v06-b2a-windows-stage.mjs';

const CONTRACT_ID = 'ags-protected-node-closure/v2';
const TARGET = 'linux-x64';
const SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';
const KEYRING_SHA256 = '610b8d249da3d5733f5a128def2dd0294dbbf5b5713e6ca2529db8db419dee00';
const GPGV_SHA256 = 'f4d13204d77fdf63c02b0e6742230f83a833128c28f7b715709c2c63a96c427b';
const HOST_MANIFEST_SHA256 = '4d48cb5601b40e29e6306bbacaccec89b03928523342f7ec49541a4ca1e8d483';
const DOCKER_IMAGE = 'sha256:229a2c5bfa27522db7815ea81f9bed70af17ccb9de9fc7ad142b1877b5830d36';
const SOURCE_EPOCH = 'b1825b56458f09fb2cb85d25af75ebf4b0634f5b';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fail = (message) => { throw new Error(message); };

function regularFile(file) {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink()) fail(`not a regular file: ${file}`);
  return readFileSync(file);
}

export function releaseId(version, archiveHash, manifestHash) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.ok(Number(version.split('.')[0]) >= 24, 'Node >=24 required');
  for (const hash of [archiveHash, manifestHash]) assert.match(hash, /^[a-f0-9]{64}$/);
  return sha256(Buffer.from([CONTRACT_ID, TARGET, version, archiveHash, manifestHash, ''].join('\n')));
}

export function signedArchiveDigest(checksums, version) {
  const name = `node-v${version}-linux-x64.tar.xz`;
  const lines = checksums.split(/\r?\n/).filter((line) => line.endsWith(`  ${name}`));
  if (lines.length !== 1) fail('archive checksum entry missing or duplicated');
  const match = /^([a-f0-9]{64}) {2}(node-v\d+\.\d+\.\d+-linux-x64\.tar\.xz)$/.exec(lines[0]);
  if (!match || match[2] !== name) fail('invalid archive checksum entry');
  return match[1];
}

export function verifyRelease(inputDir, version, gpgv) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || Number(version.split('.')[0]) < 24) fail('Node >=24 required');
  if (sha256(regularFile(gpgv)) !== GPGV_SHA256) fail('untrusted gpgv executable');
  const keyring = regularFile(path.join(inputDir, 'nodejs-release-keyring.kbx'));
  if (sha256(keyring) !== KEYRING_SHA256) fail('untrusted release keyring');
  const checksumBytes = regularFile(path.join(inputDir, 'SHASUMS256.txt'));
  const signature = regularFile(path.join(inputDir, 'SHASUMS256.txt.sig'));
  const signatureResult = spawnSync(gpgv, ['--status-fd', '1', '--keyring', './nodejs-release-keyring.kbx',
    './SHASUMS256.txt.sig', '-'], { cwd: inputDir, input: checksumBytes, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const fingerprints = [...(signatureResult.stdout ?? '').matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/gm)];
  if (signatureResult.status !== 0 || fingerprints.length !== 1 || fingerprints[0][1] !== SIGNER) fail('release signature invalid');
  const archiveName = `node-v${version}-linux-x64.tar.xz`;
  const archive = regularFile(path.join(inputDir, archiveName));
  const archiveHash = sha256(archive);
  if (archiveHash !== signedArchiveDigest(checksumBytes.toString('utf8'), version)) fail('archive digest mismatch');
  return { archiveName, archiveHash, archive, keyring, checksumBytes, signature };
}

export function stageLinuxCandidate({ inputDir, packageRoot, outputDir, version, gpgv }) {
  if (process.platform !== 'win32') fail('this Docker Desktop producer requires the Windows host');
  const release = verifyRelease(inputDir, version, gpgv);
  const pkg = inspectPackage(packageRoot, HOST_MANIFEST_SHA256);
  const id = releaseId(version, release.archiveHash, pkg.manifestHash);
  for (const source of [inputDir, packageRoot]) {
    const relative = path.relative(path.resolve(source), path.resolve(outputDir));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) fail('output overlaps source');
  }
  mkdirSync(outputDir);
  for (const [name, bytes] of [['nodejs-release-keyring.kbx', release.keyring],
    ['SHASUMS256.txt', release.checksumBytes], ['SHASUMS256.txt.sig', release.signature],
    [release.archiveName, release.archive]]) writeFileSync(path.join(outputDir, name), bytes, { flag: 'wx' });
  const stagePackage = path.join(outputDir, 'package');
  mkdirSync(stagePackage);
  for (const name of pkg.files) {
    const target = path.join(stagePackage, ...name.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(packageRoot, ...name.split('/')), target);
  }
  inspectPackage(stagePackage, HOST_MANIFEST_SHA256, true);
  if (verifyRelease(outputDir, version, gpgv).archiveHash !== release.archiveHash) fail('staged release changed');
  const inspector = path.join(path.dirname(fileURLToPath(import.meta.url)), 'v06-b3-linux-inspect.py');
  const result = spawnSync('docker', ['run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
    '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--security-opt', 'no-new-privileges',
    '--pids-limit', '128', '--memory', '1g',
    '--tmpfs', '/usr/lib/agent-governance-suite/protected-runtime:rw,exec,nosuid,nodev,size=256m,mode=0700',
    '--mount', `type=bind,source=${path.resolve(outputDir)},target=/stage,readonly`,
    '--mount', `type=bind,source=${inspector},target=/inspector.py,readonly`,
    '--entrypoint', 'python', DOCKER_IMAGE, '/inspector.py', version, release.archiveName,
    release.archiveHash, pkg.manifestHash, id], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) fail(`Docker candidate inspection failed: ${(result.stderr ?? '').trim().slice(0, 2000)}`);
  const observation = JSON.parse(result.stdout.trim());
  if (observation.status !== 'DOCKER_CANDIDATE_OBSERVED' || observation.releaseSha256 !== id
    || observation.packageFiles !== pkg.files.length) fail('Docker candidate evidence mismatch');
  const evidence = {
    contractId: CONTRACT_ID, revision: '2', status: 'DOCKER_CANDIDATE_OBSERVED',
    sourceEpoch: SOURCE_EPOCH, source: `https://nodejs.org/download/release/v${version}/${release.archiveName}`,
    acquiredAtUtc: new Date().toISOString(), archiveName: release.archiveName,
    archiveSha256: release.archiveHash, signerFingerprint: SIGNER, keyringSha256: KEYRING_SHA256,
    hostIntegrationSha256: pkg.manifestHash, artifactCount: pkg.manifest.artifacts.length,
    dockerImageId: DOCKER_IMAGE, ...observation,
    limitations: ['Docker Desktop WSL2 tmpfs candidate only', 'no operating Linux protected install',
      'no V03-h live host qualification'],
  };
  writeFileSync(path.join(outputDir, 'candidate.json'), `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  return evidence;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 10 || args.some((value, index) => index % 2 === 0 && !value.startsWith('--'))) fail('expected --input-dir --package-root --output-dir --version --gpgv');
    const options = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [args[i * 2].slice(2), args[i * 2 + 1]]));
    if (Object.keys(options).length !== 5 || Object.values(options).some((value) => !value)) fail('missing or duplicate option');
    process.stdout.write(`${JSON.stringify(stageLinuxCandidate({ inputDir: options['input-dir'],
      packageRoot: options['package-root'], outputDir: options['output-dir'], version: options.version,
      gpgv: options.gpgv }))}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
