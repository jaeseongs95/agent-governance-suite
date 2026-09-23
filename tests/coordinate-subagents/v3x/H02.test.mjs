import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { CodexResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/codex.ts';
import { projectCollectorResponseV1 } from '../../../mcp-server/src/resource/collector-port.ts';

const accountId = 'private-account@example.test';
const hmacKey = new Uint8Array(32).fill(7);
const now = () => new Date('2026-09-23T12:00:00.000Z');
const nextReset = Date.parse('2026-09-24T00:00:00.000Z') / 1000;
const laterReset = Date.parse('2026-09-30T00:00:00.000Z') / 1000;
const bucket = (primary, secondary = null) => ({ primary, secondary });
const rate = (usedPercent, resetsAt = null) => ({ usedPercent, resetsAt, windowDurationMins: null });
const capture = () => ({ accountId,
  rateLimits: bucket(rate(99)),
  rateLimitsByLimitId: {
    codex: bucket(rate(22, nextReset), rate(68, laterReset)),
    images: bucket(rate(91)),
  },
  accessToken: 'secret-token',
});
function collector(reader, resume) {
  return new CodexResourceCollectorV1({ collectorId: 'codex', resourcePoolId: 'shared',
    accountId, hmacKey, reader, now, resume });
}

test('H02 keeps multiple buckets/windows with percent units, unknown coverage and pseudonymous account', async () => {
  const subject = collector({ readRateLimits: async () => capture() });
  const first = await subject.collect();
  assert.equal(first.kind, 'full');
  assert.equal(first.snapshot.windows.length, 3);
  assert.equal(new Set(first.snapshot.windows.map(w => w.limitBucket.bucketId)).size, 2);
  assert.deepEqual(first.snapshot.windows.map(w => w.limitBucket.remaining), [78, 32, 9]);
  assert.ok(first.snapshot.windows.every(w => w.limitBucket.kind === 'subscription-percent'
    && w.limitBucket.unit === 'percent' && w.coverage === 'unknown'
    && w.resetEpoch === 0 && w.revision === 1));
  assert.equal(first.snapshot.windows[0].resetAt, new Date(nextReset * 1000).toISOString());
  assert.equal(first.snapshot.windows[2].resetAt, null);
  assert.match(first.accountScope, /^acct-hmac-sha256:[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first).includes(accountId));
  assert.ok(!JSON.stringify(first).includes('secret-token'));
  const projected = projectCollectorResponseV1(subject.scope, null, first);
  assert.equal(projected.kind, 'applied');
  assert.equal(projected.state.observationAdmitted, false);
});

test('H02 refetches stale sparse notification and advances collector-owned sequence/revision', async () => {
  let used = 50;
  const subject = collector({ readRateLimits: async () => ({ ...capture(),
    rateLimitsByLimitId: { codex: bucket(rate(used)) } }) });
  const first = await subject.collect();
  used = 75;
  const second = await subject.onRateLimitsUpdated({ rateLimits: bucket(rate(5)),
    accountId: 'other-account', accessToken: 'secret-token' });
  assert.equal(second.sequence, 2);
  assert.equal(second.snapshot.windows[0].revision, 2);
  assert.equal(second.snapshot.windows[0].limitBucket.remaining, 25);
  assert.equal(projectCollectorResponseV1(subject.scope,
    projectCollectorResponseV1(subject.scope, null, first).state, second).kind, 'applied');
  assert.ok(!JSON.stringify(second).includes('secret-token'));
});

test('H02 rejects changed account, hides transport errors and exposes missing observations as unavailable', async () => {
  const changed = collector({ readRateLimits: async () => ({ ...capture(), accountId: 'foreign' }) });
  await assert.rejects(() => changed.collect(), err => err.code === 'INVALID_INPUT'
    && !err.message.includes('foreign'));
  const failed = collector({ readRateLimits: async () => { throw new Error('secret-token'); } });
  const unavailable = await failed.collect();
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unavailable.reason, 'temporarily-unavailable');
  assert.ok(!JSON.stringify(unavailable).includes('secret-token'));
  const absent = collector({ readRateLimits: async () => ({ ...capture(), accountId: null }) });
  assert.equal((await absent.collect()).reason, 'not-exposed');
});

test('H02 leaves out-of-range percentages unknown and never reports token/request quantities', async () => {
  const subject = collector({ readRateLimits: async () => ({ ...capture(),
    rateLimitsByLimitId: { codex: bucket(rate(120)) } }) });
  const result = await subject.collect();
  assert.equal(result.snapshot.windows[0].limitBucket.remaining, null);
  assert.equal(result.snapshot.windows[0].limitBucket.limit, 100);
  assert.equal(result.snapshot.windows[0].limitBucket.unit, 'percent');
});

test('H02 resumes server-owned sequence and per-window revision after collector restart', async () => {
  const reader = { readRateLimits: async () => capture() };
  const firstCollector = collector(reader);
  const first = await firstCollector.collect();
  const previous = projectCollectorResponseV1(firstCollector.scope, null, first).state;
  assert.throws(() => collector(reader, { ...previous, scope: { ...previous.scope,
    accountScope: `acct-hmac-sha256:${'f'.repeat(64)}` } }), { code: 'INVALID_INPUT' });
  const restarted = collector(reader, previous);
  const next = await restarted.collect();
  assert.equal(next.sequence, 2);
  assert.ok(next.snapshot.windows.every(w => w.revision === 2));
  assert.equal(projectCollectorResponseV1(restarted.scope, previous, next).kind, 'applied');
});

test('H02 maps the redacted H01-a captured shape without duplicating its legacy view', async () => {
  const fixture = JSON.parse(readFileSync(new URL(
    '../../../mcp-server/src/native-adapters/codex/resource-compatibility.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture.redactedReadCapture.windowPresence, { primary: true, secondary: false });
  const subject = collector({ readRateLimits: async () => ({ accountId,
    rateLimits: bucket(rate(80)), rateLimitsByLimitId: { codex: bucket(rate(20), null) } }) });
  const result = await subject.collect();
  assert.equal(result.snapshot.windows.length, fixture.redactedReadCapture.bucketCount);
  assert.equal(result.snapshot.windows[0].limitBucket.unit, 'percent');
  assert.equal(result.snapshot.windows[0].coverage, 'unknown');
  assert.equal(result.snapshot.windows[0].revision, 1);
  assert.equal(result.snapshot.windows[0].limitBucket.remaining, 80);
});

test('H02 expires before reset and fails closed when a read already contains a past reset', async () => {
  const soonReset = Date.parse('2026-09-23T12:01:00.000Z') / 1000;
  const soon = collector({ readRateLimits: async () => ({ ...capture(),
    rateLimitsByLimitId: { codex: bucket(rate(10, soonReset)) } }) });
  const result = await soon.collect();
  assert.equal(result.snapshot.windows[0].expiresAt, '2026-09-23T12:01:00.000Z');
  const past = collector({ readRateLimits: async () => ({ ...capture(),
    rateLimitsByLimitId: { codex: bucket(rate(10, soonReset - 120)) } }) });
  const unavailable = await past.collect();
  assert.equal(unavailable.kind, 'unavailable');
  assert.equal(unavailable.reason, 'temporarily-unavailable');
});
