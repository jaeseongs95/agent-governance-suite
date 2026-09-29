// Final-tree audit (9a678df): cross paths between wake liveness (W) and receipt retention (Q). Not product code.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'vitest';
import { SessionMessageStore, WAKE_RETIRE_GRACE_MS, MESSAGE_SENDER_RECEIPT_LIMIT } from '../../mcp-server/src/session-message-store.ts';
import { ContractValidator } from '../../mcp-server/src/schema-validator.ts';

const target = { host: 'portable', sessionId: 'cross-target' };
const sender = { host: 'portable', sessionId: 'cross-sender' };
const caps = { supportedInjection: ['peer-wake', 'tool-boundary'], idleWake: 'silent' };
const iso = ms => new Date(ms).toISOString();
const H = 3600_000;
const validator = new ContractValidator();
const cleanup = [];
afterEach(() => { for (const f of cleanup.splice(0)) { f.store.close(); rmSync(f.dir, { recursive: true, force: true }); } });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ags-final-cross-'));
  const store = new SessionMessageStore(join(dir, 'm.sqlite3'));
  const f = { dir, store, now: Date.now() }; cleanup.push(f); return f;
}
function born(store, instanceId, relayId, at) {
  store.startPresence({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, at);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
function keep(store, instanceId, relayId, at) {
  store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(at + 60_000), instanceId);
  store.acquireRelay({ ...target, transport: 'portable', relayId, pid: process.pid, parentPid: process.pid }, at);
}
const sendNew = (store, who, at, to = target) => store.submitPrepared(who, store.prepare({ sender: who, target: to, body: `b-${at}-${Math.random()}`, ttlSeconds: 86400 }, at).messageId, at);
const snapshot = store => Object.fromEntries(['messages', 'prepared_messages', 'wake_nonces', 'session_activity', 'session_presence', 'relay_leases']
  .map(t => [t, store.database.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
function latchedWake(f) {
  born(f.store, 'i1', 'r1', f.now);
  const first = sendNew(f.store, sender, f.now);
  const r = f.store.reserveManagedWake({ ...target, nonce: 'cross-nonce-1-abcdefghijklmnopqrst', instanceId: 'i1', transport: 'portable', relayId: 'r1' }, f.now);
  const s = f.store.startManagedWake(r.attempt, f.now + 1).attempt;
  f.store.recordManagedWakeOutcome(s, 'submitted', f.now + 2);
  const exp = Date.parse(f.store.database.prepare('SELECT expires_at FROM wake_nonces WHERE attempt_id = ?').get(s.attemptId).expires_at);
  return { first, attempt: s, exp };
}
const wakeState = (store, a) => store.database.prepare('SELECT state, retired_at FROM wake_nonces WHERE attempt_id = ?').get(a.attemptId);

test('X1 sender capacity full: duplicate resend returns a schema-valid autoWake; a new send is a definite rejection that leaves every table unchanged', () => {
  const f = setup(); born(f.store, 'i1', 'r1', f.now);
  const sent = Array.from({ length: MESSAGE_SENDER_RECEIPT_LIMIT }, (_, i) => sendNew(f.store, sender, f.now + i));
  const at = f.now + 10_000; keep(f.store, 'i1', 'r1', at);
  const dup = f.store.submitPrepared(sender, sent[0].messageId, at);
  assert.equal(dup.duplicate, true); assert.equal(dup.messageId, sent[0].messageId); assert.equal(dup.createdAt, sent[0].createdAt);
  assert.deepEqual(validator.sessionAutoWakeOutlook(dup.autoWake), dup.autoWake); assert.equal(dup.autoWake.checkedAt, iso(at));
  const before = snapshot(f.store);
  assert.throws(() => f.store.prepare({ sender, target, body: 'over', ttlSeconds: 600 }, at + 1), (e) => e.details?.scope === 'sender');
  const after = snapshot(f.store);
  // prepare admission may prune only expired rows; none are expired at this time
  assert.deepEqual(after, before);
});

test('X1b send-time capacity rejection (draft prepared before the pool filled) rolls back before autoWake and writes nothing', () => {
  const f = setup(); born(f.store, 'i1', 'r1', f.now);
  const early = f.store.prepare({ sender, target, body: 'early', ttlSeconds: 600 }, f.now);
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT; i++) sendNew(f.store, sender, f.now + 1 + i);
  const at = f.now + 5_000; keep(f.store, 'i1', 'r1', at);
  const before = snapshot(f.store);
  let calls = 0; const original = f.store.autoWakeOutlook.bind(f.store);
  f.store.autoWakeOutlook = (...args) => { calls++; return original(...args); };
  assert.throws(() => f.store.submitPrepared(sender, early.messageId, at), (e) => e.details?.scope === 'sender' && typeof e.details.earliestReleaseAt === 'string');
  assert.equal(calls, 0, 'autoWake must not be computed for a rejected send');
  assert.deepEqual(snapshot(f.store), before);
  const row = f.store.database.prepare('SELECT receipt, body FROM prepared_messages WHERE message_id = ?').get(early.messageId);
  assert.equal(row.receipt, null); assert.equal(row.body, 'early');
});

test('X2 ACK after the wake expiry updates the receipt and records activity in one transaction; the next prune retires the latch once', () => {
  const f = setup(); const { first, attempt, exp } = latchedWake(f);
  const receiptBefore = f.store.database.prepare('SELECT expires_at FROM prepared_messages WHERE message_id = ?').get(first.messageId).expires_at;
  const [m] = f.store.claim(target, exp - 1000); assert.equal(m.messageId, first.messageId);
  const ackAt = exp + 1;
  assert.equal(f.store.acknowledge(target, [first.messageId], ackAt), 1);
  const receiptAfter = f.store.database.prepare('SELECT expires_at FROM prepared_messages WHERE message_id = ?').get(first.messageId).expires_at;
  assert.equal(receiptAfter, [receiptBefore, iso(ackAt + H)].sort()[0]);
  assert.equal(f.store.database.prepare('SELECT active_at FROM session_activity WHERE session_id = ?').get(target.sessionId).active_at, iso(ackAt));
  // Not yet retired before the grace; retired exactly once after.
  f.store.prune(exp + WAKE_RETIRE_GRACE_MS - 1); assert.equal(wakeState(f.store, attempt).state, 'submitted');
  f.store.prune(exp + WAKE_RETIRE_GRACE_MS); const w = wakeState(f.store, attempt);
  assert.equal(w.state, 'expired-unobserved');
  f.store.prune(exp + WAKE_RETIRE_GRACE_MS + 5); assert.deepEqual(wakeState(f.store, attempt), w);
  // A second ACK neither extends the receipt nor fails.
  assert.equal(f.store.acknowledge(target, [first.messageId], ackAt + 10), 0);
  assert.equal(f.store.database.prepare('SELECT expires_at FROM prepared_messages WHERE message_id = ?').get(first.messageId).expires_at, receiptAfter);
});

test('X2b a failure while recording activity rolls back the ACK and the receipt update together', () => {
  const f = setup(); const { first, exp } = latchedWake(f);
  f.store.claim(target, exp - 1000);
  const before = snapshot(f.store);
  f.store.database.exec(`CREATE TRIGGER audit_fail_ins BEFORE INSERT ON session_activity BEGIN SELECT raise(ABORT, 'audit activity failure'); END;
    CREATE TRIGGER audit_fail_upd BEFORE UPDATE ON session_activity BEGIN SELECT raise(ABORT, 'audit activity failure'); END;`);
  assert.throws(() => f.store.acknowledge(target, [first.messageId], exp + 1), /audit activity failure/);
  f.store.database.exec('DROP TRIGGER audit_fail_ins; DROP TRIGGER audit_fail_upd;');
  assert.deepEqual(snapshot(f.store), before);
});

test('X3 read tools prune receipts and retire a wake in the same call and are idempotent afterwards', () => {
  const f = setup(); const { first, attempt, exp } = latchedWake(f);
  // An old receipt that will be past its retention window at read time.
  const other = { host: 'portable', sessionId: 'cross-other' };
  const old = sendNew(f.store, sender, f.now, other);
  f.store.acknowledge(other, [old.messageId], f.now + 10);
  f.store.claim(target, exp - 1000); f.store.acknowledge(target, [first.messageId], exp + 1);
  const later = exp + WAKE_RETIRE_GRACE_MS + 60_000;
  // Only the presence lease is renewed (no call that prunes), so the first read call does both effects.
  f.store.database.prepare('UPDATE session_presence SET lease_until = ? WHERE instance_id = ?').run(iso(later + 60_000), 'i1');
  assert.equal(wakeState(f.store, attempt).state, 'submitted');
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM prepared_messages WHERE message_id = ?').get(old.messageId).n, 1);
  const s0 = snapshot(f.store);
  const view1 = f.store.listPresence(later);
  const s1 = snapshot(f.store);
  assert.equal(wakeState(f.store, attempt).state, 'expired-unobserved');
  assert.equal(f.store.database.prepare('SELECT count(*) AS n FROM prepared_messages WHERE message_id = ?').get(old.messageId).n, 0);
  const st1 = f.store.status(sender, first.messageId, later);
  const s2 = snapshot(f.store);
  const view2 = f.store.listPresence(later);
  const st2 = f.store.status(sender, first.messageId, later);
  assert.deepEqual(snapshot(f.store), s2); assert.deepEqual(s2, s1);
  assert.deepEqual(view2, view1); assert.deepEqual(st2, st1);
  for (const p of view1) if (p.autoWake) assert.deepEqual(validator.sessionAutoWakeOutlook(p.autoWake), p.autoWake);
  void s0;
});
