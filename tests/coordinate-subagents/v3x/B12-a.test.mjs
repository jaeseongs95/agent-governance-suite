import assert from 'node:assert/strict';
import { test } from 'vitest';

import { projectSnapshotCoverageV1 } from '../../../mcp-server/src/resource/coverage-projection.ts';

const accountScope = `acct-hmac-sha256:${'c'.repeat(64)}`;
const jobBindingDigest = `sha256:${'b'.repeat(64)}`;
const snapshot = (extra = {}) => ({
  accountScope, poolId: 'pool-1', windowId: 'weekly', resetEpoch: 1,
  unit: 'request', metricKind: 'used', observedAmount: 10,
  coverage: 'complete', jobBindingDigest,
  includedEventIds: [], excludedEventIds: [], watermarkSequence: null, ...extra,
});
const event = (eventId, sequence, extra = {}) => ({
  eventId, accountScope, poolId: 'pool-1', windowId: 'weekly', resetEpoch: 1,
  jobBindingDigest, unit: 'request', amount: 3, basis: 'delta',
  sequence, correctsEventId: null, ...extra,
});
const slots = { unit: 'slot', reservedAmount: 2, observedUse: 1 };
const project = (s, events, internalSlotBudget = slots) =>
  projectSnapshotCoverageV1({ snapshot: s, events, internalSlotBudget });

test('B12-a watermark includes prior usage and explicit exclusion adds only new delta', () => {
  const result = project(snapshot({ watermarkSequence: 2,
    excludedEventIds: ['event-3'] }), [
    event('event-1', 1), event('event-2', 2), event('event-3', 3, { amount: 4 }),
  ]);
  assert.deepEqual(result.eventInclusion.map(x => x.status),
    ['included', 'included', 'excluded']);
  assert.deepEqual(result.providerMetric, {
    unit: 'request', metricKind: 'used', observedAmount: 10, coverage: 'complete',
    knownExcludedDelta: 4, projectedAmount: 14,
  });
  assert.equal(result.needsReconciliation, false);
});

test('B12-a absent watermark never infers inclusion from sequence or observed usage', () => {
  const result = project(snapshot(), [event('event-1', 1)]);
  assert.equal(result.eventInclusion[0].status, 'unknown');
  assert.equal(result.providerMetric.projectedAmount, null);
  assert.equal(result.providerMetric.knownExcludedDelta, 0);
  assert.equal(result.needsReconciliation, true);
});

test('B12-a late explicit member is not charged twice; correction stays unknown', () => {
  const result = project(snapshot({ watermarkSequence: 2,
    includedEventIds: ['event-4'] }), [
    event('event-4', 4, { amount: 5 }),
    event('correction-1', 1, { amount: 2, correctsEventId: 'event-1' }),
  ]);
  assert.deepEqual(result.eventInclusion.map(x => x.status), ['included', 'unknown']);
  assert.equal(result.providerMetric.knownExcludedDelta, 0);
  assert.equal(result.providerMetric.projectedAmount, null);
});

test('B12-a remaining metric debits excluded usage once', () => {
  const result = project(snapshot({ metricKind: 'remaining', observedAmount: 10,
    watermarkSequence: 1, excludedEventIds: ['event-2'] }),
  [event('event-1', 1), event('event-2', 2)]);
  assert.equal(result.providerMetric.knownExcludedDelta, 3);
  assert.equal(result.providerMetric.projectedAmount, 7);
});

test('B12-a contradictory excluded member within included prefix fails closed', () => {
  assert.throws(() => project(snapshot({ watermarkSequence: 1,
    excludedEventIds: ['event-1'] }), [event('event-1', 1)]));
});

test('B12-a later sequence without explicit exclusion remains unknown', () => {
  const result = project(snapshot({ watermarkSequence: 1 }), [event('event-2', 2)]);
  assert.equal(result.eventInclusion[0].status, 'unknown');
  assert.equal(result.providerMetric.projectedAmount, null);
});

test('B12-a explicitly included correction stays included despite missing sequence', () => {
  const result = project(snapshot({ includedEventIds: ['correction-1'] }), [
    event('correction-1', null, { correctsEventId: 'event-1' }),
  ]);
  assert.equal(result.eventInclusion[0].status, 'included');
  assert.equal(result.providerMetric.projectedAmount, 10);
});

test('B12-a different units and jobs cannot be converted by a watermark', () => {
  const result = project(snapshot({ watermarkSequence: 1 }), [
    event('token-1', 1, { unit: 'token', amount: 100 }),
    event('other-job-1', 1, { jobBindingDigest: `sha256:${'d'.repeat(64)}` }),
  ]);
  assert.deepEqual(result.eventInclusion.map(x => x.status), ['different-unit', 'unknown']);
  assert.equal(result.providerMetric.projectedAmount, null);
  assert.equal(result.internalSlotBudget.unit, 'slot');
  assert.equal(result.internalSlotBudget.reservedAmount, 2);
});

test('B12-a unknown provider coverage never turns internal slots into provider usage', () => {
  const result = project(snapshot({ coverage: 'unknown', unit: 'percent',
    observedAmount: 73, watermarkSequence: 0 }), [],
  { unit: 'slot', reservedAmount: 4, observedUse: null });
  assert.equal(result.providerMetric.observedAmount, 73);
  assert.equal(result.providerMetric.projectedAmount, null);
  assert.deepEqual(result.internalSlotBudget,
    { unit: 'slot', reservedAmount: 4, observedUse: null });
  assert.equal(result.needsReconciliation, true);
});

test('B12-a cumulative event lacks additive delta and duplicate or foreign events fail', () => {
  const cumulative = project(snapshot({ watermarkSequence: 0,
    excludedEventIds: ['cumulative-1'] }), [
    event('cumulative-1', 1, { basis: 'cumulative' }),
  ]);
  assert.equal(cumulative.eventInclusion[0].status, 'excluded');
  assert.equal(cumulative.providerMetric.projectedAmount, null);
  assert.throws(() => project(snapshot(), [event('event-1', 1), event('event-1', 1)]));
  assert.throws(() => project(snapshot(), [event('event-1', 1, { resetEpoch: 2 })]));
});
