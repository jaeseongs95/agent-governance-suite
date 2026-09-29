// Tamper / DB-failure matrix. Run: cd /tmp/e9 && node --import tsx /tmp/ev/scripts/matrix.mjs [filter]
// Each case: fresh fixture dir, mutation, snapshot, reconcile, snapshot, invariant checks.
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
const trustEnv = () => process.env.AGENT_GOVERNANCE_TRUST_DB_PATH;
const { SessionMessageStore } = await import('/tmp/e9/mcp-server/src/session-message-store.ts');
const { dispatchSessionMessageBrokerOperation: dispatch } = await import('/tmp/e9/mcp-server/src/session-message-broker.ts');
const { adaptHostInput } = await import('/tmp/e9/mcp-server/src/host-input-adapter.ts');
const { recordWakeHookObservation, verifyHistoricalWakeObservation } = await import('/tmp/e9/mcp-server/src/session-message-wake-port.ts');
const { canonicalJson } = await import('/tmp/e9/mcp-server/src/convergence-logic.ts');
const target = { host: 'portable', sessionId: 'wake-target' };
const ROOT = '/tmp/matrix'; mkdirSync(ROOT, { recursive: true });
const presence = id => ({ ...target, instanceId: id, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true,
  deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const iso = ms => new Date(ms).toISOString();

function fixture(name, opts = {}) {
  const dir = join(ROOT, name); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir);
  const database = join(dir, 'session-messages.sqlite3'); const trustPath = join(dir, 'trust.sqlite3');
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
  const store = new SessionMessageStore(database);
  const now = Date.now() - 60_000;
  store.startPresence(presence('instance-1'), now);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-1', pid: process.pid, parentPid: process.pid }, now);
  store.send({ sender: { host: 'portable', sessionId: 'sender' }, target, messageId: 'history-body', body: 'pending body' }, now);
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'instance-1', transport: 'portable', relayId: 'relay-1', nonce: 'history-nonce-abcdefghijklmnop' }, now);
  const attempt = store.startManagedWake(reserved.attempt, now + 1).attempt;
  store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', now + 2);
  store.startPresence(presence('instance-2'), now + 5);
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: target.sessionId, agent_id: '',
    prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
  const sourceReceiptId = recordWakeHookObservation(observation, now + 10);
  store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE state = 'unknown'").run(iso(now + 11));
  return { name, dir, database, trustPath, store, now, attempt, observation, sourceReceiptId, target: { ...target }, attemptId: attempt.attemptId };
}
function trustKey(f) { const db = new DatabaseSync(f.trustPath); const v = db.prepare("SELECT value FROM trust_metadata WHERE key='trust-signing-key'").get().value; db.close(); return v; }
function receiptOf(f, id = f.sourceReceiptId) { const db = new DatabaseSync(f.trustPath); const r = JSON.parse(db.prepare('SELECT receipt_json FROM input_source_receipts WHERE receipt_id=?').get(id).receipt_json); db.close(); return r; }
function sign(unsigned, keyB64) { return createHmac('sha256', Buffer.from(keyB64, 'base64url')).update(canonicalJson(unsigned, 'Input source receipt')).digest('base64url'); }
// write receipt JSON (optionally re-signed with current key or given key) under receiptId (in place)
function putReceipt(f, receipt, { resign = true, key, id = f.sourceReceiptId } = {}) {
  const { integrityToken, ...unsigned } = receipt;
  const out = resign ? { ...unsigned, integrityToken: sign(unsigned, key ?? trustKey(f)) } : receipt;
  const db = new DatabaseSync(f.trustPath); db.prepare('UPDATE input_source_receipts SET receipt_json=? WHERE receipt_id=?').run(JSON.stringify(out), id); db.close();
}
function mutateReceipt(f, fn, opts) { const r = receiptOf(f); fn(r); putReceipt(f, r, opts); }
// checkpoint trust DB so byte snapshots are stable (no open writers)
function settle(f) { if (!existsSync(f.trustPath)) return; try { const db = new DatabaseSync(f.trustPath); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch {} }
const sha = b => createHash('sha256').update(b).digest('hex').slice(0, 16);
function files(dir) { return Object.fromEntries(readdirSync(dir).filter(n => n.startsWith('trust')).sort().map(n => { const p = join(dir, n); return [n, { size: statSync(p).size, sha: sha(readFileSync(p)) }]; })); }
function sessionSnap(f) {
  const db = f.store.database;
  return { wake: db.prepare('SELECT * FROM wake_nonces ORDER BY nonce_digest').all(), messages: db.prepare('SELECT message_id, claimed_at, claim_until, delivery_attempts, first_delivered_at, acknowledged_at FROM messages').all(),
    obs: db.prepare('SELECT count(*) n FROM input_observations').get().n, presence: db.prepare('SELECT instance_id, started_at, ended_at FROM session_presence').all() };
}
function trustLogical(f) {
  if (!existsSync(f.trustPath)) return 'ABSENT';
  try { const db = new DatabaseSync(f.trustPath, { readOnly: true });
    const o = { keys: db.prepare('SELECT * FROM trust_metadata').all(), schema: db.prepare('SELECT name, sql FROM sqlite_schema ORDER BY name').all(),
      uv: db.prepare('PRAGMA user_version').get().user_version };
    try { o.receipts = db.prepare('SELECT receipt_id, receipt_json FROM input_source_receipts ORDER BY receipt_id').all(); } catch (e) { o.receipts = `ERR ${e.message}`; }
    db.close(); return JSON.stringify(o); } catch (e) { return `ERR ${e.message}`; }
}
const results = [];
async function run(name, expect, setup, opts = {}) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  let f, rec = { case: name, expect };
  try {
    f = fixture(name);
    const ctx = (await setup?.(f)) ?? {};
    if (!ctx.noSettle) settle(f);
    const before = { s: sessionSnap(f) }; before.t = ctx.beforeT ?? trustLogical(f); before.files = files(f.dir);
    let result, error;
    const nowMs = ctx.nowMs ?? Date.now();
    const input = { target: ctx.target ?? f.target, attemptId: ctx.attemptId ?? f.attemptId, sourceReceiptId: ctx.receiptId ?? f.sourceReceiptId };
    try {
      result = ctx.nowMs !== undefined ? f.store.reconcileHistoricalWake(input.target, input.attemptId, input.sourceReceiptId, nowMs)
        : dispatch(f.store, 'reconcile-wake-observation', ctx.rawPayload ?? input);
      if (ctx.second) result = { first: result, second: dispatch(f.store, 'reconcile-wake-observation', input) };
    } catch (e) { error = e.message; }
    await ctx.after?.();
    const after = { s: sessionSnap(f), files: files(f.dir) }; after.t = trustLogical(f);
    const reconciled = (result?.first ?? result)?.reconciled === true;
    const sessionUnchanged = JSON.stringify(before.s) === JSON.stringify(after.s);
    const msgsUntouched = after.s.messages.every(m => m.claimed_at === null && m.delivery_attempts === 0 && m.acknowledged_at === null) && after.s.messages.length === before.s.messages.length;
    const noNewDispatch = after.s.wake.length === before.s.wake.length && !after.s.wake.some(w => ['reserved', 'started'].includes(w.state));
    const trustLogicalUnchanged = before.t === after.t;
    const fileDiff = {};
    for (const [n, v] of Object.entries(after.files)) { const b = before.files[n]; if (!b) fileDiff[n] = `NEW size=${v.size}`; else if (b.sha !== v.sha) fileDiff[n] = `CHANGED ${b.size}->${v.size}`; }
    for (const n of Object.keys(before.files)) if (!after.files[n]) fileDiff[n] = 'REMOVED';
    const walFramesAdded = Object.entries(fileDiff).some(([n, d]) => n.endsWith('-wal') && (d.startsWith('CHANGED') ? after.files[n].size > before.files[n].size : d.startsWith('NEW') && after.files[n].size > 32));
    const mainChanged = Object.entries(fileDiff).some(([n]) => n === 'trust.sqlite3');
    Object.assign(rec, { result: error ? `THROW: ${error}` : result, reconciled, sessionUnchanged, msgsUntouched, noNewDispatch, trustLogicalUnchanged,
      fileDiff, walFramesAdded, mainChanged, wakeAfter: after.s.wake.map(w => ({ state: w.state, observed_at: w.observed_at, consumed_at: w.consumed_at, instance_id: w.instance_id })) });
    const okReject = !reconciled && sessionUnchanged && trustLogicalUnchanged && !walFramesAdded && !mainChanged && (!ctx.absentMustStay || !existsSync(ctx.absentMustStay));
    const okAccept = reconciled && msgsUntouched && noNewDispatch && trustLogicalUnchanged && !walFramesAdded && !mainChanged;
    rec.verdict = expect === 'reject' ? (okReject ? 'PASS' : 'FAIL') : expect === 'accept' ? (okAccept ? 'PASS' : 'FAIL') : 'OBSERVE';
    if (ctx.absentMustStay) rec.absentStillAbsent = !existsSync(ctx.absentMustStay);
  } catch (e) { rec.verdict = 'UNKNOWN'; rec.harnessError = e.stack; }
  finally { try { f?.store.close(); } catch {} }
  results.push(rec);
  console.log(`${rec.verdict.padEnd(7)} ${name} expect=${expect} reconciled=${rec.reconciled} ${rec.result?.toString().startsWith?.('THROW') ? rec.result : ''} diff=${JSON.stringify(rec.fileDiff ?? {})}`);
}
// child helper: hold a lock on a DB
function holder(dbPath, sql, holdMs) {
  const code = `const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1]);d.exec(process.argv[2]);process.stdout.write('READY\\n');setTimeout(()=>{try{d.exec('ROLLBACK')}catch{};d.close();process.exit(0)},Number(process.argv[3]));`;
  const c = spawn(process.execPath, ['-e', code, dbPath, sql, String(holdMs)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((res, rej) => { c.stdout.once('data', () => res(c)); c.once('exit', code => rej(new Error('holder exited ' + code))); });
}

// ---------- control ----------
await run('control-valid', 'accept');
await run('control-replay-second-call', 'accept', () => ({ second: true }));
// ---------- MAC / signature ----------
await run('mac-flip-one-char', 'reject', f => mutateReceipt(f, r => { r.integrityToken = (r.integrityToken[0] === 'A' ? 'B' : 'A') + r.integrityToken.slice(1); }, { resign: false }));
await run('mac-truncated', 'reject', f => mutateReceipt(f, r => { r.integrityToken = r.integrityToken.slice(0, 20); }, { resign: false }));
await run('mac-missing', 'reject', f => mutateReceipt(f, r => { delete r.integrityToken; }, { resign: false }));
await run('mac-empty', 'reject', f => mutateReceipt(f, r => { r.integrityToken = ''; }, { resign: false }));
await run('mac-field-changed-not-resigned', 'reject', f => mutateReceipt(f, r => { r.eventId = 'wake-hook-other'; }, { resign: false }));
// ---------- target ----------
await run('target-payload-session', 'reject', f => ({ target: { ...target, sessionId: 'other-session' } }));
await run('target-payload-host', 'reject', f => ({ target: { host: 'other-host', sessionId: target.sessionId } }));
await run('target-receipt-session-resigned', 'reject', f => mutateReceipt(f, r => { r.sessionId = 'other-session'; }));
await run('target-receipt-host-resigned', 'reject', f => mutateReceipt(f, r => { r.host = 'other-host'; }));
await run('target-payload-extra-field', 'reject', f => ({ rawPayload: { target: { ...target, instanceId: 'instance-1' }, attemptId: f.attemptId, sourceReceiptId: f.sourceReceiptId } }));
// ---------- nonce ----------
await run('nonce-row-changed', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET nonce=?').run('forged-nonce-abcdefghijklmnopq'); });
await run('nonce-row-and-digest-changed-consistently', 'reject', f => { const n = 'forged-nonce-abcdefghijklmnopq'; f.store.database.prepare('UPDATE wake_nonces SET nonce=?, nonce_digest=?').run(n, createHash('sha256').update(n).digest('hex')); });
await run('nonce-row-null', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET nonce=NULL').run(); });
await run('nonce-receipt-for-other-nonce', 'reject', f => { const obs = { ...f.observation, wakeCandidates: ['other-nonce-abcdefghijklmnopqr'] }; return { receiptId: recordWakeHookObservation(obs, f.now + 10) }; });
await run('nonce-receipt-multi-candidate', 'reject', f => { const obs = { ...f.observation, wakeCandidates: [f.attempt.nonce, 'other-nonce-abcdefghijklmnopqr'] }; return { receiptId: recordWakeHookObservation(obs, f.now + 10) }; });
// ---------- digest ----------
await run('digest-altered-resigned', 'reject', f => mutateReceipt(f, r => { r.contentDigest = 'sha256:' + 'a'.repeat(64); }));
await run('digest-missing-resigned', 'reject', f => mutateReceipt(f, r => { delete r.contentDigest; }));
await run('digest-uppercase-resigned', 'reject', f => mutateReceipt(f, r => { r.contentDigest = r.contentDigest.toUpperCase(); }));
await run('digest-other-normalization-actor', 'reject', f => mutateReceipt(f, r => { r.contentDigest = 'sha256:' + createHash('sha256').update(JSON.stringify(['x'])).digest('hex'); }));
// ---------- observed time ----------
await run('observed-before-start-1ms', 'reject', f => { const r = f.store.database.prepare('SELECT started_at FROM wake_nonces').get(); mutateReceipt(f, x => { x.observedAt = iso(Date.parse(r.started_at) - 1); }); });
await run('observed-equals-start', 'accept', f => { const r = f.store.database.prepare('SELECT started_at FROM wake_nonces').get(); mutateReceipt(f, x => { x.observedAt = r.started_at; }); });
await run('observed-equals-late', 'accept', f => mutateReceipt(f, x => { x.observedAt = iso(f.now + 11); }));
await run('observed-late+1ms', 'reject', f => mutateReceipt(f, x => { x.observedAt = iso(f.now + 12); }));
await run('observed-future', 'reject', f => mutateReceipt(f, x => { x.observedAt = iso(Date.now() + 3_600_000); x.expiresAt = iso(Date.now() + 3_600_000 + 30_000); }));
await run('observed-missing', 'reject', f => mutateReceipt(f, x => { delete x.observedAt; }));
await run('observed-nonISO-parseable', 'OBSERVE', f => mutateReceipt(f, x => { x.observedAt = new Date(f.now + 10).toUTCString(); }));
await run('observed-offset-format-+00:00', 'OBSERVE', f => mutateReceipt(f, x => { x.observedAt = x.observedAt.replace('Z', '+00:00'); }));
await run('late-row-future', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET late_observed_at=?').run(iso(Date.now() + 3_600_000)); });
// ---------- TTL boundaries (expiresAt vs now; expiresAt vs late) ----------
for (const [label, d, exp] of [['now=expires-1ms', -1, 'reject'], ['now=expires', 0, 'accept'], ['now=expires+1ms', 1, 'accept']]) {
  await run(`ttl-${label}`, exp, f => { const r = receiptOf(f); return { nowMs: Date.parse(r.expiresAt) + d }; });
}
for (const [label, d, exp] of [['expires=late-1ms', -1, 'reject'], ['expires=late', 0, 'reject'], ['expires=late+1ms', 1, 'accept']]) {
  await run(`ttl-${label}`, exp, f => mutateReceipt(f, x => { x.expiresAt = iso(f.now + 11 + d); }));
}
await run('ttl-not-expired-future', 'reject', f => mutateReceipt(f, x => { x.expiresAt = iso(Date.now() + 60_000); }));
await run('ttl-expires-missing', 'reject', f => mutateReceipt(f, x => { delete x.expiresAt; }));
// ---------- generation ----------
await run('gen-row-is-current-instance', 'reject', f => { const p = f.store.database.prepare("SELECT started_at FROM session_presence WHERE instance_id='instance-2'").get(); f.store.database.prepare("UPDATE wake_nonces SET instance_id='instance-2', birth_generation=?").run(p.started_at); });
await run('gen-no-current-presence', 'reject', f => { f.store.database.prepare('DELETE FROM session_presence').run(); });
await run('gen-current-deleted-old-remains', 'reject', f => { f.store.database.prepare("DELETE FROM session_presence WHERE instance_id='instance-2'").run(); });
await run('gen-row-birth-null', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET birth_generation=NULL').run(); });
await run('gen-epoch-zero', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET dispatch_epoch=0').run(); });
await run('gen-row-state-submitted', 'reject', f => { f.store.database.prepare("UPDATE wake_nonces SET state='submitted'").run(); });
await run('gen-row-late-null', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET late_observed_at=NULL').run(); });
await run('gen-row-already-consumed', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET consumed_at=?').run(iso(f.now + 12)); });
await run('gen-started-at-after-observed', 'reject', f => { f.store.database.prepare('UPDATE wake_nonces SET started_at=?').run(iso(f.now + 10 + 1)); });
// ---------- key ----------
await run('key-missing-row', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.prepare('DELETE FROM trust_metadata').run(); db.close(); });
await run('key-rotated-not-resigned', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.prepare("UPDATE trust_metadata SET value=? WHERE key='trust-signing-key'").run(randomBytes(32).toString('base64url')); db.close(); });
await run('key-other-key-signed-receipt', 'reject', f => mutateReceipt(f, () => {}, { key: randomBytes(32).toString('base64url') }));
await run('key-16byte-and-resigned', 'reject', f => { const k = randomBytes(16).toString('base64url'); const db = new DatabaseSync(f.trustPath); db.prepare("UPDATE trust_metadata SET value=? WHERE key='trust-signing-key'").run(k); db.close(); mutateReceipt(f, () => {}, { key: k }); });
await run('key-renamed-id', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.prepare("UPDATE trust_metadata SET key='trust-signing-key-v2'").run(); db.close(); });
await run('key-invalid-b64', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.prepare("UPDATE trust_metadata SET value='!!!invalid!!!'").run(); db.close(); });
// ---------- receipt identity / replay ----------
await run('receipt-missing-id', 'reject', f => ({ receiptId: 'source-00000000-0000-0000-0000-000000000000' }));
await run('receipt-json-receiptId-mismatch', 'reject', f => { const r = receiptOf(f); r.receiptId = 'source-11111111-1111-1111-1111-111111111111'; putReceipt(f, r); });
await run('receipt-schemaVersion-changed-resigned', 'reject', f => mutateReceipt(f, x => { x.schemaVersion = '2.0.0'; }));
await run('receipt-adapter-changed-resigned', 'reject', f => mutateReceipt(f, x => { x.attestation.adapter = 'other-hook'; }));
await run('receipt-authority-changed-resigned', 'reject', f => mutateReceipt(f, x => { x.authorityEffect = 'approval-source'; }));
await run('receipt-origin-changed-resigned', 'reject', f => mutateReceipt(f, x => { x.originKind = 'skill-output'; }));
await run('receipt-attestation-missing-resigned', 'reject', f => mutateReceipt(f, x => { delete x.attestation; }));
await run('replay-other-session-receipt', 'reject', f => { const obs = { ...f.observation, sessionId: 'other-session' }; return { receiptId: recordWakeHookObservation(obs, f.now + 10) }; });
await run('replay-after-reconcile-other-attempt-id', 'reject', f => { dispatch(f.store, 'reconcile-wake-observation', { target, attemptId: f.attemptId, sourceReceiptId: f.sourceReceiptId }); return { attemptId: 'other-attempt' }; });
await run('replay-attempt-row-pruned', 'reject', f => { f.store.database.prepare('DELETE FROM wake_nonces').run(); });
// ---------- DB failures ----------
await run('db-trust-missing', 'reject', f => { rmSync(f.trustPath); return { absentMustStay: f.trustPath }; });
await run('db-trust-dir-missing', 'reject', f => { const p = join(f.dir, 'nodir', 'trust.sqlite3'); process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = p; return { absentMustStay: join(f.dir, 'nodir') }; });
await run('db-trust-file-readonly-0444', 'accept', f => { settle(f); chmodSync(f.trustPath, 0o444); });
await run('db-trust-dir-readonly-0555-no-sidecars', 'OBSERVE', f => { settle(f); chmodSync(f.dir, 0o555); return { after: () => chmodSync(f.dir, 0o755) }; });
await run('db-trust-other-proc-BEGIN-EXCLUSIVE', 'accept', async f => { settle(f); const beforeT = trustLogical(f); const c = await holder(f.trustPath, 'PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; UPDATE trust_metadata SET value=value;', 3000); return { beforeT, noSettle: true, after: () => once(c, 'exit') }; });
await run('db-trust-other-proc-locking_mode-EXCLUSIVE', 'reject', async f => { settle(f); const beforeT = trustLogical(f); const c = await holder(f.trustPath, 'PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE trust_metadata SET value=value;', 3000); return { beforeT, noSettle: true, after: () => once(c, 'exit') }; });
await run('db-session-other-proc-BEGIN-EXCLUSIVE-held-7s', 'reject', async f => { const c = await holder(f.database, 'BEGIN EXCLUSIVE;', 7000); return { after: () => once(c, 'exit') }; });
await run('db-trust-main-header-corrupt', 'reject', f => { settle(f); const b = readFileSync(f.trustPath); b.write('XXXXXXXXXXXXXXXX', 0); writeFileSync(f.trustPath, b); });
await run('db-trust-user_version-99', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.exec('PRAGMA user_version=99'); db.close(); });
await run('db-trust-table-renamed', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.exec('ALTER TABLE input_source_receipts RENAME TO x_receipts'); db.close(); });
await run('db-trust-column-renamed', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.exec('ALTER TABLE input_source_receipts RENAME COLUMN receipt_json TO receipt_blob'); db.close(); });
await run('db-trust-metadata-dropped', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.exec('DROP TABLE trust_metadata'); db.close(); });
await run('db-trust-receipt-json-garbage', 'reject', f => { const db = new DatabaseSync(f.trustPath); db.prepare('UPDATE input_source_receipts SET receipt_json=?').run('{not json'); db.close(); });
// WAL: receipt present only in WAL (copy taken while another connection kept WAL un-checkpointed)
async function walCopy(f, corrupt) {
  f.store.close();
  const src = f.dir; const tmp = join(ROOT, f.name + '-src'); rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
  // rebuild: fresh trust in tmp with a pinned reader, then record receipt so it lives only in WAL
  const tp = join(tmp, 'trust.sqlite3'); process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = tp;
  recordWakeHookObservation({ ...f.observation, sessionId: 'warmup' }, f.now);  // creates db + key (checkpointed on close)
  const pin = new DatabaseSync(tp); pin.exec('PRAGMA wal_autocheckpoint=0'); pin.prepare('SELECT count(*) FROM trust_metadata').get();
  const id = recordWakeHookObservation(f.observation, f.now + 10);
  for (const n of readdirSync(src).filter(n => n.startsWith('trust'))) rmSync(join(src, n));
  copyFileSync(tp, f.trustPath); copyFileSync(tp + '-wal', f.trustPath + '-wal');
  pin.close();
  const walSize = statSync(f.trustPath + '-wal').size;
  if (corrupt === 'frame-byte') { const b = readFileSync(f.trustPath + '-wal'); b[b.length - 100] ^= 0xff; writeFileSync(f.trustPath + '-wal', b); }
  if (corrupt === 'header') { const b = readFileSync(f.trustPath + '-wal'); b.write('JUNK', 0); writeFileSync(f.trustPath + '-wal', b); }
  if (corrupt === 'truncate-mid-frame') { const b = readFileSync(f.trustPath + '-wal'); writeFileSync(f.trustPath + '-wal', b.subarray(0, b.length - 500)); }
  if (corrupt === 'append-garbage') appendFileSync(f.trustPath + '-wal', randomBytes(4096));
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = f.trustPath;
  f.store = new SessionMessageStore(f.database);
  return { receiptId: id, noSettle: true, walSize };
}
await run('wal-control-receipt-only-in-wal', 'accept', f => walCopy(f, null));
await run('wal-corrupt-last-frame-byte', 'reject', f => walCopy(f, 'frame-byte'));
await run('wal-corrupt-header', 'reject', f => walCopy(f, 'header'));
await run('wal-truncated-mid-frame', 'reject', f => walCopy(f, 'truncate-mid-frame'));
await run('wal-append-garbage', 'accept', f => walCopy(f, 'append-garbage'));
writeFileSync(process.env.MATRIX_OUT ?? '/tmp/ev/matrix-results.json', JSON.stringify(results, null, 1));
const tally = results.reduce((a, r) => (a[r.verdict] = (a[r.verdict] ?? 0) + 1, a), {}); console.log('TALLY', JSON.stringify(tally));
