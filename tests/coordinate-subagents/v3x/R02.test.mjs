import assert from 'node:assert/strict';
import { test } from 'vitest';
import { collectEligibleCandidatesV2, digest } from '../../../skills/coordinate-subagents/scripts/model-routing-core.mjs';
import { bindCandidatesToResourcePoolsV1 } from '../../../skills/coordinate-subagents/scripts/resource/pool-binding.mjs';
import { capability, environment, request } from '../model-routing-v2/fixtures.mjs';

const account = `acct-hmac-sha256:${'a'.repeat(64)}`;
const otherAccount = `acct-hmac-sha256:${'b'.repeat(64)}`;
function candidates() {
  const env = environment({ capabilities: [
    capability({ actorId: 'actor-a', sessionId: 'session-a' }),
    capability({ actorId: 'actor-b', sessionId: 'session-b' }, { model: 'gpt-5.6-sol', resolvedModel: 'gpt-5.6-sol' }),
  ] });
  return collectEligibleCandidatesV2(request(), env).candidates;
}
function mapping(candidate, overrides = {}) {
  return {
    candidateKey: candidate.key,
    resolvedModel: candidate.binding.resolvedModel,
    host: candidate.snapshot.host,
    accessPath: candidate.binding.accessPath,
    accountScope: account,
    resourcePoolIds: ['shared-pool'],
    ...overrides,
  };
}
const pool = (overrides = {}) => ({ resourcePoolId: 'shared-pool', accountScope: account, accessPath: 'subscription', ...overrides });

test('two concrete models can explicitly share one approved pool without becoming an observation', () => {
  const cs = candidates();
  assert.equal(cs.length, 2);
  const result = bindCandidatesToResourcePoolsV1(cs, {
    mappings: cs.map(candidate => mapping(candidate)), approvedPools: [pool()],
  });
  assert.deepEqual(result.map(item => item.status), ['mapped', 'mapped']);
  assert.deepEqual(result.map(item => item.poolRefs), [
    [{ resourcePoolId: 'shared-pool', accountScope: account, accessPath: 'subscription' }],
    [{ resourcePoolId: 'shared-pool', accountScope: account, accessPath: 'subscription' }],
  ]);
  assert.deepEqual(result.map(item => item.mappingSource), ['configuration', 'configuration']);
  assert.ok(result.every(item => !Object.hasOwn(item, 'remaining') && !Object.hasOwn(item, 'observedAt')));
});

test('pool references remain distinct across calls with the same ID and different account or access path', () => {
  const [candidate] = candidates();
  const first = bindCandidatesToResourcePoolsV1([candidate], {
    mappings: [mapping(candidate)], approvedPools: [pool()],
  })[0].poolRefs[0];
  const accountResult = bindCandidatesToResourcePoolsV1([candidate], {
    mappings: [mapping(candidate, { accountScope: otherAccount })],
    approvedPools: [pool({ accountScope: otherAccount })],
  })[0].poolRefs[0];
  assert.equal(first.resourcePoolId, accountResult.resourcePoolId);
  assert.notDeepEqual(first, accountResult);

  const apiSnapshot = capability({}, {
    model: candidate.model.id, resolvedModel: candidate.model.id, accessPath: 'api',
  });
  const apiBinding = apiSnapshot.supportedBindings[0];
  const apiCandidate = {
    key: digest({ snapshotDigest: apiSnapshot.snapshotDigest, binding: apiBinding }),
    model: candidate.model, snapshot: apiSnapshot, binding: apiBinding,
  };
  const pathResult = bindCandidatesToResourcePoolsV1([apiCandidate], {
    mappings: [mapping(apiCandidate)], approvedPools: [pool({ accessPath: 'api' })],
  })[0].poolRefs[0];
  assert.equal(first.resourcePoolId, pathResult.resourcePoolId);
  assert.notDeepEqual(first, pathResult);
});

test('missing candidate or approved pool mapping remains unknown', () => {
  const cs = candidates();
  const missingCandidate = bindCandidatesToResourcePoolsV1(cs, {
    mappings: [mapping(cs[0])], approvedPools: [pool()],
  });
  assert.deepEqual(missingCandidate.map(item => item.status), ['mapped', 'unknown']);
  const missingPool = bindCandidatesToResourcePoolsV1(cs, {
    mappings: cs.map(candidate => mapping(candidate)), approvedPools: [],
  });
  assert.deepEqual(missingPool.map(item => item.status), ['unknown', 'unknown']);
});

test('alias, account, and access path conflicts cannot merge into an approved pool', () => {
  const [candidate] = candidates();
  const bind = (mapped, approved = pool()) => bindCandidatesToResourcePoolsV1([candidate], {
    mappings: [mapped], approvedPools: [approved],
  });
  assert.throws(() => bind(mapping(candidate, { resolvedModel: 'unverified-alias' })));
  assert.throws(() => bind(mapping(candidate, { accountScope: otherAccount })));
  assert.throws(() => bind(mapping(candidate, { accessPath: 'api' })));
  assert.throws(() => bind(mapping(candidate), pool({ accountScope: otherAccount })));
  assert.throws(() => bind(mapping(candidate), pool({ accessPath: 'api' })));
});

test('untrusted candidate and observed snapshot cannot become binding configuration', () => {
  const [candidate] = candidates();
  const tampered = structuredClone(candidate);
  tampered.binding.accessPath = 'api';
  assert.throws(() => bindCandidatesToResourcePoolsV1([tampered], {
    mappings: [mapping(candidate)], approvedPools: [pool()],
  }));
  assert.throws(() => bindCandidatesToResourcePoolsV1([candidate], {
    mappings: [mapping(candidate)], approvedPools: [pool({ windows: [] })],
  }));
  assert.throws(() => bindCandidatesToResourcePoolsV1([candidate], {
    mappings: [mapping(candidate, { accountScope: 'alice@example.com' })], approvedPools: [pool()],
  }));
});
