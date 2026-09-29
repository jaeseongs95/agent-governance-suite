// Deterministic scenario repros with explicit nowMs. Usage (cwd=srcRoot):
//   node --import tsx repro-scenarios.mjs <srcRoot> <outJson>
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

const [srcRoot, outJson] = process.argv.slice(2);
const dir = mkdtempSync(join(tmpdir(), 'wake-repro-'));
process.env.AGENT_GOVERNANCE_TRUST_DB_PATH = join(dir, 'trust.sqlite3');
const mod = (p) => import(pathToFileURL(join(srcRoot, 'mcp-server/src', p)).href);
const { SessionMessageStore } = await mod('session-message-store.ts');
const { adaptHostInput } = await mod('host-input-adapter.ts');
const { recordWakeHookObservation, wakeHookObservationReader } = await mod('session-message-wake-port.ts');
const { wakeMessage } = await mod('session-message-client.ts');

const T = { host: 'portable', sessionId: 'wake-target' };
const caps = { supportedInjection: ['peer-wake'], idleWake: 'silent' };
const BASE = Date.parse('2026-09-28T00:00:00.000Z');
let n = 0;
const nonce = (tag) => `${tag}`.padEnd(24, 'x') + String(n++).padStart(8, '0');
function fresh(name) {
  const s = new SessionMessageStore(join(dir, `${name}.sqlite3`));
  s.startPresence({ ...T, instanceId: 'inst-1', transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, BASE);
  s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-1', pid: 1, parentPid: 11 }, BASE);
  return s;
}
const startPresence = (s, inst, now) => s.startPresence({ ...T, instanceId: inst, transport: 'portable', wakeVisibility: 'silent', canWakeSilently: true, deliveryCapabilities: caps }, now);
const rows = (s) => s.database.prepare(`SELECT substr(nonce_digest,1,12) AS nd, state, instance_id, birth_generation, relay_id, attempt_id, dispatch_epoch,
  retry_not_before, expires_at, observed_at, late_observed_at FROM wake_nonces ORDER BY rowid`).all().map((r) => ({ ...r, attempt_id: r.attempt_id?.slice(0, 8) }));
const send = (s, now, id) => s.send({ sender: { host: 'portable', sessionId: 'sender' }, target: T, messageId: id, body: id, ttlSeconds: 86400 }, now);
const hook = (s, nonces, now) => {
  const observation = adaptHostInput({ hook_event_name: 'UserPromptSubmit', session_id: T.sessionId, agent_id: '', prompt: nonces.map(wakeMessage).join('\n') }, T.host).observation;
  const r = s.claimHostWake(T, observation, recordWakeHookObservation(observation, now), wakeHookObservationReader, now);
  return { recognized: r.recognized, messages: r.messages.map((m) => m.messageId), binding: r.binding && { inst: r.binding.instanceId, gen: r.binding.generation } };
};
const out = {};
function scenario(name, fn) {
  const log = [];
  const step = (label, value) => { log.push({ step: label, value }); return value; };
  try { fn(step); } catch (error) { log.push({ step: 'ERROR', value: String(error?.message ?? error) }); }
  out[name] = log;
}

// H1: reserve in generation G1, presence restarts (G2) before start -> reserved row can never start or be replaced.
scenario('H1-reserved-then-generation-switch', (step) => {
  const s = fresh('h1'); let now = BASE + 1000;
  send(s, now, 'msg-h1-0001');
  const r = step('reserve(G1)', s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('h1a'), resume: true }, now));
  now += 1000; s.endPresence(T, 'restart', 'inst-1', now); now += 1; startPresence(s, 'inst-2', now);
  s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 12 }, now + 16_000);
  step('start(old attempt)', s.startManagedWake(r.attempt, now + 16_000));
  for (const [label, dt] of [['+16s', 16_000], ['+61min', 61 * 60_000], ['+25h', 25 * 3600_000]]) {
    const t = now + dt;
    s.heartbeatPresence(T, 'inst-2', t); s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 12 }, t);
    if (dt > 3600_000) startPresence(s, 'inst-2', t);
    send(s, t, `msg-h1-${label.replace(/\W/g, '')}`);
    s.prune(t);
    step(`reserve(current inst-2) ${label}`, s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('h1b'), resume: true }, t));
    step(`pending ${label}`, s.pendingCount(T, t));
  }
  step('status', s.managedWakeStatus(T, now + 25 * 3600_000));
  step('rows', rows(s));
});

// H2: definite failure puts the attempt back to reserved; generation switch during backoff -> same permanent block.
scenario('H2-definite-failure-backoff-then-generation-switch', (step) => {
  const s = fresh('h2'); let now = BASE + 1000;
  send(s, now, 'msg-h2-0001');
  const r = s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('h2a'), resume: true }, now);
  const st = step('start', s.startManagedWake(r.attempt, now));
  step('outcome(definite-failure)', s.recordManagedWakeOutcome(st.attempt, 'definite-failure', now));
  now += 25_000; startPresence(s, 'inst-1', now); // lease lapsed -> new birth for the same instance
  s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-1', pid: 1, parentPid: 11 }, now);
  step('presence', (({ instanceId, startedAt, state }) => ({ instanceId, startedAt, state }))(s.presence(T, now)));
  step('reserve(resume same instance, after backoff)', s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('h2b'), resume: true }, now + 60_000));
  step('start(original attempt)', s.startManagedWake({ ...st.attempt }, now + 60_000));
  step('rows', rows(s));
});

// H3: started attempt fenced to unknown by lease replacement; the original dispatcher's late definite-failure
// then turns unknown -> reserved (old generation) -> same permanent block. Also tests (g) evidence path.
scenario('H3-fenced-unknown-then-late-definite-failure-after-switch', (step) => {
  const s = fresh('h3'); let now = BASE + 1000;
  send(s, now, 'msg-h3-0001');
  const r = s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('h3a'), resume: true }, now);
  const st = s.startManagedWake(r.attempt, now);
  now += 25_000; startPresence(s, 'inst-2', now); s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 12 }, now);
  step('reserve by new relay (fences started->unknown)', s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('h3b'), resume: true }, now));
  step('rows after fence', rows(s));
  step('late outcome(definite-failure) from old dispatcher', s.recordManagedWakeOutcome(st.attempt, 'definite-failure', now + 1000));
  step('rows after late outcome', rows(s));
  step('reserve by new relay after backoff', s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('h3c'), resume: true }, now + 120_000));
});

// C1: verified old-generation arrival for an attempt still in 'started' (no outcome yet), then its outcome arrives.
scenario('C1-old-arrival-on-started-then-outcome', (step) => {
  const s = fresh('c1'); let now = BASE + 1000;
  send(s, now, 'msg-c1-0001');
  const r = s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('c1a'), resume: true }, now);
  const st = s.startManagedWake(r.attempt, now);
  now += 25_000; startPresence(s, 'inst-2', now); s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 12 }, now);
  step('hook(old nonce)', hook(s, [st.attempt.nonce], now));
  step('rows after old arrival', rows(s));
  step('late outcome(submitted)', s.recordManagedWakeOutcome(st.attempt, 'submitted', now + 10));
  const r2 = step('reserve(current)', s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('c1b'), resume: true }, now + 20));
  if (r2.attempt) { const st2 = s.startManagedWake(r2.attempt, now + 30); step('start(current)', st2.dispatch); step('hook(old nonce replay)', hook(s, [st.attempt.nonce], now + 40)); step('hook(current)', hook(s, [st2.attempt.nonce], now + 50)); }
  step('rows', rows(s));
});

// C2: same instance ended and restarted within the same millisecond -> identical generation string.
scenario('C2-same-ms-restart-generation-collision', (step) => {
  const s = fresh('c2'); let now = BASE + 1000;
  send(s, now, 'msg-c2-0001');
  const r = s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('c2a'), resume: true }, now);
  const st = s.startManagedWake(r.attempt, now);
  s.recordManagedWakeOutcome(st.attempt, 'submitted', now);
  now += 5000;
  s.endPresence(T, 'restart', 'inst-1', now); const p = startPresence(s, 'inst-1', now);
  step('generation before/after', { before: st.attempt.generation, after: p.startedAt });
  s.endPresence(T, 'restart', 'inst-1', now + 3); const p2 = startPresence(s, 'inst-1', now + 3);
  step('same-ms restart then 3ms restart', { after3ms: p2.startedAt });
  step('hook(nonce from first birth)', hook(s, [st.attempt.nonce], now + 4));
  step('rows', rows(s));
  // Now the collision itself: end + start inside one millisecond.
  const s2 = fresh('c2b'); let t = BASE;
  send(s2, t, 'msg-c2b-001');
  const q = s2.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('c2b'), resume: true }, t);
  const qs = s2.startManagedWake(q.attempt, t); s2.recordManagedWakeOutcome(qs.attempt, 'submitted', t);
  // restart in the same millisecond as the original birth (BASE): end + start both at BASE
  s2.endPresence(T, 'restart', 'inst-1', BASE); const p3 = startPresence(s2, 'inst-1', BASE);
  step('collision: original birth vs restart birth', { original: qs.attempt.generation, restarted: p3.startedAt, equal: qs.attempt.generation === p3.startedAt });
  step('collision: hook(first-birth nonce) after restart', hook(s2, [qs.attempt.nonce], BASE + 1001));
  step('collision rows', rows(s2));
});

// G1: unknown survives ACK/claim/presence switch/prune/TTL without an arrival; then a verified old arrival retires it.
scenario('G1-unknown-latched-until-arrival', (step) => {
  const s = fresh('g1'); let now = BASE + 1000;
  send(s, now, 'msg-g1-0001');
  const r = s.reserveManagedWake({ ...T, instanceId: 'inst-1', transport: 'portable', relayId: 'relay-1', nonce: nonce('g1a'), resume: true }, now);
  const st = s.startManagedWake(r.attempt, now);
  s.recordManagedWakeOutcome(st.attempt, 'accepted-or-unknown', now);
  const m = s.claim(T, now + 1); s.acknowledge(T, m.map((x) => x.messageId), now + 2);
  now += 61 * 60_000; startPresence(s, 'inst-2', now); s.acquireRelay({ ...T, transport: 'portable', relayId: 'relay-2', pid: 2, parentPid: 12 }, now); s.prune(now);
  send(s, now, 'msg-g1-0002');
  step('reserve(current) while unknown', s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('g1b'), resume: true }, now));
  step('status', s.managedWakeStatus(T, now));
  step('hook(old nonce, fresh receipt)', hook(s, [st.attempt.nonce], now + 1));
  step('late outcome(definite-failure)', s.recordManagedWakeOutcome(st.attempt, 'definite-failure', now + 2));
  const r2 = step('reserve(current) after arrival', s.reserveManagedWake({ ...T, instanceId: 'inst-2', transport: 'portable', relayId: 'relay-2', nonce: nonce('g1c'), resume: true }, now + 3));
  step('rows', rows(s));
});

writeFileSync(outJson, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
