import assert from 'node:assert/strict';
import { test } from 'vitest';
import { FakeResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/fake.ts';
import { projectCollectorResponseV1, validateCollectorResponseV1 } from '../../../mcp-server/src/resource/collector-port.ts';

const accountScope = `acct-hmac-sha256:${'a'.repeat(64)}`;
const scope = (source = 'fake') => ({ collectorId: 'fixture-1', source, accountScope, resourcePoolId: 'shared' });
const window = (id = 'five-hour', revision = 1, source = 'user-declared') => ({
  windowId: id, resetEpoch: 1, resetAt: '2026-09-24T00:00:00.000Z', revision,
  limitBucket: { bucketId: 'tokens', kind: 'tokens', unit: 'token', limit: 100, remaining: 60 },
  coverage: 'partial', source: { kind: source, evidenceDigest: null },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T00:05:00.000Z',
});
const snapshot = (windows = [window()]) => ({
  schemaVersion: '1.0.0', accountScope, resourcePoolId: 'shared', accessPath: 'subscription', windows,
});
const full = (sequence = 1, windows = [window()], source = 'fake') => ({
  schemaVersion: '1.0.0', kind: 'full', ...scope(source), sequence, snapshot: snapshot(windows),
});
const delta = (sequence, baseSequence, upsertWindows = [window('five-hour', 2)]) => ({
  schemaVersion: '1.0.0', kind: 'delta', ...scope(), sequence, baseSequence,
  upsertWindows, removeWindowIds: [],
});
const unavailable = (sequence) => ({
  schemaVersion: '1.0.0', kind: 'unavailable', ...scope(), sequence, reason: 'not-exposed',
});
const apply = (current, response, expected = scope()) => projectCollectorResponseV1(expected, current, response);

test('R13 full, delta and unavailable preserve scoped sequence and require full after unavailable', () => {
  const first = apply(null, full());
  assert.equal(first.kind, 'applied');
  assert.equal(first.state.observationAdmitted, false);
  assert.equal(first.state.snapshot.windows[0].revision, 1);
  const second = apply(first.state, delta(2, 1));
  assert.equal(second.kind, 'applied');
  assert.equal(second.state.snapshot.windows[0].revision, 2);
  const lost = apply(second.state, unavailable(3));
  assert.equal(lost.kind, 'applied');
  assert.equal(lost.state.availability, 'unavailable');
  assert.equal(lost.state.snapshot, null);
  assert.equal(apply(lost.state, delta(4, 3)).kind, 'resync-required');
  assert.equal(apply(lost.state, full(5, [window('five-hour', 3)])).kind, 'applied');
});

test('R13 duplicates are idempotent; conflicting duplicate, stale and missing base do not mutate state', () => {
  const initial = apply(null, full()).state;
  const original = structuredClone(initial);
  assert.deepEqual(apply(initial, full()), { kind: 'duplicate', state: initial });
  assert.throws(() => apply(initial, full(1, [window('five-hour', 2)])), { code: 'SNAPSHOT_CONFLICT' });
  assert.equal(apply(initial, delta(3, 1)).kind, 'resync-required');
  assert.equal(apply(null, delta(2, 1)).kind, 'resync-required');
  const next = apply(initial, delta(2, 1)).state;
  assert.equal(apply(next, delta(3, 1)).kind, 'resync-required');
  assert.equal(apply(next, full(1)).kind, 'out-of-order');
  assert.deepEqual(initial, original);
});

test('R13 delta applies replacements/removals without changing another window', () => {
  const first = apply(null, full(1, [window(), window('weekly')])).state;
  const changed = delta(2, 1, [window('five-hour', 2)]);
  changed.removeWindowIds = ['weekly'];
  const result = apply(first, changed);
  assert.equal(result.kind, 'applied');
  assert.deepEqual(result.state.snapshot.windows.map((item) => item.windowId), ['five-hour']);
  assert.equal(first.snapshot.windows.length, 2);
  assert.throws(() => apply(result.state, full(3, [window('five-hour', 1)])), { code: 'INVALID_INPUT' });
  assert.throws(() => apply(result.state, full(3, [
    { ...window('five-hour', 2), limitBucket: { ...window().limitBucket, remaining: 99 } },
  ])), { code: 'INVALID_INPUT' });
});

test('R13 unavailable, delta removal and full omission cannot erase window revision history', () => {
  const first = apply(null, full(1, [window('five-hour', 5), window('weekly')])).state;
  const lost = apply(first, unavailable(2)).state;
  assert.equal(lost.snapshot, null);
  assert.equal(lost.knownWindows.length, 2);
  assert.throws(() => apply(lost, full(3, [window('five-hour', 1)])), { code: 'INVALID_INPUT' });
  const restored = apply(lost, full(3, [window('five-hour', 5), window('weekly')])).state;
  const removed = apply(restored, { ...delta(4, 3, []), removeWindowIds: ['five-hour'] }).state;
  assert.equal(removed.snapshot.windows.length, 1);
  assert.throws(() => apply(removed, delta(5, 4, [window('five-hour', 1)])), { code: 'INVALID_INPUT' });
  const omitted = apply(restored, full(4, [window('weekly')])).state;
  assert.throws(() => apply(omitted, full(5, [window('five-hour', 1)])), { code: 'INVALID_INPUT' });
  assert.equal(apply(omitted, full(5, [{ ...window('five-hour', 1), resetEpoch: 2 }])).kind, 'applied');
});

test('R13 rejects unknown fields, foreign scope and source laundering at every response shape', () => {
  assert.throws(() => validateCollectorResponseV1({ ...full(), trusted: true }, scope()), { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1({ ...delta(2, 1), rawActual: 8 }, scope()), { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1({ ...unavailable(1), snapshot: snapshot() }, scope()), { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1(full(1, [window('five-hour', 1, 'provider-observation')]), scope()),
    { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1(full(1, [window('five-hour', 1, 'configured')]), scope()),
    { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1({ ...full(), source: 'provider-reported' }, scope()),
    { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1({ ...full(), accountScope: `acct-hmac-sha256:${'b'.repeat(64)}` }, scope()),
    { code: 'INVALID_INPUT' });
  assert.throws(() => validateCollectorResponseV1({ ...delta(2, 1), upsertWindows: [
    { ...window('five-hour', 2), observed: true },
  ] }, scope()), { code: 'INVALID_INPUT' });
});

test('R13 fake and operator fixtures retain provenance and cannot become provider-reported', async () => {
  const fake = new FakeResourceCollectorV1(scope(), [full(), unavailable(2)]);
  const first = await fake.collect();
  first.snapshot.windows[0].source.kind = 'provider-observation';
  assert.equal((await fake.collect()).source, 'fake');
  await assert.rejects(() => fake.collect(), { code: 'MCP_UNAVAILABLE' });
  assert.throws(() => new FakeResourceCollectorV1(scope(), [full(1, [window('five-hour', 1, 'provider-observation')])]));
  assert.throws(() => new FakeResourceCollectorV1(scope('provider-reported'), []), { code: 'INVALID_INPUT' });
  const operator = new FakeResourceCollectorV1(scope('operator-configured'), [
    full(1, [window('five-hour', 1, 'configured')], 'operator-configured'),
  ]);
  const operatorResponse = await operator.collect();
  assert.equal(operatorResponse.source, 'operator-configured');
  assert.equal(operatorResponse.snapshot.windows[0].source.kind, 'configured');
  const projected = apply(null, operatorResponse, scope('operator-configured'));
  assert.equal(projected.kind, 'applied');
  assert.equal(projected.state.observationAdmitted, false);
  assert.throws(() => apply(null, operatorResponse, scope('provider-reported')), { code: 'INVALID_INPUT' });
});
