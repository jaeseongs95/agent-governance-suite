import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { test } from 'vitest';

import { SqliteContinuityStore } from '../../../mcp-server/src/continuity-store.ts';
import { resolveResourceAuthorityConfig } from '../../../mcp-server/src/resource/authority-config.ts';
import { initializeResourceStoreSchema } from '../../../mcp-server/src/resource/store-schema.ts';
import { SqliteWorkflowStore } from '../../../mcp-server/src/sqlite-workflow-store.ts';

function isolated(run) {
  const root = mkdtempSync(path.join(tmpdir(), 'ags-resource-schema-'));
  const shared = path.join(root, 'shared');
  mkdirSync(shared);
  const config = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: shared }, process.platform, root);
  try { run(root, config); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

const version = db => db.prepare('PRAGMA user_version').get().user_version;
const tables = db => db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'resource_%' ORDER BY name").all().map(row => row.name);

test('B02 initializes an empty independent ledger and safely reopens the same schema', () => isolated((_root, config) => {
  let db = new DatabaseSync(config.databasePath);
  try {
    initializeResourceStoreSchema(db, config);
    assert.equal(version(db), 1);
    assert.deepEqual(tables(db), [
      'resource_admission_requests', 'resource_authority', 'resource_intents', 'resource_observations', 'resource_pools',
      'resource_reservation_holds', 'resource_reservations', 'resource_terminal_evidence',
      'resource_usage_coverage', 'resource_usage_events', 'resource_window_observations',
    ]);
    const marker = db.prepare('SELECT realm_id, authority_id, owner_mode FROM resource_authority').get();
    assert.equal(marker.realm_id, config.realmId);
    assert.equal(marker.authority_id, config.authorityId);
    assert.equal(marker.owner_mode, config.ownerMode);
    db.prepare('INSERT INTO resource_admission_requests VALUES (?,?,?,?,?,?,?)')
      .run('request-1', 'digest-1', 4, '{}', 'rejected', '{"reason":"capacity"}', null);
    db.prepare('INSERT INTO resource_pools VALUES (?,?,?)').run('account', 'pool-a', 'subscription');
    db.prepare('INSERT INTO resource_pools VALUES (?,?,?)').run('account', 'pool-b', 'subscription');
    db.prepare('INSERT INTO resource_observations VALUES (?,?,?,?,?,?,?)')
      .run('observation-a', 'account', 'pool-a', 'collector', 1, 'digest-a', '{}');
    assert.throws(() => db.prepare('INSERT INTO resource_window_observations VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run('account', 'pool-b', 'weekly', 'observation-a', 1, 1, 'bucket', 'request', 10, 'now', 'later'), /FOREIGN KEY/u);
    db.prepare('INSERT INTO resource_reservations VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('reservation-1', 'request-2', 'digest-2', 'task', 'run', 'slot', 'attempt', 4, 1, 'held', 'now', 'later');
    db.prepare('INSERT INTO resource_reservation_holds VALUES (?,?,?,?,?,?,?)')
      .run('reservation-1', 'account', 'pool-a', 'weekly', 1, 5, 'request');
    db.prepare('INSERT INTO resource_usage_coverage VALUES (?,?,?,?,?,?,?,?)')
      .run('reservation-1', 'account', 'pool-a', 'weekly', 'unknown', null, 'request', 'now');
    assert.equal(db.prepare('SELECT observed_amount FROM resource_usage_coverage').get().observed_amount, null);
    db.close();
    db = new DatabaseSync(config.databasePath);
    initializeResourceStoreSchema(db, config);
    assert.equal(version(db), 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM resource_authority').get().n, 1);
    assert.equal(db.prepare('SELECT state FROM resource_admission_requests WHERE request_key = ?').get('request-1').state, 'rejected');
    assert.throws(() => initializeResourceStoreSchema(db, { ...config, realmId: 'different' }), /mismatch/u);
    assert.equal(db.prepare('SELECT realm_id FROM resource_authority').get().realm_id, config.realmId);
  } finally { db.close(); }
}));

test('B02 refuses future and unrelated database versions without changing workflow or continuity state', () => isolated((root, config) => {
  const resource = new DatabaseSync(config.databasePath);
  try {
    initializeResourceStoreSchema(resource, config);
    resource.exec('PRAGMA user_version = 2;');
    assert.throws(() => initializeResourceStoreSchema(resource, config), /Unsupported/u);
    assert.equal(version(resource), 2);
    assert.equal(resource.prepare('SELECT COUNT(*) AS n FROM resource_authority').get().n, 1);
  } finally { resource.close(); }

  for (const [name, Store] of [['workflows', SqliteWorkflowStore], ['continuity', SqliteContinuityStore]]) {
    const file = path.join(root, `${name}.sqlite3`);
    const store = new Store(file);
    store.close();
    const before = readFileSync(file);
    const db = new DatabaseSync(file);
    try { assert.throws(() => initializeResourceStoreSchema(db, config), /not the configured database/u); }
    finally { db.close(); }
    assert.deepEqual(readFileSync(file), before, name);
  }
  const userDb = new DatabaseSync(path.join(root, 'user.sqlite3'));
  try {
    userDb.exec('CREATE TABLE user_data (value TEXT); INSERT INTO user_data VALUES (\'keep\');');
    assert.throws(() => initializeResourceStoreSchema(userDb, config), /not the configured database/u);
    assert.equal(userDb.prepare('SELECT value FROM user_data').get().value, 'keep');
    assert.equal(version(userDb), 0);
    assert.deepEqual(tables(userDb), []);
  } finally { userDb.close(); }
  const otherRoot = path.join(root, 'foreign');
  mkdirSync(otherRoot);
  const otherConfig = resolveResourceAuthorityConfig({ AGENT_GOVERNANCE_SHARED_STATE_DIR: otherRoot }, process.platform, root);
  const unrecognized = new DatabaseSync(otherConfig.databasePath);
  try {
    unrecognized.exec('CREATE TABLE user_data (value TEXT);');
    assert.throws(() => initializeResourceStoreSchema(unrecognized, otherConfig), /Unrecognized/u);
    assert.equal(version(unrecognized), 0);
    assert.equal(unrecognized.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'user_data'").get().n, 1);
  } finally { unrecognized.close(); }
}));

test('B02 interrupted schema creation rolls back all tables and the version marker', () => isolated((_root, config) => {
  const fixture = fileURLToPath(new URL('./fixtures/B02-crash.mjs', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture, JSON.stringify(config)],
    { cwd: path.dirname(fixture), encoding: 'utf8' });
  assert.equal(result.status, 71, result.stderr);
  const db = new DatabaseSync(config.databasePath);
  try {
    assert.equal(version(db), 0);
    assert.deepEqual(tables(db), []);
    initializeResourceStoreSchema(db, config);
    assert.equal(version(db), 1);
  } finally { db.close(); }
}));
