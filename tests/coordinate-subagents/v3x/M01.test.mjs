import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';

const contract = JSON.parse(readFileSync(new URL('../../../docs/implementation-3x/fixtures/opus55-host-contract.json', import.meta.url), 'utf8'));

test('M01 keeps documented model identity separate from unobserved host binding', () => {
  assert.equal(contract.identity.exactApiModelId, 'claude-opus-5-5');
  assert.equal(contract.identity.host, 'anthropic-claude-code');
  assert.equal(contract.identity.hostBinding, null);
  assert.equal(contract.identity.aliasIsExactId, false);
  assert.deepEqual(contract.evidenceStates, {
    documentSupported: true, hostSupported: 'unknown', configured: false, observed: false,
  });
  assert.equal(contract.installedInspection.liveCallPerformed, false);
  assert.equal(contract.installedInspection.accountModelAvailability, 'unknown');
  assert.equal(contract.installedInspection.effectiveModelAndEffort, 'unknown');
});

test('M01 assigns migration rules and price only to their documented surfaces', () => {
  const { claudeCodeManaged: managed, messagesApiDirect: api, priceEstimate: price } = contract.surfaces;
  assert.equal(managed.historyOwner, 'claude-code');
  assert.equal(managed.thinkingAndToolRequestRewriteOwner, 'claude-code');
  assert.equal(api.historyOwner, 'calling-application');
  assert.equal(api.modelField, 'model');
  assert.equal(api.effortField, 'output_config.effort');
  assert.equal(api.thinkingDisabledAllowed, false);
  assert.equal(api.manualThinkingBudgetAllowed, false);
  assert.equal(api.forcedToolChoiceAnyOrToolAllowed, false);
  assert.match(api.responseContentRule, /type.*thinking blocks unchanged/u);
  assert.match(api.modelSwitchRule, /directional.*append-only/u);
  assert.equal(api.implementedInRepository, false);
  assert.equal(price.basis, 'apiPriceEstimate');
  assert.equal(price.provider, 'anthropic_first_party');
  assert.equal(price.speed, 'standard');
  assert.equal(price.batch, false);
  assert.equal(price.subscriptionConversion, null);
  assert.equal(price.toolFeesIncluded, false);
  assert.equal(price.implementedCalculatorInRepository, false);
});

test('M01 pins every source and consumer to a single historical ref and content hash', () => {
  assert.match(contract.sourceRef, /^[a-f0-9]{40}$/u);
  assert.match(contract.planningSource.sha256, /^[a-f0-9]{64}$/u);
  const ids = contract.pins.map(pin => pin.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['index', 'anthropic', 'hosts', 'sources', 'policy', 'preset', 'callAdapter', 'observationHook', 'observationParser', 'evaluation', 'evaluationStore', 'evaluationSchema']) {
    assert.ok(ids.includes(id), id);
  }
  for (const pin of contract.pins) {
    assert.match(pin.path, /^(skills|mcp-server|contracts)\//u);
    assert.ok(pin.symbol.length > 0);
    assert.match(pin.sha256, /^[a-f0-9]{64}$/u);
  }
});
