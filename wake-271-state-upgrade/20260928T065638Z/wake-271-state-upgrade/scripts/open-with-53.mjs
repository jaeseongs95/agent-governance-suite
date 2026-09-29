// Step 4: open a copied 2.7.1 state with 53eff30a and observe what is released.
// Usage: AGENT_GOVERNANCE_TRUST_DB_PATH=/tmp/state-53/trust.sqlite3 tsx open-with-53.mjs /tmp/v53 /tmp/state-53
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load, HOST, TRANSPORT, CAPS, SENDER, nonce, iso, schemaDump, rowsDump, fileHashes, observe } from './lib.mjs';

const [root, dir] = process.argv.slice(2);
const m = await load(root);
const state = JSON.parse(readFileSync(join(dir, 'exp-state.json'), 'utf8'));
const log = (step, data) => console.log(JSON.stringify({ step, ...data }));
const T = (name) => ({ host: HOST, sessionId: `exp-${name}` });
const NAMES = ['T0-control', 'T1-gen-unknown', 'T2-gen-submitted', 'T3-late-unknown', 'T4-started-crash', 'T5-ttl-unknown', 'T6-ttl-late'];
const live = state.live;
let now = state.lastMs + 1000;

log('4.files-before-open', { files: fileHashes(dir) });
const store = new m.SessionMessageStore(join(dir, 'session-messages.sqlite3'));
log('4.files-after-constructor', { files: fileHashes(dir) });
log('4a.schema-after-open', schemaDump(store.database));

const status = (t) => store.managedWakeStatus(t, now);
const brief = (t) => { const s = status(t); return s && { state: s.state, observation: s.observation, attemptId: s.attemptId, generation: s.generation,
  observedAt: s.observedAt, lateObservedAt: s.lateObservedAt }; };
const all = () => Object.fromEntries(NAMES.map((n) => [n, brief(T(n))]));
const dumpRows = (label) => log(`4e.rows:${label}`, rowsDump(store.database));
const binding = (t, n) => ({ ...t, nonce: n, ...live[t.sessionId], transport: TRANSPORT });
function heartbeatAll(at) {
  for (const [sessionId, l] of Object.entries(live)) {
    const t = { host: HOST, sessionId };
    store.heartbeatPresence(t, l.instanceId, at);
    store.heartbeatRelay({ ...t, transport: TRANSPORT, relayId: l.relayId }, at);
  }
}
function admit(t, label) {
  if (store.pendingCount(t, now) === 0) store.send({ sender: SENDER, target: t, messageId: `${t.sessionId}-${label}-body`, body: label }, now);
  const n = nonce(`${label}-adm`);
  const r = store.reserveManagedWake(binding(t, n), now + 1);
  return { reserveDispatch: r.dispatch, reservedAttempt: r.attempt?.attemptId ?? null, pending: store.pendingCount(t, now + 1), after: brief(t), _attempt: r.attempt };
}

dumpRows('after-open');
heartbeatAll(now);
log('4b.status-after-open-no-action', { at: iso(now), targets: all() });
log('4.presence-after-open', Object.fromEntries(NAMES.map((n) => { const p = store.presence(T(n), now); return [n, { state: p.state, instanceId: p.instanceId, generation: p.startedAt }]; })));

// (c) new-wake admission on every target right after open (no other action).
now += 1000; heartbeatAll(now);
for (const name of NAMES.slice(1)) { const { _attempt, ...r } = admit(T(name), 'c'); log('4c.admission-after-open', { target: name, ...r }); }
dumpRows('after-4c');

// (d-) non-arrival / invalid evidence against T1 must not retire it.
now += 1000; heartbeatAll(now);
{
  const t = T('T1-gen-unknown'); const old = state.targets[t.sessionId].oldNonce;
  const mixed = observe(m, t, old, now, `\n[agent-governance-suite:wake:${nonce('unregistered-x')}]`);
  const r1 = store.claimHostWake(t, mixed.observation, mixed.sourceReceiptId, m.wakeHookObservationReader, now + 1);
  const valid = observe(m, t, old, now);
  const r2 = store.claimHostWake(t, valid.observation, 'unregistered-receipt', m.wakeHookObservationReader, now + 1);
  const r3 = store.claimHostWake(t, valid.observation, valid.sourceReceiptId, m.wakeHookObservationReader, now + 30_001); // stale receipt
  const r4 = store.claimHostWake({ ...t, sessionId: 'exp-wrong-target' }, valid.observation, valid.sourceReceiptId, m.wakeHookObservationReader, now + 1);
  log('4d-.invalid-evidence-T1', { mixed: r1.recognized, unregisteredReceipt: r2.recognized, staleReceipt: r3.recognized, wrongTarget: r4.recognized, after: brief(t) });
  // Keep the fresh valid receipt unused; T1 must stay a residual without a real arrival.
}
dumpRows('after-4d-minus');

// (d) verified old-generation arrival on T2 retires only that attempt.
now += 1000; heartbeatAll(now);
{
  const t = T('T2-gen-submitted'); const old = state.targets[t.sessionId];
  const before = all();
  const obs = observe(m, t, old.oldNonce, now);
  const r = store.claimHostWake(t, obs.observation, obs.sourceReceiptId, m.wakeHookObservationReader, now + 1);
  const after = all();
  const others = NAMES.filter((n) => n !== 'T2-gen-submitted' && JSON.stringify(before[n]) !== JSON.stringify(after[n]));
  log('4d.verified-old-arrival-T2', { recognized: r.recognized, messages: r.messages.length, binding: r.binding, T2: after['T2-gen-submitted'], otherTargetsChanged: others });
  const lateOutcome = store.recordManagedWakeOutcome(old.oldAttempt, 'definite-failure', now + 2);
  const replay = store.claimHostWake(t, obs.observation, obs.sourceReceiptId, m.wakeHookObservationReader, now + 3);
  log('4d.T2-late-outcome-and-replay', { lateOutcomeAccepted: lateOutcome, replayRecognized: replay.recognized, T2: brief(t) });
  now += 1000;
  const a = admit(t, 'd');
  const started = a._attempt ? store.startManagedWake(a._attempt, now + 2) : { dispatch: false };
  const cur = started.attempt ? observe(m, t, started.attempt.nonce, now + 3) : null;
  const delivered = cur ? store.claimHostWake(t, cur.observation, cur.sourceReceiptId, m.wakeHookObservationReader, now + 4) : null;
  log('4d.T2-new-generation-wake', { reserveDispatch: a.reserveDispatch, started: started.dispatch, newAttempt: started.attempt?.attemptId,
    newGeneration: started.attempt?.generation, currentArrival: delivered && { recognized: delivered.recognized, messages: delivered.messages.map((x) => x.messageId), bindingAttempt: delivered.binding?.attemptId },
    T2: brief(t) });
}
dumpRows('after-4d');

// Synthetic re-arrival for a row 2.7.1 already marked late (T6). Not a real-world event: the marker was consumed once.
now += 1000; heartbeatAll(now);
{
  const t = T('T6-ttl-late');
  const obs = observe(m, t, state.targets[t.sessionId].oldNonce, now);
  const r = store.claimHostWake(t, obs.observation, obs.sourceReceiptId, m.wakeHookObservationReader, now + 1);
  now += 1000;
  const a = admit(t, 'd6');
  log('4d.synthetic-rearrival-T6', { recognized: r.recognized, T6: brief(t), newReserveDispatch: a.reserveDispatch });
}
dumpRows('after-4d-T6-synthetic');

// (b) ACK, generation replacement and TTL must not release T1/T3/T4/T5.
now += 1000; heartbeatAll(now);
{
  const t = T('T1-gen-unknown');
  const claimed = store.claim(t, now).map((x) => x.messageId);
  const acked = store.acknowledge(t, claimed, now + 1);
  store.send({ sender: SENDER, target: t, messageId: `${t.sessionId}-b-ack-body`, body: 'b' }, now + 2);
  const r = store.reserveManagedWake(binding(t, nonce('b-ack')), now + 3);
  log('4b.ack-T1', { claimed, acked, reserveDispatch: r.dispatch, T1: brief(t) });
  store.endPresence(t, 'exp-gen3', live[t.sessionId].instanceId, now + 4);
  store.startPresence({ ...t, instanceId: 'inst-3', transport: TRANSPORT, wakeVisibility: 'user-message', canWakeSilently: false, deliveryCapabilities: CAPS }, now + 5);
  store.acquireRelay({ ...t, transport: TRANSPORT, relayId: 'relay-3', pid: process.pid, parentPid: process.pid }, now + 5);
  live[t.sessionId] = { instanceId: 'inst-3', relayId: 'relay-3' };
  const g = store.reserveManagedWake(binding(t, nonce('b-gen')), now + 6);
  log('4b.generation-replacement-T1', { newGeneration: store.presence(t, now + 6).startedAt, reserveDispatch: g.dispatch, T1: brief(t) });
}
dumpRows('after-4b-ack-gen');
{
  const start = now + 10;
  for (let at = start; at <= start + m.WAKE_TTL_MS + 60_000; at += 10_000) heartbeatAll(at);
  now = start + m.WAKE_TTL_MS + 60_000;
  store.prune(now);
  const res = {};
  for (const name of NAMES) { const { _attempt, ...r } = admit(T(name), 'ttl'); res[name] = r; }
  log('4b.after-wake-ttl-and-prune', { at: iso(now), admission: res });
}
dumpRows('after-4b-ttl');
log('4.final-status', { at: iso(now), targets: all() });
log('4.presence-final', Object.fromEntries(NAMES.map((n) => { const p = store.presence(T(n), now); return [n, { state: p.state, instanceId: p.instanceId, generation: p.startedAt }]; })));
store.close();
log('4.files-after-close', { files: fileHashes(dir) });
