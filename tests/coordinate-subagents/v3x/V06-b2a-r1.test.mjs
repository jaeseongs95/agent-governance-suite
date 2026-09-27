import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

import { releaseId, verifyPreparedEvidence } from '../../../scripts/qualification/v06-b2a-windows-stage.mjs';

const evidence = new URL('../../../docs/implementation-3x/evidence/', import.meta.url);
const readJson = (name) => JSON.parse(readFileSync(new URL(name, evidence), 'utf8'));
const stale = readJson('v06-b2a/prepared.json');
const prepared = readJson('v06-b2a-r1/epoch-9542e833/prepared.json');
const epoch = readJson('v06-b2a-r1/epoch-9542e833/epoch.json');

test('stale V06-b2a epoch prepared record is rejected by the new package epoch', () => {
  assert.equal(stale.hostIntegrationSha256, 'c512498add740c23be75e643334b4a55429be873e06b54721e73954332e4457a');
  assert.throws(() => verifyPreparedEvidence(stale), /stale package epoch/);
});

test('new epoch prepared record recomputes the V06-b1 release identity', () => {
  assert.equal(prepared.hostIntegrationSha256, '9542e833bab74614eb5196b37702f082f567381bc16cf84df1171917d2405fed');
  const id = verifyPreparedEvidence(prepared);
  assert.equal(id, releaseId('24.19.0', prepared.archiveSha256, prepared.hostIntegrationSha256));
  assert.notEqual(id, stale.releaseSha256);
  assert.equal(prepared.archiveSha256, stale.archiveSha256);
  assert.equal(prepared.nodeSha256, stale.nodeSha256);
});

test('changed manifest, archive, version, key, tool or identity fields are rejected', () => {
  for (const [field, value, message] of [
    ['hostIntegrationSha256', 'f'.repeat(64), /stale package epoch/],
    ['archiveSha256', 'f'.repeat(64), /release identity mismatch/],
    ['nodeVersion', '24.20.0', /archive or node record mismatch/],
    ['signerFingerprint', 'F'.repeat(40), /untrusted release key/],
    ['keyringSha256', 'f'.repeat(64), /untrusted release key/],
    ['gpgvSha256', 'f'.repeat(64), /tool pin/],
    ['releaseSha256', stale.releaseSha256, /release identity mismatch/],
    ['intendedInstallRoot', stale.intendedInstallRoot, /release identity mismatch/],
    ['status', 'INSTALLED', /PREPARED staging record/],
  ]) assert.throws(() => verifyPreparedEvidence({ ...prepared, [field]: value }), message, field);
});

test('epoch record binds source base, producer and the exact package file set', () => {
  assert.equal(epoch.sourceBase.hostIntegrationSha256, prepared.hostIntegrationSha256);
  assert.match(epoch.sourceBase.commit, /^[a-f0-9]{40}$/);
  assert.match(epoch.sourceBase.tree, /^[a-f0-9]{40}$/);
  assert.match(epoch.producer.baseCommit, /^[a-f0-9]{40}$/);
  assert.match(epoch.producer.dirtyDiffSha256, /^[a-f0-9]{64}$/);
  const paths = epoch.packageFiles.map(({ path }) => path);
  assert.equal(paths.length, prepared.artifactCount + 1);
  assert.equal(new Set(paths.map((name) => name.toLowerCase())).size, paths.length);
  assert.ok(paths.includes('host-integration.json'));
  assert.ok(epoch.packageFiles.every(({ sha256 }) => /^[a-f0-9]{64}$/.test(sha256)));
  assert.equal(epoch.packageFiles.find(({ path }) => path === 'host-integration.json').sha256, prepared.hostIntegrationSha256);
});
