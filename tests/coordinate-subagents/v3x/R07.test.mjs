import assert from 'node:assert/strict';
import { test } from 'vitest';
import { combineResourcePreferenceV1 } from '../../../skills/coordinate-subagents/scripts/resource/preference-policy.mjs';

const now = '2026-09-23T12:00:00Z';
const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const approval = () => ({ approvedBy: 'operator', approvedAt: now, evidenceDigest: `sha256:${'a'.repeat(64)}` });
const snapshot = (remaining = 70) => ({ schemaVersion: '1.0.0', accountScope, resourcePoolId: 'shared-pool',
  accessPath: 'subscription', windows: [{ windowId: 'weekly', resetEpoch: 1, resetAt: null, revision: 4,
    limitBucket: { bucketId: 'shared-token-quota', kind: 'tokens', unit: 'token', limit: 100, remaining },
    coverage: 'complete', source: { kind: 'host-observation', evidenceDigest: `sha256:${'c'.repeat(64)}` },
    observedAt: '2026-09-23T11:00:00Z', expiresAt: '2026-09-23T13:00:00Z' }] });
const policy = () => ({ schemaVersion: '1.0.0', policyId: 'pool-policy', revision: 3,
  accountScope, resourcePoolId: 'shared-pool', approval: approval(), allowedAccessPaths: ['subscription'],
  onUnknown: 'defer', onStale: 'block', windows: [{ windowId: 'weekly', bucketId: 'shared-token-quota', unit: 'token',
    hardLimit: { minimumRemaining: 0 }, reservePolicy: {
      hardReserve: { minimumRemaining: 10, protectedRoleIds: ['audit'] },
      softConservation: { enterBelowRemaining: 30 },
    } }] });
const decide = (remaining, strength, roleId = 'bulk', p = policy()) => combineResourcePreferenceV1({
  snapshot: snapshot(remaining), policy: p, now, strength, roleId,
});

test('required cannot override hard unavailability and unknown follows approved disposition', () => {
  const unavailable = decide(0, 'required');
  assert.equal(unavailable.admission, 'block');
  assert.deepEqual(unavailable.reasonCodes, ['EXHAUSTED_WINDOW', 'REQUIRED_UNAVAILABLE']);
  const unknown = decide(null, 'required');
  assert.equal(unknown.admission, 'defer');
  assert.deepEqual(unknown.reasonCodes, ['UNKNOWN_WINDOW', 'RESOURCE_UNKNOWN']);
});

test('preferred passes soft conservation without changing required-first ranking', () => {
  const preferred = decide(20, 'preferred');
  assert.equal(preferred.admission, 'allow');
  assert.equal(preferred.executionAuthorized, false);
  assert.equal(preferred.preferenceRank, 1);
  assert.deepEqual(preferred.reasonCodes, ['SOFT_CONSERVATION', 'PREFERRED_BEATS_SOFT_CONSERVE']);
  assert.equal(decide(70, 'required').preferenceRank, 0);
});

test('hard reserve protects its roles and blocks unapproved preferred exceptions', () => {
  assert.equal(decide(5, 'required', 'audit').admission, 'allow');
  assert.equal(decide(5, 'required', 'audit').reasonCodes[1], 'PROTECTED_ROLE_RESERVE');
  const blocked = decide(5, 'preferred');
  assert.equal(blocked.admission, 'block');
  assert.deepEqual(blocked.reasonCodes, ['HARD_RESERVE']);
  const p = policy(); p.preferenceOverride = { mode: 'preferred-through-hard-reserve', reason: 'approved urgent review', approval: approval() };
  const excepted = decide(5, 'preferred', 'bulk', p);
  assert.equal(excepted.admission, 'allow');
  assert.equal(excepted.reasonCodes[1], 'APPROVED_RESERVE_EXCEPTION');
  assert.equal(decide(5, 'required', 'bulk', p).admission, 'block');
});

test('preferred-first priority requires an explicit separately approved policy', () => {
  const p = policy();
  p.preferenceOverride = { mode: 'preferred-over-required', reason: 'approved selection order', approval: approval() };
  const preferred = decide(70, 'preferred', 'bulk', p);
  assert.equal(preferred.preferenceRank, 0);
  assert(preferred.reasonCodes.includes('PREFERENCE_PRIORITY_OVERRIDE'));
  assert.equal(decide(70, 'required', 'bulk', p).preferenceRank, 1);
  delete p.preferenceOverride.approval;
  assert.equal(decide(70, 'preferred', 'bulk', p).preferenceRank, 1);
});
