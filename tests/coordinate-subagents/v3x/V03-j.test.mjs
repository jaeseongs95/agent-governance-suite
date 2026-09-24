import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { PROTECTED_HOST_CONTRACT as READER_CONTRACT, isProtectedInstallationRecord,
  isProtectedWindowsAcl } from '../../../mcp-server/src/host-integration/vm-model-policy.ts';
import { PROTECTED_HOST_CONTRACT as PREFLIGHT_CONTRACT, checkProtectedInstallationRecord,
  evaluateProtectedHostFixture, preflight, protectedWindowsAcl }
  from '../../../scripts/qualification/vm-transport-preflight.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureRoot = path.join(root, 'tests/coordinate-subagents/v3x/fixtures/protected-host-installation');
const manifest = JSON.parse(readFileSync(path.join(fixtureRoot, 'manifest.json'), 'utf8'));
const cases = JSON.parse(readFileSync(path.join(fixtureRoot, 'cases.json'), 'utf8'));
const profiles = JSON.parse(readFileSync(path.join(fixtureRoot, 'profiles.json'), 'utf8'));
const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const pointer = (value, name) => name.slice(1).split('/').reduce((item, key) => item[key], value);
const changed = (value, patch) => {
  const result = structuredClone(value);
  const keys = patch.path.slice(1).split('/');
  const holder = keys.slice(0, -1).reduce((item, key) => item[key], result);
  holder[keys.at(-1)] = Object.hasOwn(patch, 'valueRef')
    ? pointer(value, patch.valueRef) : patch.value;
  return result;
};

test('reader and preflight pin one frozen authority and fixture manifest', () => {
  assert.deepEqual(READER_CONTRACT, {
    id: manifest.contractId, revision: manifest.revision,
    manifestSha256: hash(readFileSync(path.join(fixtureRoot, 'manifest.json'))),
  });
  assert.equal(PREFLIGHT_CONTRACT.id, READER_CONTRACT.id);
  assert.equal(PREFLIGHT_CONTRACT.revision, READER_CONTRACT.revision);
  assert.equal(PREFLIGHT_CONTRACT.manifestSha256, READER_CONTRACT.manifestSha256);
  assert.equal(PREFLIGHT_CONTRACT.profilesSha256,
    hash(readFileSync(path.join(fixtureRoot, 'profiles.json'))));
  assert.equal(manifest.authority.sha256,
    hash(readFileSync(path.join(root, manifest.authority.path))));
  for (const item of manifest.fixtures) assert.equal(item.sha256, hash(readFileSync(path.join(root, item.path))));
});

test('each V03-i OS path mutation is rejected or remains unknown, never qualified', () => {
  for (const os of ['windows', 'linux']) {
    assert.equal(evaluateProtectedHostFixture(profiles[os], os).status, 'CONTRACT_CANDIDATE_FIXTURE');
  }
  for (const item of cases.cases.filter((entry) => entry.expected !== 'CONTRACT_CANDIDATE_FIXTURE')) {
    for (const os of item.os === 'both' ? ['windows', 'linux'] : [item.os]) {
      const outcome = evaluateProtectedHostFixture(changed(profiles[os], item.observationPatch), os);
      assert.equal(outcome.status, item.expected, `${item.id} ${os}: ${outcome.code}`);
    }
  }
  const missing = structuredClone(profiles.windows);
  delete missing.principals.worker.observed;
  assert.equal(evaluateProtectedHostFixture(missing, 'windows').status, 'UNKNOWN');
  const noProbes = structuredClone(profiles.windows);
  noProbes.accessProbes = {};
  assert.equal(evaluateProtectedHostFixture(noProbes, 'windows').status, 'UNKNOWN');
  const adminWorker = structuredClone(profiles.windows);
  adminWorker.principals.worker.groups.push('S-1-5-32-544');
  assert.equal(evaluateProtectedHostFixture(adminWorker, 'windows').status, 'REJECT');
  const privileged = structuredClone(profiles.linux);
  privileged.principals.worker.capabilities.push('CAP_DAC_OVERRIDE');
  assert.equal(evaluateProtectedHostFixture(privileged, 'linux').status, 'REJECT');
  const report = preflight({ paths: { key: '/missing/key', pin: '/missing/pin' },
    fixtureObservation: { os: 'linux', profile: profiles.linux } });
  assert.equal(report.evidenceOrigin, 'synthetic-fixture');
  assert.equal(report.hostBoundary.status, 'CONTRACT_CANDIDATE_FIXTURE');
  assert.equal(report.status, 'BLOCKED_CONTRACT');
  assert.equal(report.qualification.observed, false);
});

test('system parents permit child creation but protected subtree, pin and reparse fail closed', () => {
  const trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  const parent = { owner: trustedInstaller, reparse: false, rules: [
    { sid: 'S-1-5-32-545', rights: 0x1200a9 | 0x6, type: 'Allow' },
  ] };
  assert.equal(isProtectedWindowsAcl(parent, true), true);
  assert.equal(protectedWindowsAcl(parent, false, false, true), true);
  assert.equal(isProtectedWindowsAcl(parent, false), false);
  assert.equal(protectedWindowsAcl(parent, false), false);
  const deleteChild = { ...parent, rules: [{ ...parent.rules[0], rights: parent.rules[0].rights | 0x40 }] };
  assert.equal(isProtectedWindowsAcl(deleteChild, true), false);
  assert.equal(protectedWindowsAcl(deleteChild, false, false, true), false);
  assert.equal(isProtectedWindowsAcl({ ...parent, reparse: true }, true), false);
  assert.equal(protectedWindowsAcl({ ...parent, reparse: true }, false, false, true), false);
  const pin = { owner: 'S-1-5-18', reparse: false, rules: [
    { sid: 'S-1-5-32-545', rights: 0x1200a9, type: 'Allow' },
  ] };
  assert.equal(isProtectedWindowsAcl(pin, false, true), false);
  assert.equal(protectedWindowsAcl(pin, true), false);
});

test('installer record binds fixed OS paths, revision, manifest and current AGS principal', () => {
  for (const os of ['windows', 'linux']) {
    const profile = profiles[os];
    const id = profile.principals.ags.id;
    const record = {
      contractId: manifest.contractId, revision: manifest.revision,
      fixtureSha256: READER_CONTRACT.manifestSha256, os,
      paths: {
        key: profile.objects.key.path, pin: profile.objects.pin.path,
        coreState: profile.objects.coreState.path,
        agsState: os === 'windows' ? `${profile.objects.coreState.path}\\ags-state`
          : `${profile.objects.coreState.path}/ags-state`,
        workerEndpoint: os === 'windows' ? '\\\\.\\pipe\\flowmarshal-worker' : '/run/flowmarshal/worker.sock',
        vmEntry: os === 'windows' ? 'C:\\Program Files\\FlowMarshal\\python.exe' : '/opt/flowmarshal/python3',
        agsEntry: profile.objects.launcher.path,
      },
      principals: profile.principals,
      services: { core: 'protected-core', worker: 'protected-worker' },
      buildDigests: { vm: `sha256:${'a'.repeat(64)}`, ags: `sha256:${'b'.repeat(64)}` },
      launcherClosureDigest: `sha256:${'c'.repeat(64)}`,
    };
    for (const check of [isProtectedInstallationRecord, checkProtectedInstallationRecord]) {
      assert.equal(check(record, os, id), true);
      assert.equal(check(record, os, 'wrong-principal'), false);
      assert.equal(check({ ...record, revision: '2' }, os, id), false);
      assert.equal(check({ ...record, fixtureSha256: `sha256:${'0'.repeat(64)}` }, os, id), false);
      assert.equal(check({ ...record, paths: { ...record.paths, pin: 'caller-selected' } }, os, id), false);
      assert.equal(check({ ...record, paths: { ...record.paths, agsState: 'relative-state' } }, os, id), false);
      assert.equal(check({ ...record, principals: { ...record.principals,
        worker: { ...record.principals.worker, id: record.principals.core.id } } }, os, id), false);
      assert.equal(check({ ...record, principals: { ...record.principals,
        worker: { ...record.principals.worker, ...(os === 'windows'
          ? { groups: ['S-1-5-32-544'] } : { capabilities: ['CAP_DAC_OVERRIDE'] }) } } }, os, id), false);
    }
  }
});
