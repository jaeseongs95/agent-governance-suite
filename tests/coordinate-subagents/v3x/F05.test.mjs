import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { probeFlowmarshalProfileState } from '../../../mcp-server/src/host-integration/flowmarshal-profile-probe.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const id = 'flowmarshal-same-user-v1';
const probePath = 'mcp-server/dist/flowmarshal-profile-probe.mjs';

function fixture() {
  const directory = mkdtempSync(path.join(userInfo().homedir, '.ags-f05-'));
  const manifestBytes = readFileSync(path.join(root, 'host-integration.json'));
  const manifest = JSON.parse(manifestBytes);
  for (const artifact of manifest.artifacts) {
    const destination = path.join(directory, artifact.path);
    mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    copyFileSync(path.join(root, artifact.path), destination);
  }
  writeFileSync(path.join(directory, 'host-integration.json'), manifestBytes);
  const profileDir = path.join(directory, id);
  mkdirSync(profileDir, { mode: 0o700 });
  const profilePath = path.join(profileDir, 'server-profile.json');
  const resources = {
    key: { namespace: id, location: path.join(profileDir, 'producer-key.json') },
    pin: { namespace: id, location: path.join(profileDir, 'pins.json') },
    state: { namespace: id, location: path.join(profileDir, 'state.sqlite3') },
  };
  const publicKeySpki = generateKeyPairSync('ed25519').publicKey
    .export({ format: 'der', type: 'spki' }).toString('base64');
  const pins = { namespace: id, pins: [{ keyId: 'fixture-key', publicKeySpki, status: 'active' }] };
  const profile = {
    profileId: id, assuranceTier: 'same-user', hostId: 'flowmarshal',
    receiptDomain: 'fm-same-user-provider-terminal-to-governance-v1',
    dispatchDomain: 'ags-fm-same-user-dispatch-registration-v1',
    modelClassSource: 'flowmarshal-signed-assertion', actorSource: 'flowmarshal-signed-assertion',
    keyNamespace: id, pinNamespace: id, stateNamespace: id,
  };
  const selection = { source: 'server-local-operator-config', profile,
    pinSetDigest: convergenceDigest(pins), resourceBindingDigest: convergenceDigest(resources) };
  const document = { version: 1, selection: { ...selection, freezeIdentity: convergenceDigest(selection) }, resources };
  writeFileSync(resources.key.location, 'fixture key is not opened by AGS', { mode: 0o600 });
  writeFileSync(resources.pin.location, JSON.stringify(pins), { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify(document), { mode: 0o600 });
  return { directory, manifest, manifestBytes, profilePath, resources, pins, document,
    close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('staged package probe binds A2 temporary state and reports only local derived evidence', () => {
  const f = fixture();
  try {
    assert.equal(existsSync(f.resources.state.location), false);
    const result = probeFlowmarshalProfileState(f.directory);
    assert.equal(result.status, 'PASS');
    assert.equal(result.evidenceClass, 'local_derived');
    assert.equal(result.profileId, id);
    assert.equal(result.freezeIdentity, f.document.selection.freezeIdentity);
    assert.equal(result.manifestSha256, `sha256:${createHash('sha256').update(f.manifestBytes).digest('hex')}`);
    assert.deepEqual(result.surfaceChecks, {
      unsignedRegistrationRejected: true, unboundObservationRejected: true,
      unreservedExecutionRejected: true,
    });
    assert.deepEqual(result.surfaces.execution, ['plan_workflow', 'record_stage_result']);
    assert.equal(existsSync(f.resources.state.location), true);
    assert.equal(readFileSync(f.resources.key.location, 'utf8'), 'fixture key is not opened by AGS');
    const entry = f.manifest.entryPoints.find(({ id: entryId }) => entryId === 'mcp-server');
    assert.equal(entry.path, 'mcp-server/dist/server.mjs');
    assert.ok(entry.executionClosure.includes(probePath));
    assert.equal(f.manifest.artifacts.find(({ path: file }) => file === probePath).sha256,
      `sha256:${createHash('sha256').update(readFileSync(path.join(f.directory, probePath))).digest('hex')}`);
    const cli = spawnSync(process.execPath, [path.join(f.directory, probePath)], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), result);
  } finally { f.close(); }
});

test('missing profile, key and pin fail closed in temporary state', () => {
  const f = fixture();
  try {
    for (const missing of ['profile', 'key', 'pin']) {
      const target = missing === 'profile' ? f.profilePath : f.resources[missing].location;
      const bytes = readFileSync(target);
      rmSync(target);
      assert.throws(() => probeFlowmarshalProfileState(f.directory), /profile is unavailable|profile unavailable/);
      assert.equal(existsSync(f.resources.state.location), false);
      writeFileSync(target, bytes, { mode: 0o600 });
    }
  } finally { f.close(); }
}, 90_000);

test('cross profile selection and state identity cannot be reused', () => {
  const f = fixture();
  try {
    const wrong = structuredClone(f.document);
    wrong.selection.profile.profileId = 'vm-protected-v1';
    const { freezeIdentity: ignored, ...body } = wrong.selection;
    void ignored;
    wrong.selection.freezeIdentity = convergenceDigest(body);
    writeFileSync(f.profilePath, JSON.stringify(wrong));
    assert.throws(() => probeFlowmarshalProfileState(f.directory), /profile unavailable/);
    writeFileSync(f.profilePath, JSON.stringify(f.document));
    probeFlowmarshalProfileState(f.directory);
    const changed = structuredClone(f.document);
    const changedPins = structuredClone(f.pins);
    changedPins.pins[0].publicKeySpki = generateKeyPairSync('ed25519').publicKey
      .export({ format: 'der', type: 'spki' }).toString('base64');
    writeFileSync(f.resources.pin.location, JSON.stringify(changedPins));
    changed.selection.pinSetDigest = convergenceDigest(changedPins);
    const { freezeIdentity: previous, ...changedBody } = changed.selection;
    void previous;
    changed.selection.freezeIdentity = convergenceDigest(changedBody);
    writeFileSync(f.profilePath, JSON.stringify(changed));
    assert.throws(() => probeFlowmarshalProfileState(f.directory), /state profile identity mismatch/);
  } finally { f.close(); }
});

test('missing or modified packaged probe is rejected by manifest closure and digest', () => {
  const f = fixture();
  try {
    const bundle = path.join(f.directory, probePath);
    writeFileSync(bundle, `${readFileSync(bundle, 'utf8')}\n// changed\n`);
    assert.throws(() => probeFlowmarshalProfileState(f.directory), /Artifact hash mismatch/);
    rmSync(bundle);
    assert.throws(() => probeFlowmarshalProfileState(f.directory), /Missing package file/);
  } finally { f.close(); }
});

test('a rehashed manifest cannot silently omit a required MCP execution file', () => {
  const f = fixture();
  try {
    const omitted = '.mcp.json';
    const changed = structuredClone(f.manifest);
    const mcp = changed.entryPoints.find(({ id: entryId }) => entryId === 'mcp-server');
    mcp.executionClosure = mcp.executionClosure.filter((file) => file !== omitted);
    changed.artifacts = changed.artifacts.filter(({ path: file }) => file !== omitted);
    writeFileSync(path.join(f.directory, 'host-integration.json'), JSON.stringify(changed));
    assert.throws(() => probeFlowmarshalProfileState(f.directory), /omits or adds/);
  } finally { f.close(); }
});
