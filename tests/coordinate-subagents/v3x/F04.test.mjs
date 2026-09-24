import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { FlowmarshalCurrentInvocation } from '../../../mcp-server/src/host-integration/flowmarshal-current-invocation.ts';
import { FileSkillRegistry } from '../../../mcp-server/src/registry.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';
import { WorkflowService } from '../../../mcp-server/src/workflow-service.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';

const registryPath = fileURLToPath(new URL('../../../skills/registry.json', import.meta.url));
const task = { schemaVersion: '1.0.0', taskId: 'a2-task',
  objective: 'Exercise the signed same-user workflow boundary.',
  scope: { included: ['fixture.md'], excluded: ['deployment'] },
  acceptanceCriteria: ['Record the verified stage.'], riskLevel: 'low',
  workUnits: [{ id: 'unit-1', objective: 'Exercise the fixture.', dependencies: [], writeTargets: ['fixture.md'] }],
  requiredCapabilities: ['task-decomposition'], constraints: ['Use fixture data only.'],
  authorization: { allowedActions: ['test'], prohibitedActions: ['deploy'], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false },
  orchestration: { requested: true, mcpAvailable: true } };
const planInput = { schemaVersion: '1.0.0', taskEnvelope: task };

async function harness(withProvider = true) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-f04-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const profile = { profileId: 'flowmarshal-same-user-v1', assuranceTier: 'same-user',
    freezeIdentity: `sha256:${'a'.repeat(64)}`,
    pins: [{ keyId: 'key-1', status: 'active',
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    resources: { state: { namespace: 'flowmarshal-same-user-v1', location: join(directory, 'a2.sqlite3') } } };
  const store = new InMemoryWorkflowStore();
  const invocation = new FlowmarshalCurrentInvocation(profile, store);
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator,
    store, null, withProvider ? invocation : null);
  const updates = { check: async () => null, takeNotice: () => null };
  const server = createMcpServer(service, updates, undefined, undefined, undefined, validator,
    'default', null, null, undefined, null, undefined, null,
    { enabled: false, gateway: null }, null, invocation);
  const client = new Client({ name: 'f04-a2-test', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const responses = new Map();
  const original = clientTransport.onmessage;
  clientTransport.onmessage = (message) => {
    original?.(message);
    if (message.id !== undefined) {
      for (const resolve of responses.get(String(message.id)) ?? []) resolve(message);
      responses.delete(String(message.id));
    }
  };
  const signed = (body) => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url'),
      keyId: 'key-1' };
  };
  const registration = (input, tool, nonce, { runId = null, stage = 'bootstrap', attemptId = null } = {}) => {
    const issued = Date.now();
    const body = { version: 1, domain: 'ags-fm-same-user-dispatch-registration-v1',
      profileBinding: { profileId: profile.profileId, freezeIdentity: profile.freezeIdentity },
      assertions: { modelClass: 'deep',
        actorId: attemptId ? `flowmarshal-engine:worker:${attemptId}` : `flowmarshal-engine:steward:${stage}:thread-1` },
      serverEpoch: invocation.serverEpoch, nonce, issuedAt: new Date(issued).toISOString(),
      expiresAt: new Date(issued + 60_000).toISOString(),
      producer: { installationId: 'fm-1', keyId: 'key-1', hostId: 'flowmarshal', instanceId: 'instance-1' },
      binding: { turnId: 'turn-1', taskId: task.taskId, runId, attemptId,
        hostId: 'flowmarshal', sessionId: 'session-1', instanceId: 'instance-1' },
      terminal: { eventId: `event-${nonce}`, callId: `provider-${nonce}`, threadId: 'thread-1', turnId: 'turn-1',
        status: 'succeeded', observedAt: new Date(issued - 1000).toISOString(),
        model: 'fm-observed-model', effort: 'high', provenance: 'provider_raw_response',
        digest: `sha256:${'b'.repeat(64)}` },
      core: { goalRevision: 1, taskRevision: 3, attemptOrdinal: attemptId ? 1 : null,
        gateOperationKey: `operation-${nonce}`, stage },
      invocation: { tool, inputDigest: convergenceDigest(input), observedAt: new Date(issued).toISOString() } };
    return { body, envelope: signed(body) };
  };
  const receipt = (registrationBody, callId, nonce, mutate = () => {}) => {
    const body = { version: 2, domain: 'fm-same-user-provider-terminal-to-governance-v1',
      profileBinding: structuredClone(registrationBody.profileBinding),
      assertions: structuredClone(registrationBody.assertions),
      producer: structuredClone(registrationBody.producer),
      binding: { invocationId: callId, ...registrationBody.binding },
      terminal: structuredClone(registrationBody.terminal), core: structuredClone(registrationBody.core),
      invocation: structuredClone(registrationBody.invocation), nonce,
      issuedAt: registrationBody.issuedAt, expiresAt: registrationBody.expiresAt,
      transport: { serverEpoch: registrationBody.serverEpoch,
        registrationDigest: `sha256:${createHash('sha256').update(Buffer.from(canonicalJson(registrationBody))).digest('hex')}` } };
    mutate(body);
    return signed(body);
  };
  const call = async (tool, input, nonce, options = {}, mutate = () => {}) => {
    const registered = registration(input, tool, `registration-${nonce}`, options);
    const ticket = await client.request({ method: 'fm/reserve_dispatch',
      params: { registration: registered.envelope } },
    z.object({ callId: z.string(), serverEpoch: z.string() }));
    const attestation = receipt(registered.body, ticket.callId, `receipt-${nonce}`, mutate);
    const response = new Promise((resolve) => responses.set(ticket.callId,
      [...(responses.get(ticket.callId) ?? []), resolve]));
    await clientTransport.send({ jsonrpc: '2.0', id: ticket.callId, method: 'tools/call',
      params: { name: tool, arguments: { ...input, _hostAttestation: attestation } } });
    return response;
  };
  return { profile, service, store, call, async close() {
    await client.close(); await server.close(); invocation.close(); rmSync(directory, { recursive: true, force: true });
  } };
}

function api(response) {
  if (response.error) throw new Error(response.error.message);
  return JSON.parse(response.result.content.find((item) => item.type === 'text').text);
}

function stageInput(run) {
  const stage = run.plan.stages[0];
  return { schemaVersion: '1.0.0', runId: run.runId, stageId: stage.stageId,
    expectedRevision: run.revision, state: 'passed',
    output: { schemaVersion: '1.0.0', kind: 'output', output: { completed: true },
      artifacts: stage.requiredArtifacts.map((artifactId) => ({
        artifactId, schemaId: 'f04/v1', locator: `fixture:${artifactId}`,
        digest: 'd'.repeat(64), targetDigest: 'e'.repeat(64), verified: true })),
      error: null },
    evidence: [{ artifactId: 'a2-fixture', kind: 'test', locator: 'F04.test.mjs', verified: true, note: 'Signed current call.' }],
    findings: [], blockers: [], error: null, responseMode: 'full' };
}

test('strict WorkflowService consumes A2 bootstrap and stage contexts with the same profile pair', async () => {
  const h = await harness();
  try {
    const planned = api(await h.call('plan_workflow', planInput, 'plan'));
    assert.equal(planned.ok, true, JSON.stringify(planned.error));
    const plan = planned.data;
    assert.deepEqual(plan.bootstrapExecution.context.profileBinding,
      { profileId: h.profile.profileId, freezeIdentity: h.profile.freezeIdentity });
    assert.equal(plan.bootstrapExecution.context.model, 'fm-observed-model');
    assert.equal(plan.bootstrapExecution.context.reasoningEffort, 'high');
    assert.equal(plan.bootstrapExecution.context.modelClass, 'deep');
    const started = h.service.startWorkflow(plan);
    assert.equal(started.ok, true);
    assert.deepEqual(started.data.profileBinding, plan.bootstrapExecution.context.profileBinding);
    const input = stageInput(started.data);
    const recorded = api(await h.call('record_stage_result', input, 'stage',
      { runId: started.data.runId, stage: 'implementation', attemptId: 'attempt-1' }));
    assert.equal(recorded.ok, true);
    assert.deepEqual(recorded.data.profileBinding, started.data.profileBinding);
    assert.equal(recorded.data.stageResults[0].executionContext.model, 'fm-observed-model');
    assert.equal(recorded.data.stageResults[0].executionContext.reasoningEffort, 'high');
    assert.deepEqual(recorded.data.stageResults[0].executionContext.profileBinding, started.data.profileBinding);
  } finally { await h.close(); }
});

test('missing provider, caller context, other profile and stale stored revision fail closed', async () => {
  const noProvider = await harness(false);
  try {
    const planned = api(await noProvider.call('plan_workflow', planInput, 'no-provider'));
    assert.equal(planned.ok, false);
    assert.equal(planned.error.code, 'BINDING_REQUIRED');
  } finally { await noProvider.close(); }
  const h = await harness();
  try {
    const wrongProfile = await h.call('plan_workflow', planInput, 'wrong-profile', {},
      (body) => { body.profileBinding.profileId = 'vm-protected-v1'; });
    assert.match(wrongProfile.error?.message ?? '', /A2 receipt source or binding is invalid/);
    const planned = api(await h.call('plan_workflow', planInput, 'valid-plan'));
    assert.equal(planned.ok, true, JSON.stringify(planned.error));
    const plan = planned.data;
    const started = h.service.startWorkflow(plan);
    assert.equal(started.ok, true, JSON.stringify(started.error));
    const run = started.data;
    const input = stageInput(run);
    const caller = api(await h.call('record_stage_result',
      { ...input, executionContext: { ...plan.bootstrapExecution.context, model: 'caller-model' } },
      'caller-context', { runId: run.runId, stage: 'implementation', attemptId: 'attempt-1' }));
    assert.equal(caller.ok, false);
    assert.equal(caller.error.code, 'BINDING_INVALID');
    const stale = await h.call('record_stage_result', { ...input, expectedRevision: run.revision + 1 },
      'stale', { runId: run.runId, stage: 'implementation', attemptId: 'attempt-1' });
    assert.match(stale.error?.message ?? '', /stored workflow stage binding mismatch/);
    for (const [name, change] of [
      ['missing-stored-profile', (receipt) => { delete receipt.profileBinding; }],
      ['other-stored-profile', (receipt) => { receipt.profileBinding.profileId = 'vm-protected-v1'; }],
    ]) {
      const startedAgain = h.service.startWorkflow(plan);
      assert.equal(startedAgain.ok, true);
      const changed = structuredClone(startedAgain.data);
      change(changed);
      assert.equal(h.store.updateRun(changed, changed.revision), true);
      const rejected = api(await h.call('record_stage_result', stageInput(changed), name,
        { runId: changed.runId, stage: 'implementation', attemptId: 'attempt-1' }));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error.code, 'BINDING_INVALID');
    }
  } finally { await h.close(); }
});
