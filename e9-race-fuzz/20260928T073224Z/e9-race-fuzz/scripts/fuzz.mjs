// Controller: node --import tsx fuzz.mjs <impl:e9|v53> <mode:mixed|readonly|missing> <seedFrom> <seedTo> <Ns comma> <outDir>
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const [impl, mode, seedFrom, seedTo, nsArg, outDir, keepArg] = process.argv.slice(2);
const ROOT = impl === 'e9' ? '/tmp/e9' : '/tmp/v53';
const imp = p => import(pathToFileURL(`${ROOT}/mcp-server/src/${p}`).href);
const { SessionMessageStore } = await imp('session-message-store.ts');
const { dispatchSessionMessageBrokerOperation: dispatch } = await imp('session-message-broker.ts');
const wakePort = await imp('session-message-wake-port.ts');
const { TrustStore } = await imp('trust-store.ts');
const Ns = nsArg.split(',').map(Number);
mkdirSync(outDir, { recursive: true });
const digest = n => createHash('sha256').update(n).digest('hex');
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const presenceInput = (target, instanceId) => ({ ...target, instanceId, transport: 'portable', wakeVisibility: 'silent',
  canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } });
const obsFor = (target, nonces) => ({ host: target.host, sessionId: target.sessionId, kind: 'user-input', wakeOnly: true,
  wakeCandidates: nonces, actor: { kind: 'unknown', assurance: 'unknown', observedBy: `${target.host}:hook-payload` } });

const OPS = {
  mixed: [['reconcile', 5], ['reconcile-bad', 2], ['gen-change', 1], ['end-presence', 1], ['relay-cycle', 6], ['hook-current', 5],
    ['hook-old', 1], ['late-outcome-old', 2], ['late-outcome-mine', 2], ['send', 2], ['read-only', 2]],
  readonly: [['reconcile', 5], ['reconcile-bad', 3], ['read-only', 5], ['late-outcome-old', 1], ['gen-change', 1]],
  missing: [['reconcile', 6], ['reconcile-bad', 2], ['read-only', 3], ['gen-change', 1], ['late-outcome-old', 1], ['send', 1]],
};
const VALID = new Set(['valid', 'current-gen', 'actor-main']);

// ---------- worker pool ----------
const pool = [];
for (let i = 0; i < Math.max(...Ns); i++) {
  const child = fork(new URL('./worker.mjs', import.meta.url), [], { cwd: ROOT, execArgv: ['--import', 'tsx'],
    env: { ...process.env, FUZZ_ROOT: ROOT, FUZZ_IMPL: impl }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  const ready = new Promise(r => child.once('message', r)); pool.push({ child, ready });
}
await Promise.all(pool.map(p => p.ready));
const waitMsg = (child, type) => new Promise(r => { const f = m => { if (m.type === type) { child.off('message', f); r(m); } }; child.on('message', f); });

function seedTarget(store, dir, i, variant, T0, trustPath, rnd) {
  const target = { host: 'portable', sessionId: `wt-${i}` };
  store.startPresence(presenceInput(target, 'inst-1'), T0);
  store.acquireRelay({ ...target, transport: 'portable', relayId: 'relay-seed', pid: process.pid, parentPid: process.pid }, T0);
  store.send({ sender: { host: 'portable', sessionId: 'seed-sender' }, target, messageId: `seedmsg-${i}-x`, body: 'seed body' }, T0);
  const nonce = randomBytes(18).toString('base64url');
  const reserved = store.reserveManagedWake({ ...target, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-seed', nonce }, T0);
  const attempt = store.startManagedWake(reserved.attempt, T0 + 1).attempt;
  store.recordManagedWakeOutcome(attempt, 'accepted-or-unknown', T0 + 2);
  if (variant !== 'current-gen') store.startPresence(presenceInput(target, 'inst-2'), T0 + 5);
  let sourceReceiptId;
  const other = randomBytes(18).toString('base64url');
  if (variant === 'no-receipt') sourceReceiptId = `source-${randomBytes(8).toString('hex')}`;
  else if (variant === 'wrong-digest') sourceReceiptId = wakePort.recordWakeHookObservation(obsFor(target, [other]), T0 + 10);
  else if (variant === 'multi-nonce') sourceReceiptId = wakePort.recordWakeHookObservation(obsFor(target, [nonce, other]), T0 + 10);
  else if (variant === 'actor-main') sourceReceiptId = wakePort.recordWakeHookObservation({ ...obsFor(target, [nonce]), actor: { kind: 'main', assurance: 'observed', observedBy: 'portable:hook-payload' } }, T0 + 10);
  else if (variant === 'before-start') sourceReceiptId = wakePort.recordWakeHookObservation(obsFor(target, [nonce]), T0);
  else if (variant === 'not-expired') {
    const rid = wakePort.recordWakeHookObservation(obsFor(target, [nonce]), T0 + 10);
    const trust = new TrustStore(trustPath);
    try {
      const r = trust.getInputSource(rid);
      const input = Object.fromEntries(Object.entries(r).filter(([k]) => !['schemaVersion', 'receiptId', 'integrityToken'].includes(k)));
      sourceReceiptId = trust.recordInputSource({ ...input, eventId: `ne-${randomBytes(6).toString('hex')}`, expiresAt: new Date(Date.now() + 3_600_000).toISOString() }).receiptId;
    } finally { trust.close(); }
  } else sourceReceiptId = wakePort.recordWakeHookObservation(obsFor(target, [nonce]), T0 + 10);
  const lateAt = variant === 'no-late' ? null : new Date(T0 + 11).toISOString();
  if (lateAt) store.database.prepare("UPDATE wake_nonces SET late_observed_at = ? WHERE nonce_digest = ? AND state = 'unknown'").run(lateAt, digest(nonce));
  const row = store.database.prepare('SELECT started_at FROM wake_nonces WHERE nonce_digest = ?').get(digest(nonce));
  return { target, variant, attempt, sourceReceiptId, startedAt: row.started_at, lateAt };
}

const AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS zz_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, op TEXT, digest TEXT, nonce TEXT, sid TEXT, attempt TEXT,
  o_state TEXT, n_state TEXT, o_epoch INT, n_epoch INT, o_obs TEXT, n_obs TEXT, o_cons TEXT, n_cons TEXT, o_late TEXT, n_late TEXT,
  o_out TEXT, n_out TEXT, o_relay TEXT, n_relay TEXT, o_inst TEXT, n_inst TEXT, o_gen TEXT, n_gen TEXT, o_started TEXT, n_started TEXT,
  o_retry TEXT, n_retry TEXT, ts TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')));
CREATE TRIGGER IF NOT EXISTS zz_wi AFTER INSERT ON wake_nonces BEGIN INSERT INTO zz_audit (op, digest, nonce, sid, attempt, n_state, n_epoch, n_obs, n_cons, n_late, n_out, n_relay, n_inst, n_gen, n_started, n_retry)
  VALUES ('I', NEW.nonce_digest, NEW.nonce, NEW.session_id, NEW.attempt_id, NEW.state, NEW.dispatch_epoch, NEW.observed_at, NEW.consumed_at, NEW.late_observed_at, NEW.outcome_at, NEW.relay_id, NEW.instance_id, NEW.birth_generation, NEW.started_at, NEW.retry_not_before); END;
CREATE TRIGGER IF NOT EXISTS zz_wu AFTER UPDATE ON wake_nonces BEGIN INSERT INTO zz_audit (op, digest, nonce, sid, attempt, o_state, n_state, o_epoch, n_epoch, o_obs, n_obs, o_cons, n_cons, o_late, n_late, o_out, n_out, o_relay, n_relay, o_inst, n_inst, o_gen, n_gen, o_started, n_started, o_retry, n_retry)
  VALUES ('U', NEW.nonce_digest, NEW.nonce, NEW.session_id, NEW.attempt_id, OLD.state, NEW.state, OLD.dispatch_epoch, NEW.dispatch_epoch, OLD.observed_at, NEW.observed_at, OLD.consumed_at, NEW.consumed_at, OLD.late_observed_at, NEW.late_observed_at, OLD.outcome_at, NEW.outcome_at, OLD.relay_id, NEW.relay_id, OLD.instance_id, NEW.instance_id, OLD.birth_generation, NEW.birth_generation, OLD.started_at, NEW.started_at, OLD.retry_not_before, NEW.retry_not_before); END;
CREATE TRIGGER IF NOT EXISTS zz_wd AFTER DELETE ON wake_nonces BEGIN INSERT INTO zz_audit (op, digest, nonce, sid, attempt, o_state) VALUES ('D', OLD.nonce_digest, OLD.nonce, OLD.session_id, OLD.attempt_id, OLD.state); END;`;

const TERMINAL = new Set(['observed', 'not-submitted']); const ACTIVE = new Set(['reserved', 'started', 'submitted', 'unknown']);
const FIELDS = ['state', 'epoch', 'obs', 'cons', 'late', 'out', 'relay', 'inst', 'gen', 'started', 'retry'];
function dumpMsgDb(db) {
  const q = s => db.prepare(s).all();
  return JSON.stringify({ wake: q('SELECT * FROM wake_nonces ORDER BY nonce_digest'), messages: q('SELECT * FROM messages ORDER BY message_id'),
    presence: q('SELECT * FROM session_presence ORDER BY host, session_id, instance_id'), relays: q('SELECT * FROM relay_leases ORDER BY session_id'),
    observations: q('SELECT * FROM input_observations ORDER BY host, session_id'), audit: q('SELECT count(*) AS n FROM zz_audit') });
}
function trustState(trustPath) {
  if (!existsSync(trustPath)) return { exists: false };
  const db = new DatabaseSync(trustPath, { readOnly: true });
  try {
    const safe = s => { try { return db.prepare(s).all(); } catch (e) { return `ERR:${e.message}`; } };
    return { exists: true, meta: safe('SELECT * FROM trust_metadata ORDER BY key'), schema: safe('SELECT type, name, sql FROM sqlite_schema ORDER BY name'),
      receipts: safe('SELECT receipt_id FROM input_source_receipts ORDER BY receipt_id') };
  } finally { db.close(); }
}
function fileSnap(dir) {
  const out = {};
  for (const name of readdirSync(dir).filter(n => n.startsWith('trust.sqlite3'))) {
    const b = readFileSync(join(dir, name)); out[name] = { size: b.length, sha: createHash('sha256').update(b).digest('hex') };
  }
  return out;
}

function evaluate(ctx) {
  const v = [];
  const { audit, effects, logs, targets } = ctx;
  const bySid = Object.fromEntries(targets.map(t => [t.target.sessionId, t]));
  // (a) replay
  const state = new Map();
  for (const e of audit) {
    if (e.op === 'D') state.delete(e.digest); else state.set(e.digest, { sid: e.sid, state: e.n_state });
    const counts = {};
    for (const s of state.values()) if (ACTIVE.has(s.state)) counts[s.sid] = (counts[s.sid] ?? 0) + 1;
    for (const [sid, n] of Object.entries(counts)) if (n > 1) v.push({ inv: 'a', seq: e.seq, sid, n });
  }
  // (b) (f)
  for (const e of audit) if (e.op === 'U') {
    const changed = FIELDS.filter(f => String(e[`o_${f}`]) !== String(e[`n_${f}`]));
    if (TERMINAL.has(e.o_state) && ACTIVE.has(e.n_state)) v.push({ inv: 'b', seq: e.seq, attempt: e.attempt, from: e.o_state, to: e.n_state });
    if (TERMINAL.has(e.o_state) && changed.length) v.push({ inv: 'f', seq: e.seq, attempt: e.attempt, why: 'terminal-row-changed', changed });
    if (e.o_late !== null && e.o_out !== e.n_out) v.push({ inv: 'f', seq: e.seq, attempt: e.attempt, why: 'late-row-outcome-changed' });
    if (e.o_late !== null && ACTIVE.has(e.n_state) && e.o_state !== e.n_state) v.push({ inv: 'f', seq: e.seq, attempt: e.attempt, why: 'late-row-state-to-active', from: e.o_state, to: e.n_state });
  }
  for (const l of logs) if (l.op === 'late-outcome-old' && l.result === true && bySid[l.sid]?.lateAt) v.push({ inv: 'f', why: 'late-outcome-accepted-on-late-row', log: l });
  // (c) reconcile attribution
  const recAudit = audit.filter(e => e.op === 'U' && e.o_state === 'unknown' && e.n_state === 'observed' && e.n_obs !== e.n_cons);
  const recLog = logs.filter(l => (l.op === 'reconcile' || l.op === 'reconcile-bad') && l.result?.reconciled === true);
  if (recAudit.length !== recLog.length) v.push({ inv: 'c', why: 'reconcile-count-mismatch', audit: recAudit.length, log: recLog.length });
  for (const l of recLog) {
    if (l.result.evidence?.oldBinding?.attemptId !== l.payload.attemptId || l.result.evidence?.oldBinding?.sessionId !== l.payload.target.sessionId)
      v.push({ inv: 'c', why: 'evidence-binding-mismatch', log: l });
    if (!recAudit.some(e => e.attempt === l.payload.attemptId)) v.push({ inv: 'c', why: 'no-audit-for-reconcile', log: l });
  }
  for (const e of recAudit) {
    if (e.o_late !== e.n_late || e.o_out !== e.n_out || e.o_epoch !== e.n_epoch || e.o_gen !== e.n_gen) v.push({ inv: 'c', why: 'reconcile-changed-extra-fields', seq: e.seq });
    if (!(e.n_obs <= e.o_late)) v.push({ inv: 'c', why: 'observed-after-late', seq: e.seq });
  }
  const hookNonces = new Set(logs.filter(l => l.op?.startsWith('hook-') && l.nonce).map(l => l.nonce));
  for (const e of audit) if (e.op === 'U' && e.o_state !== 'observed' && e.n_state === 'observed' && e.n_obs === e.n_cons && !hookNonces.has(e.nonce))
    v.push({ inv: 'c', why: 'observed-without-arrival', seq: e.seq, attempt: e.attempt });
  // (d) (e)
  const starts = audit.filter(e => e.op === 'U' && e.n_state === 'started' && e.o_state !== 'started');
  const startKey = new Map(); for (const s of starts) { const k = `${s.attempt}#${s.n_epoch}`; startKey.set(k, (startKey.get(k) ?? 0) + 1); }
  for (const [k, n] of startKey) if (n > 1) v.push({ inv: 'd', why: 'multiple-start-transitions', key: k, n });
  const effKey = new Map(); const nonceAttempt = new Map();
  for (const x of effects) {
    const k = `${x.attemptId}#${x.epoch}`; effKey.set(k, (effKey.get(k) ?? 0) + 1);
    if (nonceAttempt.has(x.nonce) && nonceAttempt.get(x.nonce) !== x.attemptId) v.push({ inv: 'e', why: 'nonce-two-attempts', nonce: x.nonce });
    nonceAttempt.set(x.nonce, x.attemptId);
    if (!startKey.has(k)) v.push({ inv: 'd', why: 'effect-without-start', effect: x });
  }
  for (const [k, n] of effKey) if (n > 1) v.push({ inv: 'e', why: 'duplicate-effect', key: k, n });
  // (d) per target: no effect for an attempt whose generation was already superseded before its start (effect after reconcile/gen change on old binding)
  // (g)
  for (const e of recAudit) if (!VALID.has(bySid[e.sid]?.variant)) v.push({ inv: 'g', why: 'invalid-evidence-reconciled', seq: e.seq, variant: bySid[e.sid]?.variant });
  for (const l of recLog) {
    const t = bySid[l.payload.target.sessionId];
    if (!VALID.has(t?.variant) || l.payload.sourceReceiptId !== t.sourceReceiptId || l.payload.attemptId !== t.attempt.attemptId) v.push({ inv: 'g', why: 'reconcile-success-bad-payload', log: l });
  }
  if (ctx.mode === 'missing') for (const l of recLog) v.push({ inv: 'j', why: 'reconcile-success-without-trust', log: l });
  // (h)
  if (!ctx.h.allFalse) v.push({ inv: 'h', why: 'second-run-reconciled', detail: ctx.h.results });
  if (!ctx.h.unchanged) v.push({ inv: 'h', why: 'second-run-changed-db' });
  // (i)
  if (ctx.trust) {
    const { before, after, hookReceipts } = ctx.trust;
    if (before.exists) {
      if (JSON.stringify(before.meta) !== JSON.stringify(after.meta)) v.push({ inv: 'i', why: 'trust-metadata-changed' });
      if (JSON.stringify(before.schema) !== JSON.stringify(after.schema)) v.push({ inv: 'i', why: 'trust-schema-changed' });
      if (Array.isArray(after.receipts)) {
        const allowed = new Set([...(Array.isArray(before.receipts) ? before.receipts.map(r => r.receipt_id) : []), ...hookReceipts]);
        const extra = after.receipts.map(r => r.receipt_id).filter(id => !allowed.has(id));
        if (extra.length) v.push({ inv: 'i', why: 'unexpected-receipts', extra });
      }
    }
    if (ctx.files) {
      const { fb, fa } = ctx.files;
      for (const [name, s] of Object.entries(fb)) if (!name.endsWith('-shm') && (!fa[name] || fa[name].sha !== s.sha)) v.push({ inv: 'i', why: 'trust-file-bytes-changed', name, before: s, after: fa[name] ?? null });
      for (const [name, s] of Object.entries(fa)) if (!fb[name] && name.endsWith('-wal') && s.size > 32) v.push({ inv: 'i', why: 'new-wal-frames', name, size: s.size });
    }
  }
  if (ctx.mode === 'missing') {
    const { before, after } = ctx.trust;
    if (!before.exists && after.exists) v.push({ inv: 'j', why: 'trust-db-created' });
    if (!before.exists && Object.keys(ctx.files.fa).length) v.push({ inv: 'j', why: 'trust-sidecar-created', files: ctx.files.fa });
    if (before.exists && JSON.stringify(before.meta) !== JSON.stringify(after.meta)) v.push({ inv: 'j', why: 'key-created-or-changed' });
  }
  for (const l of logs) if (l.fatal) v.push({ inv: 'harness', why: 'worker-fatal', log: l });
  return v;
}

const summaryPath = join(outDir, 'summary.jsonl');
for (let seed = Number(seedFrom); seed <= Number(seedTo); seed++) for (const n of Ns) {
  const rnd = mulberry32(seed * 7 + n);
  const dir = mkdtempSync(join(tmpdir(), `fz-${impl}-${mode}-`));
  const database = join(dir, 'session-messages.sqlite3'); const trustPath = join(dir, 'trust.sqlite3');
  process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = trustPath;
  const T0 = Date.now() - 120_000;
  let store = new SessionMessageStore(database);
  const invalid = ['no-late', 'no-receipt', 'wrong-digest', 'multi-nonce', 'not-expired', 'before-start'];
  const variants = ['valid', rnd() < 0.5 ? 'valid' : rnd() < 0.5 ? 'current-gen' : 'actor-main', invalid[Math.floor(rnd() * invalid.length)]];
  const targets = variants.map((variant, i) => seedTarget(store, dir, i, variant, T0, trustPath, rnd));
  store.database.exec(AUDIT_SQL);
  store.close();
  let missingKind = null; let holder = null;
  if (mode === 'missing') {
    missingKind = ['missing-db', 'missing-key', 'bad-key', 'missing-table'][seed % 4];
    if (missingKind === 'missing-db') for (const f of readdirSync(dir).filter(n => n.startsWith('trust.sqlite3'))) rmSync(join(dir, f));
    else {
      const db = new DatabaseSync(trustPath);
      if (missingKind === 'missing-key') db.prepare('DELETE FROM trust_metadata').run();
      if (missingKind === 'bad-key') db.prepare("UPDATE trust_metadata SET value = 'invalid'").run();
      if (missingKind === 'missing-table') db.exec('DROP TABLE input_source_receipts');
      db.close();
    }
  }
  if (mode === 'readonly' && seed % 2 === 1) {
    // keep an independent WAL writer connection open with committed, un-checkpointed frames
    holder = new DatabaseSync(trustPath); holder.exec('PRAGMA wal_autocheckpoint = 0');
    holder.prepare('SELECT count(*) FROM input_source_receipts').get();
    const t = new TrustStore(trustPath);
    try { const r = t.getInputSource(targets[0].sourceReceiptId); t.recordInputSource({ ...Object.fromEntries(Object.entries(r).filter(([k]) => !['schemaVersion', 'receiptId', 'integrityToken'].includes(k))), eventId: `hold-${seed}` }); }
    finally { t.close(); }
  }
  const trustBefore = trustState(trustPath); const fb = fileSnap(dir);
  const effects = join(dir, 'effects.jsonl');
  const cfg = { seed, n, database, trustPath, effects, opsPerWorker: mode === 'mixed' ? 24 : 12, ops: OPS[mode],
    targets: targets.map(t => ({ target: t.target, attempt: t.attempt, sourceReceiptId: t.sourceReceiptId, startedAt: t.startedAt, lateAt: t.lateAt })) };
  const workers = pool.slice(0, n);
  const armed = workers.map(p => waitMsg(p.child, 'armed'));
  const done = workers.map(p => waitMsg(p.child, 'done'));
  workers.forEach((p, w) => p.child.send({ type: 'run', worker: w, cfg }));
  await Promise.all(armed);
  workers.forEach(p => p.child.send({ type: 'go' }));
  const logs = (await Promise.all(done)).flatMap(m => m.log);
  const fa = fileSnap(dir); // before any controller/holder connection closes (a read-write close may checkpoint)
  // (h) second reconcile of every seeded payload, from the controller
  store = new SessionMessageStore(database);
  // pass 1 may legitimately reconcile (e.g. a late generation change made a row eligible); logged as controller ops.
  const runPass = () => targets.map(t => {
    const payload = { target: t.target, attemptId: t.attempt.attemptId, sourceReceiptId: t.sourceReceiptId };
    try { return { payload, result: dispatch(store, 'reconcile-wake-observation', payload) }; } catch (e) { return { payload, error: e.message }; }
  });
  if (impl === 'e9') for (const x of runPass()) logs.push({ w: 'controller', i: 'pass1', op: 'reconcile', sid: x.payload.target.sessionId, ...x });
  const pre = dumpMsgDb(store.database); const results = impl === 'e9' ? runPass().map(x => x.result ?? { error: x.error }) : [];
  const post = dumpMsgDb(store.database);
  const audit = store.database.prepare('SELECT * FROM zz_audit ORDER BY seq').all();
  const finalRows = store.database.prepare('SELECT * FROM wake_nonces').all();
  store.close();
  if (holder) holder.close();
  const trustAfter = trustState(trustPath);
  const effectLines = existsSync(effects) ? readFileSync(effects, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const hookReceipts = logs.filter(l => l.receiptId).map(l => l.receiptId);
  const ctx = { mode, audit, effects: effectLines, logs, targets, h: { allFalse: results.every(r => r.reconciled === false), unchanged: pre === post, results },
    trust: { before: trustBefore, after: trustAfter, hookReceipts }, files: mode === 'mixed' ? null : { fb, fa } };
  const violations = evaluate(ctx);
  const errors = logs.filter(l => l.error);
  const stats = { seed, n, impl, mode, variants, missingKind, holder: Boolean(holder), ops: logs.length,
    reconciled: logs.filter(l => l.result?.reconciled === true).length, recAttempts: logs.filter(l => l.op?.startsWith('reconcile') && !l.skipped).length,
    effects: effectLines.length, starts: audit.filter(e => e.n_state === 'started' && e.o_state !== 'started').length,
    lateObserved: audit.filter(e => e.op === 'U' && e.n_state === 'observed' && e.o_state !== 'observed' && e.n_obs === e.n_cons && e.n_late !== null && e.o_late === null).length,
    hookRecognized: logs.filter(l => l.op?.startsWith('hook') && l.result?.recognized).length,
    errors: errors.length, errorKinds: [...new Set(errors.map(e => `${e.op}:${e.error.slice(0, 80)}`))],
    sidecarsCreated: Object.keys(fa).filter(k => !fb[k]), violations: violations.length, invs: [...new Set(violations.map(x => x.inv))] };
  appendFileSync(summaryPath, JSON.stringify(stats) + '\n');
  if (violations.length || errors.length || keepArg === 'keep') {
    const base = join(outDir, `run-${seed}-n${n}`);
    writeFileSync(`${base}.json`, JSON.stringify({ stats, violations, cfg, logs, audit, effects: effectLines, finalRows, trustBefore, trustAfter, fb, fa, h: ctx.h }, null, 1));
  }
  process.stdout.write(`${impl} ${mode} seed=${seed} n=${n} rec=${stats.reconciled} eff=${stats.effects} err=${stats.errors} viol=${violations.length} ${stats.invs.join(',')}\n`);
  rmSync(dir, { recursive: true, force: true });
}
for (const p of pool) p.child.send({ type: 'exit' });
