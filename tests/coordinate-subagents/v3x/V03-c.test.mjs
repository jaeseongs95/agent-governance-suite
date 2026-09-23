import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';

import { canonicalJson, convergenceDigest } from '../../../mcp-server/src/convergence-logic.ts';
import { VmCurrentInvocation } from '../../../mcp-server/src/host-integration/vm-current-invocation.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';

const now = Date.parse('2026-09-23T00:00:01.000Z');
const issuedAt = new Date(now).toISOString();
const expiresAt = new Date(now + 60_000).toISOString();
const unsigned = { schemaVersion: '1.0.0', taskId: 'task-1',
  objective: 'Review the approved local task.', scope: { included: ['artifact-a'], excluded: [] },
  acceptanceCriteria: ['Report a supported decision.'], riskLevel: 'low', workUnits: [],
  requiredCapabilities: [], constraints: [],
  authorization: { allowedActions: ['read'], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: 'simple', hasConflicts: false },
  orchestration: { requested: false, mcpAvailable: true } };

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-v03-c-'));
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pinPath = join(directory, 'pins.json');
  writeFileSync(pinPath, JSON.stringify({ version: 1, pins: [{
    keyId: 'key-1', installationId: 'install-1', hostId: 'flowmarshal-engine',
    publicKeySpki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  }] }));
  const prior = process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
  process.env.AGENT_GOVERNANCE_VM_PIN_PATH = pinPath;
  const signed = (body) => {
    const bytes = Buffer.from(canonicalJson(body));
    return { body: bytes.toString('base64url'), signature: sign(null, bytes, privateKey).toString('base64url'), keyId: 'key-1' };
  };
  const registration = (epoch, nonce, change = () => {}) => {
    const body = {
      version: 1, domain: 'ags-vm-dispatch-registration-v1', serverEpoch: epoch,
      nonce, issuedAt, expiresAt,
      producer: { installationId: 'install-1', keyId: 'key-1', hostId: 'flowmarshal-engine', instanceId: 'instance-1' },
      binding: { turnId: 'turn-1', taskId: 'task-1', runId: null, attemptId: null,
        hostId: 'flowmarshal-engine', sessionId: 'session-1', instanceId: 'instance-1' },
      terminal: { eventId: 'event-1', callId: 'provider-1', threadId: 'thread-1', turnId: 'turn-1',
        status: 'succeeded', observedAt: '2026-09-23T00:00:00.000Z', model: 'observed-model',
        effort: 'high', provenance: 'provider_raw_response', digest: `sha256:${'a'.repeat(64)}` },
      core: { goalRevision: 1, taskRevision: 1, attemptOrdinal: null, gateOperationKey: 'operation-1', stage: 'bootstrap' },
      invocation: { tool: 'plan_workflow', inputDigest: convergenceDigest(unsigned), observedAt: issuedAt },
    };
    change(body);
    return { body, envelope: signed(body) };
  };
  const receipt = (registrationBody, callId, change = () => {}) => {
    const registrationBytes = Buffer.from(canonicalJson(registrationBody));
    const body = {
      version: 2, domain: 'vm-provider-terminal-to-governance',
      producer: structuredClone(registrationBody.producer),
      binding: { invocationId: callId, ...registrationBody.binding },
      terminal: structuredClone(registrationBody.terminal), core: structuredClone(registrationBody.core),
      invocation: structuredClone(registrationBody.invocation),
      nonce: `receipt-${callId}`, issuedAt, expiresAt,
      transport: { serverEpoch: registrationBody.serverEpoch,
        registrationDigest: `sha256:${createHash('sha256').update(registrationBytes).digest('hex')}` },
    };
    change(body);
    return signed(body);
  };
  return { registration, receipt, signed, close() {
    if (prior === undefined) delete process.env.AGENT_GOVERNANCE_VM_PIN_PATH;
    else process.env.AGENT_GOVERNANCE_VM_PIN_PATH = prior;
    rmSync(directory, { recursive: true, force: true });
  } };
}

async function productServer(vm, service, updates = { check: async () => null, takeNotice: () => null }) {
  const server = createMcpServer(service, updates, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, vm);
  const client = new Client({ name: 'v03-c-product-client', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const responses = new Map();
  const waiters = new Map();
  const original = clientTransport.onmessage;
  clientTransport.onmessage = (message) => {
    original?.(message);
    const id = String(message.id ?? '');
    if (!id) return;
    const received = responses.get(id) ?? [];
    received.push(message);
    responses.set(id, received);
    for (const waiter of waiters.get(id) ?? []) waiter();
  };
  const waitFor = (id, count) => new Promise((resolve) => {
    if ((responses.get(id)?.length ?? 0) >= count) return resolve(responses.get(id));
    const list = waiters.get(id) ?? [];
    list.push(() => { if ((responses.get(id)?.length ?? 0) >= count) resolve(responses.get(id)); });
    waiters.set(id, list);
  });
  return {
    client,
    transport: clientTransport,
    responses,
    waitFor,
    async call(id, name, args) {
      const next = (responses.get(id)?.length ?? 0) + 1;
      await clientTransport.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
      return (await waitFor(id, next))[next - 1];
    },
    async close() { await client.close(); await server.close(); },
  };
}

test('product control RPC rejects concurrent swapped receipts and preserves both reservations', async () => {
  const f = fixture();
  const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
  const outcomes = [];
  const service = { planWorkflow(input) {
    assert.equal(Object.hasOwn(input, '_hostAttestation'), false);
    outcomes.push('accepted');
    return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
  } };
  const sdk = await productServer(vm, service);
  try {
    const hello = await sdk.client.request({ method: 'vm/hello', params: {} }, z.object({ serverEpoch: z.string() }));
    assert.equal(hello.serverEpoch, vm.serverEpoch);
    const a = f.registration(hello.serverEpoch, 'registration-A');
    const b = f.registration(hello.serverEpoch, 'registration-B');
    const response = z.object({ callId: z.string(), serverEpoch: z.string() });
    const ticketA = await sdk.client.request({ method: 'vm/reserve_dispatch', params: { registration: a.envelope } }, response);
    const ticketB = await sdk.client.request({ method: 'vm/reserve_dispatch', params: { registration: b.envelope } }, response);
    assert.notEqual(ticketA.callId, ticketB.callId);
    const receiptA = f.receipt(a.body, ticketA.callId);
    const receiptB = f.receipt(b.body, ticketB.callId);
    const call = (id, receipt) => sdk.call(id, 'plan_workflow', { ...unsigned, _hostAttestation: receipt });
    const copiedSideband = await call('unreserved-new-request', receiptA);
    assert.match(copiedSideband.error?.message ?? '', /current reserved request is unavailable/);
    assert.deepEqual(outcomes, []);
    const [wrongA, wrongB] = await Promise.all([
      call(ticketA.callId, receiptB), call(ticketB.callId, receiptA),
    ]);
    assert.match(wrongA.error?.message ?? '', /invocationId binding mismatch/);
    assert.match(wrongB.error?.message ?? '', /invocationId binding mismatch/);
    assert.deepEqual(outcomes, []);
    const [acceptedA, acceptedB] = await Promise.all([
      call(ticketA.callId, receiptA), call(ticketB.callId, receiptB),
    ]);
    assert.equal(acceptedA.error, undefined);
    assert.equal(acceptedB.error, undefined);
    assert.deepEqual(outcomes, ['accepted', 'accepted']);
    await assert.rejects(sdk.client.request({ method: 'vm/reserve_dispatch', params: { registration: a.envelope } }, response), /nonce already reserved/);
  } finally {
    await sdk.close();
    f.close();
  }
});

test('bad registration, copied sideband, concurrent contexts and restart fail closed', async () => {
  const f = fixture();
  try {
    const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
    const reader = vm.observationReader;
    const a = f.registration(vm.serverEpoch, 'registration-A');
    const tampered = { ...a.envelope, signature: `${a.envelope.signature[0] === 'A' ? 'B' : 'A'}${a.envelope.signature.slice(1)}` };
    assert.throws(() => vm.reserve(tampered), /signature mismatch/);
    const ticketA = vm.reserve(a.envelope);
    assert.throws(() => vm.reserve(a.envelope), /nonce already reserved/);
    const restart = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
    assert.notEqual(restart.serverEpoch, vm.serverEpoch);
    assert.throws(() => restart.reserve(a.envelope), /registration binding is invalid/);
    const b = f.registration(vm.serverEpoch, 'registration-B', (body) => {
      body.binding.sessionId = 'session-B'; body.binding.instanceId = 'instance-B';
      body.producer.instanceId = 'instance-B';
    });
    const ticketB = vm.reserve(b.envelope);
    const receiptA = f.receipt(a.body, ticketA.callId);
    const run = (ticket, receipt) => vm.runCurrentRequest(ticket.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: receipt }, async () => {
        await Promise.resolve();
        vm.verifyCurrentReceipt();
        return true;
      });
    await assert.rejects(run(ticketB, receiptA), /invocationId binding mismatch/);
    assert.equal(await run(ticketA, receiptA), true);
    assert.equal(await run(ticketB, f.receipt(b.body, ticketB.callId)), true);
    const wrongStage = f.registration(vm.serverEpoch, 'wrong-stage', (body) => { body.core.stage = 'implementation'; });
    assert.throws(() => vm.reserve(wrongStage.envelope), /registration binding is invalid/);
    const wrongAttempt = f.registration(vm.serverEpoch, 'wrong-attempt', (body) => { body.binding.attemptId = 'forged'; });
    assert.throws(() => vm.reserve(wrongAttempt.envelope), /registration binding is invalid/);
    const e = f.registration(vm.serverEpoch, 'registration-E');
    const ticketE = vm.reserve(e.envelope);
    const wrongSession = f.receipt(e.body, ticketE.callId, (body) => { body.binding.sessionId = 'copied-session'; });
    await assert.rejects(run(ticketE, wrongSession), /sessionId binding mismatch/);
    assert.throws(() => reader.readCurrentInvocation(), /current reserved request is unavailable/);
    assert.throws(() => vm.reserve(b.envelope), /nonce already reserved/);
    const c = f.registration(vm.serverEpoch, 'registration-C');
    const d = f.registration(vm.serverEpoch, 'registration-D');
    const ticketC = vm.reserve(c.envelope), ticketD = vm.reserve(d.envelope);
    const [resultC, resultD] = await Promise.all([
      run(ticketC, f.receipt(c.body, ticketC.callId)),
      run(ticketD, f.receipt(d.body, ticketD.callId)),
    ]);
    assert.deepEqual([resultC, resultD], [true, true]);
    await assert.rejects(run(ticketC, f.receipt(c.body, ticketC.callId)), /current reserved request is unavailable/);
    assert.equal(ticketB.serverEpoch, vm.serverEpoch);
  } finally { f.close(); }
});

test('product stage RPC checks stored run, session, instance, attempt and revision before nonce claim', async () => {
  const f = fixture();
  const store = new InMemoryWorkflowStore();
  const stageInput = { schemaVersion: '1.0.0', runId: 'run-1', stageId: 'stage-1', expectedRevision: 7,
    state: 'passed', output: { schemaVersion: '1.0.0', kind: 'output', output: { done: true }, artifacts: [], error: null },
    evidence: [], findings: [], blockers: [], error: null };
  const stored = { runId: 'run-1', revision: 7, state: 'running',
    plan: { taskId: 'task-1', stages: [{ stageId: 'stage-1', state: 'ready' }] } };
  store.insertRun(stored);
  const vm = new VmCurrentInvocation(store, () => now + 1);
  const delivered = [];
  const sdk = await productServer(vm, { recordStageResult(input) {
    assert.equal(Object.hasOwn(input, '_hostAttestation'), false);
    delivered.push(input);
    return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
  } });
  const registerStage = (nonce, input = stageInput, change = () => {}) => f.registration(vm.serverEpoch, nonce, (body) => {
    body.binding.runId = input.runId;
    body.binding.attemptId = 'attempt-1';
    body.core.stage = 'implementation';
    body.core.attemptOrdinal = 1;
    body.invocation.tool = 'record_stage_result';
    body.invocation.inputDigest = convergenceDigest(input);
    change(body);
  });
  const reserve = async (registration) => sdk.client.request({ method: 'vm/reserve_dispatch',
    params: { registration: registration.envelope } }, z.object({ callId: z.string(), serverEpoch: z.string() }));
  try {
    for (const [name, mutate] of [
      ['session', (body) => { body.binding.sessionId = 'wrong-session'; }],
      ['instance', (body) => { body.binding.instanceId = 'wrong-instance'; body.producer.instanceId = 'wrong-instance'; }],
      ['attempt', (body) => { body.binding.attemptId = 'wrong-attempt'; }],
    ]) {
      const registration = registerStage(`stage-${name}`);
      const ticket = await reserve(registration);
      const wrong = f.receipt(registration.body, ticket.callId, mutate);
      const failed = await sdk.call(ticket.callId, 'record_stage_result', { ...stageInput, _hostAttestation: wrong });
      assert.match(failed.error?.message ?? '', new RegExp(`${name}Id binding mismatch`));
      assert.equal(delivered.length, ['session', 'instance', 'attempt'].indexOf(name));
      const valid = f.receipt(registration.body, ticket.callId);
      const passed = await sdk.call(ticket.callId, 'record_stage_result', { ...stageInput, _hostAttestation: valid });
      assert.equal(passed.error, undefined);
    }
    assert.equal(delivered.length, 3);
    const badAttempt = registerStage('stage-null-attempt', stageInput, (body) => { body.binding.attemptId = null; });
    await assert.rejects(reserve(badAttempt), /registration binding is invalid/);

    const newerInput = { ...stageInput, expectedRevision: 8 };
    const revisionRegistration = registerStage('stage-revision', newerInput);
    const revisionTicket = await reserve(revisionRegistration);
    const revisionReceipt = f.receipt(revisionRegistration.body, revisionTicket.callId);
    const wrongRevision = await sdk.call(revisionTicket.callId, 'record_stage_result',
      { ...newerInput, _hostAttestation: revisionReceipt });
    assert.match(wrongRevision.error?.message ?? '', /stored workflow stage binding mismatch/);
    assert.equal(delivered.length, 3);
    assert.equal(store.updateRun({ ...stored, revision: 8 }, 7), true);
    const retried = await sdk.call(revisionTicket.callId, 'record_stage_result',
      { ...newerInput, _hostAttestation: revisionReceipt });
    assert.equal(retried.error, undefined);

    const otherStageInput = { ...newerInput, stageId: 'other-stage' };
    const stageRegistration = registerStage('stage-mismatch', otherStageInput);
    const stageTicket = await reserve(stageRegistration);
    const stageReceipt = f.receipt(stageRegistration.body, stageTicket.callId);
    const missingStage = await sdk.call(stageTicket.callId, 'record_stage_result',
      { ...otherStageInput, _hostAttestation: stageReceipt });
    assert.match(missingStage.error?.message ?? '', /stored workflow stage binding mismatch/);
    assert.equal(store.updateRun({ ...stored, revision: 8,
      plan: { ...stored.plan, stages: [{ stageId: 'other-stage', state: 'ready' }] } }, 8), true);
    const restored = await sdk.call(stageTicket.callId, 'record_stage_result',
      { ...otherStageInput, _hostAttestation: stageReceipt });
    assert.equal(restored.error, undefined);
    assert.equal(delivered.length, 5);
  } finally { await sdk.close(); f.close(); }
});

test('product RPC enforces TTL boundary and rejects pre-restart reservation', async () => {
  const f = fixture();
  let tick = now + 1;
  const store = new InMemoryWorkflowStore();
  const vm = new VmCurrentInvocation(store, () => tick);
  let calls = 0;
  const sdk = await productServer(vm, { planWorkflow() {
    calls += 1;
    return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
  } });
  const reserve = async (registration) => sdk.client.request({ method: 'vm/reserve_dispatch',
    params: { registration: registration.envelope } }, z.object({ callId: z.string(), serverEpoch: z.string() }));
  try {
    const before = f.registration(vm.serverEpoch, 'ttl-before');
    const ticketBefore = await reserve(before);
    tick = now + 59_999;
    const accepted = await sdk.call(ticketBefore.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: f.receipt(before.body, ticketBefore.callId) });
    assert.equal(accepted.error, undefined);
    assert.equal(calls, 1);
    const expired = f.registration(vm.serverEpoch, 'ttl-exact');
    const ticketExpired = await reserve(expired);
    tick = now + 60_000;
    const rejected = await sdk.call(ticketExpired.callId, 'plan_workflow',
      { ...unsigned, _hostAttestation: f.receipt(expired.body, ticketExpired.callId) });
    assert.match(rejected.error?.message ?? '', /reservation expired or already active/);
    assert.equal(calls, 1);

    const restarted = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
    assert.notEqual(restarted.serverEpoch, vm.serverEpoch);
    const restartedSdk = await productServer(restarted, { planWorkflow() {
      calls += 1;
      return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
    } });
    try {
      const stale = await restartedSdk.call(ticketExpired.callId, 'plan_workflow',
        { ...unsigned, _hostAttestation: f.receipt(expired.body, ticketExpired.callId) });
      assert.match(stale.error?.message ?? '', /current reserved request is unavailable/);
      await assert.rejects(restartedSdk.client.request({ method: 'vm/reserve_dispatch',
        params: { registration: expired.envelope } }, z.object({ callId: z.string(), serverEpoch: z.string() })),
      /registration binding is invalid/);
      assert.equal(calls, 1);
    } finally { await restartedSdk.close(); }
  } finally { await sdk.close(); f.close(); }
});

test('product RPC locks concurrent reuse of one call ID and consumes it after claim', async () => {
  const f = fixture();
  const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
  let started;
  let release;
  const entered = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let calls = 0;
  const sdk = await productServer(vm, { planWorkflow() {
    calls += 1;
    return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
  } }, { check: async () => { started(); await gate; return null; }, takeNotice: () => null });
  try {
    const registration = f.registration(vm.serverEpoch, 'same-id-concurrent');
    const ticket = await sdk.client.request({ method: 'vm/reserve_dispatch',
      params: { registration: registration.envelope } }, z.object({ callId: z.string(), serverEpoch: z.string() }));
    const request = { jsonrpc: '2.0', id: ticket.callId, method: 'tools/call', params: {
      name: 'plan_workflow', arguments: { ...unsigned, _hostAttestation: f.receipt(registration.body, ticket.callId) },
    } };
    const first = sdk.transport.send(request);
    await entered;
    const second = sdk.transport.send(request);
    await sdk.waitFor(ticket.callId, 1);
    release();
    await Promise.all([first, second]);
    const responses = await sdk.waitFor(ticket.callId, 2);
    assert.equal(responses.filter((item) => item.error === undefined).length, 1);
    assert.equal(responses.filter((item) => /already active/.test(item.error?.message ?? '')).length, 1);
    assert.equal(calls, 1);
    const replay = await sdk.call(ticket.callId, 'plan_workflow', request.params.arguments);
    assert.match(replay.error?.message ?? '', /current reserved request is unavailable/);
  } finally { release?.(); await sdk.close(); f.close(); }
});
