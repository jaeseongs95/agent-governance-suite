import assert from 'node:assert/strict';
import { fork, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, test, vi } from 'vitest';
import { SessionMessageStore } from '../../mcp-server/src/session-message-store.ts';
import { dispatchSessionMessageBrokerOperation as dispatch } from '../../mcp-server/src/session-message-broker.ts';
import { adaptHostInput } from '../../mcp-server/src/host-input-adapter.ts';
import { recordWakeHookObservation, createWakeHookObservationReader, verifyHistoricalWakeObservation } from '../../mcp-server/src/session-message-wake-port.ts';
import { waitForSessionMessageBrokerReady } from '../../mcp-server/src/session-message-client.ts';
import { TrustStore } from '../../mcp-server/src/trust-store.ts';

const target = { host: 'portable', sessionId: 'wake-target' };
const resources = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const f of resources.splice(0)) { f.store.close(); await rm(f.directory, { recursive: true, force: true, maxRetries: 10 }); }
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'ags-wake-history-'));
  const database = join(directory, 'session-messages.sqlite3');
  const trustPath = join(directory, 'trust.sqlite3');
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', trustPath);
  const store = new SessionMessageStore(database);
  const now = Date.now() - 60_000;
  const presence = instanceId => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
    canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
  store.startPresence(presence('instance-1'), now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
  store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: 'history-body', body: 'pending body' }, now);
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable', relayId: 'relay-1',
    nonce: 'history-nonce-abcdefghijklmnop' }, now);
  const attempt = store.startManagedWake(reserved.attempt, now + 1).attempt;
  store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', now + 2);
  store.startPresence(presence('instance-2'), now + 5);
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId,
    agent_id: '', prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
  const sourceReceiptId = recordWakeHookObservation(observation, now + 10);
  // Persisted v2.7.1 late-arrival shape; actual frozen-version upgrade is also replayed separately.
  store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE state = 'unknown'").run(new Date(now + 11).toISOString());
  const f = { directory, database, trustPath, store, now, attempt, observation, sourceReceiptId, presence };
  resources.push(f); return f;
}
function payload(f) { return { target, attemptId: f.attempt.attemptId, sourceReceiptId: f.sourceReceiptId }; }
function row(f) { return f.store.database.prepare('SELECT * FROM wake_nonces WHERE attempt_id = ?').get(f.attempt.attemptId); }
function reconcile(f) { return dispatch(f.store, 'reconcile-wake-observation', payload(f)); }
function replaceReceipt(f, changes = {}) {
  const trust = new TrustStore(f.trustPath);
  try {
    const receipt = trust.getInputSource(f.sourceReceiptId);
    const input = Object.fromEntries(Object.entries(receipt).filter(([key]) => !['schemaVersion', 'receiptId', 'integrityToken'].includes(key)));
    f.sourceReceiptId = trust.recordInputSource({ ...input, eventId: `replacement-${Math.random()}`, ...changes }).receiptId;
  } finally { trust.close(); }
}
function snapshot(f) {
  return { wake: row(f), messages: f.store.database.prepare('SELECT * FROM messages').all(),
    observations: f.store.database.prepare('SELECT * FROM input_observations').all(),
    presence: f.store.database.prepare('SELECT * FROM session_presence').all() };
}

test('expired original evidence retires only the exact old attempt, preserving historical time and pending body', () => {
  const f = fixture(); const before = snapshot(f);
  assert.equal(createWakeHookObservationReader(f.trustPath).verifyObservation(target, f.observation, f.sourceReceiptId, Date.now()), false);
  const result = reconcile(f);
  assert.equal(result.reconciled, true);
  assert.equal(result.evidence.sourceReceiptId, f.sourceReceiptId);
  assert.equal(result.evidence.oldBinding.attemptId, f.attempt.attemptId);
  assert.equal(result.evidence.oldBinding.instanceId, 'instance-1');
  assert.equal(result.evidence.oldBinding.dispatchEpoch, 1);
  assert.equal(Object.hasOwn(result.evidence.oldBinding, 'nonce'), false);
  assert.equal(result.evidence.observedAt, new Date(f.now + 10).toISOString());
  assert.equal(result.evidence.lateObservedAt, new Date(f.now + 11).toISOString());
  assert.ok(Date.parse(result.evidence.reconciledAt) > Date.parse(result.evidence.receiptExpiresAt));
  assert.equal(row(f).state, 'observed');
  assert.equal(row(f).observed_at, result.evidence.observedAt);
  assert.equal(row(f).consumed_at, result.evidence.reconciledAt);
  const after = snapshot(f);
  for (const key of ['messages', 'observations', 'presence']) assert.deepEqual(after[key], before[key]);
  assert.deepEqual(reconcile(f), { reconciled: false, evidence: null });
  assert.equal(f.store.recordManagedWakeOutcome(f.attempt, 'definite-failure'), false);
  assert.equal(f.store.startManagedWake(f.attempt).dispatch, false);
});

test.each(['target', 'attempt', 'receipt', 'nonce', 'current', 'no-current', 'no-late', 'submitted', 'already-consumed', 'bad-signature', 'digest', 'adapter', 'authority'])('history rejects %s without changing any message state', kind => {
    const f = fixture(); let input = payload(f);
    if (kind === 'target') input.target = { ...target, sessionId: 'other-session' };
    if (kind === 'attempt') input.attemptId = 'other-attempt';
    if (kind === 'receipt') input.sourceReceiptId = 'source-missing';
    if (kind === 'nonce') f.store.database.prepare('UPDATE wake_nonces SET nonce = ?').run('forged-nonce-abcdefghijklmnop');
    if (kind === 'current') f.store.database.prepare("DELETE FROM session_presence WHERE instance_id = 'instance-2'").run();
    if (kind === 'no-current') f.store.database.prepare('DELETE FROM session_presence').run();
    if (kind === 'no-late') f.store.database.prepare('UPDATE wake_nonces SET late_observed_at = NULL').run();
    if (kind === 'submitted') f.store.database.prepare("UPDATE wake_nonces SET state = 'submitted'").run();
    if (kind === 'already-consumed') f.store.database.prepare('UPDATE wake_nonces SET consumed_at = ?').run(new Date(f.now + 11).toISOString());
    if (kind === 'bad-signature') {
      const db = new DatabaseSync(f.trustPath);
      const receipt = JSON.parse(db.prepare('SELECT receipt_json FROM input_source_receipts WHERE receipt_id = ?').get(f.sourceReceiptId).receipt_json);
      receipt.integrityToken = 'forged'; db.prepare('UPDATE input_source_receipts SET receipt_json = ? WHERE receipt_id = ?').run(JSON.stringify(receipt), f.sourceReceiptId); db.close();
    }
    if (kind === 'digest') replaceReceipt(f, { contentDigest: `sha256:${'a'.repeat(64)}` });
    if (kind === 'adapter') replaceReceipt(f, { attestation: { kind: 'broker-peer-envelope', adapter: 'other-hook', capabilityVersion: '1.0.0' } });
    if (kind === 'authority') replaceReceipt(f, { originKind: 'skill-output', authorityEffect: 'approval-source',
      attestation: { kind: 'unknown', adapter: 'other-hook', capabilityVersion: '1.0.0' } });
    if (['digest', 'adapter', 'authority'].includes(kind)) input = payload(f);
    const before = snapshot(f);
    assert.deepEqual(dispatch(f.store, 'reconcile-wake-observation', input), { reconciled: false, evidence: null });
    assert.deepEqual(snapshot(f), before);
  });

test.each(['before-start', 'after-late', 'expiry-at-late', 'not-expired', 'invalid-observed', 'invalid-late', 'invalid-start'])('history rejects invalid time relation %s', kind => {
    const f = fixture();
    if (kind === 'before-start') replaceReceipt(f, { observedAt: new Date(f.now).toISOString() });
    if (kind === 'after-late') replaceReceipt(f, { observedAt: new Date(f.now + 12).toISOString() });
    if (kind === 'expiry-at-late') replaceReceipt(f, { expiresAt: new Date(f.now + 11).toISOString() });
    if (kind === 'not-expired') replaceReceipt(f, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    if (kind === 'invalid-observed') replaceReceipt(f, { observedAt: 'not-a-time' });
    if (kind === 'invalid-late') f.store.database.prepare("UPDATE wake_nonces SET late_observed_at = 'not-a-time'").run();
    if (kind === 'invalid-start') f.store.database.prepare("UPDATE wake_nonces SET started_at = 'not-a-time'").run();
    const before = snapshot(f); assert.equal(reconcile(f).reconciled, false); assert.deepEqual(snapshot(f), before);
  });

test.each([['main', 'observed'], ['main', 'unknown'], ['unknown', 'observed'], ['unknown', 'unknown']])('reconstructs only the exact signed actor digest %s/%s', (kind, assurance) => {
    const f = fixture();
    f.sourceReceiptId = recordWakeHookObservation({ ...f.observation, actor: { ...f.observation.actor, kind, assurance } }, f.now + 10);
    assert.equal(reconcile(f).reconciled, true);
  });

test('a signed multiple-nonce observation cannot be approximated by a single old nonce', () => {
  const f = fixture();
  f.sourceReceiptId = recordWakeHookObservation({ ...f.observation, wakeCandidates: [f.attempt.nonce, 'other-nonce-abcdefghijklmnop'] }, f.now + 10);
  const before = snapshot(f); assert.equal(reconcile(f).reconciled, false); assert.deepEqual(snapshot(f), before);
});

test.each(['missing-db', 'missing-key', 'bad-key', 'missing-table'])('readonly trust rejection %s creates no database/key/receipt', kind => {
  const f = fixture();
  let authorityBefore;
  if (kind === 'missing-db') rmSync(f.trustPath);
  else {
    const db = new DatabaseSync(f.trustPath);
    if (kind === 'missing-key') db.prepare('DELETE FROM trust_metadata').run();
    if (kind === 'bad-key') db.prepare("UPDATE trust_metadata SET value = 'invalid'").run();
    if (kind === 'missing-table') db.exec('DROP TABLE input_source_receipts');
    authorityBefore = { keys: db.prepare('SELECT * FROM trust_metadata').all(),
      schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
      receipts: kind === 'missing-table' ? [] : db.prepare('SELECT * FROM input_source_receipts').all() };
    db.close();
  }
  const files = readdirSync(f.directory).filter(name => name.startsWith('trust.sqlite3'));
  const bytes = new Map(files.map(name => [name, readFileSync(join(f.directory, name))]));
  const before = snapshot(f); assert.equal(reconcile(f).reconciled, false); assert.deepEqual(snapshot(f), before);
  const afterFiles = readdirSync(f.directory).filter(name => name.startsWith('trust.sqlite3'));
  // A normal read-only WAL connection may create coordination sidecars. Authority
  // bytes and WAL frames remain unchanged; immutable/checkpoint workarounds are forbidden.
  for (const name of afterFiles) {
    assert.ok(['trust.sqlite3', 'trust.sqlite3-wal', 'trust.sqlite3-shm'].includes(name));
    if (name.endsWith('-shm')) continue;
    const actual = readFileSync(join(f.directory, name));
    if (bytes.has(name)) assert.deepEqual(actual, bytes.get(name));
    else { assert.equal(name, 'trust.sqlite3-wal'); assert.ok(actual.length <= 32, 'reader added WAL frames'); }
  }
  if (kind === 'missing-db') { assert.equal(existsSync(f.trustPath), false); assert.deepEqual(afterFiles, []); }
  else {
    const db = new DatabaseSync(f.trustPath, { readOnly: true });
    assert.deepEqual({ keys: db.prepare('SELECT * FROM trust_metadata').all(), schema: db.prepare('SELECT * FROM sqlite_schema ORDER BY name').all(),
      receipts: kind === 'missing-table' ? [] : db.prepare('SELECT * FROM input_source_receipts').all() }, authorityBefore);
    db.close();
  }
});

test.each(['nowMs', 'receipt', 'approved', 'observation', 'nonce', 'instanceId'])('broker rejects caller supplied %s', field => {
  const f = fixture(); const before = snapshot(f);
  assert.throws(() => dispatch(f.store, 'reconcile-wake-observation', { ...payload(f), [field]: true }), /unsupported/i);
  assert.deepEqual(snapshot(f), before);
});

test('two independent recovery processes CAS once; pending uses separate normal reserve/start', async () => {
  const f = fixture(); const worker = fileURLToPath(new URL('./fixtures/managed-wake-process.mjs', import.meta.url));
  const children = await Promise.all(['recovery-one', 'recovery-two'].map(async relayId => {
    const child = fork(worker, ['reconcile-wake', f.database, join(f.directory, 'effects.txt'), relayId, String(process.pid)],
      { execArgv: ['--import', 'tsx'], silent: true, windowsHide: true });
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const exit = once(child, 'exit'); const [ready] = await once(child, 'message'); assert.equal(ready.type, 'ready');
    return { child, exit, result: once(child, 'message'), stderr: () => stderr };
  }));
  for (const p of children) p.child.send(payload(f));
  const outcomes = await Promise.all(children.map(async p => {
    const [{ result, error }] = await p.result; const [code] = await p.exit; assert.equal(code, 0, error ?? p.stderr()); return result;
  }));
  assert.equal(outcomes.filter(result => result.reconciled).length, 1);
  assert.equal(f.store.pendingCount(target), 1); assert.equal(existsSync(join(f.directory, 'effects.txt')), false);
  assert.equal(row(f).state, 'observed');
  f.store.startPresence(f.presence('instance-2'));
  f.store.acquireRelay({ ...target, transport: 'portable', relayId: 'current-relay', pid: process.pid, parentPid: process.pid });
  const reserved = f.store.reserveManagedWake({ ...target, instanceId: 'instance-2', transport: 'portable', relayId: 'current-relay',
    nonce: 'current-nonce-abcdefghijklmnop' });
  assert.equal(reserved.dispatch, true); assert.notEqual(reserved.attempt.attemptId, f.attempt.attemptId);
  assert.equal(f.store.startManagedWake(reserved.attempt).dispatch, true);
  assert.equal(f.store.recordManagedWakeOutcome(f.attempt, 'submitted'), false);
  assert.equal(reconcile(f).reconciled, false);
});

test.each(['generation', 'epoch', 'late', 'state'])('CAS rechecks %s after historical verification', kind => {
  const f = fixture();
  const verify = (...args) => {
    const proof = verifyHistoricalWakeObservation(...args);
    if (kind === 'generation') f.store.database.prepare("DELETE FROM session_presence WHERE instance_id = 'instance-2'").run();
    if (kind === 'epoch') f.store.database.prepare('UPDATE wake_nonces SET dispatch_epoch = dispatch_epoch + 1').run();
    if (kind === 'late') f.store.database.prepare('UPDATE wake_nonces SET late_observed_at = ?').run(new Date(f.now + 12).toISOString());
    if (kind === 'state') f.store.database.prepare("UPDATE wake_nonces SET state = 'submitted'").run();
    return proof;
  };
  assert.equal(f.store.reconcileHistoricalWake(target, f.attempt.attemptId, f.sourceReceiptId, Date.now(), verify).reconciled, false);
  assert.equal(row(f).observed_at, null); assert.equal(row(f).consumed_at, null);
});

test('historical observation retention counts from recovery application, not the old arrival', () => {
  const f = fixture(); const applied = Date.now() + 3_600_000;
  const result = f.store.reconcileHistoricalWake(target, f.attempt.attemptId, f.sourceReceiptId, applied);
  assert.equal(result.reconciled, true);
  f.store.prune(applied + 1000); assert.equal(row(f).state, 'observed');
  f.store.prune(applied + 3_600_001); assert.equal(row(f), undefined);
});

test('a reused instance with a new birth generation still retires only the old attempt', () => {
  const f = fixture(); f.store.startPresence(f.presence('instance-1'));
  assert.equal(reconcile(f).reconciled, true);
  assert.notEqual(f.store.presence(target).startedAt, f.attempt.generation);
});

test('read-only verification holds one key/receipt snapshot while an independent writer rotates both', () => {
  const f = fixture();
  const originalReceipt = TrustStore.readVerifiedInputSource(f.trustPath, f.sourceReceiptId);
  const writer = new DatabaseSync(f.trustPath);
  writer.prepare('SELECT * FROM trust_metadata').get(); // Keep the actual WAL writer connection alive.
  const prepare = DatabaseSync.prototype.prepare;
  let writes = 0;
  const spy = vi.spyOn(DatabaseSync.prototype, 'prepare').mockImplementation(function (sql) {
    const statement = prepare.call(this, sql);
    if (sql === 'SELECT value FROM trust_metadata WHERE key = ?') {
      const get = statement.get.bind(statement);
      statement.get = (...args) => {
        const key = get(...args);
        const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
          import { randomBytes, createHmac } from 'node:crypto';
          import { DatabaseSync } from 'node:sqlite';
          import { canonicalJson } from './mcp-server/src/convergence-logic.ts';
          const db = new DatabaseSync(process.argv[1]);
          db.exec('BEGIN IMMEDIATE');
          const signingKey = randomBytes(32);
          db.prepare('UPDATE trust_metadata SET value = ?').run(signingKey.toString('base64url'));
          const receipts = db.prepare('SELECT receipt_id, receipt_json FROM input_source_receipts').all();
          for (const row of receipts) {
            const unsigned = JSON.parse(row.receipt_json); delete unsigned.integrityToken;
            const integrityToken = createHmac('sha256', signingKey).update(canonicalJson(unsigned)).digest('base64url');
            db.prepare('UPDATE input_source_receipts SET receipt_json = ? WHERE receipt_id = ?').run(JSON.stringify({ ...unsigned, integrityToken }), row.receipt_id);
          }
          db.exec('COMMIT'); db.close();
        `, f.trustPath], { windowsHide: true, encoding: 'utf8', timeout: 10_000 });
        assert.equal(child.status, 0, child.stderr); writes++; return key;
      };
    }
    return statement;
  });
  let receipt;
  try { receipt = TrustStore.readVerifiedInputSource(f.trustPath, f.sourceReceiptId); }
  finally { spy.mockRestore(); writer.close(); }
  assert.equal(writes, 1);
  assert.equal(receipt?.integrityToken === originalReceipt.integrityToken, true);
  const latest = TrustStore.readVerifiedInputSource(f.trustPath, f.sourceReceiptId);
  assert.equal(latest !== null && latest.integrityToken !== originalReceipt.integrityToken, true);
});

test('bundled public CLI forwards only IDs to the private broker and cannot repeat recovery', async () => {
  const f = fixture();
  const install = join(f.directory, 'install'); mkdirSync(install);
  for (const name of ['session-message-broker.mjs', 'session-message-cli.mjs']) {
    copyFileSync(fileURLToPath(new URL(`../../mcp-server/dist/${name}`, import.meta.url)), join(install, name));
  }
  const brokerPath = join(install, 'session-message-broker.mjs');
  const cliPath = join(install, 'session-message-cli.mjs');
  assert.equal(existsSync(join(install, 'node_modules')), false);
  const env = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: f.directory, AGENT_GOVERNANCE_TRUST_DB_PATH: f.trustPath };
  const broker = spawn(process.execPath, [brokerPath, '--state-directory', f.directory], { env, cwd: install, stdio: 'ignore', windowsHide: true });
  const exited = once(broker, 'exit');
  try {
    await waitForSessionMessageBrokerReady(f.directory, broker, 5000);
    const run = input => {
      const output = spawnSync(process.execPath, [cliPath], { env, cwd: install, encoding: 'utf8', windowsHide: true, timeout: 10_000,
        input: JSON.stringify({ operation: 'reconcile-wake-observation', payload: input }) });
      assert.equal(output.error, undefined); return { code: output.status, json: JSON.parse(output.stdout) };
    };
    const messages = snapshot(f).messages;
    assert.equal(run({ ...payload(f), nowMs: Date.now() }).code, 1);
    assert.equal(row(f).state, 'unknown');
    const result = run(payload(f)); assert.equal(result.code, 0); assert.equal(result.json.data.reconciled, true);
    assert.equal(result.json.data.evidence.oldBinding.attemptId, f.attempt.attemptId);
    assert.deepEqual(run(payload(f)).json.data, { reconciled: false, evidence: null });
    assert.deepEqual(snapshot(f).messages, messages);
    assert.deepEqual(snapshot(f).observations, []);
  } finally { broker.kill(); await exited; }
}, 20_000);

test.each(['prestarted', 'client-ensure'])('packaged CLI binds history to explicit broker state directory: %s', async mode => {
  const f = fixture();
  const install = join(f.directory, 'isolated-install'); mkdirSync(install);
  for (const name of ['session-message-broker.mjs', 'session-message-cli.mjs']) {
    copyFileSync(fileURLToPath(new URL(`../../mcp-server/dist/${name}`, import.meta.url)), join(install, name));
  }
  const unrelated = join(f.directory, 'environment-default');
  const decoyPath = join(unrelated, 'trust.sqlite3');
  const decoy = new TrustStore(decoyPath); decoy.close();
  const decoyBytes = readFileSync(decoyPath);
  const trustBytes = readFileSync(f.trustPath);
  const env = { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: unrelated };
  delete env.AGENT_GOVERNANCE_TRUST_DB_PATH;
  let broker; let exited;
  if (mode === 'prestarted') {
    broker = spawn(process.execPath, [join(install, 'session-message-broker.mjs'), '--state-directory', f.directory],
      { env, cwd: install, stdio: 'ignore', windowsHide: true });
    exited = once(broker, 'exit');
  }
  try {
    if (broker) await waitForSessionMessageBrokerReady(f.directory, broker, 5000);
    const run = input => {
      const code = `import { readFileSync } from 'node:fs';
        import { runSessionMessageCli } from './session-message-cli.mjs';
        try { console.log(JSON.stringify(await runSessionMessageCli(readFileSync(0, 'utf8'), process.argv[1]))); }
        catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }`;
      const output = spawnSync(process.execPath, ['--input-type=module', '-e', code, f.directory], {
        env, cwd: install, encoding: 'utf8', windowsHide: true, timeout: 15_000,
        input: JSON.stringify({ operation: 'reconcile-wake-observation', payload: input }) });
      assert.equal(output.error, undefined); return { code: output.status, json: JSON.parse(output.stdout) };
    };
    const before = snapshot(f);
    const wrong = run({ ...payload(f), sourceReceiptId: 'source-missing' });
    assert.equal(wrong.code, 0); assert.deepEqual(wrong.json.data, { reconciled: false, evidence: null });
    assert.deepEqual(snapshot(f), before);
    assert.equal(run({ ...payload(f), approved: true }).code, 1); assert.deepEqual(snapshot(f), before);
    // Valid proof in the unrelated default DB must not replace the broker's selected DB.
    copyFileSync(f.trustPath, decoyPath); rmSync(f.trustPath);
    const missing = run(payload(f)); assert.equal(missing.code, 0);
    assert.deepEqual(missing.json.data, { reconciled: false, evidence: null });
    assert.equal(existsSync(f.trustPath), false); assert.deepEqual(snapshot(f), before);
    assert.deepEqual(readFileSync(decoyPath), trustBytes);
    writeFileSync(f.trustPath, trustBytes); writeFileSync(decoyPath, decoyBytes);
    const result = run(payload(f)); assert.equal(result.code, 0);
    assert.equal(result.json.data.reconciled, true, JSON.stringify(result.json));
    assert.equal(result.json.data.evidence.sourceReceiptId, f.sourceReceiptId);
    assert.equal(result.json.data.evidence.oldBinding.attemptId, f.attempt.attemptId);
    assert.deepEqual(snapshot(f).messages, before.messages);
    assert.deepEqual(snapshot(f).presence, before.presence);
    assert.deepEqual(snapshot(f).observations, before.observations);
    assert.deepEqual(run(payload(f)).json.data, { reconciled: false, evidence: null });
    assert.deepEqual(readFileSync(f.trustPath), trustBytes);
    assert.deepEqual(readFileSync(decoyPath), decoyBytes);
    assert.deepEqual(readdirSync(unrelated), ['trust.sqlite3']);
    assert.equal(existsSync(join(install, 'node_modules')), false);
  } finally {
    if (broker) { broker.kill(); await exited; }
    else if (existsSync(join(f.directory, 'endpoint.json'))) {
      const endpoint = JSON.parse(readFileSync(join(f.directory, 'endpoint.json'), 'utf8'));
      process.kill(endpoint.pid);
      const deadline = Date.now() + 5000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(endpoint.pid, 0); }
        catch { alive = false; }
        if (alive) await delay(20);
      }
      assert.equal(alive, false);
    }
  }
}, 30_000);
