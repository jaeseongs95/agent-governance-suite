import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'vitest';

import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { FakeResourceCollectorV1 } from '../../../mcp-server/src/resource/collectors/fake.ts';
import { ResourceObservationStore } from '../../../mcp-server/src/resource/observation-store.ts';

const accountScope = `acct-hmac-sha256:${'a'.repeat(64)}`;
const scope = { collectorId: 'collector-1', source: 'fake', accountScope, resourcePoolId: 'shared-pool' };
const window = (revision, remaining = 50) => ({
  windowId: 'weekly', resetEpoch: 1, resetAt: '2026-09-30T00:00:00.000Z', revision,
  limitBucket: { bucketId: 'requests', kind: 'requests', unit: 'request', limit: 100, remaining },
  coverage: 'partial', source: { kind: 'user-declared', evidenceDigest: null },
  observedAt: '2026-09-23T00:00:00.000Z', expiresAt: '2026-09-23T00:05:00.000Z',
});
const full = (sequence, revision, remaining = 50) => ({
  schemaVersion: '1.0.0', kind: 'full', ...scope, sequence,
  snapshot: { schemaVersion: '1.0.0', accountScope, resourcePoolId: scope.resourcePoolId,
    accessPath: 'subscription', windows: [window(revision, remaining)] },
});
const fake = responses => new FakeResourceCollectorV1(scope, responses);

async function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-b03-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  const databases = [];
  const open = collector => {
    const db = new DatabaseSync(config.databasePath);
    databases.push(db);
    return { db, store: new ResourceObservationStore(db, config, [collector]) };
  };
  try { await run(open); }
  finally {
    for (const db of databases) db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test('B03 two connections admit latest/older responses without replacing the latest window', async () => {
  for (const order of [[1, 2], [2, 1]]) await isolated(async open => {
    const ports = order.map(revision => fake([full(revision, revision, 80 - revision * 10)]));
    const connections = ports.map(port => open(port));
    const results = await Promise.all(connections.map(({ store }, index) => store.admit(ports[index])));
    assert.equal(results.some(result => result.kind === 'applied'), true);
    const db = connections[0].db;
    const current = db.prepare('SELECT revision, remaining FROM resource_window_observations').get();
    assert.equal(current.revision, 2);
    assert.equal(current.remaining, 60);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n,
      results.filter(result => result.kind === 'applied').length);
  });
});

test('B03 duplicate is idempotent, conflicting bytes fail, and raw model input or source spoofing is rejected', async () => {
  await isolated(async open => {
    const port = fake([full(1, 1), full(1, 1)]);
    const { db, store } = open(port);
    const first = await store.admit(port);
    assert.equal(first.kind, 'applied');
    assert.deepEqual(await store.admit(port), { kind: 'duplicate', observationId: first.observationId });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 1);
    assert.deepEqual(store.getObservation(first.observationId), full(1, 1));
    await assert.rejects(() => store.admit(full(3, 3)), { code: 'INVALID_INPUT' });
    const conflictPort = fake([full(1, 2)]);
    const conflicting = open(conflictPort).store;
    await assert.rejects(() => conflicting.admit(conflictPort), { code: 'SNAPSHOT_CONFLICT' });
    const forgedPort = { scope, collect: async () => ({ ...full(2, 2), source: 'provider-reported' }) };
    const forged = open(forgedPort).store;
    await assert.rejects(() => forged.admit(forgedPort), { code: 'INVALID_INPUT' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 1);
    db.prepare('UPDATE resource_observations SET payload_json = ? WHERE observation_id = ?')
      .run('{"tampered":true}', first.observationId);
    assert.throws(() => store.getObservation(first.observationId), { code: 'INVALID_INPUT' });
  });
});

test('B03 rejects duplicate window IDs in a full response before changing event or current state', async () => {
  await isolated(async open => {
    const duplicate = full(1, 2);
    duplicate.snapshot.windows.push(window(1, 99));
    const port = { scope, collect: async () => duplicate };
    const { db, store } = open(port);
    await assert.rejects(() => store.admit(port), { code: 'INVALID_INPUT' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_window_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_pools').get().n, 0);
  });
});

test('B03 observation event and current window write atomically; unavailable clears numeric capacity', async () => {
  await isolated(async open => {
    const unavailable = { schemaVersion: '1.0.0', kind: 'unavailable', ...scope, sequence: 2, reason: 'not-exposed' };
    const port = fake([full(1, 1), full(1, 1), unavailable]);
    const { db, store } = open(port);
    db.exec("CREATE TRIGGER reject_window BEFORE INSERT ON resource_window_observations BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    await assert.rejects(() => store.admit(port), /blocked/u);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_pools').get().n, 0);
    db.exec('DROP TRIGGER reject_window;');
    assert.equal((await store.admit(port)).kind, 'applied');
    const lost = await store.admit(port);
    assert.equal(lost.kind, 'applied');
    assert.deepEqual(store.getObservation(lost.observationId), unavailable);
    assert.equal(db.prepare('SELECT remaining FROM resource_window_observations').get().remaining, null);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_observations').get().n, 2);
  });
});
