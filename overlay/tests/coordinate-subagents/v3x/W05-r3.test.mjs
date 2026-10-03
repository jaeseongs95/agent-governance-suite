import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS,
  PRESENCE_RETENTION_MS, MESSAGE_SENDER_RECEIPT_LIMIT, MESSAGE_RECEIPT_LIMIT } from '../../../mcp-server/src/session-message-store.ts';
import { adaptHostInput } from '../../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, createWakeHookObservationReader,
  verifyHistoricalWakeObservation } from '../../../mcp-server/src/session-message-wake-port.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../../mcp-server/src/session-message-broker.ts';
import { TrustStore } from '../../../mcp-server/src/trust-store.ts';
import { ContractValidator } from '../../../mcp-server/src/schema-validator.ts';
import { DatabaseSync } from 'node:sqlite';
import { SessionModelCapabilityStore, capabilitySigner } from '../../../mcp-server/src/session-model-capabilities.ts';
import { capability } from '../model-routing-v2/fixtures.mjs';

const sender = { host: 'portable', sessionId: 'w05-r3-sender' };
const target = { host: 'portable', sessionId: 'w05-r3-target' };
const resources = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const f of resources.splice(0)) {
    for (const child of f.children) if (child.exitCode === null && child.signalCode === null) child.kill();
    f.store?.close();
    rmSync(f.directory, { recursive: true, force: true, maxRetries: 10 });
  }
});
const iso = ms => new Date(ms).toISOString();
const presence = instanceId => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
  canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' } });
function fixture(now = Date.now()) {
  const directory = mkdtempSync(join(tmpdir(), 'ags-w05-r3-'));
  const database = join(directory, 'messages.sqlite3');
  const trustPath = join(directory, 'trust.sqlite3');
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', trustPath);
  const store = new SessionMessageStore(database);
  const f = { directory, database, trustPath, store, now, children: [] };
  resources.push(f);
  store.startPresence(presence('birth-1'), now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
  return f;
}
function begin(f) {
  f.store.send({ sender, target, messageId: 'wake-body-0001', body: '기존 본문 😀', ttlSeconds: 86400 }, f.now);
  const reserved = f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable', relayId: 'relay-1',
    nonce: 'w05-r3-nonce-abcdefghijklmnop' }, f.now);
  assert.equal(reserved.dispatch, true);
  const started = f.store.startManagedWake(reserved.attempt, f.now + 1);
  assert.equal(started.dispatch, true);
  return started.attempt;
}
function observed(f, nonces, at) {
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: nonces.map(nonce => `[agent-governance-suite:wake:${nonce}]`).join('\n') }, target.host).observation;
  return { observation, sourceReceiptId: recordWakeHookObservation(observation, at) };
}
const row = (f, attempt) => f.store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(attempt.attemptId);
function snapshot(f) {
  return Object.fromEntries(['messages', 'session_presence', 'session_activity', 'input_observations']
    .map(table => [table, f.store.database.prepare(`SELECT * FROM ${table}`).all()]));
}
function receipt(f, owner = sender, at = f.now, ttlSeconds = 86400) {
  const draft = f.store.prepare({ sender: owner, target, body: 'receipt test', ttlSeconds }, at);
  return f.store.submitPrepared(owner, draft.messageId, at);
}
async function worker(f, input) {
  const child = fork(fileURLToPath(new URL('../../helpers/w05-r3-worker.mjs', import.meta.url)), [f.database],
    { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
  f.children.push(child);
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = once(child, 'exit');
  const [ready] = await once(child, 'message'); assert.equal(ready.ready, true);
  const result = input.loseReturn ? null : once(child, 'message');
  return { start: () => child.send(input), finish: async () => {
    const answer = result ? (await result)[0] : null;
    const [code] = await exited; assert.equal(code, 0, answer?.error ?? stderr);
    return answer?.result;
  } };
}

const schemaTable = 'ags_session_message_schema';
const tagWakeSchemas = JSON.parse(readFileSync(new URL('../../session-messaging/fixtures/w05-r3-tag-wake-schemas.json', import.meta.url), 'utf8'));
function databaseState(db) {
  const objects = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name').all();
  const tables = objects.filter(o => o.type === 'table');
  return { objects, userVersion: db.prepare('PRAGMA user_version').get().user_version,
    schemaVersion: db.prepare('PRAGMA schema_version').get().schema_version,
    rows: Object.fromEntries(tables.map(t => [t.name, db.prepare(`SELECT rowid AS rowid, * FROM "${t.name}" ORDER BY rowid`).all().map(r => ({ ...r }))])) };
}
function migrationFixture(legacy) {
  const f = fixture(); const attempt = begin(f);
  f.store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', f.now + 2);
  const sent = receipt(f);
  f.store.database.prepare('INSERT INTO task_outcomes VALUES (?, ?, ?, NULL, ?)')
    .run('migration-callback', '{"unchanged":"callback bytes"}', sent.messageId, iso(f.now));
  const signer = capabilitySigner('K'.repeat(43)), caps = new SessionModelCapabilityStore(f.store, signer);
  const publication = { schemaVersion: '1.0.0', identity: { ...target, instanceId: 'birth-1' },
    snapshot: capability({ sessionId: target.sessionId, instanceId: 'birth-1', observedAt: iso(f.now), expiresAt: iso(f.now + 60_000) }) };
  caps.publish(signer.issue('capability', publication, { issuedAt: iso(f.now), expiresAt: publication.snapshot.expiresAt }), f.now);
  f.store.database.exec(`DROP TABLE ${schemaTable}; PRAGMA user_version=17;`);
  if (legacy) {
    // Reconstruct the pre-r3 seven-state table, retaining all real rowids and binding columns.
    const sql = f.store.database.prepare("SELECT sql FROM sqlite_schema WHERE name='wake_nonces'").get().sql
      .replace(/,\s*'expired-unobserved'/u, '').replace(/,\s*retired_at TEXT/u, '');
    const columns = f.store.database.prepare('PRAGMA table_info(wake_nonces)').all().map(c => c.name).filter(n => n !== 'retired_at').join(',');
    f.store.database.exec(`ALTER TABLE wake_nonces RENAME TO wake_nonces_current;
      ${sql}; INSERT INTO wake_nonces(rowid,${columns}) SELECT rowid,${columns} FROM wake_nonces_current;
      DROP TABLE wake_nonces_current;
      CREATE UNIQUE INDEX wake_active_target ON wake_nonces(host,session_id) WHERE state IN ('reserved','started','submitted','unknown');`);
  }
  const before = databaseState(f.store.database);
  f.store.close(); f.store = null;
  return Object.assign(f, { attempt, sent, publication, before });
}
function assertMigrationRows(f, db) {
  const after = databaseState(db);
  assert.equal(after.userVersion, 17);
  for (const [table, rows] of Object.entries(f.before.rows)) {
    assert.deepEqual(after.rows[table], table === 'wake_nonces'
      ? rows.map(r => ({ ...r, retired_at: r.retired_at ?? null })) : rows);
  }
  assert.deepEqual(after.rows[schemaTable], [{ rowid: 1, singleton: 1, version: 1 }]);
}

test.each([false, true])('AC001 component migration preserves global version 17, rowids, callbacks and capability bytes (legacy=%s)', legacy => {
  const f = migrationFixture(legacy);
  f.store = new SessionMessageStore(f.database);
  assertMigrationRows(f, f.store.database);
  const once = databaseState(f.store.database);
  f.store.close(); f.store = new SessionMessageStore(f.database);
  assert.deepEqual(databaseState(f.store.database), once); // No repeat rebuild or schema/data write.
  const caps = new SessionModelCapabilityStore(f.store, capabilitySigner('K'.repeat(43)));
  assert.deepEqual(caps.list({}, f.now + 3).entries[0].snapshot, f.publication.snapshot);
  assert.equal(f.store.acknowledge(target, [f.sent.messageId], f.now + 4), 1);
  assert.equal(f.store.database.prepare('SELECT callback_acknowledged_at FROM task_outcomes').get().callback_acknowledged_at, iso(f.now + 4));
});

test.each(tagWakeSchemas.tags.map(schema => [schema.tag, schema]))(
  'AC001 %s original wake SQL preserves every old column, binding and rowid across migration and reopen', (_tag, schema) => {
    // Reproduce only the tag's wake SQL; unrelated 3.x application data is seeded by the existing fixture.
    const f = migrationFixture(false), db = new DatabaseSync(f.database);
    try {
      db.exec('DROP TABLE wake_nonces');
      for (const step of schema.steps) {
        assert.equal(createHash('sha256').update(step.sql).digest('hex'), step.sha256);
        db.exec(step.sql);
      }
      const columns = db.prepare('PRAGMA table_info(wake_nonces)').all().map(c => c.name);
      assert.deepEqual(columns, schema.columns);
      const insert = db.prepare(`INSERT INTO wake_nonces (rowid,${columns.join(',')}) VALUES (${Array(columns.length + 1).fill('?').join(',')})`);
      const consumed = { rowid: 211, nonce_digest: 'tag-consumed-digest', host: 'old-host', session_id: 'old-session',
        expires_at: iso(f.now + WAKE_TTL_MS), consumed_at: iso(f.now - 17), state: 'observed',
        nonce: 'tag-consumed-nonce-abcdefghijklmnop', instance_id: 'old-instance', birth_generation: iso(f.now - 90),
        transport: 'old-port', relay_id: 'old-relay', attempt_id: 'old-attempt', dispatch_epoch: 7,
        retry_not_before: iso(f.now + 60_000), retry_count: 2, started_at: iso(f.now - 80),
        outcome_at: iso(f.now - 60), observed_at: iso(f.now - 30), late_observed_at: iso(f.now - 10) };
      for (const old of [{ ...f.before.rows.wake_nonces[0], rowid: 107 }, consumed]) {
        insert.run(old.rowid, ...columns.map(column => old[column]));
      }
      f.before = databaseState(db);
    } finally { db.close(); }
    f.store = new SessionMessageStore(f.database);
    const after = databaseState(f.store.database);
    assert.equal(after.userVersion, 17);
    for (const [table, rows] of Object.entries(f.before.rows)) {
      assert.deepEqual(table === 'wake_nonces'
        ? after.rows[table].map(row => Object.fromEntries(Object.keys(rows[0]).map(key => [key, row[key]])))
        : after.rows[table], rows); // Includes host/session_id/consumed_at and every tag binding column, not just counts.
    }
    assert.deepEqual(after.rows.wake_nonces.map(row => row.rowid), [107, 211]);
    assert.deepEqual(after.rows[schemaTable], [{ rowid: 1, singleton: 1, version: 1 }]);
    assert.notEqual(after.objects.find(o => o.name === 'wake_nonces').sql,
      f.before.objects.find(o => o.name === 'wake_nonces').sql);
    assert.ok(after.objects.find(o => o.name === 'wake_nonces').sql.includes('expired-unobserved'));
    assert.ok(after.rows.wake_nonces.every(row => row.retired_at === null));
    if (!schema.columns.includes('state')) {
      assert.deepEqual(after.rows.wake_nonces.map(row => row.state), ['legacy', 'legacy']);
      assert.ok(after.rows.wake_nonces.every(row => row.observed_at === null));
    }
    f.store.close(); f.store = new SessionMessageStore(f.database);
    assert.deepEqual(databaseState(f.store.database), after); // Reopen must not rebuild or change any saved bytes.
    const caps = new SessionModelCapabilityStore(f.store, capabilitySigner('K'.repeat(43)));
    assert.deepEqual(caps.list({}, f.now + 3).entries[0].snapshot, f.publication.snapshot);
    assert.equal(f.store.acknowledge(target, [f.sent.messageId], f.now + 4), 1);
    assert.equal(f.store.database.prepare('SELECT callback_acknowledged_at FROM task_outcomes').get().callback_acknowledged_at, iso(f.now + 4));
  });

test.each(['future', 'unknown-wake', 'unknown-metadata', 'unknown-dependency'])(
  'AC001 %s component schema is rejected with zero schema/data effect', variant => {
    const f = migrationFixture(variant === 'unknown-dependency');
    const db = new DatabaseSync(f.database);
    try {
      if (variant === 'future') db.exec(`CREATE TABLE ${schemaTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), version INTEGER NOT NULL CHECK(version >= 1)) STRICT;
        INSERT INTO ${schemaTable} VALUES(1,2);`);
      if (variant === 'unknown-wake') db.exec('ALTER TABLE wake_nonces ADD COLUMN unsupported TEXT');
      if (variant === 'unknown-metadata') db.exec(`CREATE TABLE ${schemaTable} (version TEXT) STRICT;`);
      if (variant === 'unknown-dependency') db.exec('CREATE INDEX unknown_wake_index ON wake_nonces(nonce)');
      const before = databaseState(db);
      assert.throws(() => new SessionMessageStore(f.database), variant === 'future' ? /newer than/ : /Unsupported/);
      assert.deepEqual(databaseState(db), before);
    } finally { db.close(); }
  });

test('AC001 migration DDL, row copy and component marker roll back together', () => {
  const f = migrationFixture(true), db = new DatabaseSync(f.database), before = databaseState(db);
  const original = DatabaseSync.prototype.exec;
  const fail = vi.spyOn(DatabaseSync.prototype, 'exec').mockImplementation(function (sql) {
    if (sql.includes(`INSERT INTO ${schemaTable}`)) throw new Error('fixture-marker-failure');
    return original.call(this, sql);
  });
  try { assert.throws(() => new SessionMessageStore(f.database), /fixture-marker-failure/); }
  finally { fail.mockRestore(); }
  try { assert.deepEqual(databaseState(db), before); } finally { db.close(); }
  f.store = new SessionMessageStore(f.database);
  assertMigrationRows(f, f.store.database);
});

test('AC001 two independent processes recheck the component marker under the migration lock and rebuild once', async () => {
  const f = migrationFixture(true), gate = new DatabaseSync(f.database);
  let lockHeld = false;
  const script = `import { DatabaseSync } from 'node:sqlite';
    import { SessionMessageStore } from ${JSON.stringify(new URL('../../../mcp-server/src/session-message-store.ts', import.meta.url).href)};
    const original = DatabaseSync.prototype.exec; let rebuilds=0;
    DatabaseSync.prototype.exec=function(sql){
      if(sql==='BEGIN IMMEDIATE') process.send({type:'locking'});
      if(sql.includes('CREATE TABLE wake_nonces_next')) rebuilds++;
      return original.call(this,sql);
    };
    process.send({type:'ready'});
    process.once('message',()=>{try { const store=new SessionMessageStore(process.argv[1]);
      const version=store.database.prepare('SELECT version FROM ${schemaTable}').get().version;
      store.close();process.send({type:'done',version,rebuilds},()=>process.exit(0));
    }catch(error){process.send({type:'error',error:error.message},()=>process.exit(1));}});`;
  const workers = [0, 1].map(() => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script, f.database],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    f.children.push(child);
    const messages = { ready: null, locking: null, done: null };
    const pending = Object.fromEntries(Object.keys(messages).map(key => [key, {}]));
    for (const key of Object.keys(messages)) {
      messages[key] = new Promise((resolve, reject) => { pending[key] = { resolve, reject }; });
      messages[key].catch(() => {}); // The matching stage below still awaits and reports this rejection.
    }
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', msg => {
      if (msg.type === 'error') Object.values(pending).forEach(p => p.reject(new Error(msg.error)));
      else pending[msg.type]?.resolve(msg);
    });
    const exit = once(child, 'exit').then(([code]) => {
      if (code !== 0) {
        const error = new Error(`migration child ${code}: ${stderr}`);
        Object.values(pending).forEach(p => p.reject(error));
        throw error;
      }
    });
    exit.catch(() => {});
    return { child, ...messages, exit };
  });
  try {
    await Promise.all(workers.map(w => w.ready));
    gate.exec('BEGIN IMMEDIATE');
    lockHeld = true;
    const locked = Promise.all(workers.map(w => w.locking));
    workers.forEach(w => w.child.send('go'));
    await locked; // Both have read the old shape before contending on the held write lock.
    gate.exec('COMMIT');
    lockHeld = false;
    const results = await Promise.all(workers.map(w => w.done));
    await Promise.all(workers.map(w => w.exit));
    assert.deepEqual(results.map(r => r.version), [1, 1]);
    assert.equal(results.reduce((n, r) => n + r.rebuilds, 0), 1);
    assertMigrationRows(f, gate);
  } finally { if (lockHeld) gate.exec('ROLLBACK'); gate.close(); }
}, 20_000);

test('AC001/003 wake activity never creates trusted task/contact activity', () => {
  const f = fixture();
  f.store.observeNativeInput(target, f.now + 1);
  f.store.claimTurnEnd(target, f.now + 2);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_activity').get().n, 1);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM session_activity').get().n, 0);
  assert.equal(f.store.activityStatus(target, f.now + 3).activity, 'unknown');
});

test.each(['submitted', 'accepted-or-unknown'])('AC003 no arrival preserves %s inside grace; retirement preserves bytes and unknown', outcome => {
  const f = fixture(); const attempt = begin(f);
  f.store.recordManagedWakeOutcome(attempt, outcome, f.now + 2);
  const original = row(f, attempt); const before = snapshot(f);
  f.store.prune(f.now + WAKE_TTL_MS + 4);
  assert.deepEqual(row(f, attempt), original);
  f.store.prune(f.now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS);
  const retired = row(f, attempt);
  assert.equal(retired.state, 'expired-unobserved');
  for (const key of ['nonce', 'nonce_digest', 'instance_id', 'birth_generation', 'dispatch_epoch', 'started_at', 'expires_at']) {
    assert.equal(retired[key], original[key]);
  }
  assert.equal(f.store.managedWakeStatus(target, f.now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS).deliveryState, 'unknown');
  assert.deepEqual(snapshot(f), before);
});

test('AC003 live quiet birth stays latched; expiry activity retires only after ten minutes', () => {
  const f = fixture(); const attempt = begin(f);
  const at = f.now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS;
  f.store.database.prepare('UPDATE session_presence SET lease_until = ?').run(iso(at + 60_000));
  f.store.prune(at);
  assert.equal(row(f, attempt).state, 'started');
  f.store.observeNativeInput(target, at + 1);
  f.store.prune(at + 2);
  assert.equal(row(f, attempt).state, 'expired-unobserved');
});

test.each(['ended', 'unreachable', 'missing', 'transport', 'capability', 'ended-during-verification'])(
  'AC008 verified unexpired %s without a replaced birth keeps the unknown fence', variant => {
    const f = fixture(); const attempt = begin(f); const original = row(f, attempt); const at = f.now + 4;
    const proof = observed(f, [attempt.nonce], f.now + 2);
    if (variant === 'ended') f.store.endPresence(target, 'fixture', 'birth-1', at);
    if (variant === 'unreachable') f.store.database.prepare('UPDATE session_presence SET lease_until=?').run(iso(at));
    if (variant === 'missing') f.store.database.prepare('DELETE FROM session_presence').run();
    if (variant === 'transport') f.store.database.prepare('UPDATE session_presence SET transport=?').run('other-port');
    if (variant === 'capability') f.store.database.prepare('UPDATE session_presence SET supported_injection=?')
      .run(JSON.stringify(['tool-boundary']));
    const reader = createWakeHookObservationReader(f.trustPath);
    const guardedReader = { verifyObservation: (...args) => {
      if (variant === 'ended-during-verification') f.store.endPresence(target, 'fixture', 'birth-1', at);
      return reader.verifyObservation(...args);
    } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
    try {
      assert.deepEqual(dispatch(f.store, 'claim-host-wake', { target, ...proof }, undefined, undefined, undefined, guardedReader),
        { recognized: false, messages: [], managed: false });
    } finally { clock.mockRestore(); }
    const current = row(f, attempt);
    assert.equal(current.state, 'unknown'); assert.ok(current.late_observed_at);
    assert.equal(current.consumed_at, null); assert.equal(current.observed_at, null);
    for (const key of ['nonce', 'nonce_digest', 'instance_id', 'birth_generation', 'dispatch_epoch', 'started_at', 'expires_at']) {
      assert.equal(current[key], original[key]);
    }
    assert.equal(f.store.pendingCount(target, at), 1);
    assert.equal(f.store.managedWakeStatus(target, at).observation, 'unknown');
    if (variant === 'transport' || variant === 'capability') {
      // Restore eligibility without creating a different birth. The unknown fence must do the blocking.
      const restored = f.store.startPresence(presence('birth-1'), at + 1);
      assert.equal(restored.startedAt, original.birth_generation);
      assert.equal(restored.state, 'online');
      assert.equal(restored.transport, 'portable');
      assert.ok(restored.deliveryCapabilities.supportedInjection.includes('peer-wake'));
      assert.equal(f.store.liveRelay(target, 'portable', at + 1).relayId, 'relay-1');
      f.store.send({ sender, target, messageId: 'fence-new-body-0001', body: '추가 본문', ttlSeconds: 86400 }, at + 1);
      assert.equal(f.store.pendingCount(target, at + 1), 2);
    }
    assert.equal(f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable', relayId: 'relay-1',
      nonce: 'w05-r3-retry-abcdefghijklmnop' }, at + 1).dispatch, false);
    if (variant === 'transport' || variant === 'capability') {
      assert.deepEqual(row(f, attempt), current);
      assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM wake_nonces').get().n, 1);
      // Removing only the unknown row demonstrates that all other admission conditions now permit dispatch.
      f.store.database.prepare('DELETE FROM wake_nonces WHERE attempt_id=?').run(attempt.attemptId);
      assert.equal(f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable', relayId: 'relay-1',
        nonce: 'w05-r3-control-abcdefghijklmnop' }, at + 2).dispatch, true);
    }
  });

test.each(['transport', 'capability'])(
  'AC008 one signed receipt claims exactly once after the same birth recovers %s eligibility', variant => {
    const f = fixture(), attempt = begin(f), original = row(f, attempt);
    const proof = observed(f, [attempt.nonce], f.now + 2), reader = createWakeHookObservationReader(f.trustPath);
    const trust = new TrustStore(f.trustPath);
    let signedReceipt;
    try {
      signedReceipt = trust.getInputSource(proof.sourceReceiptId);
      assert.equal(trust.verify(signedReceipt), true);
      assert.equal(signedReceipt.authorityEffect, 'none');
      assert.equal(signedReceipt.expiresAt, iso(f.now + 30_002));
    } finally { trust.close(); }
    if (variant === 'transport') f.store.database.prepare('UPDATE session_presence SET transport=?').run('other-port');
    else f.store.database.prepare('UPDATE session_presence SET supported_injection=?').run(JSON.stringify(['tool-boundary']));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.now + 4);
    const claim = () => dispatch(f.store, 'claim-host-wake', { target, ...proof }, undefined, undefined, undefined, reader);
    try {
      assert.deepEqual(claim(), { recognized: false, messages: [], managed: false });
      const unknown = row(f, attempt);
      assert.equal(unknown.state, 'unknown');
      assert.equal(unknown.consumed_at, null); assert.equal(unknown.observed_at, null);
      for (const key of ['nonce', 'nonce_digest', 'instance_id', 'birth_generation', 'dispatch_epoch', 'expires_at']) {
        assert.equal(unknown[key], original[key]);
      }
      assert.equal(f.store.pendingCount(target, f.now + 4), 1);
      const restored = f.store.startPresence(presence('birth-1'), f.now + 5);
      assert.equal(restored.instanceId, original.instance_id); assert.equal(restored.startedAt, original.birth_generation);
      assert.equal(restored.transport, 'portable'); assert.equal(restored.state, 'online');
      assert.ok(restored.deliveryCapabilities.supportedInjection.includes('peer-wake'));
      assert.equal(f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable', relayId: 'relay-1',
        nonce: 'w05-r3-recovery-fence-abcdefghijklmnop' }, f.now + 5).dispatch, false);
      assert.deepEqual(row(f, attempt), unknown); // Recovery alone must not consume the nonce or permit a new dispatch.
      clock.mockReturnValue(f.now + 6);
      assert.ok(f.now + 6 < Date.parse(signedReceipt.expiresAt));
      const recovered = claim(); // Exactly the original observation and sourceReceiptId, with its real signature.
      assert.equal(recovered.recognized, true); assert.equal(recovered.managed, true);
      assert.deepEqual(recovered.messages.map(message => ({ messageId: message.messageId, body: message.body })),
        [{ messageId: 'wake-body-0001', body: '기존 본문 😀' }]);
      const consumed = row(f, attempt);
      assert.equal(consumed.state, 'observed');
      assert.equal(consumed.consumed_at, iso(f.now + 6)); assert.equal(consumed.observed_at, iso(f.now + 6));
      clock.mockReturnValue(f.now + 7);
      assert.deepEqual(claim(), { recognized: false, messages: [], managed: false });
      assert.deepEqual(row(f, attempt), consumed);
      assert.equal(f.store.database.prepare('SELECT delivery_attempts FROM messages WHERE message_id=?').get('wake-body-0001').delivery_attempts, 1);
      assert.equal(f.store.pendingCount(target, f.now + 7), 0);
      const reopenedTrust = new TrustStore(f.trustPath);
      try { assert.deepEqual(reopenedTrust.getInputSource(proof.sourceReceiptId), signedReceipt); }
      finally { reopenedTrust.close(); }
    } finally { clock.mockRestore(); }
  });

test.each(['expired-same-birth', 'new-instance', 'same-instance-new-birth'])(
  'AC008 verified %s is terminal-only with no body claim', variant => {
    const f = fixture(); const attempt = begin(f);
    const at = variant === 'expired-same-birth' ? f.now + WAKE_TTL_MS + 1 : f.now + 4;
    if (variant === 'expired-same-birth') f.store.database.prepare('UPDATE session_presence SET lease_until=?')
      .run(iso(at + 60_000));
    else {
      f.store.endPresence(target, 'fixture', 'birth-1', at);
      f.store.startPresence(presence(variant === 'new-instance' ? 'birth-2' : 'birth-1'), at + 1);
    }
    const proof = observed(f, [attempt.nonce], at + 2);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(at + 3);
    try {
      assert.deepEqual(dispatch(f.store, 'claim-host-wake', { target, ...proof }, undefined, undefined, undefined,
        createWakeHookObservationReader(f.trustPath)), { recognized: false, messages: [], managed: false });
    } finally { clock.mockRestore(); }
    const current = row(f, attempt);
    assert.equal(current.state, 'observed'); assert.ok(current.late_observed_at);
    assert.ok(current.consumed_at); assert.ok(current.observed_at);
    assert.equal(f.store.pendingCount(target, at + 3), 1);
  });

test('AC008 independent process birth mutation is fenced during verification, then allowed after the claim commits', () => {
  const f = fixture(); const attempt = begin(f), at = f.now + 4;
  const proof = observed(f, [attempt.nonce], at - 1);
  const script = `import { DatabaseSync } from 'node:sqlite';
    const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=1');
    try { db.prepare('UPDATE session_presence SET ended_at=? WHERE host=? AND session_id=? AND instance_id=?')
      .run(process.argv[2],${JSON.stringify(target.host)},${JSON.stringify(target.sessionId)},'birth-1');
      console.log(JSON.stringify({blocked:false}));
    } catch(error) { if(!/locked|busy/i.test(error.message)) throw error; console.log(JSON.stringify({blocked:true})); }
    finally { db.close(); }`;
  const endFromAnotherProcess = () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script, f.database, iso(at)],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.equal(child.status, 0, child.error?.message ?? child.stderr);
    return JSON.parse(child.stdout);
  };
  const reader = createWakeHookObservationReader(f.trustPath);
  const guardedReader = { verifyObservation: (...args) => {
    assert.deepEqual(endFromAnotherProcess(), { blocked: true });
    return reader.verifyObservation(...args);
  } };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const result = dispatch(f.store, 'claim-host-wake', { target, ...proof }, undefined, undefined, undefined, guardedReader);
    assert.equal(result.recognized, true); assert.equal(result.managed, true);
    assert.equal(result.messages.length, 1); assert.equal(result.messages[0].body, '기존 본문 😀');
  } finally { clock.mockRestore(); }
  assert.equal(row(f, attempt).state, 'observed');
  assert.deepEqual(endFromAnotherProcess(), { blocked: false });
  assert.equal(f.store.presence(target, at).state, 'ended');
}, 15_000);

test('AC002/008 verified expired arrival is terminal-only; retired + valid current still claims', () => {
  const f = fixture(); const old = begin(f);
  let at = f.now + WAKE_TTL_MS + 1;
  f.store.startPresence(presence('birth-2'), at);
  const proof = observed(f, [old.nonce], at + 1);
  const result = f.store.claimHostWake(target, proof.observation, proof.sourceReceiptId,
    createWakeHookObservationReader(f.trustPath), at + 2);
  assert.equal(result.recognized, false); assert.deepEqual(result.messages, []);
  assert.equal(row(f, old).state, 'observed'); assert.equal(f.store.pendingCount(target, at + 2), 1);
  // A distinct old attempt already retired cannot be promoted by a late marker.
  f.store.database.prepare("UPDATE wake_nonces SET state='expired-unobserved', observed_at=NULL, consumed_at=NULL, retired_at=?").run(iso(at));
  f.store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-2', pid: process.pid, parentPid: process.pid }, at + 3);
  const next = f.store.reserveManagedWake({ ...target, instanceId: 'birth-2', transport: 'portable', relayId: 'relay-2',
    nonce: 'w05-r3-current-abcdefghijklmnop' }, at + 4);
  const started = f.store.startManagedWake(next.attempt, at + 5).attempt;
  const mixed = observed(f, [old.nonce, started.nonce], at + 6);
  const claim = f.store.claimHostWake(target, mixed.observation, mixed.sourceReceiptId,
    createWakeHookObservationReader(f.trustPath), at + 7);
  assert.equal(claim.recognized, true); assert.equal(claim.messages[0].body, '기존 본문 😀');
  assert.equal(row(f, old).state, 'expired-unobserved'); assert.ok(row(f, old).late_observed_at);
  assert.equal(row(f, old).observed_at, null);
});

function history() {
  const f = fixture(Date.now() - 60_000); const attempt = begin(f);
  f.store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', f.now + 2);
  f.store.startPresence(presence('birth-2'), f.now + 5);
  const proof = observed(f, [attempt.nonce], f.now + 10);
  f.store.database.prepare('UPDATE wake_nonces SET late_observed_at=?').run(iso(f.now + 11));
  return { ...f, attempt, ...proof };
}
test.each(['signature', 'other-db', 'schema', 'digest', 'adapter', 'capability', 'receipt-target', 'future-observed', 'target', 'current', 'time'])('AC002 history rejects %s without body/effect mutation', variant => {
  const f = history(); const trust = new TrustStore(f.trustPath);
  try {
    const r = trust.getInputSource(f.sourceReceiptId);
    if (variant === 'signature') {
      r.integrityToken = 'forged';
      trust.database.prepare('UPDATE input_source_receipts SET receipt_json=? WHERE receipt_id=?').run(JSON.stringify(r), f.sourceReceiptId);
    }
    if (['digest', 'adapter', 'capability', 'receipt-target', 'future-observed'].includes(variant)) {
      const input = { ...r };
      delete input.schemaVersion; delete input.receiptId; delete input.integrityToken;
      input.eventId = `${input.eventId}-${variant}`;
      if (variant === 'digest') input.contentDigest = `sha256:${'a'.repeat(64)}`;
      if (variant === 'adapter') input.attestation.adapter = 'another-adapter';
      if (variant === 'capability') input.attestation.capabilityVersion = '9.0.0';
      if (variant === 'receipt-target') input.sessionId = 'another-session';
      if (variant === 'future-observed') input.observedAt = iso(f.now + 20);
      f.sourceReceiptId = trust.recordInputSource(input).receiptId;
    }
    if (variant === 'schema') trust.database.exec('PRAGMA user_version=99');
  } finally { trust.close(); }
  if (variant === 'current') f.store.database.prepare("DELETE FROM session_presence WHERE instance_id='birth-2'").run();
  const before = snapshot(f), old = row(f, f.attempt), bytes = readFileSync(f.trustPath);
  const selected = variant === 'other-db' ? join(f.directory, 'missing-trust.sqlite3') : f.trustPath;
  const result = f.store.reconcileHistoricalWake(variant === 'target' ? { ...target, sessionId: 'elsewhere' } : target,
    f.attempt.attemptId, f.sourceReceiptId, variant === 'time' ? f.now : Date.now(),
    (...args) => verifyHistoricalWakeObservation(...args, selected));
  assert.equal(result.reconciled, false); assert.deepEqual(snapshot(f), before); assert.deepEqual(row(f, f.attempt), old);
  assert.deepEqual(readFileSync(f.trustPath), bytes);
});

test('AC002 history has one terminal CAS across independent processes, with no body claim', async () => {
  const f = history(); const before = snapshot(f);
  const input = { operation: 'history', target, attemptId: f.attempt.attemptId, sourceReceiptId: f.sourceReceiptId,
    now: Date.now(), trustPath: f.trustPath };
  const workers = await Promise.all([worker(f, input), worker(f, input)]);
  workers.forEach(w => w.start());
  const results = await Promise.all(workers.map(w => w.finish()));
  assert.equal(results.filter(r => r.reconciled).length, 1);
  assert.equal(row(f, f.attempt).state, 'observed'); assert.deepEqual(snapshot(f), before);
}, 20_000);

test('AC004 quota admission, duplicate priority and first ACK retention do not block another sender', () => {
  const f = fixture(); const sent = [];
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 1; i++) sent.push(receipt(f, sender, f.now + i));
  const pending = f.store.prepare({ sender, target, body: 'will reject' }, f.now + 300);
  sent.push(receipt(f, sender, f.now + 301));
  const before = f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n;
  assert.throws(() => f.store.submitPrepared(sender, pending.messageId, f.now + 302), error =>
    error.details.scope === 'sender' && error.details.earliestReleaseAt === iso(f.now + 86400_000 + 3600_000));
  assert.equal(f.store.status(sender, pending.messageId, f.now + 303).state, 'prepared');
  assert.throws(() => f.store.prepare({ sender, target, body: 'no draft' }, f.now + 304), /no draft was created/);
  assert.equal(f.store.submitPrepared(sender, sent[0].messageId, f.now + 305).duplicate, true);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n, before);
  receipt(f, { ...sender, sessionId: 'other-sender' }, f.now + 306);
  const id = sent[0].messageId;
  f.store.acknowledge(target, [id], f.now + 400);
  const expires = f.store.database.prepare('SELECT expires_at FROM prepared_messages WHERE message_id=?').get(id).expires_at;
  assert.equal(expires, iso(f.now + 400 + 3600_000));
  assert.equal(f.store.acknowledge(target, [id], f.now + 500), 0);
  assert.equal(f.store.database.prepare('SELECT expires_at FROM prepared_messages WHERE message_id=?').get(id).expires_at, expires);
  assert.equal(f.store.status(sender, id, f.now + 400 + 3600_000), null);
  assert.throws(() => f.store.submitPrepared(sender, id, f.now + 400 + 3600_000), /Issued message ID/);
  const releasedAt = f.now + 400 + 3600_000;
  // earliestReleaseAt is after this draft's TTL: retire that ID and prepare once after the slot is released.
  assert.throws(() => f.store.submitPrepared(sender, pending.messageId, releasedAt), /Issued message ID/);
  const resumed = f.store.prepare({ sender, target, body: 'fresh after earliest release' }, releasedAt);
  assert.equal(f.store.submitPrepared(sender, resumed.messageId, releasedAt).duplicate, false);
});

test('AC004 global pool rejects atomically and reports its earliest release', () => {
  const f = fixture(); const reserved = f.store.prepare({ sender, target, body: 'global reject' }, f.now);
  for (let i = 0; i < MESSAGE_RECEIPT_LIMIT; i++) receipt(f, { ...sender, sessionId: `owner-${i % 4}` }, f.now + i);
  assert.throws(() => f.store.submitPrepared(sender, reserved.messageId, f.now + 1001), error => error.details.scope === 'global');
  assert.throws(() => f.store.prepare({ sender, target, body: 'no draft' }, f.now + 1002), error => error.details.scope === 'global');
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n, MESSAGE_RECEIPT_LIMIT);
});

test('AC004 receipt ACK and send updates roll back atomically', () => {
  const f = fixture(); const sent = receipt(f);
  const before = f.store.database.prepare('SELECT * FROM prepared_messages').all();
  f.store.database.exec("CREATE TRIGGER receipt_failure BEFORE UPDATE ON prepared_messages BEGIN SELECT RAISE(ABORT, 'fixture-rollback'); END");
  assert.throws(() => f.store.acknowledge(target, [sent.messageId], f.now + 1), /fixture-rollback/);
  assert.equal(f.store.status(sender, sent.messageId, f.now + 2).state, 'queued');
  assert.deepEqual(f.store.database.prepare('SELECT * FROM prepared_messages').all(), before);
  f.store.database.exec('DROP TRIGGER receipt_failure');
  const draft = f.store.prepare({ sender, target, body: 'send rollback' }, f.now + 3);
  f.store.database.exec("CREATE TRIGGER send_failure BEFORE UPDATE ON prepared_messages BEGIN SELECT RAISE(ABORT, 'fixture-send'); END");
  assert.throws(() => f.store.submitPrepared(sender, draft.messageId, f.now + 4), /fixture-send/);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  assert.equal(f.store.status(sender, draft.messageId, f.now + 5).state, 'prepared');
});

test('AC001 callback ACK remains in the same receipt/message transaction', () => {
  const f = fixture(); const sent = receipt(f);
  f.store.database.prepare('INSERT INTO task_outcomes VALUES (?, ?, ?, NULL, ?)')
    .run('callback-fixture', '{}', sent.messageId, iso(f.now));
  f.store.database.exec("CREATE TRIGGER callback_failure BEFORE UPDATE ON task_outcomes BEGIN SELECT RAISE(ABORT, 'callback-rollback'); END");
  assert.throws(() => f.store.acknowledge(target, [sent.messageId], f.now + 1), /callback-rollback/);
  assert.equal(f.store.status(sender, sent.messageId, f.now + 2).state, 'queued');
  assert.equal(f.store.database.prepare('SELECT callback_acknowledged_at FROM task_outcomes').get().callback_acknowledged_at, null);
  f.store.database.exec('DROP TRIGGER callback_failure');
  assert.equal(f.store.acknowledge(target, [sent.messageId], f.now + 3), 1);
  assert.equal(f.store.database.prepare('SELECT callback_acknowledged_at FROM task_outcomes').get().callback_acknowledged_at, iso(f.now + 3));
});

test('AC004 independent send race and committed lost return reuse exactly the same ID', async () => {
  const f = fixture(); const draft = f.store.prepare({ sender, target, body: 'race body' }, f.now);
  const input = { operation: 'send', sender, messageId: draft.messageId, now: f.now + 1 };
  const workers = await Promise.all([worker(f, input), worker(f, input)]);
  workers.forEach(w => w.start());
  const answers = await Promise.all(workers.map(w => w.finish()));
  assert.equal(answers.filter(r => !r.duplicate).length, 1);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 1);
  const lost = f.store.prepare({ sender, target, body: 'lost return' }, f.now + 2);
  const w = await worker(f, { ...input, messageId: lost.messageId, now: f.now + 3, loseReturn: true });
  w.start(); await w.finish();
  assert.equal(f.store.submitPrepared(sender, lost.messageId, f.now + 4).duplicate, true);
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
}, 20_000);

test('AC005 advisory is non-authorizing, and presence retention does not surface an older birth', () => {
  const f = fixture(); const validator = new ContractValidator();
  const outlook = f.store.autoWakeOutlook(target, f.now);
  assert.equal(validator.sessionAutoWakeOutlook(outlook).authorityEffect, 'none');
  assert.throws(() => validator.sessionAutoWakeOutlook({ ...outlook, authorityEffect: 'approval-source' }));
  const at = f.now + PRESENCE_RETENTION_MS + 60_000;
  f.store.startPresence(presence('birth-2'), f.now + 10);
  f.store.database.prepare('UPDATE session_presence SET lease_until=? WHERE instance_id=?').run(iso(at + 1000), 'birth-1');
  f.store.prune(at);
  assert.equal(f.store.presence(target, at).instanceId, 'birth-2');
  assert.equal(f.store.listPresence([target], at)[0].autoWake.authorityEffect, 'none');
});

test('AC002 broker rejects added historical authority, time and observation payloads', () => {
  const f = history();
  for (const field of ['approved', 'nowMs', 'observation', 'nonce']) {
    assert.throws(() => dispatch(f.store, 'reconcile-wake-observation', {
      target, attemptId: f.attempt.attemptId, sourceReceiptId: f.sourceReceiptId, [field]: true }), /unsupported/);
  }
});

// Independent wire oracle: deliberately does not call the production serializer or size helper.
const successBytes = data => Buffer.byteLength(JSON.stringify({ ok: true, data }) + '\n', 'utf8');
function fullFrameBatch(f, bytes, fields, at) {
  const messages = Array.from({ length: 8 }, (_, i) => ({ messageId: 'f1-frame-' + String(i).padStart(4, '0'),
    sender, recipient: target, body: '한😀"\\\n'.repeat(20), createdAt: iso(f.now + i),
    expiresAt: iso(f.now + i + 86400_000), deliveryAttempt: 1, firstDeliveredAt: iso(at) }));
  let remaining = bytes - successBytes({ ...fields, messages });
  assert.ok(remaining >= 0);
  for (const message of messages) {
    const added = Math.min(remaining, 4096 - Buffer.byteLength(message.body, 'utf8'));
    message.body += 'x'.repeat(added); remaining -= added;
    assert.ok(Buffer.byteLength(message.body, 'utf8') <= 4096);
  }
  assert.equal(remaining, 0); assert.equal(messages.length <= 10, true);
  assert.equal(successBytes({ ...fields, messages }), bytes);
  for (const [i, message] of messages.entries()) f.store.send({ sender, target,
    messageId: message.messageId, body: message.body, ttlSeconds: 86400 }, f.now + i);
  return messages;
}
function fullFrameClaim(f, operation, limits = {}) {
  const nonce = 'f1-frame-nonce-abcdefghijklmnop';
  if (operation.includes('wake')) {
    if (operation === 'host-managed-wake') {
      const reserved = f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable',
        relayId: 'relay-1', nonce }, f.now + 20);
      assert.equal(reserved.dispatch, true);
      const started = f.store.startManagedWake(reserved.attempt, f.now + 21);
      assert.equal(started.dispatch, true);
      assert.equal(f.store.recordManagedWakeOutcome(started.attempt, 'accepted-or-unknown', f.now + 22), true);
    } else assert.equal(f.store.reserveWake(target, nonce, f.now + 20), true);
  }
  const at = f.now + 100;
  const proof = operation.startsWith('host-') ? observed(f, [nonce], at) : null;
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  const payload = { target, ...limits, ...(proof ?? {}), ...(operation === 'claim-wake' ? { nonces: [nonce] } : {}) };
  return { at, run: () => dispatch(f.store, operation.startsWith('host-') ? 'claim-host-wake' : operation,
    payload, undefined, undefined, undefined, createWakeHookObservationReader(f.trustPath)),
    close: () => clock.mockRestore() };
}
function fullFrameState(f) {
  return Object.fromEntries(['messages', 'wake_nonces', 'input_observations', 'wake_activity']
    .map(table => [table, f.store.database.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all()]));
}
const frameOperations = ['claim', 'claim-deferred', 'claim-turn-end', 'claim-wake', 'host-legacy-wake', 'host-managed-wake'];
test.each(frameOperations.flatMap(operation => [32768, 32769].map(bytes => [operation, bytes])))
('AC005/006 F1 full %s frame=%i clips before leasing and wake observation', (operation, bytes) => {
  const f = fixture(); const at = f.now + 100;
  const fields = operation === 'claim-wake' ? { recognized: true }
    : operation.startsWith('host-') ? { recognized: true, managed: operation === 'host-managed-wake' } : {};
  const projected = fullFrameBatch(f, bytes, fields, at);
  const claim = fullFrameClaim(f, operation, bytes === 32768 ? {} : { maxMessages: 10, maxBodyChars: 32768 });
  const before = fullFrameState(f);
  try {
    let count = projected.length;
    while (successBytes({ ...fields, messages: projected.slice(0, count) }) > 32768) count--;
    assert.equal(count, bytes === 32768 ? 8 : 7);
    const result = claim.run();
    assert.deepEqual(result, { ...fields, messages: projected.slice(0, count) });
    assert.equal(successBytes(result), bytes === 32768 ? 32768 : successBytes({ ...fields, messages: projected.slice(0, 7) }));
    const after = fullFrameState(f);
    for (let i = 0; i < projected.length; i++) {
      if (i >= count) assert.deepEqual(after.messages[i], before.messages[i]);
      else {
        assert.equal(after.messages[i].delivery_attempts, 1);
        assert.equal(after.messages[i].first_delivered_at, iso(at));
        assert.equal(after.messages[i].claimed_at, iso(at));
        assert.ok(after.messages[i].claim_until > iso(at));
      }
    }
    if (operation.includes('wake')) {
      assert.equal(after.wake_nonces[0].consumed_at, iso(at));
      assert.equal(after.wake_nonces[0].state, operation === 'host-managed-wake' ? 'observed' : 'legacy');
      assert.deepEqual(claim.run(), operation === 'claim-wake' ? { recognized: false, messages: [] }
        : { recognized: false, messages: [], managed: false });
    }
  } finally { claim.close(); }
});
test('AC005 F1 managed adds bytes beyond the former recognized-only exact boundary', () => {
  const f = fixture(), at = f.now + 100;
  const projected = fullFrameBatch(f, 32768, { recognized: true }, at);
  assert.equal(successBytes({ messages: projected }), 32750);
  assert.equal(successBytes({ recognized: true, messages: projected, managed: true }), 32783);
  const claim = fullFrameClaim(f, 'host-managed-wake'); const before = fullFrameState(f);
  try {
    const result = claim.run(); assert.equal(result.messages.length, 7);
    assert.deepEqual(result.messages, projected.slice(0, 7));
    assert.ok(successBytes(result) <= 32768);
    assert.deepEqual(fullFrameState(f).messages[7], before.messages[7]);
  } finally { claim.close(); }
});
test.each(['claim-wake', 'host-legacy-wake', 'host-managed-wake'])
('AC005/008 F1 %s first-message budget rejection preserves all transaction rows and unknown fence', operation => {
  const f = fixture(); f.store.send({ sender, target, messageId: 'f1-reject-0001', body: '한😀"\\\n' }, f.now);
  const claim = fullFrameClaim(f, operation, { maxBodyChars: 1 });
  const before = fullFrameState(f);
  try {
    assert.throws(() => claim.run(), /caller claim budget/);
    assert.deepEqual(fullFrameState(f), before);
    if (operation === 'host-managed-wake') assert.equal(before.wake_nonces[0].state, 'unknown');
  } finally { claim.close(); }
});
test.each(['legacy', 'managed', 'retired', 'ineligible'])
('AC008 F1 reachable %s empty host frame preserves its existing wake effects', kind => {
  const f = fixture(); const nonce = 'f1-empty-nonce-abcdefghijklmnop';
  let attempt;
  if (kind === 'legacy') {
    f.store.send({ sender, target, messageId: 'f1-empty-0001', body: 'body' }, f.now);
    assert.equal(f.store.reserveWake(target, nonce, f.now + 1), true);
    f.store.acknowledge(target, ['f1-empty-0001'], f.now + 2);
  } else {
    attempt = begin(f);
    f.store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', f.now + 2);
    f.store.acknowledge(target, ['wake-body-0001'], f.now + 3);
    if (kind === 'retired') f.store.database.prepare("UPDATE wake_nonces SET state='expired-unobserved', retired_at=? WHERE attempt_id=?")
      .run(iso(f.now + 4), attempt.attemptId);
    if (kind === 'ineligible') f.store.endPresence(target, 'ended', 'birth-1', f.now + 4);
  }
  const at = f.now + 100, proof = observed(f, [attempt?.nonce ?? nonce], at);
  const before = fullFrameState(f); const clock = vi.spyOn(Date, 'now').mockReturnValue(at);
  try {
    const result = dispatch(f.store, 'claim-host-wake', { target, ...proof }, undefined, undefined, undefined,
      createWakeHookObservationReader(f.trustPath));
    assert.deepEqual(result, { recognized: kind === 'legacy' || kind === 'managed', messages: [], managed: kind === 'managed',
      ...(kind === 'retired' ? { retired: true } : {}) });
    assert.ok(successBytes(result) < 32768);
    const after = fullFrameState(f); assert.deepEqual(after.messages, before.messages);
    const wake = after.wake_nonces[0];
    if (kind === 'legacy' || kind === 'managed') assert.equal(wake.consumed_at, iso(at));
    else {
      assert.equal(wake.consumed_at, null);
      assert.equal(wake.state, kind === 'retired' ? 'expired-unobserved' : 'unknown');
      assert.equal(wake.late_observed_at, iso(at));
      assert.equal(wake.observed_at, null);
    }
  } finally { clock.mockRestore(); }
});
