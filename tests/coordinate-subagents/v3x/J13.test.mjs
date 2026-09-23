import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { build } from 'esbuild';
import { afterAll, beforeAll, test, vi } from 'vitest';

import { JEV_ENDPOINT } from '../../../mcp-server/src/semantic/providers/jev/http-client.ts';
import { jevProviderIdentity } from '../../../mcp-server/src/semantic/providers/jev/provider.ts';
import { InMemoryWorkflowStore } from '../../../mcp-server/src/workflow-store.ts';
import { digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const bundle = fileURLToPath(new URL('../../../mcp-server/dist/server.mjs', import.meta.url));
let openSemanticService;
let rootBundleDirectory;

beforeAll(async () => {
  rootBundleDirectory = await mkdtemp(join(tmpdir(), 'ags-j13-built-root-'));
  const result = await build({ entryPoints: [join(root, 'mcp-server/src/routing-v3/open-semantic-service.ts')],
    bundle: true, platform: 'node', format: 'esm', target: 'node22', write: false,
    // Production bundle sits at mcp-server/dist; preserve that location for bundled resource paths.
    define: { 'import.meta.url': JSON.stringify(pathToFileURL(bundle).href) } });
  const builtPath = join(rootBundleDirectory, 'root.mjs');
  await writeFile(builtPath, result.outputFiles[0].contents);
  ({ openSemanticService } = await import(pathToFileURL(builtPath).href));
});
afterAll(async () => { if (rootBundleDirectory) await rm(rootBundleDirectory, { recursive: true, force: true }); });
const egressConfig = { schemaVersion: '1.0.0', enabled: true,
  approval: { source: 'operator', revision: 1, decisionId: 'decision-1' },
  routes: [{ providerId: 'jev', endpoint: JEV_ENDPOINT,
    dataCategories: ['routing', 'question', 'catalog'], accessPaths: ['api'] }],
  budget: { requests: { max: 1, basis: 'evaluation' },
    cost: { maxMicros: 1, currency: 'USD', basis: 'evaluation' } } };
const input = extra => ({ enabled: true, egressConfig, credential: () => 'test-token', ...extra });

async function withService(jevInput, inspect) {
  const directory = await mkdtemp(join(tmpdir(), 'ags-j13-root-'));
  const opened = openSemanticService(join(directory, 'workflow.sqlite3'), new InMemoryWorkflowStore(), jevInput);
  try { assert.ok(opened); await inspect(opened); }
  finally { opened?.close(); await rm(directory, { recursive: true, force: true }); }
}

test('J13 built root requires explicit on, exact egress route and credential; registry never activates assist', async () => {
  for (const jevInput of [input({ enabled: false }), input({ egressConfig: undefined }),
    input({ egressConfig: { ...egressConfig, enabled: false } }),
    input({ egressConfig: { ...egressConfig, routes: [{ ...egressConfig.routes[0], endpoint: 'https://elsewhere.test/' }] } }),
    input({ egressConfig: '{bad-json' })]) {
    await withService(jevInput, opened => {
      assert.equal(opened.jev.status, 'off');
      assert.deepEqual(opened.registry.ids(), []);
      assert.equal(opened.jev.assistActive, false);
    });
  }
  await withService(input({ credential: () => null }), opened => {
    assert.equal(opened.jev.status, 'credential-unavailable');
    assert.deepEqual(opened.registry.ids(), []);
  });
  await withService(input(), opened => {
    assert.equal(opened.jev.status, 'registered');
    assert.deepEqual(opened.registry.ids(), ['jev']);
    assert.equal(opened.jev.adoption, 'unvalidated');
    assert.equal(opened.jev.assistActive, false);
  });
});

test('J13 built root detects prior provider identity drift without adopting advice', async () => {
  const current = jevProviderIdentity();
  const adoption = provider => ({ status: 'validated', minimumConfidence: 0.5,
    evidenceDigest: digest('evidence'), provider, questionDigest: digest('question'),
    reducerVersion: '1.0.0' });
  await withService(input({ adoption: adoption(current) }), opened => {
    assert.equal(opened.jev.adoption, 'requires-admission');
    assert.equal(opened.jev.assistActive, false);
  });
  await withService(input({ adoption: adoption({ ...current, adapterVersion: 'old' }) }), opened => {
    assert.equal(opened.jev.adoption, 'drift');
    assert.equal(opened.jev.assistActive, false);
    assert.deepEqual(opened.registry.ids(), ['jev']);
  });
});

test('J13 built normal entrypoint distinguishes registration and drift without a Jev call or adoption', async () => {
  const driftedAdoption = { status: 'validated', minimumConfidence: 0.5,
    evidenceDigest: digest('evidence'),
    provider: { ...jevProviderIdentity(), adapterVersion: 'old' },
    questionDigest: digest('question'), reducerVersion: '1.0.0' };
  for (const variant of [
    { enabled: 'false', credential: 'test-token', config: egressConfig, expected: 'off; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: undefined, expected: 'off; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: { ...egressConfig, enabled: false }, expected: 'off; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: '{bad-json', expected: 'off; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: { ...egressConfig,
      routes: [{ ...egressConfig.routes[0], endpoint: 'https://elsewhere.test/' }] }, expected: 'off; adoption: unvalidated' },
    { enabled: 'true', credential: '', config: egressConfig, expected: 'credential-unavailable; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: egressConfig, expected: 'registered; adoption: unvalidated' },
    { enabled: 'true', credential: 'test-token', config: egressConfig,
      adoption: driftedAdoption, expected: 'registered; adoption: drift' },
  ]) {
    const directory = await mkdtemp(join(tmpdir(), 'ags-j13-stdio-'));
    const databasePath = join(directory, 'workflow.sqlite3');
    const env = getDefaultEnvironment();
    Object.assign(env, {
      AGENT_GOVERNANCE_DB_PATH: databasePath,
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, 'continuity.sqlite3'),
      AGENT_GOVERNANCE_TRUST_DB_PATH: join(directory, 'trust.sqlite3'),
      AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: join(directory, 'sessions.sqlite3'),
      AGENT_GOVERNANCE_SEMANTIC_ROUTING_ENABLED: 'true',
      AGENT_GOVERNANCE_JEV_ENABLED: variant.enabled,
      AGENT_GOVERNANCE_SEMANTIC_EGRESS_CONFIG: typeof variant.config === 'string'
        ? variant.config : variant.config ? JSON.stringify(variant.config) : '',
      AGENT_GOVERNANCE_JEV_ADOPTION_CANDIDATE: variant.adoption ? JSON.stringify(variant.adoption) : '',
      TYPESAFE_API_KEY: variant.credential,
    });
    const transport = new StdioClientTransport({ command: process.execPath, args: [bundle],
      cwd: root, env, stderr: 'pipe' });
    const client = new Client({ name: 'j13-entrypoint-test', version: '1.0.0' });
    let stderr = '';
    transport.stderr.on('data', chunk => { stderr += chunk.toString(); });
    try {
      await client.connect(transport);
      await vi.waitFor(() => assert.ok(stderr.includes(`Semantic Jev registry: ${variant.expected}\n`), stderr));
      assert.equal((await client.listTools()).tools.some(tool => tool.name === 'resolve_semantic_model_assignment'), true);
      const response = JSON.parse((await client.callTool({ name: 'resolve_semantic_model_assignment',
        arguments: contracts().assignment })).content[0].text);
      assert.equal(response.ok, true);
      const decision = response.data.status === 'non-adoption' ? response.data.baselineDecision : response.data;
      assert.equal(decision.schemaVersion, '2.0.0');
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal(db.prepare('SELECT count(*) AS n FROM ags_semantic_intents_v1').get().n, 0);
        assert.equal(db.prepare('SELECT count(*) AS n FROM ags_model_decision_refs_v3').get().n, 0);
      } finally { db.close(); }
    } finally {
      try { await client.close(); } finally {
        await transport.close();
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 60000);
