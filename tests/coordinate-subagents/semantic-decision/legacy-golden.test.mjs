import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { canonical, resolveV2, recordV2 } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { application, fixture } from '../model-routing-v2/fixtures.mjs';
const golden = JSON.parse(readFileSync(new URL('./fixtures/v2-golden.json', import.meta.url), 'utf8'));
const validator = new ContractValidator();

test('legacy schemas retain the exact pre-S1a bytes, not just similar acceptance', () => {
  for (const [name, expected] of Object.entries(golden.schemaSha256)) {
    const actual = createHash('sha256').update(readFileSync(new URL(`../../../contracts/${name}`, import.meta.url))).digest('hex');
    assert.equal(actual, expected, name);
  }
});
for (const entry of golden.cases) test(`fixed pre-S1a v2 golden: ${entry.name}`, () => {
  const env = { ...structuredClone(golden.environment), ...structuredClone(entry.environmentPatch) };
  const actual = resolveV2(structuredClone(entry.request), env);
  assert.deepEqual(actual, entry.expected);
  assert.equal(canonical(actual), entry.expectedCanonical);
  assert.equal(actual.decisionDigest, entry.expected.decisionDigest);
  validator.modelRoutingDecisionV2(actual);
});

test('v2 validators accept legacy payloads but never silently accept semantic fields or v3', () => {
  const { req, env, decision } = fixture();
  const input = application(req, decision);
  const record = recordV2(input, { ...env, request: req, decision });
  for (const [method, value] of [['modelSelectionRequestV2', req], ['modelRoutingDecisionV2', decision],
    ['modelApplicationRequestV2', input], ['modelApplicationRecordV2', record]]) {
    validator[method](value);
    assert.throws(() => validator[method]({ ...value, semantic: {} }));
    assert.throws(() => validator[method]({ ...value, schemaVersion: '3.0.0' }));
  }
});
