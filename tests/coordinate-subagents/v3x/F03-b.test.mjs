import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { FlowmarshalCurrentInvocation } from '../../../mcp-server/src/host-integration/flowmarshal-current-invocation.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';

const now = Date.parse('2026-09-24T00:00:01.000Z');
const issuedAt = new Date(now).toISOString();
const expiresAt = new Date(now + 60_000).toISOString();
const task = { schemaVersion: '1.0.0', taskId: 'task-1',
  objective: 'Review the approved local task.', scope: { included: ['artifact-a'], excluded: [] },
  acceptanceCriteria: ['Report a supported decision.'], riskLevel: 'low', workUnits: [],
  requiredCapabilities: [], constraints: [],
  authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false },
  orchestration: { requested: false, mcpAvailable: true } };

function fixture(store = new InMemoryWorkflowStore()) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-f03-b-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const profile = { profileId: 'flowmarshal-same-user-v1', assuranceTier: 'same-user',
    freezeIdentity: `sha256:${'a'.repeat(64)}`,
    pins: [{ keyId: 'key-1', status: 'active',
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    resources: { state: { namespace: 'flowmarshal-same-user-v1', location: join(directory, 'state.sqlite3') } } };
  let tick = now + 1;
  const invocation = new FlowmarshalCurrentInvocation(profile, store, () => tick);
  const signed = (body, key = privateKey, keyId = 'key-1') => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url'), keyId };
  };
  const registration = (nonce, input = task, mutate = () => {}) => {
    const body = { version: 1, domain: 'ags-fm-same-user-dispatch-registration-v1',
      profileBinding: { profileId: profile.profileId, freezeIdentity: profile.freezeIdentity },
      assertions: { modelClass: 'deep', actorId: 'flowmarshal-engine:steward:bootstrap:thread-1' },
      serverEpoch: invocation.serverEpoch,
      nonce, issuedAt, expiresAt,
      producer: { installationId: 'fm-1', keyId: 'key-1', hostId: 'flowmarshal', instanceId: 'instance-1' },
      binding: { turnId: 'turn-1', taskId: 'task-1', runId: null, attemptId: null,
        hostId: 'flowmarshal', sessionId: 'session-1', instanceId: 'instance-1' },
      terminal: { eventId: 'event-1', callId: 'provider-1', threadId: 'thread-1', turnId: 'turn-1',
        status: 'succeeded', observedAt: '2026-09-24T00:00:00.000Z', model: 'fm-asserted-model',
        effort: 'high', provenance: 'provider_raw_response', digest: `sha256:${'b'.repeat(64)}` },
      core: { goalRevision: 1, taskRevision: 3, attemptOrdinal: null, gateOperationKey: 'operation-1', stage: 'bootstrap' },
      invocation: { tool: 'plan_workflow', inputDigest: convergenceDigest(input), observedAt: issuedAt } };
    mutate(body);
    return { body, envelope: signed(body) };
  };
  const receipt = (registrationBody, callId, nonce, mutate = () => {}) => {
    const registrationBytes = Buffer.from(canonicalJson(registrationBody));
    const body = { version: 2, domain: 'fm-same-user-provider-terminal-to-governance-v1',
      profileBinding: structuredClone(registrationBody.profileBinding),
      assertions: structuredClone(registrationBody.assertions),
      producer: structuredClone(registrationBody.producer),
      binding: { invocationId: callId, ...registrationBody.binding },
      terminal: structuredClone(registrationBody.terminal), core: structuredClone(registrationBody.core),
      invocation: structuredClone(registrationBody.invocation),
      nonce, issuedAt, expiresAt,
      transport: { serverEpoch: registrationBody.serverEpoch,
        registrationDigest: `sha256:${createHash('sha256').update(registrationBytes).digest('hex')}` } };
    mutate(body);
    return { body, envelope: signed(body) };
  };
  const current = (ticket, receiptEnvelope, input = task) =>
    invocation.runCurrentRequest(ticket.callId, 'plan_workflow', { ...input, _hostAttestation: receiptEnvelope },
      async () => invocation.verifyCurrentReceipt());
  return { profile, invocation, store, registration, receipt, signed, current,
    setClock(value) { tick = value; },
    claimRows() {
      const database = new DatabaseSync(profile.resources.state.location, { readOnly: true });
      try { return database.prepare('SELECT * FROM a2_receipt_claims').all(); }
      finally { database.close(); }
    },
    close() { invocation.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('A2 signed receipt is bound to the current call and atomically consumed once', async () => {
  const f = fixture();
  try {
    const registration = f.registration('registration-one');
    const ticket = f.invocation.reserve(registration.envelope);
    const receipt = f.receipt(registration.body, ticket.callId, 'receipt-one');
    const verified = await f.current(ticket, receipt.envelope);
    assert.equal(verified.profileId, f.profile.profileId);
    assert.equal(verified.freezeIdentity, f.profile.freezeIdentity);
    assert.equal(verified.model, 'fm-asserted-model');
    assert.equal(verified.modelClass, 'deep');
    assert.equal(verified.actorId, 'flowmarshal-engine:steward:bootstrap:thread-1');
    assert.equal(verified.binding.invocationId, ticket.callId);
    assert.equal(f.claimRows().length, 1);
    await assert.rejects(f.current(ticket, receipt.envelope), /already used/);
    assert.equal(f.claimRows().length, 1);
  } finally { f.close(); }
});

test('cross profile, key, domain, transport, terminal and Core fail before claim', async () => {
  const f = fixture();
  try {
    const foreign = generateKeyPairSync('ed25519');
    const cases = [
      ['domain', (body) => { body.domain = 'vm-provider-terminal-to-governance'; }],
      ['profile', (body) => { body.profileBinding.profileId = 'vm-protected-v1'; }],
      ['freeze', (body) => { body.profileBinding.freezeIdentity = `sha256:${'c'.repeat(64)}`; }],
      ['model-class', (body) => { body.assertions.modelClass = 'other'; }],
      ['actor', (body) => { body.assertions.actorId = 'other'; }],
      ['key', (body) => { body.producer.keyId = 'vm-key'; }],
      ['task', (body) => { body.binding.taskId = 'other-task'; }],
      ['run', (body) => { body.binding.runId = 'other-run'; }],
      ['stage', (body) => { body.core.stage = 'scope'; }],
      ['revision', (body) => { body.core.taskRevision = 4; }],
      ['tool', (body) => { body.invocation.tool = 'record_stage_result'; }],
      ['input', (body) => { body.invocation.inputDigest = `sha256:${'d'.repeat(64)}`; }],
      ['terminal', (body) => { body.terminal.model = 'different-model'; }],
      ['epoch', (body) => { body.transport.serverEpoch = 'other-epoch'; }],
      ['digest', (body) => { body.transport.registrationDigest = `sha256:${'e'.repeat(64)}`; }],
      ['call', (body) => { body.binding.invocationId = 'other-call'; }],
    ];
    for (const [name, mutate] of cases) {
      const registration = f.registration(`reg-${name}`);
      const ticket = f.invocation.reserve(registration.envelope);
      const wrong = f.receipt(registration.body, ticket.callId, `receipt-${name}`, mutate);
      await assert.rejects(f.current(ticket, wrong.envelope), /A2|registration mismatch/);
      assert.equal(f.claimRows().length, cases.indexOf(cases.find(([id]) => id === name)));
      const valid = f.receipt(registration.body, ticket.callId, `valid-${name}`);
      assert.equal((await f.current(ticket, valid.envelope)).model, 'fm-asserted-model');
    }
    const registration = f.registration('foreign-key');
    const ticket = f.invocation.reserve(registration.envelope);
    const valid = f.receipt(registration.body, ticket.callId, 'foreign-key-receipt');
    const forged = f.signed(valid.body, foreign.privateKey);
    await assert.rejects(f.current(ticket, forged), /signature mismatch/);
    assert.equal((await f.current(ticket, valid.envelope)).model, 'fm-asserted-model');
  } finally { f.close(); }
});

test('receipt nonce replay across reservations and expiry are rejected', async () => {
  const f = fixture();
  try {
    const first = f.registration('reg-first');
    const firstTicket = f.invocation.reserve(first.envelope);
    await f.current(firstTicket, f.receipt(first.body, firstTicket.callId, 'shared-nonce').envelope);
    const second = f.registration('reg-second');
    const secondTicket = f.invocation.reserve(second.envelope);
    await assert.rejects(f.current(secondTicket, f.receipt(second.body, secondTicket.callId, 'shared-nonce').envelope));
    assert.equal(f.claimRows().length, 1);
    await f.current(secondTicket, f.receipt(second.body, secondTicket.callId, 'fresh-nonce').envelope);
    const expired = f.registration('reg-expired');
    const expiredTicket = f.invocation.reserve(expired.envelope);
    f.setClock(now + 60_000);
    await assert.rejects(f.current(expiredTicket,
      f.receipt(expired.body, expiredTicket.callId, 'expired-receipt').envelope), /expired/);
    assert.equal(f.claimRows().length, 2);
  } finally { f.close(); }
});

test('stale signed terminal observations fail before A2 claim', async () => {
  const f = fixture();
  try {
    const registration = f.registration('stale-terminal', task, (body) => {
      body.terminal.observedAt = '2026-09-23T23:45:00.000Z';
    });
    const ticket = f.invocation.reserve(registration.envelope);
    const receipt = f.receipt(registration.body, ticket.callId, 'stale-receipt');
    await assert.rejects(f.current(ticket, receipt.envelope), /causal time or expiry/);
    assert.equal(f.claimRows().length, 0);
  } finally { f.close(); }
});

test('stage receipt waits for the stored run revision and stage without consuming an invalid claim', async () => {
  const store = new InMemoryWorkflowStore();
  const stored = { runId: 'run-1', revision: 7, state: 'running',
    plan: { taskId: 'task-1', stages: [{ stageId: 'implementation', state: 'ready' }] } };
  store.insertRun(stored);
  const f = fixture(store);
  const stageInput = { schemaVersion: '1.0.0', runId: 'run-1', stageId: 'implementation',
    expectedRevision: 8, state: 'passed',
    output: { schemaVersion: '1.0.0', kind: 'output', output: { done: true }, artifacts: [], error: null },
    evidence: [], findings: [], blockers: [], error: null };
  try {
    const registration = f.registration('stage-registration', stageInput, (body) => {
      body.binding.runId = 'run-1'; body.binding.attemptId = 'attempt-1';
      body.core.stage = 'scope'; body.core.attemptOrdinal = 1;
      body.invocation.tool = 'record_stage_result';
    });
    const ticket = f.invocation.reserve(registration.envelope);
    const receipt = f.receipt(registration.body, ticket.callId, 'stage-receipt');
    const call = () => f.invocation.runCurrentRequest(ticket.callId, 'record_stage_result',
      { ...stageInput, _hostAttestation: receipt.envelope }, async () => f.invocation.verifyCurrentReceipt());
    await assert.rejects(call(), /stored workflow stage binding mismatch/);
    assert.equal(f.claimRows().length, 0);
    assert.equal(store.updateRun({ ...stored, revision: 8 }, 7), true);
    assert.equal((await call()).core.stage, 'scope');
    assert.equal(f.claimRows().length, 1);
  } finally { f.close(); }
});

test('product current call consumes a valid receipt while strict WorkflowService admission stays closed', async () => {
  const f = fixture();
  let serviceCalls = 0;
  const service = { planWorkflow() { serviceCalls++; throw Error('service must stay closed'); } };
  const updates = { check: async () => null, takeNotice: () => null };
  const server = createMcpServer(service, updates, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { enabled: false, gateway: null }, undefined, f.invocation);
  const client = new Client({ name: 'f03-b-test', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const responses = new Map();
  const original = clientTransport.onmessage;
  clientTransport.onmessage = (message) => {
    original?.(message);
    if (message.id !== undefined) {
      const key = String(message.id);
      for (const resolve of responses.get(key) ?? []) resolve(message);
      responses.delete(key);
    }
  };
  const rawCall = async (id, args) => {
    const response = new Promise((resolve) => responses.set(id, [...(responses.get(id) ?? []), resolve]));
    await clientTransport.send({ jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'plan_workflow', arguments: args } });
    return response;
  };
  try {
    const registration = f.registration('product-registration');
    const ticket = await client.request({ method: 'fm/reserve_dispatch',
      params: { registration: registration.envelope } },
    z.object({ callId: z.string(), serverEpoch: z.string() }));
    const receipt = f.receipt(registration.body, ticket.callId, 'product-receipt');
    const first = await rawCall(ticket.callId, { ...task, _hostAttestation: receipt.envelope });
    assert.match(first.error?.message ?? '', /strict workflow provider is not installed/);
    assert.equal(f.claimRows().length, 1);
    assert.equal(serviceCalls, 0);
    const replay = await rawCall(ticket.callId, { ...task, _hostAttestation: receipt.envelope });
    assert.match(replay.error?.message ?? '', /already used/);
    assert.equal(serviceCalls, 0);
  } finally { await client.close(); await server.close(); f.close(); }
});
