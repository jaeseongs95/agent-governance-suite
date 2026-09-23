import assert from 'node:assert/strict';
import { test } from 'vitest';

import { JEV_MAX_CHOICE_OPTIONS, JEV_MAX_REQUEST_BYTES, checkJevChoiceCardinality,
  checkJevPayloadBytes } from '../../../mcp-server/src/semantic/providers/jev/request-limits.ts';

test('J04 accepts 255 options and rejects 256 without shortening or reordering candidates', () => {
  const options = Array.from({ length: 256 }, (_, i) => ({ optionId: `option-${i}`,
    model: `model-${i}`, candidateKeys: [`candidate-${i}`] }));
  const original = structuredClone(options);
  assert.equal(JEV_MAX_CHOICE_OPTIONS, 255);
  assert.equal(checkJevChoiceCardinality(options.slice(0, 255)), null);
  assert.equal(checkJevChoiceCardinality(options), 'unsupported-cardinality');
  assert.deepEqual(options, original);
  assert.deepEqual(options.map(option => option.candidateKeys[0]),
    Array.from({ length: 256 }, (_, i) => `candidate-${i}`));
});

test('J04 caps exact UTF-8 body bytes at N and rejects N+1', () => {
  assert.equal(checkJevPayloadBytes('a'.repeat(JEV_MAX_REQUEST_BYTES)), null);
  assert.equal(checkJevPayloadBytes('a'.repeat(JEV_MAX_REQUEST_BYTES + 1)), 'unsupported-bytes');
  assert.equal(checkJevPayloadBytes('a'.repeat(JEV_MAX_REQUEST_BYTES - 3) + '한'), null);
  assert.equal(checkJevPayloadBytes('a'.repeat(JEV_MAX_REQUEST_BYTES - 2) + '한'),
    'unsupported-bytes');
});
