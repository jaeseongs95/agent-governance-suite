import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureDir = path.join(root, 'tests/coordinate-subagents/v3x/fixtures/protected-host-installation');
const manifest = JSON.parse(readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'));
const cases = JSON.parse(readFileSync(path.join(fixtureDir, 'cases.json'), 'utf8'));
const profiles = JSON.parse(readFileSync(path.join(fixtureDir, 'profiles.json'), 'utf8'));
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const atPointer = (value, pointer) => pointer.slice(1).split('/').reduce((item, part) => item?.[part], value);
const withPatch = (value, patch) => {
  const clone = structuredClone(value);
  const parts = patch.path.slice(1).split('/');
  const parent = parts.slice(0, -1).reduce((item, part) => item[part], clone);
  parent[parts.at(-1)] = Object.hasOwn(patch, 'valueRef') ? atPointer(value, patch.valueRef) : patch.value;
  return clone;
};
const fixtureVerdict = (profile, baseline, os) => {
  if (profile.principals.worker.observed == null || profile.coreBinding.oneShotRequest == null) return 'UNKNOWN';
  if (profile.principals.worker.id === profile.principals.core.id) return 'REJECT';
  if (Object.values(profile.accessProbes).some((value) => value !== 'DENIED')) return 'REJECT';
  if (!profile.coreBinding.currentPreparedOperation || !profile.coreBinding.oneShotRequest || profile.coreBinding.callerOverride) return 'REJECT';
  if (!profile.objects.launcher.measuredClosure) return 'REJECT';
  for (const chain of Object.values(profile.protectedChains)) {
    for (const name of chain) {
      const item = profile.objects[name];
      const base = baseline.objects[name];
      if (item.identity !== base.identity || item.owner !== base.owner || item.aclChanged || item.reparseOrSymlink || item.reparse || item.symlink) return 'REJECT';
      if (os === 'linux' && (Number.parseInt(item.mode, 8) & 0o022)) return 'REJECT';
      const rights = item.workerEffective;
      if (['write', 'delete', 'replace', 'deleteChild', 'writeDac', 'writeOwner'].some((right) => rights[right])) return 'REJECT';
      if (os === 'linux' && rights.createChild) return 'REJECT';
      if (name === 'key' && rights.read) return 'REJECT';
    }
  }
  return 'CONTRACT_CANDIDATE_FIXTURE';
};

test('AGS authority manifest pins the exact document and shared fixture revision', () => {
  assert.equal(manifest.contractId, 'ags-vm-protected-host-installation/v1');
  assert.equal(manifest.revision, cases.revision);
  assert.equal(manifest.contractId, cases.contractId);
  assert.equal(manifest.revision, profiles.revision);
  assert.equal(manifest.contractId, profiles.contractId);
  assert.equal(manifest.provisioningRevision, 'protected-host-provisioning/v1');
  assert.equal(manifest.status, 'CONTRACT_ONLY');
  assert.deepEqual(manifest.requiredConsumers, ['AGS V03-j', 'VM V03-k']);
  assert.deepEqual(manifest.provisioningReferences, ['B14-k issuer', 'B14-m storage']);
  assert.deepEqual(manifest.fixtures.map((item) => path.basename(item.path)).sort(), ['cases.json', 'profiles.json']);
  for (const item of [manifest.authority, ...manifest.fixtures]) {
    assert.ok(item.path.startsWith('docs/') || item.path.startsWith('tests/coordinate-subagents/v3x/fixtures/'));
    const bytes = readFileSync(path.join(root, item.path));
    assert.equal(item.sha256, hash(bytes));
    assert.notEqual(item.sha256, hash(Buffer.concat([bytes, Buffer.from('tamper')])));
  }
});

test('OS profiles contain concrete protected objects, principals, and denied child probes', () => {
  for (const os of ['windows', 'linux']) {
    const profile = profiles[os];
    assert.equal(profile.installationRecord.contractRevision, manifest.revision);
    assert.notEqual(profile.principals.core.id, profile.principals.worker.id);
    assert.equal(profile.principals.worker.observed, true);
    for (const name of ['systemRoot', 'systemParent', 'subtree', 'agsSubtree', 'key', 'pin', 'coreState', 'launcher', 'installationRecord', 'agsInstall']) {
      assert.ok(profile.objects[name].path);
      assert.ok(profile.objects[name].identity.startsWith('fixture-'));
      assert.ok(profile.objects[name].owner);
    }
    for (const [target, chain] of Object.entries(profile.protectedChains)) {
      assert.equal(chain[0], 'systemRoot');
      assert.equal(chain.at(-1), target);
      for (let i = 0; i < chain.length; i++) {
        const item = profile.objects[chain[i]];
        assert.ok(item, `${os} ${target} ${chain[i]}`);
        assert.equal(item.reparse ?? item.symlink, false);
        assert.equal(item.workerEffective.deleteChild, false);
        assert.equal(item.workerEffective.writeDac, false);
        assert.equal(item.workerEffective.writeOwner, false);
        if (i) {
          const parent = profile.objects[chain[i - 1]].path;
          const child = item.path;
          const separator = os === 'windows' ? '\\' : '/';
          assert.ok(child.startsWith(parent.endsWith(separator) ? parent : parent + separator),
            `${os} ${target}: ${parent} -> ${child}`);
          assert.notEqual(child, parent);
        }
      }
    }
    assert.deepEqual(Object.keys(profile.protectedChains).sort(),
      ['coreState', 'installationRecord', 'key', 'launcher', 'pin']);
    assert.equal(profile.objects.systemParent.aclChanged, false);
    assert.equal(profile.objects.systemRoot.aclChanged, false);
    assert.equal(profile.objects.systemParent.workerEffective.deleteChild, false);
    assert.equal(profile.objects.subtree.workerEffective.replace, false);
    assert.equal(profile.objects.key.workerEffective.read, false);
    assert.equal(profile.objects.coreState.workerEffective.write, false);
    assert.equal(profile.objects.launcher.measuredClosure, true);
    for (const verdict of Object.values(profile.accessProbes)) assert.equal(verdict, 'DENIED');
    assert.equal(profile.coreBinding.currentPreparedOperation, true);
    assert.equal(profile.coreBinding.oneShotRequest, true);
  }
  assert.ok(profiles.windows.objects.systemParent.path.startsWith('C:'));
  assert.ok(profiles.linux.objects.systemParent.path.startsWith('/etc'));
});

test('synthetic matrix rejects replacement, same-principal access, inherited IPC, and unknown identity', () => {
  assert.equal(cases.provenance, 'synthetic-fixture');
  assert.equal(cases.operationalQualification, false);
  assert.equal(cases.baselineAssertions.systemParentUnchanged, true);
  assert.deepEqual(cases.cases.filter((item) => item.expected === 'CONTRACT_CANDIDATE_FIXTURE')
    .map((item) => item.os).sort(), ['linux', 'windows']);
  const required = [
    'system-root-acl-mutated', 'windows-parent-delete-child', 'windows-subtree-delete', 'linux-parent-writable',
    'windows-subtree-acl-relaxed', 'linux-subtree-mode-relaxed',
    'ags-pin-parent-replace', 'core-state-parent-replace', 'launcher-parent-replace',
    'installation-record-replace', 'linux-var-parent-writable', 'windows-core-state-parent-replace',
    'precreated-untrusted-vendor-subtree',
    'junction-or-symlink', 'parent-replaced-during-read', 'key-or-pin-permission-relaxed',
    'same-effective-worker-principal', 'child-reads-key', 'child-reads-core-ledger',
    'child-reaches-signer-pipe', 'inherited-handle-or-fd',
    'caller-selects-protected-path', 'core-invocation-unbound', 'unmeasured-launcher',
    'child-token-not-observed', 'child-uid-not-observed', 'broker-peer-unproven',
  ];
  assert.deepEqual(cases.cases.filter((item) => item.expected !== 'CONTRACT_CANDIDATE_FIXTURE')
    .map((item) => item.id).sort(), required.sort());
  for (const item of cases.cases) {
    assert.ok(['windows', 'linux', 'both'].includes(item.os));
    const entries = Object.entries(item.override);
    assert.ok(entries.every(([key]) => Object.hasOwn(cases.baselineAssertions, key)));
    assert.ok(item.reason.length > 20);
    assert.equal(item.expected, entries.some(([, value]) => value === null)
      ? 'UNKNOWN' : entries.some(([, value]) => value === false)
        ? 'REJECT' : 'CONTRACT_CANDIDATE_FIXTURE');
    if (item.expected !== 'CONTRACT_CANDIDATE_FIXTURE') {
      assert.ok(item.observationPatch?.path.startsWith('/'));
      for (const os of item.os === 'both' ? ['windows', 'linux'] : [item.os]) {
        const profile = profiles[os];
        const before = atPointer(profile, item.observationPatch.path);
        const after = Object.hasOwn(item.observationPatch, 'valueRef')
          ? atPointer(profile, item.observationPatch.valueRef)
          : item.observationPatch.value;
        assert.notEqual(before, undefined, item.id);
        assert.notDeepEqual(after, before, item.id);
        assert.equal(fixtureVerdict(withPatch(profile, item.observationPatch), profile, os), item.expected, item.id);
        if (item.observationPatch.path.startsWith('/objects/')) {
          const objectName = item.observationPatch.path.split('/')[2];
          assert.ok(Object.values(profile.protectedChains).some((chain) => chain.includes(objectName)),
            `${item.id}: mutation must affect a protected path chain`);
          if (item.expected === 'REJECT' && item.observationPatch.path.includes('/workerEffective/')) {
            assert.equal(after, true, item.id);
          }
          if (os === 'linux') {
            assert.ok(!item.observationPatch.path.endsWith('/writeDac'), item.id);
          }
        }
      }
    }
    if (item.expected === 'CONTRACT_CANDIDATE_FIXTURE') {
      assert.equal(fixtureVerdict(profiles[item.os], profiles[item.os], item.os), item.expected, item.id);
    }
    assert.notEqual(item.expected, 'PASS');
  }
});
