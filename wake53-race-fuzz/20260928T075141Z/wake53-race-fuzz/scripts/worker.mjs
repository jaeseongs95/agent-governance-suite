// Fuzz worker: one independent node process sharing a state directory with siblings.
// Usage (cwd = source root, run with --import tsx):
//   node --import tsx worker.mjs <srcRoot> <stateDir> <seed> <workerIndex> <steps>
// Uses only public store/wake-port/adapter exports (same paths the repo fixture uses).
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [srcRoot, stateDir, seedArg, workerArg, stepsArg] = process.argv.slice(2);
const seed = Number(seedArg); const worker = Number(workerArg); const steps = Number(stepsArg);
const mod = (p) => import(pathToFileURL(join(srcRoot, 'mcp-server/src', p)).href);
const { SessionMessageStore } = await mod('session-message-store.ts');
const { adaptHostInput } = await mod('host-input-adapter.ts');
const { recordWakeHookObservation, wakeHookObservationReader } = await mod('session-message-wake-port.ts');
const { wakeMessage, newWakeNonce } = await mod('session-message-client.ts');

function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rand = mulberry32((seed * 7919 + worker * 104729 + 17) >>> 0);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const chance = (p) => rand() < p;
const digest = (n) => createHash('sha256').update(n).digest('hex');
// Deterministic nonces per seed/worker so a run can be replayed (still valid 32-char base64url).
let nonceCounter = 0;
const seededNonce = () => createHash('sha256').update(`${seed}:${worker}:${nonceCounter++}`).digest('base64url').slice(0, 32);

const store = new SessionMessageStore(join(stateDir, 'session-messages.sqlite3'));
const db = store.database;
let currentOp = 'init'; let currentOpName = 'init'; let currentNow = 0;
db.function('h_op', () => currentOp);
db.function('h_opname', () => currentOpName);
db.function('h_now', () => currentNow);
db.exec(`
CREATE TEMP TRIGGER h_wake_ins AFTER INSERT ON main.wake_nonces BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, old_state, new_state, old_late, new_late, gen, instance_id, attempt_id, old_epoch, new_epoch, old_relay, new_relay, now_ms)
  VALUES (h_op(), h_opname(), 'wake', 'I', NEW.nonce_digest, NEW.host, NEW.session_id, NULL, NEW.state, NULL, NEW.late_observed_at, NEW.birth_generation, NEW.instance_id, NEW.attempt_id, NULL, NEW.dispatch_epoch, NULL, NEW.relay_id, h_now());
END;
CREATE TEMP TRIGGER h_wake_upd AFTER UPDATE ON main.wake_nonces BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, old_state, new_state, old_late, new_late, gen, instance_id, attempt_id, old_epoch, new_epoch, old_relay, new_relay, now_ms, extra)
  VALUES (h_op(), h_opname(), 'wake', 'U', NEW.nonce_digest, NEW.host, NEW.session_id, OLD.state, NEW.state, OLD.late_observed_at, NEW.late_observed_at, NEW.birth_generation, NEW.instance_id, NEW.attempt_id, OLD.dispatch_epoch, NEW.dispatch_epoch, OLD.relay_id, NEW.relay_id, h_now(),
    json_object('old_consumed', OLD.consumed_at, 'new_consumed', NEW.consumed_at, 'old_retry', OLD.retry_not_before, 'new_retry', NEW.retry_not_before, 'expires', NEW.expires_at));
END;
CREATE TEMP TRIGGER h_wake_del AFTER DELETE ON main.wake_nonces BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, old_state, new_state, gen, instance_id, attempt_id, old_epoch, now_ms)
  VALUES (h_op(), h_opname(), 'wake', 'D', OLD.nonce_digest, OLD.host, OLD.session_id, OLD.state, NULL, OLD.birth_generation, OLD.instance_id, OLD.attempt_id, OLD.dispatch_epoch, h_now());
END;
CREATE TEMP TRIGGER h_pres_ins AFTER INSERT ON main.session_presence BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, gen, instance_id, now_ms, extra)
  VALUES (h_op(), h_opname(), 'presence', 'I', NEW.instance_id, NEW.host, NEW.session_id, NEW.started_at, NEW.instance_id, h_now(), json_object('lease_until', NEW.lease_until, 'ended_at', NEW.ended_at));
END;
CREATE TEMP TRIGGER h_pres_upd AFTER UPDATE ON main.session_presence BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, gen, instance_id, now_ms, extra)
  VALUES (h_op(), h_opname(), 'presence', 'U', NEW.instance_id, NEW.host, NEW.session_id, NEW.started_at, NEW.instance_id, h_now(), json_object('lease_until', NEW.lease_until, 'ended_at', NEW.ended_at, 'old_started', OLD.started_at));
END;
CREATE TEMP TRIGGER h_msg_upd AFTER UPDATE OF claimed_at, acknowledged_at ON main.messages BEGIN
  INSERT INTO h_audit (op_id, op, tbl, kind, key, host, session_id, now_ms, extra)
  VALUES (h_op(), h_opname(), 'message', 'U', NEW.message_id, NEW.target_host, NEW.target_session_id, h_now(), json_object('claimed', NEW.claimed_at, 'acked', NEW.acknowledged_at, 'old_acked', OLD.acknowledged_at));
END;
`);

const TARGETS = [{ host: 'portable', sessionId: 'wake-t0' }, { host: 'portable', sessionId: 'wake-t1' }];
const TRANSPORT = 'portable';
const relayId = `relay-s${seed}-w${worker}-${process.pid}`;
const parentPid = 900000 + worker;
const clockNow = () => {
  const row = db.prepare('SELECT ms FROM h_clock WHERE id = 1').get();
  return Number(row.ms) + Math.floor(rand() * 300);
};
const local = { attempts: [], claimed: [], observations: [], staleInstances: [] };
let opSeq = 0;
let violations = 0;

function logOp(op, args, result, now, error) {
  const res = result === undefined ? null : JSON.stringify(result, (k, v) => (k === 'body' ? undefined : v));
  for (let i = 0; i < 20; i += 1) {
    try {
      db.prepare('INSERT INTO h_ops (op_id, worker, pid, op, args, result, error, now_ms, wall_ms) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(currentOp, worker, process.pid, op, JSON.stringify(args ?? null), res, error ?? null, now, Date.now());
      return;
    } catch (e) { if (!String(e.message).includes('locked') && !String(e.message).includes('busy')) throw e; }
  }
}
function checkActive(now) {
  for (const t of TARGETS) {
    const n = db.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE host = ? AND session_id = ? AND state IN ('reserved','started','submitted','unknown')`).get(t.host, t.sessionId).n;
    if (n > 1) { violations += 1; logOp('VIOLATION-a', { target: t, n }, null, now); }
  }
}
function poolPut(kind, payload) {
  db.prepare('INSERT INTO h_pool (kind, worker, payload) VALUES (?,?,?)').run(kind, worker, JSON.stringify(payload));
}
function poolPick(kind) {
  const rows = db.prepare('SELECT id, payload FROM h_pool WHERE kind = ? ORDER BY id DESC LIMIT 30').all(kind);
  if (!rows.length) return null;
  const r = rows[Math.floor(rand() * rows.length)];
  return { id: r.id, ...JSON.parse(r.payload) };
}

function presenceOf(t, now) { return store.presence(t, now); }
function makeObservation(t, nonces) {
  const prompt = nonces.map((n) => wakeMessage(n)).join('\n');
  return adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: t.sessionId, agent_id: '', prompt }, t.host).observation;
}
function effect(attempt, now) {
  // Mirrors the fixture: an adapter effect requires a committed started intent.
  const row = db.prepare('SELECT state, dispatch_epoch FROM wake_nonces WHERE nonce_digest = ?').get(digest(attempt.nonce));
  db.prepare(`INSERT INTO h_effects (op_id, worker, host, session_id, nonce, nonce_digest, attempt_id, epoch, generation, instance_id, relay_id, row_state, row_epoch, now_ms)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(currentOp, worker, attempt.host, attempt.sessionId, attempt.nonce, digest(attempt.nonce), attempt.attemptId,
      attempt.dispatchEpoch, attempt.generation, attempt.instanceId, attempt.relayId, row?.state ?? null, row?.dispatch_epoch ?? null, now);
  appendFileSync(join(stateDir, 'effects.txt'), `${worker}\t${wakeMessage(attempt.nonce)}\t${attempt.dispatchEpoch}\n`);
}
const hasReserved = (t) => Boolean(db.prepare("SELECT 1 FROM wake_nonces WHERE host = ? AND session_id = ? AND state = 'reserved'").get(t.host, t.sessionId));
const anyReserved = () => Boolean(db.prepare("SELECT 1 FROM wake_nonces WHERE state = 'reserved'").get());
const OUTCOMES = ['submitted', 'submitted', 'accepted-or-unknown', 'definite-failure', 'throw'];

const OPS = {
  send(now) {
    const t = pick(TARGETS);
    const ttl = chance(0.15) ? 30 : chance(0.3) ? 3600 : 86400;
    return { args: { t: t.sessionId, ttl }, result: store.send({ sender: { host: 'portable', sessionId: `sender-${worker}` }, target: t, body: `b-${seed}-${worker}-${opSeq}`, ttlSeconds: ttl }, now) };
  },
  claim(now) {
    const t = pick(TARGETS);
    const msgs = store.claim(t, now);
    for (const m of msgs) local.claimed.push({ t, id: m.messageId });
    if (msgs.length && chance(0.6)) { const ids = msgs.map((m) => m.messageId); local.claimed = local.claimed.filter((c) => !ids.includes(c.id)); return { args: { t: t.sessionId }, result: { claimed: ids, ackedNow: store.acknowledge(t, ids, now) } }; }
    return { args: { t: t.sessionId }, result: { claimed: msgs.map((m) => m.messageId) } };
  },
  ack(now) {
    if (!local.claimed.length) return null;
    const k = 1 + Math.floor(rand() * Math.min(3, local.claimed.length));
    const batch = local.claimed.splice(0, k);
    const t = batch[0].t;
    const ids = batch.filter((b) => b.t.sessionId === t.sessionId).map((b) => b.id);
    return { args: { t: t.sessionId, ids }, result: { acked: store.acknowledge(t, ids, now) } };
  },
  acquire(now) {
    const t = pick(TARGETS);
    return { args: { t: t.sessionId, relayId }, result: { acquired: store.acquireRelay({ ...t, transport: TRANSPORT, relayId, pid: process.pid, parentPid }, now) } };
  },
  heartbeat(now) {
    const t = pick(TARGETS);
    const p = presenceOf(t, now);
    let r1 = p.instanceId ? store.heartbeatPresence(t, p.instanceId, now) : false;
    if (!r1 && chance(0.6) && !(GATE && hasReserved(t))) {
      // Host restart after lease loss: same or new instance, always a new presence birth.
      if (p.instanceId) local.staleInstances.push({ t, inst: p.instanceId });
      const inst = chance(0.5) && p.instanceId ? p.instanceId : `inst-s${seed}-w${worker}-${opSeq}`;
      r1 = store.startPresence({ ...t, instanceId: inst, transport: TRANSPORT, wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: { supportedInjection: ['peer-wake'], idleWake: 'silent' } }, now).startedAt;
    }
    const r2 = store.heartbeatRelay({ ...t, transport: TRANSPORT, relayId }, now);
    return { args: { t: t.sessionId, inst: p.instanceId }, result: { presence: r1, relay: r2 } };
  },
  tick(now) {
    const d = pick(PROFILE === 'steady' ? [100, 500, 1000, 2000, 5000, 5000, 5000, 16_000, 31_000] : PROFILE === 'gencross' ? [100, 1000, 5000, 5000, 16_000, 21_000, 31_000, 61 * 60_000] : [100, 100, 1000, 1000, 5000, 5000, 16_000, 21_000, 31_000, 61 * 60_000, 3601_000]);
    const gated = GATE && d >= 16_000 && anyReserved();
    db.prepare('UPDATE h_clock SET ms = ms + ? WHERE id = 1').run(gated ? 5000 : d);
    return { args: { d, gated }, result: {} };
  },
  prune(now) { store.prune(now); return { args: {}, result: {} }; },
  presenceSwitch(now) {
    const t = pick(TARGETS);
    const p = presenceOf(t, now);
    const variant = pick(['new-instance', 'new-instance', 'restart-same', 'end-only', 'start-same']);
    if (GATE && hasReserved(t)) return { args: { t: t.sessionId, variant, gated: true }, result: {} };
    const caps = { supportedInjection: ['peer-wake'], idleWake: 'silent' };
    const start = (inst) => store.startPresence({ ...t, instanceId: inst, transport: TRANSPORT, wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, now);
    if (p.instanceId) local.staleInstances.push({ t, inst: p.instanceId });
    let r;
    if (variant === 'new-instance') { if (p.instanceId && chance(0.5)) store.endPresence(t, 'switch', p.instanceId, now); r = start(`inst-s${seed}-w${worker}-${opSeq}`); }
    else if (variant === 'restart-same') { if (p.instanceId) store.endPresence(t, 'restart', p.instanceId, now); r = start(p.instanceId ?? `inst-s${seed}-w${worker}-${opSeq}`); }
    else if (variant === 'end-only') { r = p.instanceId ? store.endPresence(t, 'end', p.instanceId, now) : null; }
    else r = start(p.instanceId ?? `inst-s${seed}-w${worker}-${opSeq}`);
    return { args: { t: t.sessionId, variant, from: p.instanceId, fromGen: p.startedAt }, result: r && typeof r === 'object' ? { inst: r.instanceId, gen: r.startedAt, state: r.state } : { r } };
  },
  reserve(now) {
    const t = pick(TARGETS);
    const p = presenceOf(t, now);
    let inst = p.instanceId ?? 'inst-none';
    const stale = local.staleInstances.filter((s) => s.t.sessionId === t.sessionId);
    if (stale.length && chance(0.2)) inst = pick(stale).inst;
    if (chance(0.8)) { store.acquireRelay({ ...t, transport: TRANSPORT, relayId, pid: process.pid, parentPid }, now); if (p.instanceId) store.heartbeatPresence(t, p.instanceId, now); }
    const nonce = seededNonce();
    const r = store.reserveManagedWake({ ...t, instanceId: inst, transport: TRANSPORT, relayId, nonce, resume: true }, now);
    if (r.attempt) { local.attempts.push({ stage: 'reserved', attempt: r.attempt }); poolPut('reserved', r.attempt); }
    return { args: { t: t.sessionId, inst, nonceDigest: digest(nonce) }, result: { dispatch: r.dispatch, attempt: r.attempt && { ...r.attempt, nonce: undefined, nd: digest(r.attempt.nonce) } } };
  },
  start(now) {
    let entry = local.attempts.find((a) => a.stage === 'reserved');
    let attempt = entry?.attempt;
    const dup = !attempt || chance(0.15);
    if (dup) { const p = poolPick(chance(0.5) ? 'reserved' : 'started'); if (!p) return null; attempt = p; entry = null; }
    if (!dup && chance(0.7)) { store.heartbeatRelay({ ...attempt, transport: TRANSPORT, relayId }, now); store.heartbeatPresence(attempt, attempt.instanceId, now); }
    const r = store.startManagedWake(attempt, now);
    if (entry) entry.stage = r.dispatch ? 'consumed' : 'dead';
    if (r.dispatch) { local.attempts.push({ stage: 'started', attempt: r.attempt }); poolPut('started', r.attempt); }
    return { args: { nd: digest(attempt.nonce), epoch: attempt.dispatchEpoch, dup }, result: { dispatch: r.dispatch, epoch: r.attempt?.dispatchEpoch } };
  },
  dispatch(now) {
    const entry = local.attempts.find((a) => a.stage === 'started');
    if (!entry) return null;
    entry.stage = 'effected';
    effect(entry.attempt, now);
    if (chance(0.25)) { poolPut('deferred-outcome', entry.attempt); return { args: { nd: digest(entry.attempt.nonce), epoch: entry.attempt.dispatchEpoch }, result: { deferred: true } }; }
    let o = pick(OUTCOMES); if (o === 'throw') o = 'accepted-or-unknown';
    const ok = store.recordManagedWakeOutcome(entry.attempt, o, now);
    if (o === 'definite-failure' && ok) local.attempts.push({ stage: 'reserved', attempt: entry.attempt });
    return { args: { nd: digest(entry.attempt.nonce), epoch: entry.attempt.dispatchEpoch, outcome: o }, result: { recorded: ok } };
  },
  lateOutcome(now) {
    const p = poolPick(chance(0.6) ? 'deferred-outcome' : 'started');
    if (!p) return null;
    const o = pick(['submitted', 'accepted-or-unknown', 'definite-failure']);
    const ok = store.recordManagedWakeOutcome(p, o, now);
    return { args: { nd: digest(p.nonce), epoch: p.dispatchEpoch, outcome: o, late: true }, result: { recorded: ok } };
  },
  hook(now) {
    const effects = db.prepare('SELECT host, session_id, nonce, generation FROM h_effects ORDER BY rowid DESC LIMIT 20').all();
    let t; let nonces;
    const v = rand();
    let variant;
    if (effects.length && v < 0.7) { const e = pick(effects); t = { host: e.host, sessionId: e.session_id }; nonces = [e.nonce]; variant = 'effected'; }
    else if (effects.length && v < 0.8) { const e = pick(effects); t = { host: e.host, sessionId: e.session_id }; const e2 = pick(effects); nonces = [...new Set([e.nonce, e2.nonce])]; variant = 'batch2'; }
    else if (effects.length && v < 0.87) { const e = pick(effects); t = { host: e.host, sessionId: e.session_id }; nonces = [e.nonce, newWakeNonce()]; variant = 'mixed-unregistered'; }
    else if (v < 0.93) { const r = poolPick('reserved'); if (!r) return null; t = { host: r.host, sessionId: r.sessionId }; nonces = [r.nonce]; variant = 'reserved-only'; }
    else { t = pick(TARGETS); nonces = [newWakeNonce()]; variant = 'unregistered'; }
    const observation = makeObservation(t, nonces);
    const rv = rand();
    let receiptId; let receiptMode;
    if (rv < 0.8) { receiptId = recordWakeHookObservation(observation, now); receiptMode = 'fresh'; }
    else if (rv < 0.9) { receiptId = recordWakeHookObservation(observation, now - 31_000); receiptMode = 'expired'; }
    else { receiptId = `bogus-${randomBytes(8).toString('hex')}`; receiptMode = 'bogus'; }
    const presence = presenceOf(t, now);
    const r = store.claimHostWake(t, observation, receiptId, wakeHookObservationReader, now);
    local.observations.push({ t, observation, receiptId });
    poolPut('observation', { t, observation, receiptId });
    for (const m of r.messages) local.claimed.push({ t, id: m.messageId });
    let ackedNow = 0;
    if (r.messages.length && chance(0.7)) { const ids = r.messages.map((m) => m.messageId); local.claimed = local.claimed.filter((c) => !ids.includes(c.id)); ackedNow = store.acknowledge(t, ids, now); }
    return { args: { t: t.sessionId, nds: nonces.map(digest), variant, ackedNow, receiptMode, presGen: presence.startedAt, presInst: presence.instanceId, presState: presence.state },
      result: { recognized: r.recognized, messages: r.messages.map((m) => m.messageId), binding: r.binding && { gen: r.binding.generation, inst: r.binding.instanceId, attemptId: r.binding.attemptId } } };
  },
  hookReplay(now) {
    const p = poolPick('observation');
    if (!p) return null;
    const r = store.claimHostWake(p.t, p.observation, p.receiptId, wakeHookObservationReader, now);
    for (const m of r.messages) local.claimed.push({ t: p.t, id: m.messageId });
    return { args: { t: p.t.sessionId, nds: p.observation.wakeCandidates.map(digest), variant: 'replay', receiptMode: 'replayed' },
      result: { recognized: r.recognized, messages: r.messages.map((m) => m.messageId), binding: r.binding && { gen: r.binding.generation, inst: r.binding.instanceId, attemptId: r.binding.attemptId } } };
  },
  legacyReserve(now) {
    const t = pick(TARGETS);
    const nonce = seededNonce();
    return { args: { t: t.sessionId, nd: digest(nonce) }, result: { reserved: store.reserveWake(t, nonce, now) } };
  },
  relayCycle(now) {
    // Mirrors dispatchManagedWake in one process, with an abandoned-after-start branch (crash stand-in).
    const t = pick(TARGETS);
    const p = presenceOf(t, now);
    store.acquireRelay({ ...t, transport: TRANSPORT, relayId, pid: process.pid, parentPid }, now);
    if (p.instanceId) store.heartbeatPresence(t, p.instanceId, now);
    const nonce = seededNonce();
    const r = store.reserveManagedWake({ ...t, instanceId: p.instanceId ?? 'inst-none', transport: TRANSPORT, relayId, nonce, resume: true }, now);
    if (!r.attempt) return { args: { t: t.sessionId, stage: 'reserve' }, result: { dispatch: false } };
    poolPut('reserved', r.attempt);
    const st = store.startManagedWake(r.attempt, now);
    if (!st.dispatch) return { args: { t: t.sessionId, stage: 'start', nd: digest(r.attempt.nonce) }, result: { dispatch: false } };
    poolPut('started', st.attempt);
    if (chance(0.1)) return { args: { t: t.sessionId, stage: 'abandon-after-start', nd: digest(st.attempt.nonce) }, result: { abandoned: true } };
    effect(st.attempt, now);
    if (chance(0.1)) return { args: { t: t.sessionId, stage: 'abandon-after-effect', nd: digest(st.attempt.nonce), epoch: st.attempt.dispatchEpoch }, result: { abandoned: true } };
    if (chance(0.2)) { poolPut('deferred-outcome', st.attempt); return { args: { t: t.sessionId, stage: 'defer-outcome', nd: digest(st.attempt.nonce), epoch: st.attempt.dispatchEpoch }, result: { deferred: true } }; }
    let o = pick(OUTCOMES); if (o === 'throw') o = 'accepted-or-unknown';
    const ok = store.recordManagedWakeOutcome(st.attempt, o, now);
    if (o === 'definite-failure' && ok) local.attempts.push({ stage: 'reserved', attempt: st.attempt });
    return { args: { t: t.sessionId, stage: 'outcome', nd: digest(st.attempt.nonce), epoch: st.attempt.dispatchEpoch, outcome: o }, result: { recorded: ok } };
  },
  status(now) {
    const t = pick(TARGETS);
    return { args: { t: t.sessionId }, result: store.managedWakeStatus(t, now) };
  },
};
const PROFILE = ['chaos', 'steady', 'gencross'][seed % 3];
// GATE: avoid generation switches / lease lapses while a target holds a 'reserved' row (see h_stuck_reserved).
const GATE = seed % 2 === 1;
const WEIGHTS0 = { send: 12, claim: 4, ack: 8, acquire: 4, heartbeat: 12, tick: 5, prune: 3, presenceSwitch: 3, reserve: 12, start: 10, dispatch: 10, lateOutcome: 5, hook: 12, hookReplay: 3, legacyReserve: 1, status: 2, relayCycle: 10 };
const WEIGHTS = PROFILE === 'steady' ? { ...WEIGHTS0, presenceSwitch: 1, tick: 4, hook: 16, relayCycle: 14 } : PROFILE === 'gencross' ? { ...WEIGHTS0, presenceSwitch: 4, hook: 14, relayCycle: 12 } : WEIGHTS0;
const bag = Object.entries(WEIGHTS).flatMap(([k, w]) => Array(w).fill(k));

process.send?.({ type: 'ready', worker, pid: process.pid });
for (opSeq = 0; opSeq < steps; opSeq += 1) {
  const name = pick(bag);
  currentOp = `w${worker}-${process.pid}-${opSeq}`; currentOpName = name;
  let now;
  try {
    now = clockNow(); currentNow = now;
    const out = OPS[name](now);
    if (out) logOp(name, out.args, out.result, now);
  } catch (error) {
    logOp(name, null, null, now ?? 0, String(error?.message ?? error));
  }
  currentOp = 'post'; currentOpName = 'post';
  try { checkActive(now); } catch { /* busy */ }
  if (chance(0.3)) await new Promise((r) => setTimeout(r, Math.floor(rand() * 5)));
}
store.close();
process.send?.({ type: 'done', worker, violations });
process.exit(0);
