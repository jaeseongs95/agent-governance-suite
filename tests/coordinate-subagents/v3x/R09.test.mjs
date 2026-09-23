import assert from 'node:assert/strict';
import { test } from 'vitest';
import { stabilizeResourcePolicyV1 } from '../../../skills/coordinate-subagents/scripts/resource/policy-stability.mjs';

const enteredAt = '2026-09-23T00:00:00.000Z';
const input = (overrides = {}) => ({
  candidateState: 'NORMAL', previousPolicyState: 'CONSERVE', enteredAt,
  now: '2026-09-23T00:00:30.000Z', policyVersion: 3, previousPolicyVersion: 3,
  minimumHoldMs: 60000, ...overrides,
});

test('soft boundary round trips obey explicit minimum hold', () => {
  const held = stabilizeResourcePolicyV1(input());
  assert.equal(held.state, 'CONSERVE');
  assert.equal(held.enteredAt, enteredAt);
  assert.equal(held.reasonCode, 'MINIMUM_HOLD');
  const released = stabilizeResourcePolicyV1(input({ now: '2026-09-23T00:01:00.000Z' }));
  assert.equal(released.state, 'NORMAL');
  assert.equal(released.enteredAt, '2026-09-23T00:01:00.000Z');
  const bounced = stabilizeResourcePolicyV1(input({ candidateState: 'CONSERVE',
    previousPolicyState: 'NORMAL', enteredAt: released.enteredAt,
    now: '2026-09-23T00:01:01.000Z' }));
  assert.equal(bounced.state, 'NORMAL');
  assert.equal(bounced.reasonCode, 'MINIMUM_HOLD');
});

test('hard exhaustion is immediate and cannot be delayed by hold or clock rollback', () => {
  const exhausted = stabilizeResourcePolicyV1(input({ candidateState: 'UNAVAILABLE',
    now: '2026-09-22T23:59:59.000Z' }));
  assert.equal(exhausted.state, 'UNAVAILABLE');
  assert.equal(exhausted.reasonCode, 'HARD_UNAVAILABLE_IMMEDIATE');
  assert.equal(exhausted.enteredAt, '2026-09-22T23:59:59.000Z');
  const unchanged = stabilizeResourcePolicyV1(input({ candidateState: 'UNAVAILABLE',
    previousPolicyState: 'UNAVAILABLE' }));
  assert.equal(unchanged.enteredAt, enteredAt);
  assert.equal(stabilizeResourcePolicyV1(input({ candidateState: 'RESERVE' })).state, 'RESERVE');
  assert.equal(stabilizeResourcePolicyV1(input({ candidateState: 'UNKNOWN' })).state, 'UNKNOWN');
});

test('policy version change resets prior soft state with explicit reason', () => {
  const changed = stabilizeResourcePolicyV1(input({ policyVersion: 4 }));
  assert.equal(changed.state, 'NORMAL');
  assert.equal(changed.enteredAt, '2026-09-23T00:00:30.000Z');
  assert.equal(changed.reasonCode, 'POLICY_VERSION_RESET');
  assert.equal(changed.resetReason, 'POLICY_VERSION_CHANGED');
  assert.equal(changed.previousStateInherited, false);
  const hard = stabilizeResourcePolicyV1(input({ candidateState: 'UNAVAILABLE', policyVersion: 4 }));
  assert.equal(hard.state, 'UNAVAILABLE');
  assert.equal(hard.resetReason, 'POLICY_VERSION_CHANGED');
});

test('clock rollback holds prior state and cannot silently reset dwell time', () => {
  const rolled = stabilizeResourcePolicyV1(input({ now: '2026-09-22T23:59:59.000Z' }));
  assert.equal(rolled.state, 'CONSERVE');
  assert.equal(rolled.enteredAt, enteredAt);
  assert.equal(rolled.reasonCode, 'CLOCK_ROLLBACK_HOLD');
  const hardRecovery = stabilizeResourcePolicyV1(input({ previousPolicyState: 'UNAVAILABLE',
    now: '2026-09-22T23:59:59.000Z' }));
  assert.equal(hardRecovery.state, 'UNAVAILABLE');
  assert.equal(hardRecovery.reasonCode, 'CLOCK_ROLLBACK_HOLD');
});

test('same input replays after a fresh module import without hidden memory or clock', async () => {
  const first = stabilizeResourcePolicyV1(input());
  const fresh = await import('../../../skills/coordinate-subagents/scripts/resource/policy-stability.mjs?restart=1');
  assert.deepEqual(fresh.stabilizeResourcePolicyV1(structuredClone(input())), first);
  assert.deepEqual(stabilizeResourcePolicyV1(input()), first);
  const initial = stabilizeResourcePolicyV1(input({ previousPolicyState: null,
    enteredAt: null, previousPolicyVersion: null }));
  assert.equal(initial.state, 'NORMAL');
  assert.equal(initial.reasonCode, 'INITIAL_EVALUATION');
});

test('rejects implicit time, invalid prior frame and missing version', () => {
  assert.throws(() => stabilizeResourcePolicyV1(input({ now: undefined })), { code: 'INVALID_INPUT' });
  assert.throws(() => stabilizeResourcePolicyV1(input({ enteredAt: null })), { code: 'INVALID_INPUT' });
  assert.throws(() => stabilizeResourcePolicyV1(input({ policyVersion: null })), { code: 'INVALID_INPUT' });
});
