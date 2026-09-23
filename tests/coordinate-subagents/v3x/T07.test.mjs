import assert from 'node:assert/strict';
import { test } from 'vitest';

import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { canonical, seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { recordSemanticApplicationV3 } from '../../../skills/coordinate-subagents/scripts/semantic/application-record.mjs';
import { observation, LATER } from '../model-routing-v2/fixtures.mjs';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const { legacy, decision, application } = contracts();
  const context = { request: legacy.req, decision, catalog: legacy.env.catalog,
    policy: legacy.env.policy, now: LATER };
  return { input: structuredClone(application), context };
}

test('v3 record keeps selected and dispatched provenance while remaining diagnostic', () => {
  const { input, context } = fixture();
  const record = recordSemanticApplicationV3(input, context);
  new ContractValidator().modelApplicationRecordForDecisionV3(record, context.decision);
  assert.equal(record.recordDigest.startsWith('sha256:'), true);
  assert.equal(canonical(record.selected), canonical(context.decision.selected));
  assert.equal(canonical(record.dispatched), canonical(input.dispatched));
  assert.equal(canonical(record.semantic), canonical(context.decision.semantic));
  assert.equal(record.observed, null);
  assert.deepEqual([record.modelVerification, record.reasoningVerification,
    record.runtimeModeVerification], ['unverified', 'unverified', 'unverified']);
  assert.equal(record.trustedGateSatisfied, false);
  assert.equal(record.artifactOnly, true);
});

test('selected and actual dispatched binding must agree', () => {
  const { input, context } = fixture();
  assert.throws(() => recordSemanticApplicationV3({
    ...input, dispatched: { ...input.dispatched, resolvedModel: 'claude-opus-5-5' },
  }, context), { code: 'DISPATCH_MISMATCH' });
  assert.throws(() => recordSemanticApplicationV3({
    ...input, binding: { ...input.binding, attemptId: 'other-attempt' },
  }, context), { code: 'BINDING_MISMATCH' });
  assert.throws(() => recordSemanticApplicationV3({
    ...input, semanticAdviceDigest: context.decision.semantic.baselineDecisionDigest,
  }, context), { code: 'BINDING_MISMATCH' });
  assert.throws(() => recordSemanticApplicationV3(input, {
    ...context, policy: { ...context.policy, maxCatalogAgeDays: 31 },
  }), { code: 'BINDING_MISMATCH' });
  assert.throws(() => recordSemanticApplicationV3(input, {
    ...context, catalog: seal({ ...context.catalog,
      models: [...context.catalog.models].reverse() }, 'catalogDigest'),
  }), { code: 'BINDING_MISMATCH' });
});

test('caller observation and self report never become admitted actual model evidence', () => {
  const { input, context } = fixture();
  const claimed = observation(context.request, context.decision);
  const raw = recordSemanticApplicationV3({ ...input, observation: claimed }, context);
  assert.equal(raw.observationAdmitted, false);
  assert.equal(raw.modelVerification, 'unverified');
  assert.equal(raw.status, 'unverified');
  assert.deepEqual(raw.observed, claimed);
  const self = recordSemanticApplicationV3(input, { ...context,
    admittedObservation: { ...claimed, source: 'agent-self-report' } });
  assert.equal(self.modelVerification, 'unverified');
  assert.equal(self.terminalOutcome, 'unknown');
});

test('admitted actual observations preserve matching and each mismatch independently', () => {
  const { input, context } = fixture();
  const actual = observation(context.request, context.decision);
  const matched = recordSemanticApplicationV3(input, { ...context, admittedObservation: actual });
  assert.deepEqual([matched.modelVerification, matched.reasoningVerification,
    matched.runtimeModeVerification], ['matched', 'matched', 'matched']);
  assert.equal(matched.status, 'matched');
  assert.equal(matched.observationAdmitted, true);
  assert.equal(matched.trustedGateSatisfied, false);
  const changed = { ...actual, models: [{ resolvedModel: 'gpt-5.6-sol', modelOrigin: 'openai' }],
    nativeReasoning: { kind: 'enum', value: 'low' }, runtimeMode: 'alternate' };
  const mismatch = recordSemanticApplicationV3(input, { ...context, admittedObservation: changed });
  new ContractValidator().modelApplicationRecordForDecisionV3(mismatch, context.decision);
  assert.deepEqual([mismatch.modelVerification, mismatch.reasoningVerification,
    mismatch.runtimeModeVerification], ['mismatch', 'mismatch', 'mismatch']);
  assert.equal(mismatch.status, 'mismatch');
  assert.deepEqual(mismatch.observed, changed);
});

test('missing actual model stays unverified and never copies an Opus 5.5 intention into observed', () => {
  const { input, context } = fixture();
  const selected = { ...context.decision.selected, model: 'claude-opus-5-5',
    resolvedModel: 'claude-opus-5-5', modelOrigin: 'anthropic', servingProvider: 'anthropic', accessPath: 'api' };
  const decision = seal({ ...context.decision, selected }, 'decisionDigest');
  const opusInput = { ...input, decisionDigest: decision.decisionDigest, dispatched: selected };
  const noModel = observation(context.request, decision, { models: [], nativeReasoning: null, runtimeMode: null });
  const record = recordSemanticApplicationV3(opusInput, { ...context, decision, admittedObservation: noModel });
  assert.equal(record.selected.resolvedModel, 'claude-opus-5-5');
  assert.deepEqual(record.observed.models, []);
  assert.equal(record.modelVerification, 'unverified');
  assert.equal(record.status, 'unverified');
  assert.equal(record.originVerified, false);
  assert.equal(record.trustedGateSatisfied, false);
  const wrongModel = observation(context.request, decision, {
    models: [{ resolvedModel: 'claude-opus-5', modelOrigin: 'anthropic' }] });
  const mismatch = recordSemanticApplicationV3(opusInput, { ...context, decision, admittedObservation: wrongModel });
  assert.equal(mismatch.modelVerification, 'mismatch');
  assert.equal(mismatch.observed.models[0].resolvedModel, 'claude-opus-5');
});
