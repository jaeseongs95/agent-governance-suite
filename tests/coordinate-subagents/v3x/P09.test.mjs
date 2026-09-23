import assert from 'node:assert/strict';
import { test } from 'vitest';
import { seal } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { normalizeSemanticProviderResult, validateSemanticAdviceForRequest } from '../../../mcp-server/src/semantic/advice-validator.ts';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

const choice = (confidence = 0.75, selectedOptionIds = ['option-a']) =>
  ({ status: 'success', choice: { kind: 'Choice', selectedOptionIds, confidence } });

test('P09 normalizes only a bounded Choice using the prepared binding and versions', () => {
  const { request } = contracts('shadow');
  for (const confidence of [0.75, null]) {
    const advice = normalizeSemanticProviderResult({ prepared: request, rawResult: choice(confidence), now: request.requestedAt });
    assert.equal(advice.choice.confidence, confidence);
    assert.equal(advice.evaluationId, request.evaluationId);
    assert.deepEqual(advice.provider, request.provider);
    assert.equal(advice.semanticRequestDigest, request.requestDigest);
    assert.deepEqual(validateSemanticAdviceForRequest({ prepared: request, advice, now: request.requestedAt }), advice);
    assert.equal(Object.hasOwn(advice, 'admitted'), false);
  }
});

test('P09 rejects invalid confidence, unknown options, and forged raw binding fields', () => {
  const { request } = contracts('shadow');
  for (const rawResult of [choice(NaN), choice(Infinity), choice(-0.01), choice(1.01),
    choice(0.7, ['unknown-option']), { ...choice(), evaluationId: 'other-evaluation' },
    { ...choice(), provider: { ...request.provider, providerVersion: 'other-version' } },
    { status: 'abstained' }]) {
    assert.throws(() => normalizeSemanticProviderResult({ prepared: request, rawResult, now: request.requestedAt }));
  }
});

test('P09 rejects re-sealed JSON-valid cross-request binding, version, and digest tampering', () => {
  const { request, advice } = contracts('shadow');
  for (const changed of [
    { evaluationId: 'other-evaluation' },
    { binding: { ...advice.binding, taskId: 'other-task' } },
    { provider: { ...advice.provider, providerVersion: 'other-version' } },
    { provider: { ...advice.provider, modelVersion: 'other-version' } },
    { semanticRequestDigest: `sha256:${'0'.repeat(64)}` },
    { schemaVersion: '2.0.0' },
  ]) {
    const forged = seal({ ...advice, ...changed }, 'adviceDigest');
    assert.throws(() => validateSemanticAdviceForRequest({ prepared: request, advice: forged, now: advice.evaluatedAt }));
  }
  assert.throws(() => validateSemanticAdviceForRequest({ prepared: request,
    advice: { ...advice, choice: { ...advice.choice, confidence: 0.5 } }, now: advice.evaluatedAt }));
});

test('P09 requires live, canonical observation and evaluation times', () => {
  const { request, advice } = contracts('shadow');
  assert.throws(() => normalizeSemanticProviderResult({ prepared: request, rawResult: choice(), now: request.expiresAt }));
  assert.throws(() => normalizeSemanticProviderResult({ prepared: request, rawResult: choice(), now: 'not-a-time' }));
  assert.throws(() => validateSemanticAdviceForRequest({ prepared: request, advice, now: request.expiresAt }));
  assert.throws(() => validateSemanticAdviceForRequest({ prepared: request, advice, now: request.requestedAt }));
});
