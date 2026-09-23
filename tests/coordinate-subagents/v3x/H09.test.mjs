import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'vitest';
import { ClaudeUsageCollectorV1 } from '../../../mcp-server/src/resource/collectors/claude.ts';
import { FakeResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/fake.ts';
import { projectCollectorResponseV1 } from '../../../mcp-server/src/resource/collector-port.ts';

const accountScope = `acct-hmac-sha256:${'a'.repeat(64)}`;
const scope = (source = 'provider-reported') => ({ collectorId: 'claude-usage', source,
  accountScope, resourcePoolId: 'shared' });
const observedAt = () => new Date('2026-09-23T12:00:00.000Z');
const event = (usage = {}) => ({ type: 'assistant', message: {
  type: 'message', role: 'assistant', model: 'claude-opus-5-5',
  usage: { input_tokens: 8, output_tokens: 900,
    cache_read_input_tokens: 20, cache_creation_input_tokens: 30,
    cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 20 },
    ...usage } }, credential: 'private-secret' });
const collector = (reader, options = {}) => new ClaudeUsageCollectorV1({ scope: scope(), reader,
  now: observedAt, ...options });

test('H09 reads only exposed transcript usage, with unknown coverage and no quota conversion', async () => {
  const fixture = JSON.parse(readFileSync(new URL(
    '../../../mcp-server/src/native-adapters/claude/resource-compatibility.json', import.meta.url), 'utf8'));
  assert.equal(fixture.observedOpus55Sample.quotaWindowObserved, false);
  const subject = collector({ readLatestUsage: async () => event() });
  const response = await subject.collect();
  assert.equal(response.kind, 'unavailable');
  assert.equal(response.reason, 'not-exposed');
  assert.equal(response.source, 'provider-reported');
  assert.equal(response.snapshot, undefined);
  assert.deepEqual(subject.latestUsage, { source: 'claude-code-transcript', coverage: 'unknown',
    sequence: 1, observedAt: observedAt().toISOString(), inputTokens: 8,
    cacheReadInputTokens: 20, cacheCreationInputTokens: 30,
    cacheCreation5mInputTokens: 10, cacheCreation1hInputTokens: 20,
    outputTokens: null, quotaWindow: null });
  assert.ok(!JSON.stringify(response).includes('private-secret'));
  assert.ok(!JSON.stringify(subject.latestUsage).includes('private-secret'));
  assert.equal(projectCollectorResponseV1(subject.scope, null, response).state.observationAdmitted, false);
});

test('H09 leaves unavailable input/cache details unknown and never makes percentages from token counts', async () => {
  const subject = collector({ readLatestUsage: async () => event({
    cache_read_input_tokens: undefined, cache_creation_input_tokens: undefined,
    cache_creation: { ephemeral_5m_input_tokens: 10 },
  }) });
  const result = await subject.collect();
  assert.equal(result.kind, 'unavailable');
  assert.equal(subject.latestUsage.cacheReadInputTokens, null);
  assert.equal(subject.latestUsage.cacheCreationInputTokens, null);
  assert.equal(subject.latestUsage.cacheCreation5mInputTokens, 10);
  assert.equal(subject.latestUsage.cacheCreation1hInputTokens, null);
  assert.equal(subject.latestUsage.quotaWindow, null);
  assert.ok(!JSON.stringify(subject.latestUsage).includes('percent'));
});

test('H09 distinguishes missing observation, transport failure and operator-configured snapshots', async () => {
  const missing = collector({ readLatestUsage: async () => null });
  assert.equal((await missing.collect()).reason, 'not-exposed');
  assert.equal(missing.latestUsage, null);
  const broken = collector({ readLatestUsage: async () => { throw new Error('private-secret'); } });
  const unavailable = await broken.collect();
  assert.equal(unavailable.reason, 'temporarily-unavailable');
  assert.ok(!JSON.stringify(unavailable).includes('private-secret'));
  assert.throws(() => new ClaudeUsageCollectorV1({ scope: scope('operator-configured'),
    reader: { readLatestUsage: async () => event() } }), { code: 'INVALID_INPUT' });
  const operator = new FakeResourceCollectorV1(scope('operator-configured'), [{
    schemaVersion: '1.0.0', kind: 'unavailable', ...scope('operator-configured'),
    sequence: 1, reason: 'not-exposed',
  }]);
  assert.equal((await operator.collect()).source, 'operator-configured');
});

test('H09 rejects contradictory cache totals without exposing the raw event', async () => {
  const subject = collector({ readLatestUsage: async () => event({ cache_creation_input_tokens: 31 }) });
  await assert.rejects(() => subject.collect(), err => err.code === 'INVALID_INPUT'
    && !err.message.includes('private-secret'));
  assert.equal(subject.latestUsage, null);
});

test('H09 does not label a user or malformed event as Claude transcript usage', async () => {
  for (const sample of [
    { ...event(), type: 'user' },
    { ...event(), message: { ...event().message, role: 'user' } },
    { ...event(), message: { ...event().message, type: 'tool_result' } },
    { ...event(), message: { ...event().message, model: null } },
  ]) {
    const subject = collector({ readLatestUsage: async () => sample });
    const result = await subject.collect();
    assert.equal(result.kind, 'unavailable');
    assert.equal(subject.latestUsage, null);
  }
});

test('H09 resumes sequence only from the matching server projection', async () => {
  const reader = { readLatestUsage: async () => event() };
  const first = collector(reader);
  const initial = await first.collect();
  const previous = projectCollectorResponseV1(first.scope, null, initial).state;
  assert.throws(() => collector(reader, { resume: { ...previous, scope: {
    ...previous.scope, resourcePoolId: 'foreign' } } }), { code: 'INVALID_INPUT' });
  const restarted = collector(reader, { resume: previous });
  const next = await restarted.collect();
  assert.equal(next.sequence, 2);
  assert.equal(restarted.latestUsage.sequence, 2);
  assert.equal(projectCollectorResponseV1(restarted.scope, previous, next).kind, 'applied');
});
