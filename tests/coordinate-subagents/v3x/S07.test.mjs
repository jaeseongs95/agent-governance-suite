import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import {
  canonical, collectEligibleCandidatesV2, digest, getBaselineCandidateMetadataV2, resolveV2, seal,
} from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { projectSemanticCandidatesV1 } from '../../../skills/coordinate-subagents/scripts/semantic/candidate-projection.mjs';
import { reduceSemanticDecisionV1 } from '../../../skills/coordinate-subagents/scripts/semantic/reducer.mjs';
import {
  replaySemanticDecisionV1, SEMANTIC_REDUCER_VERSION_V1,
} from '../../../skills/coordinate-subagents/scripts/semantic/replay.mjs';
import { capability, environment, NOW, LATER, END, request } from '../model-routing-v2/fixtures.mjs';
import { bindingFields, contracts, resealRequest } from '../semantic-decision/fixtures/contracts.mjs';

function fixture() {
  const routingRequest = request();
  const env = environment({ capabilities: [
    capability({ actorId: 'actor-a', sessionId: 'session-a' }),
    capability({ actorId: 'actor-b', sessionId: 'session-b' },
      { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  const pool = collectEligibleCandidatesV2(routingRequest, env);
  const mapping = projectSemanticCandidatesV1(pool.candidates,
    getBaselineCandidateMetadataV2(pool.candidates, routingRequest, env));
  const prepared = resealRequest({
    ...contracts().request, reducerVersion: SEMANTIC_REDUCER_VERSION_V1,
    binding: structuredClone(routingRequest.binding),
    effectiveRoutingRequestDigest: digest(routingRequest),
    catalogDigest: env.catalog.catalogDigest, routingPolicyDigest: digest(env.policy),
    capabilitySetDigest: pool.capabilitySetDigest,
    eligibleSet: mapping.eligibleSet, options: mapping.options,
  });
  const advice = seal({
    ...contracts().advice,
    ...Object.fromEntries(bindingFields.map(key => [key, structuredClone(prepared[key])])),
    semanticRequestDigest: prepared.requestDigest,
    choice: { kind: 'Choice', selectedOptionIds: mapping.options.map(option => option.optionId), confidence: 0.75 },
  }, 'adviceDigest');
  return { routingRequest, environment: env, prepared, advice,
    adoption: { status: 'eligible', evidenceDigest: digest('archived-admission') },
    decisionTime: LATER, reducerVersion: SEMANTIC_REDUCER_VERSION_V1 };
}

test('archived inputs reproduce the same v3 digest with current clock and network unavailable', () => {
  const archived = fixture();
  archived.environment.now = LATER;
  const before = canonical(archived);
  const candidates = collectEligibleCandidatesV2(archived.routingRequest, archived.environment).candidates;
  const expected = reduceSemanticDecisionV1({
    prepared: archived.prepared, advice: archived.advice, adoption: archived.adoption,
    baselineDecision: resolveV2(archived.routingRequest, archived.environment), candidates,
  });
  const NativeDate = globalThis.Date;
  class NoCurrentDate extends NativeDate {
    constructor(...args) { if (args.length === 0) throw new Error('current clock accessed'); super(...args); }
    static now() { throw new Error('current clock accessed'); }
  }
  vi.stubGlobal('Date', NoCurrentDate);
  vi.stubGlobal('fetch', () => { throw new Error('network accessed'); });
  try {
    const replayed = replaySemanticDecisionV1(archived);
    assert.equal(replayed.decisionDigest, expected.decisionDigest);
    assert.deepEqual(replayed, expected);
    assert.equal(replayed.executionAuthorized, false);
    new ContractValidator().modelRoutingDecisionV3(replayed);
    assert.equal(canonical(archived), before);
  } finally { vi.unstubAllGlobals(); }
});

test('missing inputs and unsupported reducer versions fail explicitly', () => {
  const archived = fixture();
  archived.environment.now = LATER;
  for (const key of Object.keys(archived)) {
    const missing = { ...archived };
    delete missing[key];
    assert.throws(() => replaySemanticDecisionV1(missing), { code: 'REPLAY_INPUT_MISSING' });
  }
  assert.throws(() => replaySemanticDecisionV1(), { code: 'REPLAY_INPUT_MISSING' });
  assert.throws(() => replaySemanticDecisionV1({ ...archived, reducerVersion: 'future-reducer-v2' }),
    { code: 'UNSUPPORTED_REDUCER' });
  const prepared = resealRequest({ ...archived.prepared, reducerVersion: 'future-reducer-v2' });
  assert.throws(() => replaySemanticDecisionV1({ ...archived, prepared }), { code: 'UNSUPPORTED_REDUCER' });
  assert.throws(() => replaySemanticDecisionV1({ ...archived, adoption: { status: 'eligible' } }),
    { code: 'INVALID_INPUT' });
});

test('decision time, expired advice, and changed archived mapping cannot be silently replayed', () => {
  const archived = fixture();
  archived.environment.now = LATER;
  assert.throws(() => replaySemanticDecisionV1({ ...archived, decisionTime: NOW }),
    { code: 'REPLAY_TIME_MISMATCH' });
  const advice = seal({ ...archived.advice, expiresAt: LATER }, 'adviceDigest');
  assert.throws(() => replaySemanticDecisionV1({ ...archived, advice }),
    { code: 'REPLAY_TIME_MISMATCH' });
  const earlyAdvice = seal({ ...archived.advice, evaluatedAt: '2026-09-21T11:59:00.000Z' }, 'adviceDigest');
  assert.throws(() => replaySemanticDecisionV1({ ...archived, advice: earlyAdvice }),
    { code: 'REPLAY_TIME_MISMATCH' });
  const prepared = resealRequest({ ...archived.prepared, eligibleSet: [] });
  assert.throws(() => replaySemanticDecisionV1({ ...archived, prepared }),
    { code: 'PREPARED_INPUT_MISMATCH' });
  assert.equal(archived.prepared.requestedAt, NOW);
  assert.equal(archived.prepared.expiresAt, END);
});
