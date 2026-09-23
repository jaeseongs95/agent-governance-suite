import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { VmApprovedSlotSource } from '../../../mcp-server/src/host-integration/vm-approved-slot-source.ts';
import { VmCurrentInvocation } from '../../../mcp-server/src/host-integration/vm-current-invocation.ts';
import { VmModelPolicy } from '../../../mcp-server/src/host-integration/vm-model-policy.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';

const now = Date.parse('2026-09-23T00:00:01.000Z');
const id = `vm-approved-slot-${'a'.repeat(32)}`;
const vmVector = JSON.parse(readFileSync(new URL('./fixtures/R16-e-vm-producer-source.json', import.meta.url), 'utf8'));
const vmStage = JSON.parse(Buffer.from(vmVector.signedSource.body, 'base64url')).source.stages[0];

test('the actual VM R16-c synthetic producer source registers and consumes once', () => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/R16-e-vm-producer-source.json', import.meta.url), 'utf8'));
  const body = JSON.parse(Buffer.from(vector.signedSource.body, 'base64url'));
  const pin = { keyId: vector.signedSource.keyId, installationId: body.producer.installationId,
    hostId: body.producer.hostId, publicKeySpki: vector.publicKeySpki,
    hostBuildDigest: `sha256:${'b'.repeat(64)}`, modelPolicyVersion: 'policy-1', status: 'active' };
  const policy = VmModelPolicy.fixture({ version: 1, modelPolicyVersion: 'policy-1',
    pins: [pin], hostBuilds: [], models: [] });
  const vm = { serverEpoch: vector.serverEpoch, verifySignedEnvelope: (value) => policy.verifyEnvelope(value) };
  const registry = new VmApprovedSlotSource(vm, () => Date.parse(body.issuedAt) + 1);
  const expected = { invocationId: vector.invocationId, projectId: vector.projectId,
    taskId: vector.taskId, snapshotDigest: vector.snapshotDigest };
  assert.equal(registry.register(vector.invocationId, vector.signedSource).accepted, true);
  const source = registry.consume(expected);
  assert.equal(source.snapshot_digest, vector.snapshotDigest);
  assert.ok(source.stages[0].assignments.length > 0);
  assert.throws(() => registry.consume(expected), /pending source is unavailable/);
});

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pin = { keyId: 'key-1', installationId: 'install-1', hostId: 'flowmarshal-engine',
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    hostBuildDigest: `sha256:${'b'.repeat(64)}`, modelPolicyVersion: 'policy-1', status: 'active' };
  const policy = VmModelPolicy.fixture({ version: 1, modelPolicyVersion: 'policy-1',
    pins: [pin], hostBuilds: [], models: [] });
  const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now, policy);
  let tick = now;
  const registry = new VmApprovedSlotSource(vm, () => tick);
  const signed = (body) => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url'), keyId: pin.keyId };
  };
  const make = (invocationId = id, change = () => {}) => {
    const source = { owner: 'flowmarshal-engine', project_id: 'project-1', task_id: 'task-1',
      run_id: 'approval-1', plan_revision_id: 'revision-1', plan_id: 'plan-1', revision_no: 1,
      definition_digest: `sha256:${'c'.repeat(64)}`, activation_digest: `sha256:${'d'.repeat(64)}`,
      activation_id: 'activation-1', activation_authorization_id: 'authorization-1',
      authorization_id: 'authorization-1', authorization_revision_no: 1,
      authorization_digest: `sha256:${'e'.repeat(64)}`, revoked: false,
      stages: [{ ...structuredClone(vmStage), taskId: 'task-1' }],
      participation: { entries: [], complete: true, watermark: 4 },
      source_revision: 4 };
    source.snapshot_digest = `sha256:${createHash('sha256').update(canonicalJson(source)).digest('hex')}`;
    const body = { version: 1, domain: 'ags-vm-approved-slot-source-v1',
      producer: { installationId: pin.installationId, keyId: pin.keyId, hostId: pin.hostId,
        instanceId: 'instance-1', sessionId: 'session-1' },
      binding: { invocationId, serverEpoch: vm.serverEpoch, projectId: source.project_id,
        taskId: source.task_id, snapshotDigest: source.snapshot_digest },
      nonce: `nonce-${invocationId}`, issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(), source };
    change(body);
    return signed(body);
  };
  const expected = { invocationId: id, projectId: 'project-1', taskId: 'task-1',
    snapshotDigest: JSON.parse(Buffer.from(make().body, 'base64url')).source.snapshot_digest };
  return { vm, registry, policy, pin, make, expected, setClock(value) { tick = value; } };
}

test('signed VM source registers only once and is consumed only once', () => {
  const f = fixture();
  const envelope = f.make();
  assert.deepEqual(f.registry.register(id, envelope), { accepted: true, invocationId: id,
    serverEpoch: f.vm.serverEpoch, snapshotDigest: f.expected.snapshotDigest,
    projectId: 'project-1', taskId: 'task-1' });
  assert.throws(() => f.registry.register(id, envelope), /replay/);
  assert.equal(f.registry.consume(f.expected).snapshot_digest, f.expected.snapshotDigest);
  assert.throws(() => f.registry.consume(f.expected), /pending source is unavailable/);
  assert.throws(() => f.registry.register(id, f.make(id, (body) => {
    body.nonce = `second-${id}`;
  })), /replay/);
});

test('a newer signed watermark invalidates older pending sources', () => {
  const f = fixture();
  const nextId = `vm-approved-slot-${'b'.repeat(32)}`;
  const staleId = `vm-approved-slot-${'c'.repeat(32)}`;
  f.registry.register(id, f.make());
  const newer = f.make(nextId, (body) => {
    body.source.participation.watermark = 5;
    body.source.source_revision = 5;
    const { snapshot_digest, ...unsigned } = body.source;
    void snapshot_digest;
    body.source.snapshot_digest = `sha256:${createHash('sha256').update(canonicalJson(unsigned)).digest('hex')}`;
    body.binding.snapshotDigest = body.source.snapshot_digest;
  });
  const latestDigest = JSON.parse(Buffer.from(newer.body, 'base64url')).source.snapshot_digest;
  f.registry.register(nextId, newer);
  assert.throws(() => f.registry.consume(f.expected), /pending source is unavailable/);
  assert.throws(() => f.registry.register(staleId, f.make(staleId)), /stale/);
  assert.equal(f.registry.consume({ ...f.expected, invocationId: nextId, snapshotDigest: latestDigest })
    .source_revision, 5);
});

test('signature, pin, epoch, source binding, TTL and replay failures close the registry', () => {
  const f = fixture();
  const invalid = [
    f.make(id, (body) => { body.domain = 'vm-provider-terminal-to-governance'; }),
    f.make(id, (body) => { body.binding.serverEpoch = 'old-epoch'; }),
    f.make(id, (body) => { body.binding.projectId = 'other-project'; }),
    f.make(id, (body) => { body.producer.installationId = 'other-installation'; }),
    f.make(id, (body) => { body.source.revoked = true; }),
    f.make(id, (body) => { body.source.participation.watermark = 5; }),
    f.make(id, (body) => { body.source.stages[0].stageId = 'tampered'; }),
    f.make(id, (body) => { body.binding.snapshotDigest = `sha256:${'f'.repeat(64)}`; }),
  ];
  for (const envelope of invalid) assert.throws(() => f.registry.register(id, envelope));
  assert.throws(() => f.registry.register(`vm-approved-slot-${'d'.repeat(32)}`, f.make()), /source binding is invalid/);
  const changed = f.make();
  changed.signature = 'a'.repeat(changed.signature.length);
  assert.throws(() => f.registry.register(id, changed), /signature/);
  f.pin.status = 'revoked';
  assert.throws(() => f.registry.register(id, f.make()), /revoked/);
  f.pin.status = 'active';
  f.registry.register(id, f.make());
  f.pin.status = 'revoked';
  assert.throws(() => f.registry.consume(f.expected), /revoked/);
  assert.throws(() => f.registry.consume(f.expected), /pending source is unavailable/);
  f.pin.status = 'active';

  const expired = fixture();
  expired.setClock(now + 60_000);
  assert.throws(() => expired.registry.register(id, expired.make()), /source binding is invalid/);
  const restartedVm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now, f.policy);
  const restarted = new VmApprovedSlotSource(restartedVm, () => now);
  assert.throws(() => restarted.register(id, f.make()), /source binding is invalid/);
});

test('control RPC accepts the VM request ID and general tools/call cannot register a source', async () => {
  const f = fixture();
  const server = createMcpServer({} , { check: async () => null, takeNotice: () => null },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, f.vm, undefined, f.registry);
  const client = new Client({ name: 'r16-e-fixture', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const original = clientTransport.onmessage;
  const waiters = new Map();
  clientTransport.onmessage = (message) => {
    original?.(message);
    const resolve = waiters.get(message.id);
    if (resolve) { waiters.delete(message.id); resolve(message); }
  };
  const call = async (requestId, method, params) => {
    const response = new Promise((resolve) => waiters.set(requestId, resolve));
    await clientTransport.send({ jsonrpc: '2.0', id: requestId, method, params });
    return response;
  };
  try {
    const envelope = f.make();
    const accepted = await call(id, 'vm/register_approved_slot', { signedSource: envelope });
    assert.equal(accepted.result.accepted, true);
    assert.equal(accepted.result.slots.length, 1);
    assert.equal(accepted.result.slots[0].executionAuthorized, false);
    assert.throws(() => f.registry.consume(f.expected), /pending source is unavailable/);
    const replay = await call(id, 'vm/register_approved_slot', { signedSource: envelope });
    assert.match(replay.error?.message ?? '', /replay/);
    const injected = await call('injected', 'tools/call', {
      name: 'register_approved_slot', arguments: { signedSource: f.make() },
    });
    assert.ok(injected.error || injected.result?.isError);
    assert.throws(() => f.registry.consume(f.expected), /pending source is unavailable/);
  } finally { await client.close(); await server.close(); }
});
