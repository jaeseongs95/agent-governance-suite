import assert from 'node:assert/strict';
import { test } from 'vitest';
import { evaluateResourcePolicyV1 } from '../../../skills/coordinate-subagents/scripts/resource/policy-evaluator.mjs';

const now = '2026-09-23T12:00:00Z';
const accountScope = `acct-hmac-sha256:${'b'.repeat(64)}`;
const approval = (letter = 'a') => ({ approvedBy: 'operator', approvedAt: '2026-09-23T00:00:00Z', evidenceDigest: `sha256:${letter.repeat(64)}` });
const window = (windowId, remaining) => ({
  windowId, resetEpoch: 1, resetAt: '2026-09-24T00:00:00Z', revision: 7,
  limitBucket: { bucketId: `${windowId}-bucket`, kind: 'tokens', unit: 'token', limit: 100, remaining },
  coverage: 'complete', source: { kind: 'host-observation', evidenceDigest: `sha256:${'a'.repeat(64)}` },
  observedAt: '2026-09-23T11:00:00Z', expiresAt: '2026-09-23T13:00:00Z',
});
const snapshot = () => ({ schemaVersion: '1.0.0', accountScope, resourcePoolId: 'shared-pool',
  accessPath: 'subscription', windows: [window('short', 70), window('weekly', 70)] });
const policy = () => ({ schemaVersion: '1.0.0', policyId: 'pool-policy', revision: 3,
  accountScope, resourcePoolId: 'shared-pool', approval: approval(),
  allowedAccessPaths: ['subscription'],
  onUnknown: 'defer', onStale: 'block',
  windows: ['short', 'weekly'].map((windowId) => ({ windowId, bucketId: `${windowId}-bucket`, unit: 'token',
    hardLimit: { minimumRemaining: 0 }, reservePolicy: {
      hardReserve: { minimumRemaining: 10, protectedRoleIds: ['audit'] },
      softConservation: { enterBelowRemaining: 30 },
    },
  })),
});
const evaluate = (s = snapshot(), p = policy(), time = now) => evaluateResourcePolicyV1({ snapshot: s, policy: p, now: time });

test('either short or weekly exhaustion immediately yields UNAVAILABLE', () => {
  for (const index of [0, 1]) {
    const s = snapshot(); s.windows[index].limitBucket.remaining = 0;
    const result = evaluate(s);
    assert.equal(result.state, 'UNAVAILABLE');
    assert.equal(result.disposition, 'block');
    assert.equal(result.outcomes.find((item) => item.windowId === s.windows[index].windowId).reason, 'EXHAUSTED_WINDOW');
  }
  const withoutLimit = policy(); delete withoutLimit.windows[1].hardLimit;
  const s = snapshot(); s.windows[1].limitBucket.remaining = 0;
  assert.equal(evaluate(s, withoutLimit).state, 'UNAVAILABLE');
});

test('reserve and conservation are separate policy states, never observations', () => {
  const s = snapshot(); s.windows[0].limitBucket.remaining = 10;
  assert.equal(evaluate(s).state, 'RESERVE');
  s.windows[0].limitBucket.remaining = 29;
  const result = evaluate(s);
  assert.equal(result.state, 'CONSERVE');
  assert.equal(result.kind, 'policy-output');
  assert.equal(result.disposition, 'none');
  assert.equal(evaluate().state, 'NORMAL');
});

test('one unknown or stale window is not mistaken for normal; known hard exhaustion still wins', () => {
  const s = snapshot(); s.windows[0].limitBucket.remaining = null;
  assert.equal(evaluate(s).state, 'UNKNOWN');
  assert.equal(evaluate(s).disposition, 'defer');
  s.windows[1].limitBucket.remaining = 0;
  assert.equal(evaluate(s).state, 'UNAVAILABLE');
  const stale = snapshot(); stale.windows[1].expiresAt = now;
  assert.equal(evaluate(stale).state, 'UNKNOWN');
  assert.equal(evaluate(stale).disposition, 'block');
  stale.windows[1].limitBucket.remaining = null;
  assert.equal(evaluate(stale).outcomes.find((item) => item.windowId === 'weekly').reason, 'UNKNOWN_STALE_WINDOW');
  assert.equal(evaluate(stale).disposition, 'block');
  const inverse = policy(); inverse.onUnknown = 'block'; inverse.onStale = 'defer';
  assert.equal(evaluate(stale, inverse).disposition, 'block');
});

test('explicit time, policy revision and window revisions yield repeatable output', () => {
  const s = snapshot(), p = policy();
  assert.deepEqual(evaluate(s, p), evaluate(structuredClone(s), structuredClone(p)));
  p.revision += 1;
  assert.equal(evaluate(s, p).policyRevision, 4);
  s.windows[0].revision += 1;
  assert.equal(evaluate(s, p).outcomes.find((item) => item.windowId === 'short').revision, 8);
  assert.equal(evaluate(s, p, '2026-09-23T13:00:00Z').state, 'UNKNOWN');
});

test('binding gaps and disallowed access paths cannot appear normal', () => {
  const p = policy(); p.windows.pop();
  assert.throws(() => evaluate(snapshot(), p), { code: 'INVALID_INPUT' });
  const paid = snapshot(); paid.accessPath = 'api';
  assert.equal(evaluate(paid).state, 'UNAVAILABLE');
  assert.equal(evaluate(paid).outcomes[0].reason, 'ACCESS_PATH_DENIED');
  const paidPolicy = policy(); paidPolicy.allowedAccessPaths.push('api');
  assert.equal(evaluate(paid, paidPolicy).state, 'UNAVAILABLE');
  paidPolicy.paidAccessApproval = approval('c');
  assert.equal(evaluate(paid, paidPolicy).state, 'NORMAL');
  const mismatch = snapshot(); mismatch.windows[0].limitBucket.unit = 'request';
  assert.throws(() => evaluate(mismatch), { code: 'INVALID_INPUT' });
});
