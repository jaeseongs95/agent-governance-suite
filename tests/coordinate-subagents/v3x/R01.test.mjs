import assert from 'node:assert/strict';
import { test } from 'vitest';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';

const validator = new ContractValidator();
const digest = `sha256:${'a'.repeat(64)}`;
const window = (windowId, resetEpoch) => ({
  windowId,
  resetEpoch,
  resetAt: '2026-09-24T00:00:00.000Z',
  revision: 1,
  limitBucket: { bucketId: 'shared-token-quota', kind: 'tokens', unit: 'token', limit: 1000, remaining: null },
  coverage: 'unknown',
  source: { kind: 'host-observation', evidenceDigest: digest },
  observedAt: '2026-09-23T00:00:00.000Z',
  expiresAt: '2026-09-23T00:05:00.000Z',
});
const snapshot = () => ({
  schemaVersion: '1.0.0',
  accountScope: `acct-hmac-sha256:${'b'.repeat(64)}`,
  resourcePoolId: 'shared-pool',
  accessPath: 'subscription',
  windows: [window('five-hour', 7), window('weekly', 2)],
});

test('one model can use two windows and distinct models can reference the same pool', () => {
  const observed = validator.resourceStateSnapshotV1(snapshot());
  const configuredBindings = [
    { model: 'model-a', resourcePoolId: observed.resourcePoolId },
    { model: 'model-b', resourcePoolId: observed.resourcePoolId },
  ];
  assert.equal(observed.windows.length, 2);
  assert.equal(configuredBindings[0].resourcePoolId, configuredBindings[1].resourcePoolId);
  assert.equal(observed.windows[0].limitBucket.remaining, null);
});

test('reset epoch and per-window revision can advance without collapsing pool identity', () => {
  const old = validator.resourceStateSnapshotV1(snapshot());
  const next = snapshot();
  next.windows[0].resetEpoch += 1;
  next.windows[0].revision += 1;
  assert.equal(validator.resourceStateSnapshotV1(next).resourcePoolId, old.resourcePoolId);
  assert.equal(next.windows[1].resetEpoch, old.windows[1].resetEpoch);
});

test('rejects raw account identifiers, secret fields, duplicate windows, and invalid freshness', () => {
  const raw = snapshot(); raw.accountScope = 'alice@example.com';
  assert.throws(() => validator.resourceStateSnapshotV1(raw));
  const secret = snapshot(); secret.accountToken = 'secret';
  assert.throws(() => validator.resourceStateSnapshotV1(secret));
  const duplicate = snapshot(); duplicate.windows[1].windowId = duplicate.windows[0].windowId;
  assert.throws(() => validator.resourceStateSnapshotV1(duplicate));
  const expired = snapshot(); expired.windows[0].expiresAt = expired.windows[0].observedAt;
  assert.throws(() => validator.resourceStateSnapshotV1(expired));
  const mixedUnit = snapshot(); mixedUnit.windows[0].limitBucket.unit = 'request';
  assert.throws(() => validator.resourceStateSnapshotV1(mixedUnit));
});
