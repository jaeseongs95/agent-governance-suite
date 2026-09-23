import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'vitest';

import { checkInstallation, inspectFile, preflight, protectedWindowsAcl }
  from '../../../scripts/qualification/vm-transport-preflight.mjs';

const script = resolve('scripts/qualification/vm-transport-preflight.mjs');
const digest = `sha256:${'a'.repeat(64)}`;

function installation() {
  const pair = generateKeyPairSync('ed25519');
  const key = { version: 1, installationId: 'install-1', keyId: 'key-1',
    hostId: 'flowmarshal-engine', modelPolicyVersion: 'policy-v1',
    privateKeyPkcs8: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
  const policy = { version: 1, modelPolicyVersion: 'policy-v1', pins: [{
    keyId: key.keyId, installationId: key.installationId, hostId: key.hostId,
    publicKeySpki: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    hostBuildDigest: digest, modelPolicyVersion: key.modelPolicyVersion, status: 'active',
  }], hostBuilds: [{ hostId: key.hostId, hostBuildDigest: digest, status: 'verified' }],
  models: [{ hostId: key.hostId, hostBuildDigest: digest, observedModelId: 'exact-model',
    modelClass: 'deep', status: 'verified' }] };
  return { key, policy };
}

test('protected key and active exact build/model pin are checked without returning secret material', () => {
  const { key, policy } = installation();
  const ready = checkInstallation(key, policy, 'exact-model');
  assert.equal(ready.ok, true);
  assert.equal(ready.installationId, 'install-1');
  assert.ok(!JSON.stringify(ready).includes(key.privateKeyPkcs8));
  assert.equal(checkInstallation(key, policy, undefined).code, 'EXACT_MODEL_INPUT_MISSING');
  assert.equal(checkInstallation(key, policy, 'other-model').code, 'EXACT_MODEL_NOT_VERIFIED_IN_POLICY');
  policy.pins[0].status = 'revoked';
  assert.equal(checkInstallation(key, policy, 'exact-model').code, 'PIN_REVOKED_OR_MISMATCHED');
  policy.pins[0].status = 'active';
  policy.modelPolicyVersion = 'rotated';
  assert.equal(checkInstallation(key, policy, 'exact-model').code, 'POLICY_VERSION_OR_FORMAT_INVALID');
});

test('unprivileged write and reparse ACLs are rejected, including secret read access', () => {
  const acl = { owner: 'S-1-5-18', reparse: false, rules: [
    { sid: 'S-1-5-11', rights: 0x1200a9, type: 'Allow' },
  ] };
  assert.equal(protectedWindowsAcl(acl, false), true);
  assert.equal(protectedWindowsAcl(acl, true), false);
  assert.equal(protectedWindowsAcl({ ...acl, reparse: true }, false), false);
  assert.equal(protectedWindowsAcl({ ...acl, rules: [{ ...acl.rules[0], rights: 0x1200ab }] }, false), false);
  const trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464';
  assert.equal(protectedWindowsAcl({ owner: trustedInstaller, reparse: false,
    rules: [{ sid: trustedInstaller, rights: 0x1f01ff, type: 'Allow' }] }, false, true), true);
});

test('real temporary path is not accepted as an operator-protected installation', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-g-'));
  try {
    const file = join(directory, 'producer-key.json');
    writeFileSync(file, '{}');
    assert.equal(inspectFile(file, { protectedFile: true, secret: true }).ok, false);
    assert.equal(inspectFile(file, { protectedFile: true, candidate: true }).code, 'OWNER_OR_ACL_UNSAFE');
    try {
      const link = join(directory, 'linked-key.json');
      symlinkSync(file, link);
      assert.equal(inspectFile(link, { protection: () => true, protectedFile: true }).code, 'PATH_REPARSE_OR_TYPE');
    } catch (error) {
      if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('missing installed inputs remain blocked and fixture origin cannot become live evidence', () => {
  const result = preflight({ paths: { key: join(tmpdir(), 'missing-vm-key.json'),
    pin: join(tmpdir(), 'missing-ags-pin.json') } });
  assert.equal(result.status, 'BLOCKED_CONTRACT');
  assert.equal(result.evidenceOrigin, 'synthetic-fixture');
  assert.equal(result.qualification.observed, false);
  assert.ok(result.missingInputs.some((item) => item.startsWith('key:')));
  assert.ok(result.missingInputs.includes('vmEntry'));
  assert.ok(result.missingInputs.includes('observedModel'));
});

test('synthetic protected files can prepare a harness without becoming host or product evidence', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-g-ready-'));
  try {
    const { key, policy } = installation();
    const keyPath = join(directory, 'key.json');
    const pinPath = join(directory, 'pin.json');
    writeFileSync(keyPath, JSON.stringify(key));
    writeFileSync(pinPath, JSON.stringify(policy));
    const report = preflight({ paths: { key: keyPath, pin: pinPath },
      vmEntry: script, agsEntry: script,
      observedModel: 'exact-model', protection: () => true, execution: () => true });
    assert.equal(report.status, 'FIXTURE_ONLY', JSON.stringify(report));
    assert.equal(report.evidenceOrigin, 'synthetic-fixture');
    assert.equal(report.qualification.hostSupported, 'unknown');
    assert.equal(report.qualification.configured, 'unconfirmed');
    assert.equal(report.qualification.observed, false);
    assert.ok(!JSON.stringify(report).includes(key.privateKeyPkcs8));
    const nonExecutable = preflight({ paths: { key: keyPath, pin: pinPath },
      vmEntry: keyPath, agsEntry: keyPath, observedModel: 'exact-model', protection: () => true });
    assert.equal(nonExecutable.status, 'BLOCKED_CONTRACT');
    assert.equal(nonExecutable.checks.vmEntry.code, 'NOT_EXECUTABLE');
    const writableCandidate = preflight({ paths: { key: keyPath, pin: pinPath },
      vmEntry: script, agsEntry: script, observedModel: 'exact-model',
      protection: (target, _status, _secret, candidate) => !candidate || target !== script,
      execution: () => true });
    assert.equal(writableCandidate.status, 'BLOCKED_CONTRACT');
    assert.equal(writableCandidate.checks.vmEntry.code, 'OWNER_OR_ACL_UNSAFE');
    writeFileSync(keyPath, JSON.stringify(key).replace('"keyId":"key-1"',
      '"keyId":"key-1","keyId":"key-1"'));
    const duplicateKey = preflight({ paths: { key: keyPath, pin: pinPath },
      vmEntry: script, agsEntry: script, observedModel: 'exact-model',
      protection: () => true, execution: () => true });
    assert.equal(duplicateKey.status, 'BLOCKED_CONTRACT');
    assert.equal(duplicateKey.policy.code, 'PROTECTED_JSON_UNREADABLE');
    writeFileSync(keyPath, JSON.stringify(key));
    writeFileSync(pinPath, JSON.stringify(policy).replace('"status":"active"',
      '"status":"active","status":"active"'));
    const duplicatePin = preflight({ paths: { key: keyPath, pin: pinPath },
      vmEntry: script, agsEntry: script, observedModel: 'exact-model',
      protection: () => true, execution: () => true });
    assert.equal(duplicatePin.status, 'BLOCKED_CONTRACT');
    assert.equal(duplicatePin.policy.code, 'PROTECTED_JSON_UNREADABLE');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('CLI with absent inputs emits a blocked report, not a qualification pass', () => {
  const run = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const report = JSON.parse(run.stdout);
  assert.equal(report.status, 'BLOCKED_CONTRACT');
  assert.equal(report.evidenceOrigin, 'installed-preflight');
  assert.equal(report.qualification.observed, false);
  assert.ok(!run.stdout.includes('privateKeyPkcs8'));
});
