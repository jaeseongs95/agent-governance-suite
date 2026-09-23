import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const fixture = JSON.parse(readFileSync(new URL('../../../docs/implementation-3x/fixtures/vm-authenticated-dispatch-context.json', import.meta.url), 'utf8'));

test('installed MCP SDK exposes the current JSON-RPC id to the request handler', async () => {
  const seen = [];
  let resolveOpaque;
  const opaqueSeen = new Promise((resolve) => { resolveOpaque = resolve; });
  const server = new Server({ name: 'v03-a-contract', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(z.object({ method: z.literal('vm/hello'), params: z.object({}) }),
    async (_request, extra) => ({ epoch: `epoch-from-${extra.requestId}` }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    seen.push({ id: extra.requestId, tool: request.params.name });
    if (extra.requestId === 'vm-call-A') resolveOpaque();
    return { content: [{ type: 'text', text: 'contract probe only' }] };
  });
  const client = new Client({ name: 'v03-a-client', version: '1.0.0' }, { capabilities: {} });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const hello = await client.request({ method: 'vm/hello', params: {} }, z.object({ epoch: z.string() }));
    assert.match(hello.epoch, /^epoch-from-/);
    await client.request({ method: 'tools/call', params: { name: 'plan_workflow', arguments: {} } }, CallToolResultSchema);
    await client.request({ method: 'tools/call', params: { name: 'plan_workflow', arguments: {} } }, CallToolResultSchema);
    await clientTransport.send({ jsonrpc: '2.0', id: 'vm-call-A', method: 'tools/call',
      params: { name: 'plan_workflow', arguments: {} } });
    await opaqueSeen;
    assert.equal(seen.length, 3);
    assert.notEqual(seen[0].id, seen[1].id);
    assert.equal(seen[2].id, 'vm-call-A');
    assert.deepEqual(seen.map((entry) => entry.tool), ['plan_workflow', 'plan_workflow', 'plan_workflow']);
  } finally {
    await client.close();
    await server.close();
  }
});

function contractDecision(step, claimed) {
  const pending = Object.values(fixture.reservations).find((item) => item.callId === step.requestId);
  if (!pending) return ['unsupported_before_claim', null];
  if ((step.currentEpoch ?? fixture.serverEpoch) !== pending.epoch || step.pinActive === false) return ['reject_before_claim', null];
  if (step.requestId === fixture.reservations.baseline.callId && step.coreLedgerAttemptAbsent !== true) {
    return ['unsupported_before_claim', null];
  }
  const receipt = fixture.reservations[step.receipt];
  const observedModel = step.observedModelId ?? pending.modelId;
  if (!receipt || receipt.tool !== pending.tool || receipt.inputDigest !== pending.inputDigest
    || (step.receiptTerminalEventId ?? receipt.terminalEventId) !== pending.terminalEventId
    || receipt.terminalCallId !== pending.terminalCallId
    || (step.receiptModelId ?? step.observedModelId ?? receipt.modelId) !== observedModel
    || (step.receiptEffort ?? receipt.effort) !== pending.effort
    || Object.keys(pending.binding).some((key) => (key === 'attemptId' && step.receiptAttemptId !== undefined
      ? step.receiptAttemptId : receipt.binding[key]) !== pending.binding[key])
    || claimed.has(step.receipt)) return ['reject_before_claim', null];
  if (observedModel !== fixture.modelPolicy.exactModelId
    || (step.hostBuild ?? fixture.hostBuild) !== fixture.modelPolicy.hostBuild) return ['unsupported_before_claim', null];
  claimed.add(step.receipt);
  return ['admission_candidate', step.receipt];
}

test('contract fixture keeps B-first substitution and replay outside the claim boundary', () => {
  assert.equal(fixture.pin.actorId, `vm-producer:${fixture.pin.installationId}`);
  assert.equal(fixture.pin.hostBuild, fixture.modelPolicy.hostBuild);
  assert.equal(fixture.pin.modelPolicyVersion, fixture.modelPolicy.version);
  for (const item of fixture.cases) {
    const claimed = new Set();
    for (const step of item.steps) {
      const [status, claim] = contractDecision(step, claimed);
      assert.deepEqual([status, claim], [step.expected, step.claim], item.id);
    }
  }
  for (const item of fixture.registrationCases) {
    const status = item.coreOwnedTransport === false ? 'unsupported'
      : item.alreadyReserved || (item.currentEpoch ?? fixture.serverEpoch) !== fixture.serverEpoch
      ? 'reject_no_new_reservation' : 'reservation_candidate';
    assert.equal(status, item.expected, item.id);
  }
  assert.ok(fixture.cases.some((item) => item.id === 'B_first_use_of_A_receipt_then_A'));
  assert.ok(fixture.registrationCases.some((item) => item.id === 'copied_sideband_same_epoch'));
});
