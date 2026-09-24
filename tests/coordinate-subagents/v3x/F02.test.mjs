import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';

import { convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { isSameUserWindowsAcl, loadFlowmarshalProfileFile } from '../../../mcp-server/src/host-integration/flowmarshal-profile.ts';
import { resolveFlowmarshalProfilePath } from '../../../mcp-server/src/runtime-config.ts';

const id = 'flowmarshal-same-user-v1';
const profile = {
  profileId: id, assuranceTier: 'same-user', hostId: 'flowmarshal',
  receiptDomain: 'fm-same-user-provider-terminal-to-governance-v1',
  dispatchDomain: 'ags-fm-same-user-dispatch-registration-v1',
  modelClassSource: 'flowmarshal-signed-assertion', actorSource: 'flowmarshal-signed-assertion',
  keyNamespace: id, pinNamespace: id, stateNamespace: id,
};
const publicKeySpki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const secondKeySpki = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const clone = (value) => structuredClone(value);

function fixture() {
  const directory = mkdtempSync(path.join(userInfo().homedir, '.ags-f02-'));
  const profilePath = path.join(directory, 'server-profile.json');
  const resources = {
    key: { namespace: id, location: path.join(directory, 'producer-key.json') },
    pin: { namespace: id, location: path.join(directory, 'pins.json') },
    state: { namespace: id, location: path.join(directory, 'state.sqlite3') },
  };
  const pins = { namespace: id, pins: [{ keyId: 'key-1', publicKeySpki, status: 'active' }] };
  const body = {
    source: 'server-local-operator-config', profile,
    pinSetDigest: convergenceDigest(pins), resourceBindingDigest: convergenceDigest(resources),
  };
  const document = { version: 1, selection: { ...body, freezeIdentity: convergenceDigest(body) }, resources };
  writeFileSync(resources.key.location, 'fixture private key is never parsed', { mode: 0o600 });
  writeFileSync(resources.pin.location, JSON.stringify(pins), { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify(document), { mode: 0o600 });
  return { directory, profilePath, document, resources, pins, write(value = document) {
    writeFileSync(profilePath, JSON.stringify(value), { mode: 0o600 });
  }, close() { rmSync(directory, { recursive: true, force: true }); } };
}

test('fixed A2 configuration loads a same-user profile without reading the producer key', () => {
  const f = fixture();
  try {
    const loaded = loadFlowmarshalProfileFile(f.profilePath);
    assert.equal(loaded.profileId, id);
    assert.equal(loaded.assuranceTier, 'same-user');
    assert.equal(loaded.freezeIdentity, f.document.selection.freezeIdentity);
    assert.equal(loaded.pins[0].keyId, 'key-1');
    assert.equal(loaded.resources.state.location, f.resources.state.location);
    assert.equal(readFileSync(f.resources.key.location, 'utf8'), 'fixture private key is never parsed');
    const serverUrl = pathToFileURL(path.join(f.directory, 'mcp-server', 'dist', 'server.mjs')).href;
    const installedPath = resolveFlowmarshalProfilePath(serverUrl);
    assert.equal(installedPath, path.join(f.directory, id, 'server-profile.json'));
    const previousHome = process.env.USERPROFILE;
    process.env.USERPROFILE = path.join(f.directory, 'caller-selected-home');
    try { assert.equal(resolveFlowmarshalProfilePath(serverUrl), installedPath); }
    finally {
      if (previousHome === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousHome;
    }
  } finally { f.close(); }
});

test('missing, mixed, legacy and caller-selected profiles never activate A2 or VM strong', () => {
  const f = fixture();
  try {
    assert.equal(loadFlowmarshalProfileFile(path.join(f.directory, 'absent.json')), null);
    for (const mutate of [
      (d) => { d.selection.profile.assuranceTier = 'strong'; },
      (d) => { d.selection.profile.profileId = 'vm-protected-v1'; },
      (d) => { d.selection.profile.receiptDomain = 'vm-provider-terminal-to-governance'; },
      (d) => { d.selection.source = 'request-field'; },
      (d) => { d.selection.env = 'AGENT_GOVERNANCE_VM_PIN_PATH'; },
      (d) => { d.selection.argv = '--profile=vm-protected-v1'; },
      (d) => { d.selection.installed = true; },
      (d) => { d.resources.state.location = path.join(f.directory, 'vm-state.sqlite3'); },
      (d) => { d.resources.pin.namespace = 'vm-protected-v1'; },
      (d) => { d.resources.key.location = d.resources.pin.location; },
    ]) {
      const changed = clone(f.document);
      mutate(changed);
      const { freezeIdentity: ignored, ...body } = changed.selection;
      void ignored;
      changed.selection.freezeIdentity = convergenceDigest(body);
      f.write(changed);
      assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /profile unavailable/);
    }
    const wrongFreeze = clone(f.document);
    wrongFreeze.selection.freezeIdentity = convergenceDigest({ other: true });
    f.write(wrongFreeze);
    assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /freeze identity is invalid/);
  } finally { f.close(); }
});

test('pin set, file identity and same-user permissions fail closed', () => {
  const f = fixture();
  try {
    f.pins.namespace = 'vm-protected-v1';
    writeFileSync(f.resources.pin.location, JSON.stringify(f.pins));
    assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /profile unavailable/);
    f.pins.namespace = id;
    f.pins.pins[0].status = 'revoked';
    writeFileSync(f.resources.pin.location, JSON.stringify(f.pins));
    assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /profile unavailable/);
    f.pins.pins[0].status = 'active';
    f.pins.pins[0].publicKeySpki = 'wrong-key';
    writeFileSync(f.resources.pin.location, JSON.stringify(f.pins));
    assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /profile unavailable/);
    f.pins.pins[0].publicKeySpki = secondKeySpki;
    writeFileSync(f.resources.pin.location, JSON.stringify(f.pins));
    assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /pin set digest is invalid/);
    if (process.platform !== 'win32') {
      writeFileSync(f.resources.pin.location, JSON.stringify({ ...f.pins,
        pins: [{ ...f.pins.pins[0], publicKeySpki }] }));
      chmodSync(f.profilePath, 0o666);
      assert.throws(() => loadFlowmarshalProfileFile(f.profilePath), /permissions are too broad/);
    }
  } finally { f.close(); }
});

test('Windows ACL rejects another reader, writer or owner for every A2 resource', () => {
  const self = 'S-1-5-21-123-456-789-1001';
  const acl = { self, owner: self, rules: [
    { sid: self, rights: 0x1f01ff, type: 'Allow' },
    { sid: 'S-1-5-18', rights: 0x1f01ff, type: 'Allow' },
    { sid: 'S-1-5-32-545', rights: 0x1200a9, type: 'Allow' },
  ] };
  assert.equal(isSameUserWindowsAcl(acl), false);
  assert.equal(isSameUserWindowsAcl({ ...acl, rules: acl.rules.slice(0, 2) }), true);
  assert.equal(isSameUserWindowsAcl({ ...acl, owner: 'S-1-5-32-545' }), false);
  assert.equal(isSameUserWindowsAcl({ ...acl, rules: [...acl.rules,
    { sid: 'S-1-5-32-545', rights: 0x1301bf, type: 'Allow' }] }), false);
});
