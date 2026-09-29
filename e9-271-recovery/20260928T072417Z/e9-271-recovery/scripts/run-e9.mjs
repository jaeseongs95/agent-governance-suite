// CASE=e9-271-recovery driver. Disposable state only. Usage:
//   tsx run-e9.mjs <e9-root> <stateDir> <mode: main|f1a|f1b|f1c> <fakeHome>
// The broker is spawned explicitly with a controlled env; reconcile goes through the public CLI (dist/session-message-cli.mjs).
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rowsDump, logicalDigest, HOST, TRANSPORT, CAPS } from './lib.mjs';

const [root, dir, mode, fakeHome] = process.argv.slice(2);
const log = (step, data) => console.log(JSON.stringify({ step, t: new Date().toISOString(), ...data }));
const exp = JSON.parse(readFileSync(join(dir, 'exp-state.json'), 'utf8'));
const T = (name) => ({ host: HOST, sessionId: `exp-${name}` });
const NAMES = ['T0-control', 'T1-gen-unknown', 'T2-gen-submitted', 'T3-late-unknown', 'T4-started-crash', 'T5-ttl-unknown', 'T6-ttl-late'];
const defaultTrustDir = join(fakeHome, '.agent-governance-suite', 'session-messaging');
const defaultTrust = join(defaultTrustDir, 'trust.sqlite3');
const stateTrust = join(dir, 'trust.sqlite3');

// Receipts: operator-style lookup by host/sessionId in a throwaway copy (wake_nonces stores no source receipt id).
const receipts = {};
{
  const db = new DatabaseSync('/tmp/state-lookup/trust.sqlite3', { readOnly: true });
  for (const r of db.prepare('SELECT receipt_json FROM input_source_receipts').all()) {
    const j = JSON.parse(r.receipt_json); if (j.attestation?.adapter === 'session-message-wake-hook') receipts[j.sessionId] = j.receiptId;
  }
  db.close();
}
const NO_RECEIPT = 'source-00000000-0000-4000-8000-000000000000';
log('receipts', { receipts, NO_RECEIPT });

function hashDir(d) {
  const out = {};
  if (!existsSync(d)) return null;
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name); if (!statSync(p).isFile()) continue;
    if (/^(broker-key\.pem|broker\.token)$/.test(name)) { out[name] = { bytes: statSync(p).size, sha256: '(secret, not hashed)' }; continue; }
    out[name] = { bytes: statSync(p).size, sha256: createHash('sha256').update(readFileSync(p)).digest('hex') };
  }
  return out;
}
let snapN = 0;
function snap(label, withRows = false) {
  // Logical view from a scratch copy so this observation itself never touches the experiment directory.
  const tmp = `/tmp/snapcopy-${mode}-${snapN++}`; rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp);
  for (const f of readdirSync(dir)) if (/^(session-messages|trust)\.sqlite3(-wal|-shm)?$/.test(f)) cpSync(join(dir, f), join(tmp, f));
  const m = new DatabaseSync(join(tmp, 'session-messages.sqlite3'), { readOnly: true });
  const t = new DatabaseSync(join(tmp, 'trust.sqlite3'), { readOnly: true });
  const trustLogical = { receipts: t.prepare('SELECT count(*) n FROM input_source_receipts').get().n,
    keyDigest: createHash('sha256').update(String(t.prepare("SELECT value FROM trust_metadata WHERE key='trust-signing-key'").get()?.value)).digest('hex').slice(0, 16),
    schema: createHash('sha256').update(JSON.stringify(t.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all())).digest('hex'),
    receiptIds: t.prepare('SELECT receipt_id FROM input_source_receipts ORDER BY receipt_id').all().map((r) => r.receipt_id) };
  const out = { label, stateDir: hashDir(dir), defaultTrustDir: hashDir(defaultTrustDir),
    messageLogical: logicalDigest(m), trustLogical,
    wake: m.prepare(`SELECT session_id, state, attempt_id, instance_id, birth_generation, dispatch_epoch, retry_count, started_at, outcome_at,
      observed_at, late_observed_at, consumed_at, expires_at FROM wake_nonces WHERE state <> 'legacy' ORDER BY session_id, rowid`).all(),
    ...(withRows ? { rows: rowsDump(m) } : {}) };
  m.close(); t.close(); rmSync(tmp, { recursive: true, force: true });
  log(`snap:${label}`, out);
  return out;
}

const brokerEnv = { PATH: process.env.PATH, HOME: fakeHome };
if (mode === 'main') brokerEnv.AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR = dir; // CLI-spawned broker shape: state dir from env
const cliEnv = { PATH: process.env.PATH, HOME: fakeHome, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: dir };

async function startBroker() {
  rmSync(join(dir, 'endpoint.json'), { force: true });
  const child = spawn(process.execPath, [join(root, 'mcp-server/dist/session-message-broker.mjs'), '--state-directory', dir],
    { env: brokerEnv, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100 && !existsSync(join(dir, 'endpoint.json')); i++) await new Promise((r) => setTimeout(r, 100));
  log('broker-start', { pid: child.pid, endpoint: existsSync(join(dir, 'endpoint.json')), envKeys: Object.keys(brokerEnv), stderr });
  return child;
}
function cli(operation, payload) {
  const r = spawnSync(process.execPath, [join(root, 'mcp-server/dist/session-message-cli.mjs')],
    { input: JSON.stringify({ operation, payload }), env: cliEnv, encoding: 'utf8' });
  const out = { operation, payload, exit: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
  log('cli', out);
  try { return JSON.parse(r.stdout); } catch { return null; }
}
const { sessionMessageRequest } = await import(join(root, 'mcp-server/src/session-message-client.ts'));
async function req(op, payload) {
  try { const data = await sessionMessageRequest(op, payload, dir); log('req', { op, payload, data }); return data; }
  catch (e) { log('req-error', { op, payload, error: e.message }); return null; }
}
const reconcile = (name, receiptId) => cli('reconcile-wake-observation',
  { target: T(name), attemptId: exp.targets[`exp-${name}`].oldAttempt.attemptId, sourceReceiptId: receiptId });
const receiptFor = (name) => receipts[`exp-${name}`] ?? NO_RECEIPT;

snap('00-pre-broker', true);
const broker = await startBroker();
snap('01-after-broker-start');

if (mode !== 'main') {
  // F1: broker --state-directory = dir, trust default path resolved from HOME (no env).
  log('f1-paths', { brokerReaderTrust: stateTrust, reconcileTrustDefault: defaultTrust, defaultExists: existsSync(defaultTrust) });
  reconcile('T3-late-unknown', receiptFor('T3-late-unknown'));
  snap('f1-after-T3');
  reconcile('T3-late-unknown', receiptFor('T3-late-unknown'));
  snap('f1-after-T3-second');
  broker.kill('SIGTERM'); await new Promise((r) => broker.once('exit', r));
  snap('f1-after-broker-stop', true);
  process.exit(0);
}

// (a) no dry-run exists: record read-only-looking status queries only.
for (const n of NAMES) { await req('wake-status', { target: T(n) }); await req('presence', { target: T(n) }); }
snap('02-after-status-queries');

// (b) first apply at the current (unchanged) presence.
for (const n of NAMES) reconcile(n, receiptFor(n));
reconcile('T1-gen-unknown', receipts['exp-T3-late-unknown']); // wrong-target receipt
snap('03-after-apply-1', true);
// (c) second apply.
for (const n of NAMES) reconcile(n, receiptFor(n));
snap('04-after-apply-2');

// Old T3 attempt late outcome after reconcile must not reopen.
await req('record-wake-outcome', { attempt: exp.targets['exp-T3-late-unknown'].oldAttempt, outcome: 'submitted' });

// (d) new generation for T1..T6 (inst-3 / relay-3), then T6 becomes an old generation.
const G = NAMES.filter((n) => n !== 'T0-control');
const beat = async (n) => { await req('presence-heartbeat', { target: T(n), instanceId: 'inst-3' });
  await req('heartbeat-relay', { target: T(n), transport: TRANSPORT, relayId: 'relay-3' }); };
for (const n of G) {
  await req('presence-start', { target: T(n), instanceId: 'inst-3', transport: TRANSPORT, wakeVisibility: 'user-message',
    canWakeSilently: false, supportedInjection: CAPS.supportedInjection, idleWake: CAPS.idleWake });
  await req('acquire-relay', { target: T(n), transport: TRANSPORT, relayId: 'relay-3', pid: process.pid, parentPid: process.pid });
}
for (const n of G) reconcile(n, receiptFor(n));
snap('05-after-new-gen-apply', true);
for (const n of G) reconcile(n, receiptFor(n));
snap('06-after-new-gen-apply-2');

// (e) new-generation admission and effect count.
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = stateTrust; // hook-side receipt store = broker reader store
const port = await import(join(root, 'mcp-server/src/session-message-wake-port.ts'));
const adapter = await import(join(root, 'mcp-server/src/host-input-adapter.ts'));
const admission = {};
for (const n of G) {
  await beat(n);
  const prep = cli('prepare', { sender: { host: 'portable', sessionId: 'exp-sender' }, target: T(n), body: `${n}-e9-body` });
  const messageId = prep?.data?.messageId;
  cli('send', { sender: { host: 'portable', sessionId: 'exp-sender' }, messageId });
  await beat(n);
  const nonce = `e9-${randomBytes(18).toString('base64url')}`;
  const r = await req('reserve-wake', { target: T(n), nonce, instanceId: 'inst-3', relayId: 'relay-3', transport: TRANSPORT });
  const res = { reserve: r?.dispatch ?? null };
  if (r?.dispatch) {
    const s = await req('start-wake', { attempt: r.attempt });
    res.start = s?.dispatch;
    res.outcome = (await req('record-wake-outcome', { attempt: s.attempt, outcome: 'submitted' }))?.recorded;
    const second = await req('reserve-wake', { target: T(n), nonce: `e9-${randomBytes(18).toString('base64url')}`, instanceId: 'inst-3', relayId: 'relay-3', transport: TRANSPORT });
    res.secondReserveWhileActive = second?.dispatch;
    const observation = adapter.adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: T(n).sessionId, agent_id: '',
      prompt: `[agent-governance-suite:wake:${nonce}]` }, HOST).observation;
    const sourceReceiptId = port.recordWakeHookObservation(observation);
    const c1 = await req('claim-host-wake', { target: T(n), observation, sourceReceiptId, maxMessages: 1, maxBodyChars: 4096 });
    const c2 = await req('claim-host-wake', { target: T(n), observation, sourceReceiptId, maxMessages: 1, maxBodyChars: 4096 });
    res.claim1 = { recognized: c1?.recognized, managed: c1?.managed, messages: c1?.messages?.map((m) => m.messageId) };
    res.claim2Replay = { recognized: c2?.recognized, messages: c2?.messages?.length };
    const third = await req('reserve-wake', { target: T(n), nonce: `e9-${randomBytes(18).toString('base64url')}`, instanceId: 'inst-3', relayId: 'relay-3', transport: TRANSPORT });
    res.reserveAfterClaim = third?.dispatch;
    if (c1?.messages?.length) await req('acknowledge', { target: T(n), messageIds: c1.messages.map((m) => m.messageId) });
  }
  res.status = (await req('wake-status', { target: T(n) }))?.wake ?? null;
  admission[n] = res;
}
log('admission-summary', { admission });
snap('07-after-admission', true);
broker.kill('SIGTERM'); await new Promise((r) => broker.once('exit', r));
snap('08-after-broker-stop');
