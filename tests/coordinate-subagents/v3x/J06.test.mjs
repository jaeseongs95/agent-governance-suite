import assert from 'node:assert/strict';
import { test } from 'vitest';

import { createOptionalJevRegistry } from '../../../mcp-server/src/semantic/provider-registry.ts';
import { JEV_ENDPOINT } from '../../../mcp-server/src/semantic/providers/jev/http-client.ts';
import { JEV_IMPLEMENTATION_IDENTITY, jevProviderIdentity } from '../../../mcp-server/src/semantic/providers/jev/provider.ts';
import { projectSemanticState } from '../../../mcp-server/src/semantic/state-projection.ts';
import { digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { loadCatalog } from '../../../skills/coordinate-subagents/scripts/model-catalog.mjs';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

const enabled = (extra = {}) => ({ enabled: true, credential: () => 'test-token',
  timeoutMs: 1000, maxResponseBytes: 4096, ...extra });

test('J06 starts with Jev absent and distinguishes explicit registration from missing credentials', () => {
  let credentialReads = 0;
  const absent = createOptionalJevRegistry();
  assert.equal(absent.status, 'off');
  assert.deepEqual(absent.registry.ids(), []);
  assert.equal(absent.registry.get('jev'), null);
  assert.equal(absent.assistActive, false);
  const disabled = createOptionalJevRegistry({ enabled: false, credential: () => { credentialReads++; return 'secret'; } });
  assert.equal(disabled.status, 'off');
  assert.equal(credentialReads, 0);
  const missing = createOptionalJevRegistry(enabled({ credential: () => null }));
  assert.equal(missing.status, 'credential-unavailable');
  assert.deepEqual(missing.registry.ids(), []);
  const registered = createOptionalJevRegistry(enabled());
  assert.equal(registered.status, 'registered');
  assert.deepEqual(registered.registry.ids(), ['jev']);
  assert.ok(registered.registry.get('jev'));
  assert.equal(registered.adoption, 'unvalidated');
  assert.equal(registered.assistActive, false);
});

test('J06 binds endpoint, model, adapter and projection drift into adoption identity', () => {
  const current = jevProviderIdentity();
  const adoption = provider => ({ status: 'validated', minimumConfidence: 0.5,
    evidenceDigest: digest('past-evidence'), provider,
    questionDigest: digest('question'), reducerVersion: '1.0.0' });
  const same = createOptionalJevRegistry(enabled({ adoption: adoption(current) }));
  assert.equal(same.adoption, 'requires-admission');
  assert.equal(same.assistActive, false);
  for (const field of ['endpoint', 'model', 'adapterRevision', 'projectionVersion', 'stateProjectionVersion']) {
    const previous = jevProviderIdentity({ ...JEV_IMPLEMENTATION_IDENTITY,
      [field]: `${JEV_IMPLEMENTATION_IDENTITY[field]}-old` });
    assert.notEqual(previous.adapterVersion, current.adapterVersion);
    const registry = createOptionalJevRegistry(enabled({ adoption: adoption(previous) }));
    assert.equal(registry.adoption, 'drift', field);
    assert.equal(registry.assistActive, false);
    assert.equal(registry.registry.get('jev') !== null, true);
  }
});

test('J06 registered adapter makes one bounded call while policy remains unvalidated', async () => {
  const base = contracts();
  const modelIds = ['claude-opus-5-5', 'claude-fable-5-1'];
  const state = projectSemanticState({ routingRequest: base.legacy.req, catalog: loadCatalog(),
    eligibleModelIds: modelIds, question: base.question }).state;
  let calls = 0;
  const registry = createOptionalJevRegistry(enabled({ fetcher: async (_url, init) => {
    calls++;
    assert.equal(init.redirect, 'error');
    const wire = JSON.parse(init.body);
    assert.deepEqual(Object.keys(wire.questions.model_choice.criteria), ['option-0', 'option-1']);
    return new globalThis.Response(JSON.stringify({ model: 'jev-1.13.0', answers: { model_choice: {
      type: 'choice', choice: 'option-0', confidence: 0.4,
      probabilities: { 'option-0': 0.7, 'option-1': 0.3 },
    } }, usage: { input_tokens: 20, output_tokens: 5 } }), { status: 200 });
  } }));
  const request = resealRequest({ ...base.request, state, provider: registry.identity,
    eligibleSet: modelIds.map((model, i) => ({ candidateKey: `candidate-${i}`, model,
      preferenceGroup: i, baselineRank: i })),
    options: modelIds.map((model, i) => ({ optionId: `option-${i}`, model,
      candidateKeys: [`candidate-${i}`] })) });
  const control = { endpoint: JEV_ENDPOINT, redirect: 'error', signal: new globalThis.AbortController().signal,
    onOutput: () => {} };
  const result = await registry.registry.get('jev').evaluate(request, control);
  assert.deepEqual(result, { status: 'success', choice: { kind: 'Choice',
    selectedOptionIds: ['option-0'], confidence: 0.4 } });
  assert.equal(calls, 1);
  assert.equal(registry.assistActive, false);
  const drifted = resealRequest({ ...request, provider: { ...request.provider, adapterVersion: 'old' } });
  assert.deepEqual(await registry.registry.get('jev').evaluate(drifted, control), { status: 'invalid' });
  const tooMany = resealRequest({ ...request, options: Array.from({ length: 256 }, (_, i) => ({
    optionId: `overflow-${i}`, model: modelIds[i % 2], candidateKeys: [`candidate-${i % 2}`],
  })) });
  assert.deepEqual(await registry.registry.get('jev').evaluate(tooMany, control), { status: 'invalid' });
  const missingArtifact = resealRequest({ ...request, state: { ...request.state,
    sources: [...request.state.sources, { kind: 'artifact', id: 'source-note', digest: digest('note') }] } });
  assert.deepEqual(await registry.registry.get('jev').evaluate(missingArtifact, control), { status: 'invalid' });
  assert.equal(calls, 1);
});
