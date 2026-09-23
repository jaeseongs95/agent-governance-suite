import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { onTestFinished, test } from 'vitest';

import { WorkflowContractError } from '../../../contracts/types.ts';
import { InMemoryPluginUpdateStore } from '../../../mcp-server/src/plugin-update-store.ts';
import { PluginUpdateService } from '../../../mcp-server/src/plugin-update-service.ts';
import { FileSkillRegistry } from '../../../mcp-server/src/registry.ts';
import { createSemanticGateway } from '../../../mcp-server/src/routing-v3/semantic-gateway.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { createMcpServer } from '../../../mcp-server/src/server.ts';
import { WorkflowService } from '../../../mcp-server/src/workflow-service.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

async function connect(semantic = undefined, profile = 'default') {
  const validator = new ContractValidator();
  const registryPath = fileURLToPath(new URL('../../../skills/registry.json', import.meta.url));
  const workflow = new WorkflowService(new FileSkillRegistry(registryPath, validator),
    validator, new InMemoryWorkflowStore());
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore());
  const server = createMcpServer(workflow, updates, undefined, undefined, undefined, validator,
    profile, undefined, undefined, undefined, undefined, undefined, undefined, semantic);
  const client = new Client({ name: 't04-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  onTestFinished(async () => { await client.close(); await server.close(); });
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return JSON.parse(result.content[0].text);
}

test('disabled or missing semantic gateway preserves the existing tool list and behavior', async () => {
  let calls = 0;
  const gateway = createSemanticGateway({ resolve: async () => { calls++; return contracts().legacy.decision; } });
  const baseline = await connect();
  const disabled = await connect({ enabled: false, gateway });
  const missing = await connect({ enabled: true, gateway: null });
  const names = async client => (await client.listTools()).tools.map(tool => tool.name);
  assert.deepEqual(await names(disabled), await names(baseline));
  assert.deepEqual(await names(missing), await names(baseline));
  assert.equal((await names(baseline)).includes('resolve_semantic_model_assignment'), false);
  const request = contracts().assignment;
  assert.equal((await call(disabled, 'resolve_semantic_model_assignment', request)).error.code, 'INVALID_INPUT');
  assert.equal((await call(missing, 'resolve_semantic_model_assignment', request)).error.code, 'INVALID_INPUT');
  assert.equal(calls, 0);
  const old = await call(disabled, 'resolve_model_assignment', request.routingRequest);
  assert.equal(old.data.schemaVersion, '2.0.0');
});

test('enabled facade exposes only assignment input and forwards to the injected service', async () => {
  const received = [], expected = contracts().assignment;
  const gateway = createSemanticGateway({ resolve: async assignment => {
    received.push(assignment);
    return contracts().legacy.decision;
  } });
  const client = await connect({ enabled: true, gateway });
  const tool = (await client.listTools()).tools.find(item => item.name === 'resolve_semantic_model_assignment');
  assert.ok(tool);
  assert.deepEqual(tool.inputSchema.required, ['schemaVersion', 'routingRequest', 'taskRef']);
  assert.equal(tool.inputSchema.additionalProperties, false);
  const result = await call(client, tool.name, expected);
  assert.equal(result.ok, true);
  assert.equal(result.data.schemaVersion, '2.0.0');
  assert.deepEqual(received, [expected]);
  for (const extra of ['catalog', 'policy', 'advice', 'credential']) {
    assert.equal((await call(client, tool.name, { ...expected, [extra]: {} })).error.code, 'INVALID_INPUT');
  }
  assert.equal(received.length, 1);
  const anthropic = await connect({ enabled: true, gateway }, 'anthropic');
  const inlined = (await anthropic.listTools()).tools.find(item => item.name === tool.name);
  assert.ok(inlined);
  assert.equal(JSON.stringify(inlined.inputSchema).includes('"$ref"'), false);
});

test('gateway preserves typed service failure and hides unexpected internal errors', async () => {
  const input = contracts().assignment;
  const typed = await connect({ enabled: true, gateway: createSemanticGateway({ resolve: async () => {
    throw new WorkflowContractError('INTEGRITY_FAILED', 'Registered evidence changed.');
  } }) });
  assert.equal((await call(typed, 'resolve_semantic_model_assignment', input)).error.code, 'INTEGRITY_FAILED');
  const unknown = await connect({ enabled: true, gateway: createSemanticGateway({ resolve: async () => {
    throw new Error('internal secret');
  } }) });
  const failed = await call(unknown, 'resolve_semantic_model_assignment', input);
  assert.equal(failed.error.code, 'MCP_UNAVAILABLE');
  assert.equal(JSON.stringify(failed).includes('internal secret'), false);
});
