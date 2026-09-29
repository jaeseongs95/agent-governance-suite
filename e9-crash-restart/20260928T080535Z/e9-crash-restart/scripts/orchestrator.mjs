// One crash/restart trial through the public broker/relay/hook path.
// usage (cwd=<worktree>): node --import tsx orchestrator.mjs '<json {version, worktree, dir, spec, seed, trace}>'
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const cfg = JSON.parse(process.argv[2]);
const { version, worktree, dir, spec = { mode: 'none' }, trace = '' } = cfg;
const src = `${worktree}/mcp-server/src`;
const { requestSessionMessageOnce, waitForSessionMessageBrokerReady } = await import(`${src}/session-message-client.ts`);
const INJECT = '/tmp/ev/scripts/inject.mjs';
const NODE = process.execPath;
const dbPath = join(dir, 'session-messages.sqlite3');
const trustPath = join(dir, 'trust.sqlite3');
const effectsFile = join(dir, 'effects.jsonl');
const receiptsFile = join(dir, 'receipts.jsonl');
const log = [];
const L = (x) => { log.push({ t: new Date().toISOString(), ...x }); };
const digest = (n) => createHash('sha256').update(n).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- baseline (frozen v2.7.1 writes the historical rows) ----------
rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
const b = spawnSync(NODE, ['--import', 'tsx', '/tmp/ev/scripts/baseline271.mjs', dir, ...(cfg.hotTrustWal ? ['hotwal'] : [])], { cwd: '/tmp/v271', encoding: 'utf8' });
if (b.status !== 0 && !(cfg.hotTrustWal && b.signal === 'SIGKILL')) { console.log(JSON.stringify({ harnessError: 'baseline', stderr: b.stderr })); process.exit(2); }
const baseline = JSON.parse(readFileSync(join(dir, 'baseline.json'), 'utf8'));
const A = baseline.targets['wake-A']; const B = baseline.targets['wake-B'];
const hotWalFiles = cfg.hotTrustWal ? ['trust.sqlite3-wal', 'trust.sqlite3-shm'].map((f) => [f, existsSync(join(dir, f)) ? readFileSync(join(dir, f)).length : null]) : null;
let rAPath = trustPath;
if (cfg.hotTrustWal) { const c = join(dir, '..', `${dir.split('/').pop()}-trustcopy`); rmSync(c, { recursive: true, force: true }); mkdirSync(c);
  for (const f of ['trust.sqlite3', 'trust.sqlite3-wal', 'trust.sqlite3-shm']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(c, f));
  rAPath = join(c, 'trust.sqlite3'); }
const rA = (() => { const d = new DatabaseSync(rAPath, { readOnly: !cfg.hotTrustWal }); try { return JSON.parse(d.prepare('SELECT receipt_json FROM input_source_receipts WHERE receipt_id = ?').get(A.sourceReceiptId).receipt_json); } finally { d.close(); } })();
if (cfg.dropTrustShm) rmSync(join(dir, 'trust.sqlite3-shm'), { force: true });
const baselineSchema = schemaOf(dbPath);

function schemaOf(path) {
  const d = new DatabaseSync(path);
  try {
    return { integrity: d.prepare('PRAGMA integrity_check').all().map((r) => r.integrity_check).join(','),
      userVersion: d.prepare('PRAGMA user_version').get().user_version,
      journal: d.prepare('PRAGMA journal_mode').get().journal_mode,
      schema: d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all() };
  } finally { d.close(); }
}
function dumpRows(path) {
  const d = new DatabaseSync(path);
  try {
    return { wake: d.prepare('SELECT rowid AS _rowid, * FROM wake_nonces ORDER BY rowid').all(),
      messages: d.prepare('SELECT message_id, target_session_id, claimed_at, claim_until, delivery_attempts, first_delivered_at, acknowledged_at, expires_at FROM messages ORDER BY created_at').all(),
      presence: d.prepare('SELECT session_id, instance_id, started_at, lease_until, ended_at FROM session_presence ORDER BY session_id, started_at').all() };
  } finally { d.close(); }
}

// ---------- broker supervisor ----------
let brokerIndex = 0; let broker = null; let ready = null; const restarts = []; let stopping = false;
function brokerEnv(kill) {
  const env = { ...process.env, AGENT_GOVERNANCE_TRUST_DB_PATH: trustPath, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: dir,
    AGS_ROLE: `broker#${brokerIndex}` };
  for (const k of ['AGS_KILL_AT', 'AGS_KILL_POINT', 'AGS_KILL_DELAY_US', 'AGS_KILL_LOG', 'AGS_TRACE', 'AGS_SLOW_MS']) delete env[k];
  if (trace) env.AGS_TRACE = trace;
  if (kill) { env.AGS_KILL_AT = String(brokerIndex === 2 ? spec.event2 : spec.event); env.AGS_KILL_LOG = join(dir, brokerIndex === 2 ? 'kill-broker-2.json' : `kill-broker.json`);
    if (spec.delayUs !== undefined) env.AGS_KILL_DELAY_US = String(spec.delayUs); }
  return env;
}
function startBroker() {
  brokerIndex += 1;
  const kill = spec.role === 'broker' && spec.mode !== 'none' && (brokerIndex === 1 || (brokerIndex === 2 && spec.event2 !== undefined));
  const child = spawn(NODE, ['--import', INJECT, `${worktree}/mcp-server/dist/session-message-broker.mjs`, '--state-directory', dir],
    { env: brokerEnv(kill), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (c) => { stderr += c; });
  broker = child;
  child.once('exit', (code, signal) => {
    if (stopping) return;
    L({ ev: 'broker-exit', index: brokerIndex, code, signal, stderr: stderr.slice(0, 500) });
    // Preserve the raw crash image before anything reopens the DB.
    const image = join(dir, `crash-image-${restarts.length + 1}`);
    mkdirSync(image, { recursive: true });
    for (const f of ['session-messages.sqlite3', 'session-messages.sqlite3-wal', 'session-messages.sqlite3-shm', 'trust.sqlite3', 'trust.sqlite3-wal', 'trust.sqlite3-shm']) {
      if (existsSync(join(dir, f))) cpSync(join(dir, f), join(image, f));
    }
    restarts.push({ code, signal, image, at: new Date().toISOString() });
    ready = spec.downMs && restarts.length === 1 ? sleep(spec.downMs).then(() => startBroker()) : startBroker(); ready.catch(() => {});
  });
  const p = waitForSessionMessageBrokerReady(dir, child, 15000).then(() => { L({ ev: 'broker-ready', index: brokerIndex }); });
  p.catch(() => {}); // a startup crash is followed by the exit handler's restart
  return p;
}
async function call(op, payload, { retry = true } = {}) {
  if (trace) appendFileSync(trace, `parent\t-\tstep:${op}\n`);
  let timer = null;
  if (spec.mode === 'timing-parent' && spec.step === currentStep && !timingFired) {
    timingFired = true; const b0 = broker;
    timer = setTimeout(() => { writeFileSync(join(dir, 'kill-broker.json'), JSON.stringify({ role: 'broker', timing: true, step: currentStep, delayMs: spec.delayMs })); b0.kill('SIGKILL'); }, spec.delayMs);
  }
  for (let i = 0; ; i++) {
    const beforeIndex = brokerIndex;
    try {
      await readySafe();
      const r = await requestSessionMessageOnce(op, payload, dir, 5000);
      L({ ev: 'op', op, ok: true, attempt: i, data: r });
      return r;
    } catch (error) {
      if (error?.constructor?.name === 'BrokerRequestRejected') { L({ ev: 'op', op, ok: false, rejected: error.message }); return { rejected: error.message }; }
      L({ ev: 'op', op, ok: false, error: String(error.message), attempt: i });
      await sleep(150); await readySafe();
      if (!retry || i >= 2) return { transportError: String(error.message) };
      if (brokerIndex === beforeIndex) await sleep(300);
    }
  }
}
let timingFired = false; let currentStep = '';
async function readySafe() { for (let i = 0; i < 20; i++) { try { await ready; return; } catch { await sleep(300); } } }

// ---------- workers ----------
let relayCall = 0; let hookCall = 0; const relayIds = {}; const hookResults = []; const relayResults = [];
function runWorker(role, input, killThis) {
  const env = { ...process.env, AGENT_GOVERNANCE_TRUST_DB_PATH: trustPath, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: dir };
  for (const k of ['AGS_KILL_AT', 'AGS_KILL_POINT', 'AGS_KILL_DELAY_US', 'AGS_KILL_LOG', 'AGS_TRACE', 'AGS_SLOW_MS']) delete env[k];
  const index = role === 'relay' ? relayCall : hookCall;
  env.AGS_ROLE = `${role}#${index}`;
  if (trace) env.AGS_TRACE = trace;
  if (killThis) { env.AGS_KILL_LOG = join(dir, `kill-${role}.json`); if (spec.point) env.AGS_KILL_POINT = spec.point; else env.AGS_KILL_AT = String(spec.event); }
  return new Promise((resolve) => {
    const child = spawn(NODE, ['--import', 'tsx', '--import', INJECT, '/tmp/ev/scripts/worker.mjs', JSON.stringify({ ...input, role, worktree, stateDir: dir, effectsFile, receiptsFile })],
      { cwd: worktree, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    child.stdout.on('data', (c) => { out += c; }); child.stderr.on('data', (c) => { err += c; });
    child.once('exit', (code, signal) => {
      let json = null; try { json = JSON.parse(out.trim().split('\n').pop()); } catch { /* none */ }
      resolve({ code, signal, json, stderr: err.slice(0, 800) });
    });
  });
}
async function relayTick(sessionId, instanceId, outcome) {
  if (trace) appendFileSync(trace, `parent\t-\tstep:relay:${sessionId}\n`);
  for (let i = 0; i < 3; i++) {
    relayCall += 1;
    relayIds[sessionId] ??= { gen: 1 };
    const relayId = `relay-${sessionId}-${relayIds[sessionId].gen}`;
    const killThis = spec.role === 'relay' && spec.call === relayCall;
    const r = await runWorker('relay', { target: { host: 'portable', sessionId }, instanceId, relayId, parentPid: process.pid, outcome }, killThis);
    relayResults.push({ call: relayCall, sessionId, instanceId, relayId, ...r });
    L({ ev: 'relay', call: relayCall, sessionId, instanceId, relayId, code: r.code, signal: r.signal, json: r.json });
    if (r.signal === 'SIGKILL') { relayIds[sessionId].gen += 1; return r; } // relay process died; the host starts a new relay later
    if (r.code === 0) return r;
    await sleep(200); await readySafe(); // broker died under it: the relay loop retries next cycle
  }
}
const processedEffects = new Set();
async function hookArrivals() {
  if (trace) appendFileSync(trace, `parent\t-\tstep:hooks\n`);
  const effects = existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  for (const e of effects) {
    if (processedEffects.has(e.nonce)) continue; processedEffects.add(e.nonce);
    hookCall += 1;
    const killThis = spec.role === 'hook' && spec.call === hookCall;
    const afterRestart = restarts.length > 0;
    const r = await runWorker('hook', { target: { host: 'portable', sessionId: e.sessionId }, nonce: e.nonce }, killThis);
    hookResults.push({ call: hookCall, nonce: e.nonce, sessionId: e.sessionId, attemptId: e.attemptId, afterRestart, ...r });
    L({ ev: 'hook', call: hookCall, nonce: e.nonce, code: r.code, signal: r.signal, json: r.json });
  }
}
const claimed = [];
async function ackAll(sessionId) {
  const ids = hookResults.filter((h) => h.sessionId === sessionId && h.json?.result?.messages).flatMap((h) => h.json.result.messages.map((m) => m.messageId));
  for (const id of ids) claimed.push({ sessionId, id });
  const unique = [...new Set(ids)];
  if (unique.length) return call('acknowledge', { target: { host: 'portable', sessionId }, messageIds: unique });
  return null;
}

// ---------- scenario ----------
const presence = (sessionId, instanceId) => ({ target: { host: 'portable', sessionId }, instanceId, transport: 'portable',
  wakeVisibility: 'silent', canWakeSilently: true, supportedInjection: ['peer-wake'], idleWake: 'silent' });
const reconcileResults = [];
async function step(name, fn) { currentStep = name; L({ ev: 'step', name }); if (trace) appendFileSync(trace, `parent\t-\tSTEP ${name}\n`); return fn(); }
let aRowAfterS21Before = null;
try {
  await step('S00-broker-start', async () => { ready = startBroker(); for (let i = 0; i < 5; i++) { try { await ready; break; } catch { await sleep(300); } } });
  await step('S01-presence-A3', () => call('presence-start', presence('wake-A', 'instance-3')));
  await step('S02-presence-B3', () => call('presence-start', presence('wake-B', 'instance-3')));
  await step('S03-relay-A-latched', () => relayTick('wake-A', 'instance-3', cfg.outcome ?? 'submitted'));
  await step('S04-reconcile-A', async () => reconcileResults.push({ s: 'S04', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-A' }, attemptId: A.attemptId, sourceReceiptId: A.sourceReceiptId }) }));
  await step('S05-reconcile-A-again', async () => reconcileResults.push({ s: 'S05', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-A' }, attemptId: A.attemptId, sourceReceiptId: A.sourceReceiptId }) }));
  await step('S06-reconcile-B-foreign', async () => reconcileResults.push({ s: 'S06', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-B' }, attemptId: B.attemptId, sourceReceiptId: A.sourceReceiptId }) }));
  await step('S07-reconcile-B-bogus', async () => reconcileResults.push({ s: 'S07', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-B' }, attemptId: B.attemptId, sourceReceiptId: 'source-00000000-0000-0000-0000-000000000000' }) }));
  await step('S08-relay-A', () => relayTick('wake-A', 'instance-3', cfg.outcome ?? 'submitted'));
  await step('S09-hooks', () => hookArrivals());
  await step('S10-ack-A', () => ackAll('wake-A'));
  await step('S11-presence-D1', () => call('presence-start', presence('wake-D', 'instance-1')));
  const prepared = await step('S12-prepare-D', () => call('prepare', { sender: { host: 'portable', sessionId: 'sender-x' }, target: { host: 'portable', sessionId: 'wake-D' }, body: 'body D1' }));
  await step('S13-send-D', () => prepared?.messageId ? call('send', { sender: { host: 'portable', sessionId: 'sender-x' }, messageId: prepared.messageId }) : null);
  await step('S14-relay-D1', () => relayTick('wake-D', 'instance-1', cfg.outcomeD ?? 'accepted-or-unknown'));
  await step('S15-presence-D2', () => call('presence-start', presence('wake-D', 'instance-2')));
  await step('S16-hooks', () => hookArrivals());
  await step('S17-relay-D2', () => relayTick('wake-D', 'instance-2', cfg.outcome ?? 'submitted'));
  await step('S18-hooks', () => hookArrivals());
  await step('S19-ack-D', () => ackAll('wake-D'));
  await step('S20-relay-final', async () => { await relayTick('wake-A', 'instance-3', 'submitted'); await relayTick('wake-D', 'instance-2', 'submitted'); await hookArrivals(); });
  await step('S21-reconcile-final', async () => {
    aRowAfterS21Before = dumpRows(dbPath).wake.find((r) => r.attempt_id === A.attemptId);
    reconcileResults.push({ s: 'S21', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-A' }, attemptId: A.attemptId, sourceReceiptId: A.sourceReceiptId }) });
    reconcileResults.push({ s: 'S21b', r: await call('reconcile-wake-observation', { target: { host: 'portable', sessionId: 'wake-B' }, attemptId: B.attemptId, sourceReceiptId: A.sourceReceiptId }) });
  });
} catch (error) { L({ ev: 'harness-error', error: String(error.stack ?? error) }); }
const wakeStatus = {};
for (const s of ['wake-A', 'wake-B', 'wake-D']) wakeStatus[s] = await call('wake-status', { target: { host: 'portable', sessionId: s } });
stopping = true; broker.kill('SIGTERM'); await once(broker, 'exit').catch(() => {});

// ---------- evaluation ----------
const final = dumpRows(dbPath); const finalSchema = schemaOf(dbPath); const trustSchema = schemaOf(trustPath);
const effects = existsSync(effectsFile) ? readFileSync(effectsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const receipts = existsSync(receiptsFile) ? readFileSync(receiptsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const killFile = ['broker', 'relay', 'hook'].map((r) => join(dir, `kill-${r}.json`)).find(existsSync);
const kill = killFile ? JSON.parse(readFileSync(killFile, 'utf8')) : null;
const images = restarts.map((r) => { try { return { ...r, schema: schemaOf(join(r.image, 'session-messages.sqlite3')), trust: existsSync(join(r.image, 'trust.sqlite3')) ? schemaOf(join(r.image, 'trust.sqlite3')) : null, rows: dumpRows(join(r.image, 'session-messages.sqlite3')) }; } catch (e) { return { ...r, error: String(e.message) }; } });
const byDigest = new Map(final.wake.map((r) => [r.nonce_digest, r]));
const aRow = final.wake.find((r) => r.attempt_id === A.attemptId); const bRow = final.wake.find((r) => r.attempt_id === B.attemptId);
const checks = {}; const V = (k, ok, detail) => { (checks[k] ??= { verdict: 'PASS', details: [] }); if (ok === null) { if (checks[k].verdict === 'PASS' && checks[k].details.length === 0) checks[k].verdict = 'NA'; checks[k].details.push(detail); return; } if (!ok) { checks[k].verdict = 'FAIL'; checks[k].details.push(detail); } };
// (a)
V('a_integrity', finalSchema.integrity === 'ok' && trustSchema.integrity === 'ok', { final: finalSchema.integrity, trust: trustSchema.integrity });
for (const im of images) V('a_integrity', im.schema?.integrity === 'ok' && (im.trust === null || im.trust.integrity === 'ok'), { image: im.image, s: im.schema?.integrity, t: im.trust?.integrity, err: im.error });
// (b) receipts attach to the right attempt; no effect duplication
const effectsByNonce = {}; for (const e of effects) (effectsByNonce[e.nonce] ??= []).push(e);
for (const [n, es] of Object.entries(effectsByNonce)) V('b_reattach', es.length === 1, { dupEffectNonce: n, count: es.length });
const effectsByAttempt = {}; for (const e of effects) (effectsByAttempt[e.attemptId] ??= []).push(e);
for (const [a, es] of Object.entries(effectsByAttempt)) V('b_reattach', es.length === 1, { dupEffectAttempt: a, count: es.length });
for (const e of effects) V('b_reattach', e.persisted?.state === 'started', { effectWithoutCommittedStart: e });
let bTested = 0;
for (const h of hookResults) {
  const row = byDigest.get(digest(h.nonce));
  const claimAnswered = h.code === 0 && h.json?.result;
  if (!claimAnswered) continue; // hook died before/while claiming: no attachment is required
  bTested += h.afterRestart || h.json.retried ? 1 : 0;
  V('b_reattach', row && row.attempt_id === h.attemptId && row.state === 'observed' && row.observed_at !== null,
    { nonce: h.nonce, expectAttempt: h.attemptId, row: row ?? null, result: h.json.result });
}
const deliveries = {}; for (const h of hookResults) for (const m of h.json?.result?.messages ?? []) deliveries[m.messageId] = (deliveries[m.messageId] ?? 0) + 1;
for (const m of final.messages) V('b_reattach', m.acknowledged_at !== null || Date.parse(m.expires_at) > Date.now(), { lostMessage: m });
// (c) unknown without evidence stays unknown
V('c_unknown_preserved', bRow && bRow.state === 'unknown' && bRow.late_observed_at === null && bRow.observed_at === null && bRow.consumed_at === null
  && bRow.dispatch_epoch === B.row.dispatch_epoch && bRow.outcome_at === B.row.outcome_at, { bRow });
for (const r of reconcileResults.filter((x) => ['S06', 'S07', 'S21b'].includes(x.s))) V('c_unknown_preserved', r.r?.reconciled !== true, { reconcileB: r });
const receiptNonces = new Set(receipts.map((r) => r.nonce));
for (const r of final.wake) if (r.state === 'observed' || r.state === 'submitted') {
  const viaReceipt = receiptNonces.has(r.nonce);
  const viaReconcile = r.attempt_id === A.attemptId && r.observed_at === rA.observedAt;
  const viaOutcome = r.state === 'submitted' && effects.some((e) => e.nonce === r.nonce);
  V('c_unknown_preserved', viaReceipt || viaReconcile || viaOutcome, { successWithoutEvidence: r });
}
for (const r of final.wake) if (r.state === 'observed' && r.attempt_id !== A.attemptId) V('c_unknown_preserved', r.observed_at !== null && r.consumed_at !== null, { observedShape: r });
// (d) reconcile convergence / idempotence
const reconciledShape = (r) => r && r.state === 'observed' && r.observed_at === rA.observedAt && r.consumed_at !== null
  && r.late_observed_at === A.row.late_observed_at && r.outcome_at === A.row.outcome_at && r.dispatch_epoch === A.row.dispatch_epoch
  && r.instance_id === A.row.instance_id && r.started_at === A.row.started_at && r.relay_id === A.row.relay_id;
const untouched = (r) => r && ['state', 'observed_at', 'consumed_at', 'late_observed_at', 'outcome_at', 'dispatch_epoch', 'instance_id', 'relay_id', 'started_at'].every((k) => r[k] === A.row[k]);
const supportsReconcile = version === 'e9';
if (supportsReconcile) {
  V('d_reconcile_idempotent', reconciledShape(aRow), { finalA: aRow });
  V('d_reconcile_idempotent', reconcileResults.filter((x) => x.r?.reconciled === true).length <= 1, { trueCount: reconcileResults.filter((x) => x.r?.reconciled === true).length });
  const s21 = reconcileResults.find((x) => x.s === 'S21');
  V('d_reconcile_idempotent', s21?.r?.reconciled === false && JSON.stringify(aRowAfterS21Before) === JSON.stringify(aRow), { s21, before: aRowAfterS21Before });
  for (const im of images) { const r = im.rows?.wake.find((x) => x.attempt_id === A.attemptId); V('d_reconcile_idempotent', untouched(r) || reconciledShape(r), { imageA: r, image: im.image }); }
} else {
  V('d_reconcile_idempotent', null, 'reconcile-wake-observation not implemented in 53 (op rejected)');
  V('c_unknown_preserved', untouched(aRow), { aRowMustStayUnknownOn53: aRow });
}
// (e) new-generation wake effect <= 1
const byGen = {}; for (const e of effects) (byGen[`${e.sessionId}|${e.generation}`] ??= []).push(e);
for (const [g, es] of Object.entries(byGen)) V('e_new_generation_effect', es.length <= 1, { generation: g, count: es.length, es });
const activePerTarget = {}; for (const r of final.wake) if (['reserved', 'started', 'submitted', 'unknown'].includes(r.state)) activePerTarget[r.session_id] = (activePerTarget[r.session_id] ?? 0) + 1;
for (const [s, n] of Object.entries(activePerTarget)) V('e_new_generation_effect', n <= 1, { activeRows: s, n });
// (f) schema/user_version unchanged after WAL recovery
const ref = cfg.refSchema ? JSON.parse(readFileSync(cfg.refSchema, 'utf8')) : null;
const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
if (ref) {
  V('f_schema', same(finalSchema.schema, ref.db.schema) && finalSchema.userVersion === ref.db.userVersion && finalSchema.journal === 'wal', { finalSchemaDiff: !same(finalSchema.schema, ref.db.schema), uv: finalSchema.userVersion, journal: finalSchema.journal });
  V('f_schema', same(trustSchema.schema, ref.trust.schema) && trustSchema.userVersion === ref.trust.userVersion, { trustDiff: !same(trustSchema.schema, ref.trust.schema), uv: trustSchema.userVersion });
  for (const im of images) V('f_schema', (same(im.schema?.schema, ref.db.schema) || same(im.schema?.schema, baselineSchema.schema)) && im.schema?.userVersion === ref.db.userVersion
    && (im.trust === null || (same(im.trust.schema, ref.trust.schema) && im.trust.userVersion === ref.trust.userVersion)), { image: im.image, uv: im.schema?.userVersion });
} else V('f_schema', null, 'reference run');
const kill2 = existsSync(join(dir, 'kill-broker-2.json')) ? JSON.parse(readFileSync(join(dir, 'kill-broker-2.json'), 'utf8')) : null;
const killed = spec.mode === 'none' ? null : Boolean(kill) && (restarts.some((r) => r.signal === 'SIGKILL') || relayResults.some((r) => r.signal === 'SIGKILL') || hookResults.some((r) => r.signal === 'SIGKILL'));
const transportDuringCrash = (m) => restarts.length > 0 && /timed out|ECONN|socket|closed|EPIPE|endpoint|disconnect|broker/i.test(String(m ?? ''));
const harnessIssues = [...hookResults.filter((h) => h.code !== 0 && h.signal !== 'SIGKILL' && !transportDuringCrash(h.json?.error)).map((h) => ({ hook: h.call, error: h.json?.error, stderr: h.stderr })),
  ...relayResults.filter((r) => r.code !== 0 && r.signal !== 'SIGKILL' && !transportDuringCrash(r.json?.error)).map((r) => ({ relay: r.call, error: r.json?.error, stderr: r.stderr })),
  ...log.filter((l) => l.ev === 'harness-error')];
const result = { version, spec, killed, kill2, hotWalFiles, harnessIssues, kill, restarts: restarts.length, bTestedAfterRestart: bTested, checks,
  observations: { finalA: aRow ?? null, finalB: bRow ?? null, reconcileResults, deliveries, effects, receipts: receipts.length, wakeStatus,
    hooks: hookResults.map((h) => ({ call: h.call, nonce: h.nonce, attemptId: h.attemptId, afterRestart: h.afterRestart, code: h.code, signal: h.signal, recognized: h.json?.result?.recognized, managed: h.json?.result?.managed, msgs: (h.json?.result?.messages ?? []).map((m) => m.messageId), retried: h.json?.retried, error: h.json?.error })),
    relays: relayResults.map((r) => ({ call: r.call, sessionId: r.sessionId, instanceId: r.instanceId, relayId: r.relayId, code: r.code, signal: r.signal, called: r.json?.called, reserve: r.json?.reserve?.dispatch, start: r.json?.start?.dispatch, error: r.json?.error })),
    messages: final.messages, finalWake: final.wake, schemaNow: { db: { userVersion: finalSchema.userVersion, journal: finalSchema.journal }, trust: { userVersion: trustSchema.userVersion } } },
  log };
if (cfg.writeRef) writeFileSync(cfg.writeRef, JSON.stringify({ db: finalSchema, trust: trustSchema, baseline: baselineSchema }, null, 1));
writeFileSync(join(dir, 'result.json'), JSON.stringify(result, null, 1));
console.log(JSON.stringify({ version, spec, killed, kill2: kill2?.label ?? null, restarts: restarts.length, harnessIssues: harnessIssues.length, verdicts: Object.fromEntries(Object.entries(checks).map(([k, v]) => [k, v.verdict])) }));
process.exit(0);
