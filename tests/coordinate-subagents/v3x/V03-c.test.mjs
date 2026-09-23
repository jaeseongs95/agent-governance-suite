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
      producer: registrationBody.producer,
      binding: { invocationId: callId, ...registrationBody.binding },
      terminal: registrationBody.terminal, core: registrationBody.core, invocation: registrationBody.invocation,
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

test('product control RPC binds current SDK request ID; B-first copy leaves A usable', async () => {
  const f = fixture();
  const vm = new VmCurrentInvocation(new InMemoryWorkflowStore(), () => now + 1);
  const outcomes = [];
  const service = { planWorkflow(input) {
    assert.equal(Object.hasOwn(input, '_hostAttestation'), false);
    outcomes.push('accepted');
    return { schemaVersion: '1.0.0', ok: true, data: {}, error: null };
  } };
  const updates = { check: async () => null, takeNotice: () => null };
  const server = createMcpServer(service, updates, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, vm);
  const client = new Client({ name: 'v03-c-client', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const hello = await client.request({ method: 'vm/hello', params: {} }, z.object({ serverEpoch: z.string() }));
    assert.equal(hello.serverEpoch, vm.serverEpoch);
    const a = f.registration(hello.serverEpoch, 'registration-A');
    const b = f.registration(hello.serverEpoch, 'registration-B');
    const response = z.object({ callId: z.string(), serverEpoch: z.string() });
    const ticketA = await client.request({ method: 'vm/reserve_dispatch', params: { registration: a.envelope } }, response);
    const ticketB = await client.request({ method: 'vm/reserve_dispatch', params: { registration: b.envelope } }, response);
    assert.notEqual(ticketA.callId, ticketB.callId);
    const receiptA = f.receipt(a.body, ticketA.callId);
    const call = (id, receipt) => new Promise((resolve, reject) => {
      const original = clientTransport.onmessage;
      clientTransport.onmessage = (message) => {
        original?.(message);
        if (message.id === id) { clientTransport.onmessage = original; resolve(message); }
      };
      clientTransport.send({ jsonrpc: '2.0', id, method: 'tools/call',
        params: { name: 'plan_workflow', arguments: { ...unsigned, _hostAttestation: receipt } } }).catch(reject);
    });
    const copiedSideband = await call('unreserved-new-request', receiptA);
    assert.match(copiedSideband.error?.message ?? '', /current reserved request is unavailable/);
    assert.deepEqual(outcomes, []);
    const rejected = await call(ticketB.callId, receiptA);
    assert.match(rejected.error?.message ?? '', /invocationId binding mismatch/);
    assert.deepEqual(outcomes, []);
    const accepted = await call(ticketA.callId, receiptA);
    assert.equal(accepted.error, undefined);
    assert.deepEqual(outcomes, ['accepted']);
    await assert.rejects(client.request({ method: 'vm/reserve_dispatch', params: { registration: a.envelope } }, response), /nonce already reserved/);
  } finally {
    await client.close();
    await server.close();
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
