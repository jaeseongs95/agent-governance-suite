import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';

import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { VmCurrentInvocation } from '../../../mcp-server/src/host-integration/vm-current-invocation.ts';
import { VmModelPolicy, installedVmPolicyPath, isProtectedWindowsAcl,
  readProtectedVmPolicyFile, readProtectedVmPolicyFileFixture } from '../../../mcp-server/src/host-integration/vm-model-policy.ts';

const clock = Date.parse('2026-09-23T00:00:01.000Z');
const issuedAt = new Date(clock).toISOString();
const expiresAt = new Date(clock + 60_000).toISOString();
const build = `sha256:${'a'.repeat(64)}`;
const unsigned = { schemaVersion: '1.0.0', taskId: 'task-1',
  objective: 'Review the approved local task.', scope: { included: ['artifact-a'], excluded: [] },
  acceptanceCriteria: ['Report a supported decision.'], riskLevel: 'low', workUnits: [],
  requiredCapabilities: [], constraints: [],
  authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false },
  orchestration: { requested: false, mcpAvailable: true } };

function fixture() {
  const pair = generateKeyPairSync('ed25519');
  const spki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  const config = { version: 1, modelPolicyVersion: 'policy-v1', pins: [{
    keyId: 'key-1', installationId: 'installation-1', hostId: 'flowmarshal-engine',
    publicKeySpki: spki, hostBuildDigest: build, modelPolicyVersion: 'policy-v1', status: 'active',
  }], hostBuilds: [{ hostId: 'flowmarshal-engine', hostBuildDigest: build, status: 'verified' }],
  models: [{ hostId: 'flowmarshal-engine', hostBuildDigest: build, observedModelId: 'observed-model-1',
    modelClass: 'deep', status: 'verified' }] };
  const signed = (body) => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, pair.privateKey).toString('base64url'), keyId: 'key-1' };
  };
  const registration = (epoch, nonce, change = () => {}) => {
    const body = { version: 1, domain: 'ags-vm-dispatch-registration-v1', serverEpoch: epoch,
      nonce, issuedAt, expiresAt,
      producer: { installationId: 'installation-1', keyId: 'key-1', hostId: 'flowmarshal-engine', instanceId: 'instance-1' },
      binding: { turnId: 'turn-1', taskId: 'task-1', runId: null, attemptId: null,
        hostId: 'flowmarshal-engine', sessionId: 'session-1', instanceId: 'instance-1' },
      terminal: { eventId: 'event-1', callId: 'provider-1', threadId: 'thread-1', turnId: 'turn-1',
        status: 'succeeded', observedAt: '2026-09-23T00:00:00.000Z', model: 'observed-model-1',
        effort: 'high', provenance: 'provider_raw_response', digest: `sha256:${'b'.repeat(64)}` },
      core: { goalRevision: 1, taskRevision: 1, attemptOrdinal: null, gateOperationKey: 'operation-1', stage: 'bootstrap' },
      invocation: { tool: 'plan_workflow', inputDigest: convergenceDigest(unsigned), observedAt: issuedAt } };
    change(body);
    return { body, envelope: signed(body) };
  };
  const receipt = (registrationBody, callId) => {
    const raw = Buffer.from(canonicalJson(registrationBody));
    return signed({ version: 2, domain: 'vm-provider-terminal-to-governance',
      producer: structuredClone(registrationBody.producer), binding: { invocationId: callId, ...registrationBody.binding },
      terminal: structuredClone(registrationBody.terminal), core: structuredClone(registrationBody.core),
      invocation: structuredClone(registrationBody.invocation), nonce: `receipt-${callId}`,
      issuedAt, expiresAt, transport: { serverEpoch: registrationBody.serverEpoch,
        registrationDigest: `sha256:${createHash('sha256').update(raw).digest('hex')}` } });
  };
  return { config, signed, registration, receipt, spki };
}

test('exact verified host model and pinned installation produce only the producer principal', async () => {
  const f = fixture();
  const nextKey = generateKeyPairSync('ed25519');
  f.config.pins.push({ ...f.config.pins[0], keyId: 'key-2',
    publicKeySpki: nextKey.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') });
  const policy = VmModelPolicy.fixture(f.config);
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  try {
    const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => clock + 1, policy);
    const registration = f.registration(vm.serverEpoch, 'normal');
    const ticket = vm.reserve(registration.envelope);
    const observed = await vm.runCurrentRequest(ticket.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: f.receipt(registration.body, ticket.callId) },
      async () => vm.verifyCurrentReceipt());
    assert.equal(observed.model, 'observed-model-1');
    assert.deepEqual(observed.vmProfile, { modelClass: 'deep', actorId: 'vm-producer:installation-1',
      observedModelId: 'observed-model-1', installationId: 'installation-1',
      hostBuildDigest: build, modelPolicyVersion: 'policy-v1' });
    assert.throws(() => vm.verifyCurrentReceipt(), /current reserved request is unavailable/);

    const rotated = f.registration(vm.serverEpoch, 'other-instance', (body) => {
      body.producer.instanceId = 'instance-2'; body.binding.instanceId = 'instance-2';
    });
    const rotatedTicket = vm.reserve(rotated.envelope);
    const second = await vm.runCurrentRequest(rotatedTicket.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: f.receipt(rotated.body, rotatedTicket.callId) },
      async () => vm.verifyCurrentReceipt());
    assert.equal(second.vmProfile.actorId, observed.vmProfile.actorId);

    const signedWithNextKey = (body) => {
      const bytes = Buffer.from(canonicalJson(body));
      return { body: bytes.toString('base64url'),
        signature: sign(null, bytes, nextKey.privateKey).toString('base64url'), keyId: 'key-2' };
    };
    const nextRegistration = f.registration(vm.serverEpoch, 'next-key');
    nextRegistration.body.producer.keyId = 'key-2';
    const nextTicket = vm.reserve(signedWithNextKey(nextRegistration.body));
    const nextReceipt = f.receipt(nextRegistration.body, nextTicket.callId);
    const nextReceiptBody = JSON.parse(Buffer.from(nextReceipt.body, 'base64url').toString('utf8'));
    const third = await vm.runCurrentRequest(nextTicket.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: signedWithNextKey(nextReceiptBody) },
      async () => vm.verifyCurrentReceipt());
    assert.equal(third.vmProfile.actorId, observed.vmProfile.actorId);
  } finally {
    if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
    else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
  }
});

test('unknown alias, retired model, unverified host and policy version mismatch are unsupported before claim', async () => {
  for (const [name, change, expected] of [
    ['alias', (_config, body) => { body.terminal.model = 'alias-model'; }, /exact observed host model is unsupported/],
    ['retired', (config) => { config.models[0].status = 'retired'; }, /exact observed host model is unsupported/],
    ['unverified', (config) => { config.hostBuilds[0].status = 'unverified'; }, /exact observed host model is unsupported/],
    ['policy-version', (config) => { config.pins[0].modelPolicyVersion = 'stale-policy'; }, /policy version mismatches/],
  ]) {
    const f = fixture();
    const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => clock + 1, VmModelPolicy.fixture(f.config));
    const registration = f.registration(vm.serverEpoch, name, (body) => {
      if (name === 'alias') change(f.config, body);
    });
    const ticket = vm.reserve(registration.envelope);
    if (name !== 'alias') change(f.config, registration.body);
    await assert.rejects(vm.runCurrentRequest(ticket.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: f.receipt(registration.body, ticket.callId) },
      async () => vm.verifyCurrentReceipt()), expected);
    if (name === 'alias') {
      f.config.models.push({ ...f.config.models[0], observedModelId: 'alias-model' });
      const retried = await vm.runCurrentRequest(ticket.callId, 'plan_workflow',
        { ...unsigned, _hostAttestation: f.receipt(registration.body, ticket.callId) },
        async () => vm.verifyCurrentReceipt());
      assert.equal(retried.vmProfile.modelClass, 'deep');
    }
  }
});

test('revoked or changed installation pin and caller profile fields never yield a strict profile', async () => {
  const f = fixture();
  const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => clock + 1, VmModelPolicy.fixture(f.config));
  const registration = f.registration(vm.serverEpoch, 'revocation');
  const ticket = vm.reserve(registration.envelope);
  const input = { ...unsigned, _hostAttestation: f.receipt(registration.body, ticket.callId) };
  f.config.pins[0].status = 'revoked';
  await assert.rejects(vm.runCurrentRequest(ticket.callId, 'plan_workflow', input,
    async () => vm.verifyCurrentReceipt()), /pin is revoked/);
  f.config.pins[0].status = 'active';
  f.config.pins[0].installationId = 'different-installation';
  await assert.rejects(vm.runCurrentRequest(ticket.callId, 'plan_workflow', input,
    async () => vm.verifyCurrentReceipt()), /producer installation is not pinned/);
  f.config.pins[0].installationId = 'installation-1';
  for (const extra of [{ modelClass: 'frontier' }, { actorId: 'human-1' }, { _vmProducerReceipt: input._hostAttestation }]) {
    await assert.rejects(vm.runCurrentRequest(ticket.callId, 'plan_workflow', { ...input, ...extra },
      async () => vm.verifyCurrentReceipt()), /current tool or input differs from registration/);
  }
  const valid = await vm.runCurrentRequest(ticket.callId, 'plan_workflow', input, async () => vm.verifyCurrentReceipt());
  assert.equal(valid.vmProfile.actorId, 'vm-producer:installation-1');
});

test('installed path ignores inherited environment; unsafe ACL and symlink fail closed', () => {
  const original = installedVmPolicyPath();
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  process.env.AGENT_GOVERNANCE_VM_PIN_PATH = join(tmpdir(), 'caller-selected-pins.json');
  assert.equal(installedVmPolicyPath(), original);
  if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
  assert.equal(isProtectedWindowsAcl({ owner: 'S-1-5-18', rules: [
    { sid: 'S-1-5-32-544', rights: 2032127, type: 'Allow' },
    { sid: 'S-1-5-32-545', rights: 1179817, type: 'Allow' },
  ] }), true);
  assert.equal(isProtectedWindowsAcl({ owner: 'S-1-5-18', rules: [
    { sid: 'S-1-5-32-545', rights: 197055, type: 'Allow' },
  ] }), false);
  assert.equal(isProtectedWindowsAcl({ owner: 'S-1-5-21-1', rules: [] }), false);

  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-d-'));
  const file = join(directory, 'policy.json');
  writeFileSync(file, JSON.stringify(fixture().config));
  try {
    assert.throws(() => readProtectedVmPolicyFile(file), /owner or permissions are unsafe|ACL is writable or owner is untrusted/);
    const link = join(directory, 'linked.json');
    try {
      symlinkSync(file, link);
      assert.throws(() => readProtectedVmPolicyFileFixture(link, { isProtected: () => true }), /not regular/);
    } catch (error) {
      if (error?.code !== 'EPERM') throw error;
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('protected policy loader checks every ancestor and loads the same approved file', () => {
  const base = mkdtempSync(join(tmpdir(), 'ags-v03-d-chain-'));
  const ancestor = join(base, 'unsafe-ancestor');
  const directory = join(ancestor, 'protected-parent');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'policy.json');
  const expected = fixture().config;
  writeFileSync(file, JSON.stringify(expected));
  try {
    assert.throws(() => readProtectedVmPolicyFileFixture(file, {
      isProtected: (target) => target !== ancestor,
    }), /owner or permissions are unsafe/);
    assert.deepEqual(readProtectedVmPolicyFileFixture(file, { isProtected: () => true }), expected);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test('policy loader rejects directory and file swaps during or after protection checks', () => {
  for (const changed of ['directory', 'file']) for (const moment of ['during', 'after']) {
    const base = mkdtempSync(join(tmpdir(), `ags-v03-d-${changed}-`));
    const directory = join(base, 'protected-parent');
    mkdirSync(directory);
    const file = join(directory, 'policy.json');
    writeFileSync(file, JSON.stringify(fixture().config));
    const replacement = join(base, 'replacement');
    if (changed === 'directory') {
      mkdirSync(replacement);
      writeFileSync(join(replacement, 'policy.json'), JSON.stringify({ attacker: true }));
    }
    const swap = () => {
      if (changed === 'directory') {
        renameSync(directory, join(base, 'approved-backup'));
        renameSync(replacement, directory);
      } else {
        renameSync(file, join(directory, 'approved-backup.json'));
        writeFileSync(file, JSON.stringify({ attacker: true }));
      }
    };
    try {
      assert.throws(() => readProtectedVmPolicyFileFixture(file, {
        isProtected: (target) => {
          if (moment === 'during' && target === (changed === 'directory' ? directory : file)) swap();
          return true;
        },
        afterValidation: moment === 'after' ? swap : undefined,
      }), /configuration changed during validation|configuration changed before open|configuration changed during read/);
    } finally { rmSync(base, { recursive: true, force: true }); }
  }
});
