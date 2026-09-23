import assert from 'node:assert/strict';
import { test } from 'vitest';

import { normalizeSemanticProviderResult } from '../../../mcp-server/src/semantic/advice-validator.ts';
import { mapJevChoiceResponse } from '../../../mcp-server/src/semantic/providers/jev/response-mapper.ts';
import { contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const prepared = resealRequest({ ...contracts().request, provider: {
    id: 'jev', model: 'jev-1.13.0', adapterVersion: 'j03',
    providerVersion: null, modelVersion: null,
  } });
  const raw = { model: 'jev-1.13.0', answers: { model_choice: {
    type: 'choice', choice: 'option-a', confidence: 0.41,
    probabilities: { 'option-a': 0.8, 'option-b': 0.2 },
  } }, usage: { input_tokens: 100, output_tokens: 12 } };
  return { prepared, raw };
}

test('J03 maps one documented Choice without promoting confidence or response metadata to authority', () => {
  const { prepared, raw } = fixture();
  const original = structuredClone(raw);
  raw.executionAuthorized = true;
  raw.model_revision = 'invented-revision';
  const result = mapJevChoiceResponse(raw, prepared);
  assert.deepEqual(result, { status: 'success', choice: {
    kind: 'Choice', selectedOptionIds: ['option-a'], confidence: 0.41,
  } });
  assert.equal(result.choice.confidence, 0.41);
  assert.notEqual(result.choice.confidence, raw.answers.model_choice.probabilities['option-a']);
  assert.deepEqual(raw.answers, original.answers);
  const advice = normalizeSemanticProviderResult({ prepared, rawResult: result,
    now: prepared.requestedAt });
  assert.equal(advice.provider.providerVersion, null);
  assert.equal(advice.provider.modelVersion, null);
  assert.equal(Object.hasOwn(advice, 'executionAuthorized'), false);
});

test('J03 rejects unknown options, partial answers and malformed distributions', () => {
  const { prepared, raw } = fixture();
  const invalid = [
    { ...raw, model: 'jev-preview' },
    { ...raw, answers: {} },
    { ...raw, usage: undefined },
    { ...raw, answers: { model_choice: { ...raw.answers.model_choice, choice: 'unknown' } } },
    { ...raw, answers: { model_choice: { ...raw.answers.model_choice,
      probabilities: { 'option-a': 0.8 } } } },
    { ...raw, answers: { model_choice: { ...raw.answers.model_choice,
      probabilities: { 'option-a': 0.8, 'option-b': 0.1, unknown: 0.1 } } } },
    { ...raw, answers: { model_choice: { ...raw.answers.model_choice,
      probabilities: { 'option-a': 0.2, 'option-b': 0.8 } } } },
    { ...raw, answers: { model_choice: { ...raw.answers.model_choice,
      probabilities: { 'option-a': Number.NaN, 'option-b': 0.2 } } } },
  ];
  for (const value of invalid) assert.deepEqual(mapJevChoiceResponse(value, prepared), { status: 'invalid' });
});

test('J03 keeps null or missing confidence out of success and treats explicit null answer as abstention', () => {
  const { prepared, raw } = fixture();
  for (const confidence of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -0.1, 1.1]) {
    const value = { ...raw, answers: { model_choice: { ...raw.answers.model_choice, confidence } } };
    assert.deepEqual(mapJevChoiceResponse(value, prepared), { status: 'invalid' });
  }
  assert.deepEqual(mapJevChoiceResponse(null, prepared), { status: 'abstained' });
  assert.deepEqual(mapJevChoiceResponse({ ...raw, answers: { model_choice: null } }, prepared),
    { status: 'abstained' });
});
