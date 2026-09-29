// Step 3: build disposable 2.7.1 (d5c5932) state reproducing the old-generation wake fence.
// Usage: AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-271/trust.sqlite3 tsx build-271-state.mjs /tmp/v271 /tmp/state-271
import { mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { load, HOST, TRANSPORT, CAPS, SENDER, nonce, iso, schemaDump, rowsDump, fileHashes, observe } from './lib.mjs';

const [root, dir] = process.argv.slice(2);
const m = await load(root);
mkdirSync(dir, { recursive: true });
const dbPath = join(dir, 'session-messages.sqlite3');
const store = new m.SessionMessageStore(dbPath);
const log = (step, data) => console.log(JSON.stringify({ step, ...data }));
const H = 60 * 60_000;
const base = Math.floor((Date.now() - 3 * H) / 1000) * 1000;
const TF = base + 61 * 60_000;
const state = { base: iso(base), baseMs: base, TF: iso(TF), TFMs: TF, WAKE_TTL_MS: m.WAKE_TTL_MS, targets: {} };
const T = (name) => ({ host: HOST, sessionId: `exp-${name}` });
const live = {}; // sessionId -> { instanceId, relayId }

function presence(t, instanceId, relayId, now) {
  store.startPresence({ ...t, instanceId, transport: TRANSPORT, wakeVisibility: 'user-message',
    canWakeSilently: false, deliveryCapabilities: CAPS }, now);
  const ok = store.acquireRelay({ ...t, transport: TRANSPORT, relayId, pid: process.pid, parentPid: process.pid }, now);
  live[t.sessionId] = { instanceId, relayId };
  return { generation: store.presence(t, now).startedAt, relayAcquired: ok };
}
const body = (t, id, now) => store.send({ sender: SENDER, target: t, messageId: id, body: id }, now);
const binding = (t, n, now) => ({ ...t, nonce: n, ...live[t.sessionId], transport: TRANSPORT });
function begin(t, n, now) {
  const r = store.reserveManagedWake(binding(t, n, now), now);
  const s = r.dispatch ? store.startManagedWake(r.attempt, now + 1) : { dispatch: false, attempt: null };
  return { reserved: r.dispatch, started: s.dispatch, attempt: s.attempt };
}
function newGen(t, instanceId, relayId, now, sameInstance = false) {
  store.endPresence(t, 'exp-generation-change', live[t.sessionId].instanceId, now);
  return presence(t, sameInstance ? live[t.sessionId].instanceId : instanceId, relayId, now + 1);
}
function tryNew(t, tag, now) {
  body(t, `${t.sessionId}-new-body`, now);
  const n = nonce(`${tag}-new`);
  const r = store.reserveManagedWake(binding(t, n, now), now + 1);
  return { newReserveDispatch: r.dispatch, pending: store.pendingCount(t, now + 1), status: store.managedWakeStatus(t, now + 1) };
}
function heartbeatAll(now) {
  for (const [sessionId, l] of Object.entries(live)) {
    const t = { host: HOST, sessionId };
    store.heartbeatPresence(t, l.instanceId, now);
    store.heartbeatRelay({ ...t, transport: TRANSPORT, relayId: l.relayId }, now);
  }
}

// --- T5/T6 start at base (same generation, TTL expiry path). Heartbeats every 10s keep one generation.
const t5 = T('T5-ttl-unknown'), t6 = T('T6-ttl-late');
for (const [t, tag] of [[t5, 't5'], [t6, 't6']]) {
  const g = presence(t, 'inst-1', 'relay-1', base);
  body(t, `${t.sessionId}-old-body`, base);
  const n = nonce(`${tag}-old`);
  const b = begin(t, n, base + 1);
  const outcome = store.recordManagedWakeOutcome(b.attempt, tag === 't5' ? 'accepted-or-unknown' : 'submitted', base + 3);
  state.targets[t.sessionId] = { oldNonce: n, oldAttempt: b.attempt, gen1: g.generation };
  log('3.setup', { target: t.sessionId, gen1: g.generation, ...b, attempt: b.attempt?.attemptId, outcome, status: store.managedWakeStatus(t, base + 3) });
}
// --- T1..T4 and control within the last 5 minutes (TTL not expired at TF).
const s = TF - 5 * 60_000;
for (let now = base + 10_000; now <= s; now += 10_000) heartbeatAll(now); // continuous heartbeats: T5/T6 stay one online generation
const cases = [
  ['T1-gen-unknown', 't1', 'accepted-or-unknown', false],
  ['T2-gen-submitted', 't2', 'submitted', false],
  ['T3-late-unknown', 't3', 'submitted', true],
  ['T4-started-crash', 't4', null, false],
];
for (const [name, tag, outcome, sameInstance] of cases) {
  const t = T(name);
  const g1 = presence(t, 'inst-1', 'relay-1', s);
  body(t, `${t.sessionId}-old-body`, s);
  const n = nonce(`${tag}-old`);
  const b = begin(t, n, s + 1);
  const rec = outcome ? store.recordManagedWakeOutcome(b.attempt, outcome, s + 3) : 'none(crash-after-start)';
  // Old body is claimed+ACKed by an ordinary boundary (as in the real ops history).
  store.claim(t, s + 4); store.acknowledge(t, [`${t.sessionId}-old-body`], s + 5);
  const g2 = newGen(t, 'inst-2', 'relay-2', s + 10, sameInstance);
  state.targets[t.sessionId] = { oldNonce: n, oldAttempt: b.attempt, gen1: g1.generation, gen2: g2.generation };
  log('3.setup', { target: t.sessionId, gen1: g1.generation, gen2: g2.generation, reserved: b.reserved, started: b.started,
    attempt: b.attempt?.attemptId, outcome: rec, sameInstance, statusAfterGenChange: store.managedWakeStatus(t, s + 12) });
}
for (let now = s + 10_000; now <= TF; now += 10_000) heartbeatAll(now);

// --- Verified old arrivals processed by 2.7.1 (T3 after generation change, T6 after TTL expiry).
for (const name of ['T3-late-unknown', 'T6-ttl-late']) {
  const t = T(name); const at = TF - 8_000;
  const obs = observe(m, t, state.targets[t.sessionId].oldNonce, at);
  const r = store.claimHostWake(t, obs.observation, obs.sourceReceiptId, m.wakeHookObservationReader, at + 1);
  log('3.old-arrival-271', { target: t.sessionId, recognized: r.recognized, messages: r.messages.length, status: store.managedWakeStatus(t, at + 1) });
}
heartbeatAll(TF);
log('3.presence-at-TF', Object.fromEntries(Object.keys(live).map((id) => [id, store.presence({ host: HOST, sessionId: id }, TF)])));

// --- Observe the block: new-generation (or post-TTL) wake admission for every target.
for (const name of ['T1-gen-unknown', 'T2-gen-submitted', 'T3-late-unknown', 'T4-started-crash', 'T5-ttl-unknown', 'T6-ttl-late']) {
  const t = T(name);
  const r = tryNew(t, name.slice(0, 2).toLowerCase(), TF + 100);
  log('3.new-wake-271', { target: t.sessionId, ...r });
}
// T4: late outcome of the crashed old attempt after the fence became unknown.
{
  const t = T('T4-started-crash');
  const late = store.recordManagedWakeOutcome(state.targets[t.sessionId].oldAttempt, 'submitted', TF + 200);
  log('3.t4-late-outcome-271', { accepted: late, status: store.managedWakeStatus(t, TF + 200) });
}
// Control: target with no historical row admits a wake in 2.7.1.
{
  const t = T('T0-control');
  presence(t, 'inst-1', 'relay-1', TF + 300);
  body(t, `${t.sessionId}-body`, TF + 300);
  const n = nonce('t0');
  const r = store.reserveManagedWake(binding(t, n, TF + 301), TF + 301);
  log('3.control-271', { target: t.sessionId, reserveDispatch: r.dispatch });
  if (r.attempt) store.recordManagedWakeOutcome(store.startManagedWake(r.attempt, TF + 302).attempt, 'submitted', TF + 303);
  state.targets[t.sessionId] = { oldNonce: n, oldAttempt: r.attempt };
}
state.lastMs = TF + 400; state.last = iso(state.lastMs);
state.live = live;
log('3.schema', schemaDump(store.database));
log('3.rows', rowsDump(store.database));
writeFileSync(join(dir, 'exp-state.json'), JSON.stringify(state, null, 2));

// Live snapshot (connection still open, WAL/SHM present) — mirrors a running broker on a user PC.
const snap = `${dir}-live-snapshot`;
rmSync(snap, { recursive: true, force: true }); mkdirSync(snap);
store.database.exec('BEGIN IMMEDIATE'); // hold writers out while copying (same process)
for (const f of ['session-messages.sqlite3', 'session-messages.sqlite3-wal', 'session-messages.sqlite3-shm', 'trust.sqlite3', 'trust.sqlite3-wal', 'trust.sqlite3-shm', 'exp-state.json']) {
  try { cpSync(join(dir, f), join(snap, f)); } catch (e) { log('3.snapshot-missing', { file: f, code: e.code }); }
}
store.database.exec('ROLLBACK');
log('3.live-snapshot', { dir: snap, files: fileHashes(snap) });
store.close();
log('3.after-close', { dir, files: fileHashes(dir) });
