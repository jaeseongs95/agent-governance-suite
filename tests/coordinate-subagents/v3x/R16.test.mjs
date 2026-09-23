import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { canonicalJson } from '../../../mcp-server/src/convergence-logic.ts';
import { VmApprovedSlotSource } from '../../../mcp-server/src/host-integration/vm-approved-slot-source.ts';
import { VmModelPolicy } from '../../../mcp-server/src/host-integration/vm-model-policy.ts';
import { ApprovedSlotReader } from '../../../mcp-server/src/orchestration/approved-slot-reader.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';

const vector = JSON.parse(readFileSync(new URL('./fixtures/R16-e-vm-producer-source.json', import.meta.url), 'utf8'));
const actualBody = JSON.parse(Buffer.from(vector.signedSource.body, 'base64url'));
const expectation = { invocationId: vector.invocationId, projectId: vector.projectId,
  taskId: vector.taskId, snapshotDigest: vector.snapshotDigest };

function registry(publicKeySpki, keyId, installationId, epoch, clock) {
  const policy = VmModelPolicy.fixture({ version: 1, modelPolicyVersion: 'test-policy',
    pins: [{ keyId, installationId, hostId: 'flowmarshal-engine', publicKeySpki,
      hostBuildDigest: `sha256:${'a'.repeat(64)}`, modelPolicyVersion: 'test-policy', status: 'active' }],
    hostBuilds: [], models: [] });
  return new VmApprovedSlotSource({ serverEpoch: epoch,
    verifySignedEnvelope: (value) => policy.verifyEnvelope(value) }, clock);
}

function synthetic(mutate) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const body = structuredClone(actualBody);
  body.producer.keyId = 'synthetic-key';
  body.producer.installationId = 'synthetic-installation';
  body.binding.invocationId = `vm-approved-slot-${'z'.repeat(32)}`;
  body.nonce = `synthetic-${'n'.repeat(32)}`;
  mutate(body);
  const { snapshot_digest, ...unsigned } = body.source;
  void snapshot_digest;
  body.source.snapshot_digest = `sha256:${createHash('sha256').update(canonicalJson(unsigned)).digest('hex')}`;
  body.binding.snapshotDigest = body.source.snapshot_digest;
  const bytes = Buffer.from(canonicalJson(body));
  const signedSource = { body: bytes.toString('base64url'),
    signature: sign(null, bytes, privateKey).toString('base64url'), keyId: body.producer.keyId };
  const source = registry(publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    body.producer.keyId, body.producer.installationId, vector.serverEpoch,
    () => Date.parse(body.issuedAt) + 1);
  const expected = { invocationId: body.binding.invocationId, projectId: body.binding.projectId,
    taskId: body.binding.taskId, snapshotDigest: body.binding.snapshotDigest };
  return { source, signedSource, expected };
}

test('VM writer and signer fixture projects through one-use AGS receiver into R15 RoleSlots', () => {
  const source = registry(vector.publicKeySpki, vector.signedSource.keyId,
    actualBody.producer.installationId, vector.serverEpoch, () => Date.parse(actualBody.issuedAt) + 1);
  source.register(vector.invocationId, vector.signedSource);
  const reader = new ApprovedSlotReader(source);
  const result = reader.read(expectation);
  assert.equal(result.authority.projectId, vector.projectId);
  assert.equal(result.authority.planRevisionId, actualBody.source.plan_revision_id);
  assert.equal(result.authority.authorizationId, actualBody.source.authorization_id);
  assert.equal(result.authority.sourceRevision, actualBody.source.source_revision);
  assert.equal(result.authority.snapshotDigest, vector.snapshotDigest);
  assert.equal(result.slots.length, 1);
  assert.equal(result.slots[0].routingRole, 'independent-audit');
  assert.equal(result.slots[0].authorization.taskId, vector.taskId);
  assert.equal(result.slots[0].authorization.runId, actualBody.source.run_id);
  assert.equal(result.slots[0].executionAuthorized, false);
  assert.equal(result.slots[0].authorization.planDigest, result.projection.planDigest);
  assert.throws(() => reader.read(expectation), /pending source is unavailable/);
});

test('the product control RPC returns R15 slots from the signed VM producer fixture', async () => {
  const policy = VmModelPolicy.fixture({ version: 1, modelPolicyVersion: 'test-policy',
    pins: [{ keyId: vector.signedSource.keyId, installationId: actualBody.producer.installationId,
      hostId: 'flowmarshal-engine', publicKeySpki: vector.publicKeySpki,
      hostBuildDigest: `sha256:${'a'.repeat(64)}`, modelPolicyVersion: 'test-policy', status: 'active' }],
    hostBuilds: [], models: [] });
  const vm = { serverEpoch: vector.serverEpoch, verifySignedEnvelope: (value) => policy.verifyEnvelope(value),
    reserve() { throw Error('unused'); }, hasCurrentRequest: () => false,
    runCurrentRequest: async (_id, _tool, _args, run) => run() };
  const pending = new VmApprovedSlotSource(vm, () => Date.parse(actualBody.issuedAt) + 1);
  const server = createMcpServer({}, { check: async () => null, takeNotice: () => null },
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, vm, undefined, pending);
  const client = new Client({ name: 'r16-fixture', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const response = new Promise((resolve) => {
      const original = clientTransport.onmessage;
      clientTransport.onmessage = (message) => { original?.(message);
        if (message.id === vector.invocationId) resolve(message); };
    });
    await clientTransport.send({ jsonrpc: '2.0', id: vector.invocationId,
      method: 'vm/register_approved_slot', params: { signedSource: vector.signedSource } });
    const message = await response;
    assert.equal(message.result.accepted, true);
    assert.equal(message.result.authority.snapshotDigest, vector.snapshotDigest);
    assert.equal(message.result.slots.length, 1);
    assert.equal(message.result.slots[0].executionAuthorized, false);
    assert.throws(() => pending.consume(expectation), /pending source is unavailable/);
  } finally { await client.close(); await server.close(); }
});

test('wrong task, stale plan, revoked source and forged requirements fail closed', () => {
  const absent = synthetic((body) => { body.source.stages = []; });
  assert.throws(() => absent.source.register(absent.expected.invocationId, absent.signedSource), /source binding is invalid/);

  const wrongTask = synthetic((body) => { body.source.stages[0].taskId = 'other-task'; });
  wrongTask.source.register(wrongTask.expected.invocationId, wrongTask.signedSource);
  assert.throws(() => new ApprovedSlotReader(wrongTask.source).read(wrongTask.expected), /stage does not belong/);

  const stale = synthetic(() => {});
  stale.source.register(stale.expected.invocationId, stale.signedSource);
  assert.throws(() => new ApprovedSlotReader(stale.source).read({ ...stale.expected,
    planRevisionId: 'superseded-revision' }), /approval or participation is stale/);
  assert.throws(() => new ApprovedSlotReader(stale.source).read(stale.expected), /pending source is unavailable/);

  const oldAuthorization = synthetic(() => {});
  oldAuthorization.source.register(oldAuthorization.expected.invocationId, oldAuthorization.signedSource);
  assert.throws(() => new ApprovedSlotReader(oldAuthorization.source).read({ ...oldAuthorization.expected,
    authorizationId: 'superseded-authorization' }), /approval or participation is stale/);

  const revoked = synthetic((body) => { body.source.revoked = true; });
  assert.throws(() => revoked.source.register(revoked.expected.invocationId, revoked.signedSource), /source binding is invalid/);

  const forged = synthetic(() => {});
  const changed = { ...forged.signedSource,
    body: Buffer.from(forged.signedSource.body, 'base64url').toString('utf8') };
  const payload = JSON.parse(changed.body);
  payload.source.stages[0].assignments[0].requirements.filesystem = 'write';
  changed.body = Buffer.from(canonicalJson(payload)).toString('base64url');
  assert.throws(() => forged.source.register(forged.expected.invocationId, changed), /signature/);
});

test('incomplete participant history and audit exclusions above 128 fail closed', () => {
  const participated = synthetic((body) => {
    body.source.participation.entries = [{ actorId: 'reviewer-1', host: 'codex', sessionId: 'session-1' }];
  });
  participated.source.register(participated.expected.invocationId, participated.signedSource);
  const audit = new ApprovedSlotReader(participated.source).read(participated.expected).slots[0];
  assert.deepEqual(audit.requirements.excludedActors, ['reviewer-1']);
  assert.deepEqual(audit.requirements.excludedSessions, ['codex/session-1']);

  const incomplete = synthetic((body) => { body.source.participation.complete = false; });
  assert.throws(() => incomplete.source.register(incomplete.expected.invocationId, incomplete.signedSource), /source binding is invalid/);
  const overLimit = synthetic((body) => {
    body.source.participation.entries = Array.from({ length: 129 }, (_, index) => ({
      actorId: `actor-${index}`, host: 'host-1', sessionId: `session-${index}` }));
  });
  overLimit.source.register(overLimit.expected.invocationId, overLimit.signedSource);
  assert.throws(() => new ApprovedSlotReader(overLimit.source).read(overLimit.expected));
});
