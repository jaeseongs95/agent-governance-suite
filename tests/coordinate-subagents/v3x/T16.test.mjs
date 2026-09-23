import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { test } from 'vitest';

import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = fileURLToPath(new URL('../../../mcp-server/dist/server.mjs', import.meta.url));

async function boot(enabled, inspect) {
  const directory = await mkdtemp(join(tmpdir(), 'ags-t16-'));
  const databasePath = join(directory, 'workflow.sqlite3');
  const env = getDefaultEnvironment();
  env.AGENT_GOVERNANCE_DB_PATH = databasePath;
  env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH = join(directory, 'continuity.sqlite3');
  env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(directory, 'trust.sqlite3');
  env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = join(directory, 'sessions.sqlite3');
  env.AGENT_GOVERNANCE_SEMANTIC_ROUTING_ENABLED = enabled ? 'true' : 'false';
  const transport = new StdioClientTransport({ command: process.execPath, args: [bundle],
    cwd: root, env, stderr: 'pipe' });
  const client = new Client({ name: 't16-entrypoint-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    await inspect(client, databasePath);
  } finally {
    try { await client.close(); } finally {
      try {
        await transport.close();
        if (enabled) {
          const db = new DatabaseSync(databasePath, { readOnly: true });
          try { assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok'); }
          finally { db.close(); }
        }
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}

function payload(result) { return JSON.parse(result.content[0].text); }

test('built normal entrypoint leaves the semantic tool unadvertised when off', async () => {
  await boot(false, async client => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.includes('resolve_semantic_model_assignment'), false);
    assert.equal(names.includes('resolve_model_assignment'), true);
  });
}, 15000);

test('built normal entrypoint routes enabled tool through the real service and persisted baseline writer', async () => {
  await boot(true, async (client, databasePath) => {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    assert.equal(names.includes('resolve_semantic_model_assignment'), true);
    const response = payload(await client.callTool({
      name: 'resolve_semantic_model_assignment', arguments: contracts().assignment,
    }));
    assert.equal(response.ok, true);
    const decision = response.data.status === 'non-adoption' ? response.data.baselineDecision : response.data;
    assert.equal(decision.schemaVersion, '2.0.0');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(db.prepare('SELECT count(*) AS n FROM ags_model_decisions_v2').get().n, 1);
      assert.equal(db.prepare('SELECT count(*) AS n FROM ags_model_decision_refs_v3').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) AS n FROM ags_semantic_intents_v1').get().n, 0);
    } finally { db.close(); }
  });
}, 15000);
