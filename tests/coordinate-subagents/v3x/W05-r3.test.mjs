import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
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

const sender = { host: 'portable', sessionId: 'w05-r3-sender' };
const target = { host: 'portable', sessionId: 'w05-r3-target' };
const resources = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const f of resources.splice(0)) {
    for (const child of f.children) if (child.exitCode === null && child.signalCode === null) child.kill();
    f.store.close();
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
    assert.equal(f.store.reserveManagedWake({ ...target, instanceId: 'birth-1', transport: 'portable', relayId: 'relay-1',
      nonce: 'w05-r3-retry-abcdefghijklmnop' }, at + 1).dispatch, false);
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
    const result = f.store.claimHostWake(target, proof.observation, proof.sourceReceiptId,
      createWakeHookObservationReader(f.trustPath), at + 3);
    assert.deepEqual(result, { recognized: false, messages: [], binding: null });
    const current = row(f, attempt);
    assert.equal(current.state, 'observed'); assert.ok(current.late_observed_at);
    assert.ok(current.consumed_at); assert.ok(current.observed_at);
    assert.equal(f.store.pendingCount(target, at + 3), 1);
  });

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
