import assert from 'node:assert/strict';
import { test } from 'vitest';
import { rankRoleResourceOptionsV1 } from '../../../skills/coordinate-subagents/scripts/resource/role-priority.mjs';

const now = '2026-09-23T12:00:00Z';
const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const approval = { approvedBy: 'operator', approvedAt: now, evidenceDigest: `sha256:${'a'.repeat(64)}` };
const snapshot = (pool, remaining = 12) => ({ schemaVersion: '1.0.0', accountScope,
  resourcePoolId: pool, accessPath: 'subscription', windows: [{ windowId: 'weekly', resetEpoch: 1,
    resetAt: null, revision: 4, limitBucket: { bucketId: 'requests', kind: 'requests', unit: 'request',
      limit: 100, remaining }, coverage: 'complete',
    source: { kind: 'host-observation', evidenceDigest: `sha256:${'c'.repeat(64)}` },
    observedAt: '2026-09-23T11:00:00Z', expiresAt: '2026-09-23T13:00:00Z' }] });
const policy = pool => ({ schemaVersion: '1.0.0', policyId: `policy-${pool}`, revision: 3,
  accountScope, resourcePoolId: pool, approval, allowedAccessPaths: ['subscription'],
  onUnknown: 'defer', onStale: 'block', rolePriorities: [
    { roleId: 'audit', priority: 0 }, { roleId: 'bulk', priority: 2 },
  ], windows: [{ windowId: 'weekly', bucketId: 'requests', unit: 'request',
    hardLimit: { minimumRemaining: 0 }, reservePolicy: {
      hardReserve: { minimumRemaining: 10, protectedRoleIds: ['audit'] },
      softConservation: { enterBelowRemaining: 20 },
    } }] });
const option = (optionId, overrides = {}) => {
  const pool = overrides.pool ?? 'shared';
  return { optionId, roleId: 'bulk', workClass: 'work', strength: 'required', utilityScore: 1,
    snapshot: snapshot(pool, overrides.remaining ?? 12), policy: policy(pool),
    estimates: [{ windowId: 'weekly', unit: 'request', phases: {
      work: 1, judgment: 1, review: 0, handoff: 0,
    } }], ...Object.fromEntries(Object.entries(overrides)
      .filter(([key]) => !['pool', 'remaining'].includes(key))) };
};
const rank = options => rankRoleResourceOptionsV1({ options, now });

test('bulk cannot spend judgment reserve even with high utility; judgment cost is included', () => {
  const bulk = option('bulk-high', { utilityScore: 999 });
  bulk.estimates[0].phases.judgment = 2;
  const judgment = option('judgment', { roleId: 'audit', workClass: 'judgment', utilityScore: 0 });
  judgment.estimates[0].phases.work = 0;
  judgment.estimates[0].phases.judgment = 3;
  const result = rank([bulk, judgment]);
  assert.deepEqual(result.ranked.map(item => item.optionId), ['judgment']);
  assert.deepEqual(result.rejected, [{ optionId: 'bulk-high', disposition: 'defer', reason: 'HARD_RESERVE' }]);
  assert.equal(result.ranked[0].planned[0].required, 3);
  assert.equal(result.ranked[0].planned[0].projectedRemaining, 9);
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.reservationIssued, false);
  bulk.estimates[0].phases.judgment = 1;
  assert.equal(rank([bulk]).ranked[0].planned[0].projectedRemaining, 10);
});

test('repeat work prefers an allowed less scarce pool, then stable ID tie breaking', () => {
  const scarce = option('scarce', { pool: 'scarce', remaining: 21, utilityScore: 100 });
  const abundant = option('abundant', { pool: 'abundant', remaining: 40, utilityScore: 1 });
  assert.deepEqual(rank([scarce, abundant]).ranked.map(item => item.optionId), ['abundant', 'scarce']);
  const tiedA = option('a', { pool: 'a', remaining: 40 });
  const tiedB = option('b', { pool: 'b', remaining: 40 });
  assert.deepEqual(rank([tiedB, tiedA]).ranked.map(item => item.optionId), ['a', 'b']);
  assert.deepEqual(rank([tiedA, tiedB]).ranked.map(item => item.optionId), ['a', 'b']);
});

test('required role priority and hard exhaustion are not offset by score', () => {
  const audit = option('audit', { roleId: 'audit', workClass: 'review', remaining: 30, utilityScore: 0 });
  audit.estimates[0].phases.review = 1;
  const bulk = option('bulk', { remaining: 30, utilityScore: 1000 });
  assert.deepEqual(rank([bulk, audit]).ranked.map(item => item.optionId), ['audit', 'bulk']);
  const exhausted = option('exhausted', { remaining: 1, utilityScore: 1000 });
  assert.equal(rank([exhausted]).rejected[0].reason, 'HARD_RESERVE');
  const noReserve = option('no-reserve', { remaining: 1 });
  delete noReserve.policy.windows[0].reservePolicy;
  assert.equal(rank([noReserve]).rejected[0].reason, 'HARD_LIMIT');
});

test('unknown and stale evidence cannot become numeric capacity', () => {
  const unknown = option('unknown'); unknown.snapshot.windows[0].limitBucket.remaining = null;
  const stale = option('stale'); stale.snapshot.windows[0].expiresAt = now;
  const result = rank([stale, unknown]);
  assert.deepEqual(result.ranked, []);
  assert.deepEqual(result.rejected.map(item => [item.optionId, item.disposition]),
    [['stale', 'block'], ['unknown', 'defer']]);
});

test('four phases, window identity, units, and option identity are explicit', () => {
  const missing = option('missing'); delete missing.estimates[0].phases.judgment;
  assert.throws(() => rank([missing]));
  const mismatched = option('mismatch'); mismatched.estimates[0].unit = 'token';
  assert.throws(() => rank([mismatched]));
  const duplicate = option('duplicate');
  assert.throws(() => rank([duplicate, duplicate]));
  const unknownEstimate = option('unknown-estimate'); unknownEstimate.estimates[0].phases.review = null;
  assert.equal(rank([unknownEstimate]).rejected[0].reason, 'UNKNOWN_ESTIMATE');
});

test('malformed count floors cannot make projected negative capacity look eligible', () => {
  const negative = option('negative', { remaining: 1 });
  negative.policy.windows[0].hardLimit.minimumRemaining = -100;
  negative.policy.windows[0].reservePolicy.hardReserve.minimumRemaining = -50;
  assert.throws(() => rank([negative]), { code: 'INVALID_INPUT' });
  const fractional = option('fractional', { remaining: 20.5 });
  assert.throws(() => rank([fractional]), { code: 'INVALID_INPUT' });
  const inverted = option('inverted', { remaining: 20 });
  inverted.policy.windows[0].reservePolicy.softConservation.enterBelowRemaining = 5;
  assert.throws(() => rank([inverted]), { code: 'INVALID_INPUT' });
});

test('a protected role list must be an exact array, never a substring claim', () => {
  const forged = option('forged', { roleId: 'audit', workClass: 'judgment' });
  forged.estimates[0].phases.judgment = 2;
  forged.policy.windows[0].reservePolicy.hardReserve.protectedRoleIds = 'foo-audit';
  assert.throws(() => rank([forged]), { code: 'INVALID_INPUT' });
  forged.policy.windows[0].reservePolicy.hardReserve.protectedRoleIds = ['foo-audit'];
  assert.equal(rank([forged]).rejected[0].reason, 'HARD_RESERVE');
});

test('an empty resource window set cannot bypass every hard floor', () => {
  const empty = option('empty');
  empty.snapshot.windows = [];
  empty.policy.windows = [];
  empty.estimates = [];
  assert.throws(() => rank([empty]), { code: 'INVALID_INPUT' });
  const missingFloor = option('missing-floor', { remaining: 1 });
  delete missingFloor.policy.windows[0].hardLimit;
  delete missingFloor.policy.windows[0].reservePolicy;
  assert.throws(() => rank([missingFloor]), { code: 'INVALID_INPUT' });
  const hollowLimit = option('hollow-limit', { remaining: 1 });
  hollowLimit.policy.windows[0].hardLimit = {};
  delete hollowLimit.policy.windows[0].reservePolicy;
  assert.throws(() => rank([hollowLimit]), { code: 'INVALID_INPUT' });
});
