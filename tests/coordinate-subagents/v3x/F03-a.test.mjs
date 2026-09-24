import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
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
const task = { schemaVersion: '1.0.0', taskId: 'task-1',
  objective: 'Review the approved local task.', scope: { included: ['artifact-a'], excluded: [] },
  acceptanceCriteria: ['Report a supported decision.'], riskLevel: 'low', workUnits: [],
  requiredCapabilities: [], constraints: [],
  authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false },
  orchestration: { requested: false, mcpAvailable: true } };
const stage = { schemaVersion: '1.0.0', runId: 'run-1', stageId: 'implementation', expectedRevision: 7,
  state: 'passed', output: { schemaVersion: '1.0.0', kind: 'output', output: { done: true }, artifacts: [], error: null },
  evidence: [], findings: [], blockers: [], error: null };

function fixture(store = new InMemoryWorkflowStore()) {
  let tick = now + 1;
  const directory = mkdtempSync(join(tmpdir(), 'ags-f03-a-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const profile = { profileId: 'flowmarshal-same-user-v1', assuranceTier: 'same-user',
    freezeIdentity: `sha256:${'a'.repeat(64)}`,
    pins: [{ keyId: 'key-1', status: 'active',
      publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }],
    resources: { state: { namespace: 'flowmarshal-same-user-v1', location: join(directory, 'state.sqlite3') } } };
  const invocation = new FlowmarshalCurrentInvocation(profile, store, () => tick);
  const signed = (body, key = privateKey, keyId = 'key-1') => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, key).toString('base64url'), keyId };
  };
  const registration = (nonce, input = task, change = () => {}) => {
    const body = { version: 1, domain: 'ags-fm-same-user-dispatch-registration-v1',
      profileBinding: { profileId: profile.profileId, freezeIdentity: profile.freezeIdentity },
      assertions: { modelClass: 'deep', actorId: 'flowmarshal-engine:steward:bootstrap:thread-1' },
      serverEpoch: invocation.serverEpoch, nonce,
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      producer: { installationId: 'fm-1', keyId: 'key-1', hostId: 'flowmarshal', instanceId: 'instance-1' },
      binding: { turnId: 'turn-1', taskId: 'task-1', runId: null, attemptId: null,
        hostId: 'flowmarshal', sessionId: 'session-1', instanceId: 'instance-1' },
      terminal: { eventId: 'event-1', callId: 'provider-1', threadId: 'thread-1', turnId: 'turn-1',
        status: 'succeeded', observedAt: '2026-09-24T00:00:00.000Z', model: 'fm-asserted-model',
        effort: 'high', provenance: 'provider_raw_response', digest: `sha256:${'b'.repeat(64)}` },
      core: { goalRevision: 1, taskRevision: 1, attemptOrdinal: null,
        gateOperationKey: 'operation-1', stage: 'bootstrap' },
      invocation: { tool: 'plan_workflow', inputDigest: convergenceDigest(input),
        observedAt: new Date(now).toISOString() } };
    change(body);
    return { body, envelope: signed(body) };
  };
  return { invocation, profile, store, directory, signed, registration,
    setClock(value) { tick = value; },
    close() { invocation.close(); rmSync(directory, { recursive: true, force: true }); } };
}

test('A2 signed registration, durable nonce and one-use current call bind to the selected profile', async () => {
  const f = fixture();
  try {
    const valid = f.registration('nonce-1');
    const { callId, serverEpoch } = f.invocation.reserve(valid.envelope);
    assert.match(callId, /^fmr-/);
    assert.equal(serverEpoch, f.invocation.serverEpoch);
    assert.throws(() => f.invocation.reserve(valid.envelope), /nonce already reserved/);
    const result = await f.invocation.runCurrentRequest(callId, 'plan_workflow', task,
      async () => {
        const observed = f.invocation.readCurrentInvocation();
        f.invocation.claimCurrentReservation();
        return observed;
      });
    assert.equal(result.callId, callId);
    assert.equal(result.registration.profileBinding.profileId, f.profile.profileId);
    assert.equal(result.registration.profileBinding.freezeIdentity, f.profile.freezeIdentity);
    await assert.rejects(f.invocation.runCurrentRequest(callId, 'plan_workflow', task, async () => true),
      /already used/);
    const restarted = new FlowmarshalCurrentInvocation(f.profile, f.store, () => now + 1);
    try {
      assert.notEqual(restarted.serverEpoch, serverEpoch);
      assert.throws(() => restarted.reserve({ ...valid.envelope,
        body: f.signed({ ...valid.body, serverEpoch: restarted.serverEpoch }).body,
        signature: f.signed({ ...valid.body, serverEpoch: restarted.serverEpoch }).signature }),
      /nonce already reserved/);
    } finally { restarted.close(); }
    assert.throws(() => new FlowmarshalCurrentInvocation({
      ...f.profile, freezeIdentity: `sha256:${'c'.repeat(64)}`,
    }, f.store, () => now + 1), /state profile identity mismatch/);
  } finally { f.close(); }
});

test('A2 rejects forged signature, wrong pin/profile/domain, epoch, expiry and nonce reuse', () => {
  const f = fixture();
  try {
    const base = f.registration('nonce-2');
    const other = generateKeyPairSync('ed25519');
    for (const envelope of [
      f.signed(base.body, other.privateKey),
      f.signed(base.body, undefined, 'vm-key'),
      ...[
        (body) => { body.profileBinding.profileId = 'vm-protected-v1'; },
        (body) => { body.profileBinding.freezeIdentity = `sha256:${'c'.repeat(64)}`; },
        (body) => { body.domain = 'ags-vm-dispatch-registration-v1'; },
        (body) => { body.serverEpoch = 'old-epoch'; },
        (body) => { body.expiresAt = new Date(now).toISOString(); },
        (body) => { body.producer.keyId = 'vm-key'; },
      ].map((change) => f.registration('nonce-2', task, change).envelope),
    ]) assert.throws(() => f.invocation.reserve(envelope), /A2 dispatch unavailable/);
    assert.match(f.invocation.reserve(base.envelope).callId, /^fmr-/);
    assert.throws(() => f.invocation.reserve(base.envelope), /nonce already reserved/);
  } finally { f.close(); }
});

test('durable registration evidence is reverified before a current call', async () => {
  const f = fixture();
  try {
    const ticket = f.invocation.reserve(f.registration('durable-evidence').envelope);
    const database = new DatabaseSync(f.profile.resources.state.location);
    try {
      const row = database.prepare('SELECT signed_envelope_json, body_json, registration_digest FROM a2_dispatch_reservations WHERE call_id=?')
        .get(ticket.callId);
      assert.equal(JSON.parse(row.signed_envelope_json).keyId, 'key-1');
      assert.equal(JSON.parse(row.body_json).profileBinding.profileId, f.profile.profileId);
      assert.match(row.registration_digest, /^sha256:/);
      const changed = { ...JSON.parse(row.signed_envelope_json), signature: 'AA' };
      database.prepare('UPDATE a2_dispatch_reservations SET signed_envelope_json=? WHERE call_id=?')
        .run(JSON.stringify(changed), ticket.callId);
    } finally { database.close(); }
    let called = false;
    await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow', task,
      async () => { called = true; }), /registration signature mismatch/);
    assert.equal(called, false);
  } finally { f.close(); }
});

test('stored expiry cannot extend a signed reservation', async () => {
  const f = fixture();
  try {
    const ticket = f.invocation.reserve(f.registration('expiry-tamper').envelope);
    const database = new DatabaseSync(f.profile.resources.state.location);
    try {
      database.prepare('UPDATE a2_dispatch_reservations SET expires_at=? WHERE call_id=?')
        .run(now + 120_000, ticket.callId);
    } finally { database.close(); }
    f.setClock(now + 60_001);
    let called = false;
    await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow', task,
      async () => { called = true; }), /stored registration evidence mismatch/);
    assert.equal(called, false);
  } finally { f.close(); }
});

test('current tool, input, task, stored run, stage and revision mismatch never reach a callback', async () => {
  const store = new InMemoryWorkflowStore();
  store.insertRun({ runId: 'run-1', revision: 7, state: 'running',
    plan: { taskId: 'task-1', stages: [{ stageId: 'implementation', state: 'ready' }] } });
  const f = fixture(store);
  try {
    let called = false;
    for (const [nonce, tool, input] of [
      ['wrong-tool', 'record_stage_result', task],
      ['wrong-input', 'plan_workflow', { ...task, objective: 'changed' }],
    ]) {
      const ticket = f.invocation.reserve(f.registration(nonce).envelope);
      await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, tool, input,
        async () => { called = true; }), /tool or input differs/);
      assert.equal((await f.invocation.runCurrentRequest(ticket.callId, 'plan_workflow', task,
        async () => f.invocation.readCurrentInvocation())).callId, ticket.callId);
    }
    const wrongTask = f.registration('wrong-task', task, (body) => { body.binding.taskId = 'other-task'; });
    const taskTicket = f.invocation.reserve(wrongTask.envelope);
    await assert.rejects(f.invocation.runCurrentRequest(taskTicket.callId, 'plan_workflow', task,
      async () => { called = true; }), /bootstrap task binding mismatch/);
    for (const [name, input, change] of [
      ['run', stage, (body) => { body.binding.runId = 'other-run'; }],
      ['stage', { ...stage, stageId: 'other-stage' }, () => {}],
      ['revision', { ...stage, expectedRevision: 8 }, () => {}],
    ]) {
      const registration = f.registration(name, input, (body) => {
        body.binding.runId = 'run-1'; body.binding.attemptId = 'attempt-1';
        body.core.stage = 'implementation'; body.core.taskRevision = 7; body.core.attemptOrdinal = 1;
        body.invocation.tool = 'record_stage_result';
        change(body);
      });
      const ticket = f.invocation.reserve(registration.envelope);
      await assert.rejects(f.invocation.runCurrentRequest(ticket.callId, 'record_stage_result', input,
        async () => { called = true; }), /stored workflow stage binding mismatch/);
    }
    assert.equal(called, false);
    const stageCompact = { ...stage, responseMode: 'compact' };
    const valid = f.registration('valid-stage', stageCompact, (body) => {
      body.binding.runId = 'run-1'; body.binding.attemptId = 'attempt-1';
      body.core.stage = 'scope'; body.core.taskRevision = 3; body.core.attemptOrdinal = 1;
      body.invocation.tool = 'record_stage_result';
    });
    const ticket = f.invocation.reserve(valid.envelope);
    assert.equal((await f.invocation.runCurrentRequest(ticket.callId, 'record_stage_result', stageCompact,
      async () => f.invocation.readCurrentInvocation())).tool, 'record_stage_result');
  } finally { f.close(); }
});

test('product A2 control RPC reserves a signed call but keeps WorkflowService admission closed', async () => {
  const f = fixture();
  let called = false;
  const updates = { check: async () => null, takeNotice: () => null };
  const service = { planWorkflow() { called = true; throw Error('service must stay closed'); } };
  const server = createMcpServer(service, updates, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { enabled: false, gateway: null }, undefined, f.invocation);
  const client = new Client({ name: 'f03-a-test', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const hello = await client.request({ method: 'fm/hello', params: {} }, z.object({ serverEpoch: z.string() }));
    assert.equal(hello.serverEpoch, f.invocation.serverEpoch);
    const ticket = await client.request({ method: 'fm/reserve_dispatch',
      params: { registration: f.registration('rpc').envelope } },
    z.object({ callId: z.string(), serverEpoch: z.string() }));
    const response = new Promise((resolve) => {
      const original = clientTransport.onmessage;
      clientTransport.onmessage = (message) => {
        original?.(message);
        if (message.id === ticket.callId) resolve(message);
      };
    });
    await clientTransport.send({ jsonrpc: '2.0', id: ticket.callId,
      method: 'tools/call', params: { name: 'plan_workflow', arguments: task } });
    const result = await response;
    assert.match(result.error?.message ?? '', /current receipt is missing/);
    assert.equal(called, false);
  } finally { await client.close(); await server.close(); f.close(); }
});
