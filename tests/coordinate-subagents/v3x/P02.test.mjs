import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { FakeSemanticDecisionProvider } from '../../../mcp-server/src/semantic/providers/fake.ts';
import { parseSemanticProviderResultV1 } from '../../../mcp-server/src/semantic/provider-port.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { contracts } from '../semantic-decision/fixtures/contracts.mjs';

test('a seed and fixture produce the same valid Choice without network access', async () => {
  const { request } = contracts();
  const before = structuredClone(request);
  const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network access'); });
  try {
    const fixture = { outcome: 'success', confidence: 0.75 };
    const first = await new FakeSemanticDecisionProvider('seed-1', fixture).evaluate(request);
    const second = await new FakeSemanticDecisionProvider('seed-1', fixture).evaluate(request);
    assert.deepEqual(first, second);
    assert.deepEqual(parseSemanticProviderResultV1(first), first);
    assert.equal(first.status, 'success');
    assert.equal(first.choice.selectedOptionIds.length, 1);
    assert.ok(request.options.some(option => option.optionId === first.choice.selectedOptionIds[0]));
    assert.deepEqual(request, before);
    assert.equal(fetch.mock.calls.length, 0);
  } finally { fetch.mockRestore(); }
});

test('tie, abstain, timeout, and invalid fixtures stay within the port result union', async () => {
  const { request } = contracts();
  const tie = await new FakeSemanticDecisionProvider('seed-1', { outcome: 'tie' }).evaluate(request);
  assert.equal(tie.status, 'success');
  assert.equal(new Set(tie.choice.selectedOptionIds).size, 2);
  assert.deepEqual(tie.choice.selectedOptionIds.slice().sort(), request.options.map(option => option.optionId).sort());
  assert.deepEqual(parseSemanticProviderResultV1(tie), tie);
  for (const [outcome, status] of [['abstain', 'abstained'], ['timeout', 'timeout'], ['invalid', 'invalid']]) {
    const result = await new FakeSemanticDecisionProvider('seed-1', { outcome }).evaluate(request);
    assert.deepEqual(result, { status });
    assert.deepEqual(parseSemanticProviderResultV1(result), result);
  }
  const oneOption = { ...request, options: request.options.slice(0, 1) };
  assert.deepEqual(await new FakeSemanticDecisionProvider('seed-1', { outcome: 'tie' }).evaluate(oneOption), { status: 'invalid' });
});

test('the fake marker is outside provider output and cannot validate adoption', async () => {
  const { request, policy } = contracts();
  const provider = new FakeSemanticDecisionProvider('seed-1', { outcome: 'success' });
  const result = await provider.evaluate(request);
  assert.equal(provider.testOnly, 'fake');
  assert.deepEqual(Object.keys(result).sort(), ['choice', 'status']);
  assert.equal(policy.adoption.status, 'unvalidated');
  const attempted = { ...policy, mode: 'assist',
    adoption: { status: 'validated', minimumConfidence: 0.5, evidenceDigest: provider.testOnly,
      provider: request.provider, questionDigest: request.questionDigest, reducerVersion: request.reducerVersion },
    egress: { enabled: true, allowedProviders: [request.provider.id] } };
  assert.throws(() => new ContractValidator().semanticDecisionPolicyV1(attempted));
});
