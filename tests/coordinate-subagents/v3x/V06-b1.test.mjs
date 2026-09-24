import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { PROTECTED_HOST_CONTRACT as READER_PIN } from '../../../mcp-server/src/host-integration/vm-model-policy.ts';
import { PROTECTED_HOST_CONTRACT as PREFLIGHT_PIN } from '../../../scripts/qualification/vm-transport-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (name) => readFileSync(path.join(root, name));
const json = (name) => JSON.parse(read(name).toString('utf8'));
const sha256 = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const doc = read('docs/implementation-3x/protected-node-closure-v2.ko.md').toString('utf8');
const match = doc.match(/<!-- protected-node-closure-contract -->\s*```json\s*([\s\S]*?)\s*```/);
assert.ok(match, 'normative contract block must be present');
const contract = JSON.parse(match[1]);

test('v2 is an additive contract; V03-i authority and both V03-j pins remain frozen', () => {
  const base = json('tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json');
  assert.deepEqual(contract.extends, { contractId: base.contractId, revision: base.revision });
  assert.equal(contract.contractId, 'ags-protected-node-closure/v2');
  assert.equal(contract.revision, '2');
  assert.equal(base.authority.sha256, sha256(read(base.authority.path)));
  assert.equal(sha256(read('tests/coordinate-subagents/v3x/fixtures/protected-host-installation/manifest.json')),
    'sha256:0c5bfc700c37cd22b7c15c06f00c916948f1b170a7a0f8cd9da7768eb39ccb19');
  assert.equal(PREFLIGHT_PIN.id, READER_PIN.id);
  assert.equal(PREFLIGHT_PIN.revision, READER_PIN.revision);
  assert.equal(PREFLIGHT_PIN.manifestSha256, READER_PIN.manifestSha256);
  assert.equal(PREFLIGHT_PIN.profilesSha256,
    'sha256:fdd8677983d4aaf3d4d2ae8809a009a48643f5f047a4787b7940c5f4701d4b82');
  assert.deepEqual(READER_PIN, {
    id: base.contractId,
    revision: base.revision,
    manifestSha256: 'sha256:0c5bfc700c37cd22b7c15c06f00c916948f1b170a7a0f8cd9da7768eb39ccb19',
  });
});

test('both independent producers receive the same version, entry and manifest requirements', () => {
  const host = json('host-integration.json');
  const pkg = json('package.json');
  assert.equal(contract.nodeEngine, pkg.engines.node);
  assert.equal(contract.nodeEngine, '>=24');
  assert.deepEqual(Object.keys(contract.targets).sort(), ['linux-x64', 'windows-x64']);
  assert.deepEqual(Object.values(contract.targets).map(({ os, arch }) => `${os}-${arch}`).sort(),
    ['linux-x64', 'win32-x64']);
  assert.equal(contract.targets['windows-x64'].archive, 'node-v<version>-win-x64.zip');
  assert.equal(contract.targets['linux-x64'].archive, 'node-v<version>-linux-x64.tar.xz');
  assert.equal(contract.targets['windows-x64'].installRoot,
    'C:\\ProgramData\\agent-governance-suite\\protected-runtime\\<releaseSha256>');
  assert.equal(contract.targets['linux-x64'].installRoot,
    '/usr/lib/agent-governance-suite/protected-runtime/<releaseSha256>');
  assert.deepEqual(contract.releaseIdInputs,
    ['contractId', 'targetId', 'nodeVersion', 'archiveSha256Hex', 'hostIntegrationSha256Hex']);
  const releaseId = (input) => sha256(Buffer.from(contract.releaseIdInputs.map((key) => input[key]).join('\n') + '\n', 'utf8')).slice(7);
  const candidate = {
    contractId: contract.contractId, targetId: 'windows-x64', nodeVersion: '24.19.0',
    archiveSha256Hex: 'a'.repeat(64), hostIntegrationSha256Hex: 'b'.repeat(64),
  };
  assert.match(releaseId(candidate), /^[a-f0-9]{64}$/);
  assert.notEqual(releaseId(candidate), releaseId({ ...candidate, hostIntegrationSha256Hex: 'c'.repeat(64) }));
  assert.notEqual(releaseId(candidate), releaseId({ ...candidate, targetId: 'linux-x64' }));
  assert.deepEqual(contract.nodeFlags, ['--no-addons', '--no-global-search-paths']);
  assert.deepEqual(contract.entryPointIds, host.entryPoints.map(({ id }) => id));
  assert.equal(contract.packagePolicy, 'exact-host-integration-manifest-plus-artifacts-no-extra-files');
  assert.equal(contract.nodeInstallPolicy, 'byte-identical-archive-extracted-node');
  assert.deepEqual(contract.requiredManifestFields, [
    'contractId', 'revision', 'baseContract', 'hostIntegrationSha256',
    'os', 'arch', 'osBuild', 'nodeVersion', 'releaseSource', 'releaseSha256',
    'installRoot', 'nodePath', 'packageRoot', 'entryPoints',
    'loadedFiles', 'measurement', 'result',
  ]);
});

test('shared refusal rules cover mutable paths, loader bytes, identity and false qualification', () => {
  assert.deepEqual(contract.rejectOn, [
    'unsupported-target', 'node-below-24', 'unverified-source',
    'unprotected-or-alias-path', 'mutable-search-path', 'wrapper-or-override',
    'incomplete-loaded-files', 'digest-or-identity-mismatch',
    'undeclared-module', 'unmeasured-native-addon',
    'extra-package-file', 'transformed-node-bytes',
  ]);
  assert.equal(contract.environmentPolicy, 'explicit-allowlist-no-node-or-loader-overrides');
  assert.equal(contract.dependencyPolicy, 'measured-loaded-bytes-only');
  assert.equal(contract.candidateStatus, 'CANDIDATE_VERIFIED_LIVE_PENDING');
  for (const item of ['NODE_*', 'LD_*', 'DYLD_*', 'node_modules', 'UNKNOWN', 'BLOCKED_CONTRACT',
    'volume serial', 'device·inode·mount identity', 'OS 업데이트',
    '시스템 조상은 기존 owner/ACE를 바꾸지 않는다', 'host-integration.json` bytes']) {
    assert.ok(doc.includes(item), `missing refusal or identity boundary: ${item}`);
  }
  assert.ok(!doc.includes('운영 설치 PASS'), 'contract-only evidence must not qualify a host');
});

test('contract package identity rejects an extra file, changed artifact and transformed Node bytes', () => {
  const host = json('host-integration.json');
  const expected = new Map(host.artifacts.map((item) => [item.path, item.sha256]));
  expected.set('host-integration.json', sha256(read('host-integration.json')));
  const files = new Map([...expected.keys()].map((name) => [name, read(name)]));
  const accepts = (actual, extractedNode, installedNode) =>
    actual.size === expected.size
    && [...expected].every(([name, digest]) => actual.has(name) && sha256(actual.get(name)) === digest)
    && extractedNode.equals(installedNode);
  const archiveNode = Buffer.from('checked archive node bytes');
  assert.equal(accepts(files, archiveNode, archiveNode), true);
  assert.equal(accepts(new Map([...files, ['extra.mjs', Buffer.from('extra')]]), archiveNode, archiveNode), false);
  const changed = new Map(files);
  changed.set(host.artifacts[0].path, Buffer.from('changed artifact'));
  assert.equal(accepts(changed, archiveNode, archiveNode), false);
  assert.equal(accepts(files, archiveNode, Buffer.from('transformed node bytes')), false);
});
