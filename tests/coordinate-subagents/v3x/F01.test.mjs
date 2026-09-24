import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { test } from 'vitest';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const schema = JSON.parse(readFileSync(path.join(root, 'contracts/host-integration.v1.schema.json'), 'utf8'));
const ajv = new Ajv2020({ allErrors: true }).addSchema(schema);
const profileValid = ajv.getSchema(`${schema.$id}#/$defs/trustProfile`);
const selectionValid = ajv.getSchema(`${schema.$id}#/$defs/serverProfileSelection`);
const bindingValid = ajv.getSchema(`${schema.$id}#/$defs/profileBinding`);
const digest = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
const selectionDigest = (selection) => {
  const base = { ...selection };
  delete base.freezeIdentity;
  return digest(base);
};
const clone = (value) => structuredClone(value);

const vm = {
  profileId: 'vm-protected-v1', assuranceTier: 'strong', hostId: 'flowmarshal-engine',
  receiptDomain: 'vm-provider-terminal-to-governance',
  dispatchDomain: 'ags-vm-dispatch-registration-v1',
  modelClassSource: 'operator-exact-observed-model', actorSource: 'operator-pinned-installation',
  keyNamespace: 'vm-protected-v1', pinNamespace: 'vm-protected-v1', stateNamespace: 'vm-protected-v1',
};
const fm = {
  profileId: 'flowmarshal-same-user-v1', assuranceTier: 'same-user', hostId: 'flowmarshal',
  receiptDomain: 'fm-same-user-provider-terminal-to-governance-v1',
  dispatchDomain: 'ags-fm-same-user-dispatch-registration-v1',
  modelClassSource: 'flowmarshal-signed-assertion', actorSource: 'flowmarshal-signed-assertion',
  keyNamespace: 'flowmarshal-same-user-v1', pinNamespace: 'flowmarshal-same-user-v1',
  stateNamespace: 'flowmarshal-same-user-v1',
};
function selection(profile) {
  const namespace = profile.profileId;
  const resources = {
    keyLocation: `/fixture/${namespace}/key`,
    pinLocation: `/fixture/${namespace}/pin`,
    stateLocation: `/fixture/${namespace}/state`,
  };
  const base = {
    source: 'server-local-operator-config', profile,
    pinSetDigest: digest({ profileId: profile.profileId, pins: ['key-1'] }),
    resourceBindingDigest: digest(resources),
  };
  return { ...base, freezeIdentity: digest(base) };
}

// This is a contract fixture, not a product verifier or proof that any profile is installed.
function matchesFrozenFixture(selected, receipt, pin, state, context, workflowReceipt, resources) {
  if (!selectionValid(selected) || selected.freezeIdentity !== selectionDigest(selected)) return false;
  const profile = selected.profile;
  const bound = { profileId: profile.profileId, freezeIdentity: selected.freezeIdentity };
  if (selected.resourceBindingDigest !== digest(resources)) return false;
  return bindingValid(receipt.binding) && bindingValid(context.binding)
    && bindingValid(workflowReceipt.binding)
    && [receipt.binding, context.binding, workflowReceipt.binding].every((item) =>
      item.profileId === bound.profileId && item.freezeIdentity === bound.freezeIdentity)
    && receipt.domain === profile.receiptDomain && receipt.dispatchDomain === profile.dispatchDomain
    && receipt.keyNamespace === profile.keyNamespace && pin.namespace === profile.pinNamespace
    && pin.keyNamespace === profile.keyNamespace && pin.keyId === receipt.keyId
    && state.namespace === profile.stateNamespace
    && context.modelClassSource === profile.modelClassSource && context.actorSource === profile.actorSource;
}

function fixture(selected) {
  const profile = selected.profile;
  const binding = { profileId: profile.profileId, freezeIdentity: selected.freezeIdentity };
  return [
    { binding, domain: profile.receiptDomain, dispatchDomain: profile.dispatchDomain,
      keyNamespace: profile.keyNamespace, keyId: 'key-1' },
    { namespace: profile.pinNamespace, keyNamespace: profile.keyNamespace, keyId: 'key-1' },
    { namespace: profile.stateNamespace },
    { binding, modelClassSource: profile.modelClassSource, actorSource: profile.actorSource },
    { binding },
    {
      keyLocation: `/fixture/${profile.profileId}/key`,
      pinLocation: `/fixture/${profile.profileId}/pin`,
      stateLocation: `/fixture/${profile.profileId}/state`,
    },
  ];
}

test('A2 and protected VM have disjoint exact profile identities and authority sources', () => {
  assert.ok(profileValid(fm));
  assert.ok(profileValid(vm));
  for (const key of ['profileId', 'assuranceTier', 'hostId', 'receiptDomain', 'dispatchDomain',
    'modelClassSource', 'actorSource', 'keyNamespace', 'pinNamespace', 'stateNamespace']) {
    assert.notEqual(fm[key], vm[key], key);
    for (const [profile, opposite] of [[fm, vm], [vm, fm]]) {
      const mixed = { ...profile, [key]: opposite[key] };
      assert.equal(profileValid(mixed), false, `${profile.profileId} ${key}`);
    }
  }
  assert.equal(profileValid({ ...fm, installed: true }), false);
});

test('only explicit server selection has a stable identity; caller and install hints cannot switch it', () => {
  for (const profile of [fm, vm]) {
    const chosen = selection(profile);
    assert.ok(selectionValid(chosen));
    assert.equal(chosen.freezeIdentity, selectionDigest(chosen));
    for (const extra of [{ source: 'request-field' }, { env: 'AGS_PROFILE=vm-protected-v1' },
      { argv: '--profile=vm-protected-v1' }, { installed: true }]) {
      assert.equal(selectionValid({ ...chosen, ...extra }), false);
    }
    for (const key of ['profile', 'pinSetDigest', 'resourceBindingDigest']) {
      const changed = clone(chosen);
      changed[key] = key === 'profile' ? (profile === fm ? vm : fm) : `changed-${key}`;
      assert.notEqual(changed.freezeIdentity, selectionDigest(changed), key);
    }
  }
  assert.notEqual(selection(fm).freezeIdentity, selection(vm).freezeIdentity);
});

test('cross-domain, key, pin, state, receipt and context fixtures are rejected', () => {
  for (const [profile, opposite] of [[fm, vm], [vm, fm]]) {
    const chosen = selection(profile);
    const good = fixture(chosen);
    const foreign = fixture(selection(opposite));
    assert.equal(matchesFrozenFixture(chosen, ...good), true);
    const changes = [
      [0, 'domain', opposite.receiptDomain], [0, 'dispatchDomain', opposite.dispatchDomain],
      [0, 'keyNamespace', opposite.keyNamespace], [1, 'namespace', opposite.pinNamespace],
      [1, 'keyNamespace', opposite.keyNamespace], [2, 'namespace', opposite.stateNamespace],
      [3, 'modelClassSource', opposite.modelClassSource], [3, 'actorSource', opposite.actorSource],
    ];
    for (const [index, key, value] of changes) {
      const mixed = clone(good);
      mixed[index][key] = value;
      assert.equal(matchesFrozenFixture(chosen, ...mixed), false, `${profile.profileId} ${index}.${key}`);
    }
    for (const index of [0, 3, 4]) {
      for (const binding of [
        { profileId: opposite.profileId, freezeIdentity: chosen.freezeIdentity },
        { profileId: profile.profileId, freezeIdentity: selection(opposite).freezeIdentity },
        { freezeIdentity: chosen.freezeIdentity },
      ]) {
        const mixed = clone(good);
        mixed[index].binding = binding;
        assert.equal(matchesFrozenFixture(chosen, ...mixed), false, `${profile.profileId} ${index} binding`);
      }
    }
    const otherKey = clone(good);
    otherKey[1].keyId = 'key-2';
    assert.equal(matchesFrozenFixture(chosen, ...otherKey), false);
    for (const location of ['keyLocation', 'pinLocation', 'stateLocation']) {
      const crossed = clone(good);
      crossed[5][location] = foreign[5][location];
      assert.equal(matchesFrozenFixture(chosen, ...crossed), false, `${profile.profileId} ${location}`);
    }
  }
  assert.notEqual(`${fm.pinNamespace}:key-1`, `${vm.pinNamespace}:key-1`);
});
