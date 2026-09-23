import assert from 'node:assert/strict';
import { test } from 'vitest';
import { decideUnknownResourcePolicyV1 } from '../../../skills/coordinate-subagents/scripts/resource/unknown-policy.mjs';

const now = '2026-09-23T12:00:00.000Z';
const input = (overrides = {}) => ({
  modelAvailability: 'available', now,
  usageClaim: { source: 'unknown', metric: { kind: 'native-percent', amount: null },
    observedAt: null, expiresAt: null },
  policy: { mode: 'observe-only', onUnknown: 'conservative-concurrency',
    onStale: 'operator-refresh', conservativeConcurrency: 1 },
  ...overrides,
});
const claim = (changes = {}) => ({ source: 'provider-reported',
  metric: { kind: 'native-percent', amount: 70 },
  observedAt: '2026-09-23T11:00:00.000Z', expiresAt: '2026-09-23T12:00:00.000Z', ...changes });

test('unknown source keeps availability separate from quota and never fills a metric', () => {
  const result = decideUnknownResourcePolicyV1(input());
  assert.equal(result.modelAvailability, 'available');
  assert.equal(result.quotaKnowledge, 'unknown');
  assert.equal(result.quotaRemaining, null);
  assert.equal(result.claimedMetric.amount, null);
  assert.equal(result.recommendation, 'conservative-concurrency');
  assert.equal(result.proposedConcurrencyLimit, 1);
  assert.equal(result.issuanceCount, 0);
  assert.equal(result.reservationIssued, false);
  assert.equal(result.executionAuthorized, false);
  for (const amount of [0, 100]) {
    assert.throws(() => decideUnknownResourcePolicyV1(input({
      usageClaim: { ...input().usageClaim, metric: { kind: 'native-percent', amount } },
    })), { code: 'INVALID_INPUT' });
  }
});

test('expiry boundary stays stale and cannot be resealed by evaluation time', () => {
  const result = decideUnknownResourcePolicyV1(input({ usageClaim: claim() }));
  assert.equal(result.freshness, 'stale');
  assert.equal(result.quotaKnowledge, 'stale');
  assert.equal(result.observedAt, '2026-09-23T11:00:00.000Z');
  assert.equal(result.expiresAt, now);
  assert.equal(result.evaluatedAt, now);
  assert.equal(result.recommendation, 'operator-refresh');
  assert.equal(result.quotaRemaining, null);
  assert.equal(result.claimedMetric.amount, 70);
  assert.equal(result.refreshRequested, false);
  const fresh = decideUnknownResourcePolicyV1(input({
    now: '2026-09-23T11:59:59.999Z', usageClaim: claim(),
  }));
  assert.equal(fresh.freshness, 'fresh');
  assert.equal(fresh.quotaKnowledge, 'unadmitted');
  assert.equal(fresh.quotaRemaining, null);
  const future = decideUnknownResourcePolicyV1(input({
    usageClaim: claim({ observedAt: '2026-09-23T12:01:00.000Z',
      expiresAt: '2026-09-23T13:00:00.000Z' }),
  }));
  assert.equal(future.freshness, 'stale');
  assert.equal(future.quotaRemaining, null);
});

test('explicit defer and availability block dominate speculative concurrency', () => {
  const deferred = decideUnknownResourcePolicyV1(input({
    usageClaim: claim({ source: 'unknown', metric: { kind: 'native-percent', amount: null } }),
    policy: { ...input().policy, onStale: 'defer' },
  }));
  assert.equal(deferred.recommendation, 'defer');
  assert.equal(deferred.proposedConcurrencyLimit, null);
  assert.equal(decideUnknownResourcePolicyV1(input({ modelAvailability: 'unavailable' })).recommendation, 'block');
  assert.equal(decideUnknownResourcePolicyV1(input({ modelAvailability: 'unknown' })).recommendation, 'defer');
});

test('observe-only and recommend-only issue no reservation or refresh', () => {
  for (const mode of ['observe-only', 'recommend-only']) {
    const result = decideUnknownResourcePolicyV1(input({ policy: { ...input().policy, mode } }));
    assert.equal(result.issuanceCount, 0);
    assert.equal(result.refreshRequested, false);
    assert.equal(result.executionAuthorized, false);
  }
});

test('rejects forged admission flags, implicit time, and invented policy limits', () => {
  assert.throws(() => decideUnknownResourcePolicyV1(input({ now: undefined })), { code: 'INVALID_INPUT' });
  assert.throws(() => decideUnknownResourcePolicyV1(input({
    usageClaim: { ...input().usageClaim, observationAdmitted: true },
  })));
  assert.throws(() => decideUnknownResourcePolicyV1(input({
    policy: { ...input().policy, conservativeConcurrency: null },
  })), { code: 'INVALID_INPUT' });
  assert.throws(() => decideUnknownResourcePolicyV1(input({
    usageClaim: claim({ observedAt: '2026-09-23T13:00:00.000Z', expiresAt: now }),
  })), { code: 'INVALID_INPUT' });
});
