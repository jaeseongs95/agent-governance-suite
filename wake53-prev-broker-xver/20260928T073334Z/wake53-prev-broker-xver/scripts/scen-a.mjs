// (a) 2.7.1 <-> 53 sessions, bidirectional prepare/send/claim/ACK through one shared state dir,
// seeded random interleaving with random broker-version swaps, plus a concurrent cross-version claim race.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { startBroker, stopBroker, cli, dump, Log, rng, envFor, VERSIONS } from "./lib.mjs";

const seed = Number(process.argv[2] ?? 1);
const initialBroker = process.argv[3] ?? "2.7.1";
const OLD = process.argv[4] ?? "2.7.1";
const STEPS = 60;
const tag = `a-${OLD}-${initialBroker}-s${seed}`;
const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true });
const log = new Log(`${out}/run.log`);
const r = rng(seed);
const pick = (a) => a[Math.floor(r() * a.length)];
const sessions = [
  { id: { host: "codex", sessionId: "A-old" }, v: OLD }, { id: { host: "codex", sessionId: "B-new" }, v: "53" },
  { id: { host: "claude-code", sessionId: "C-old" }, v: OLD }, { id: { host: "claude-code", sessionId: "D-new" }, v: "53" },
];
log.w(`seed=${seed} initialBroker=${initialBroker} old=${OLD} steps=${STEPS} sessions=${JSON.stringify(sessions)}`);
let broker = await startBroker(initialBroker, dir, log);
const msgs = new Map(); // id -> {sender, target, body, sent, claims:[], acks:0}
const prepared = [];
const violations = []; const errors = [];
let dumpN = 0;
const snap = (label) => dump(dir, `${out}/${String(dumpN++).padStart(2, "0")}-${label}.json`);
snap("start");
for (let step = 0; step < STEPS; step++) {
  const x = r();
  if (x < 0.08) { // swap broker version (upgrade/downgrade while sessions keep running)
    const next = broker.v === "53" ? OLD : "53";
    await stopBroker(broker, log); broker = await startBroker(next, dir, log); snap(`swap-to-${next}-step${step}`); continue;
  }
  if (x < 0.35) { // prepare
    const s = pick(sessions); const t = pick(sessions.filter((q) => q !== s));
    const body = `seed${seed}-step${step}-${s.id.sessionId}->${t.id.sessionId}`;
    const res = cli(s.v, dir, "prepare", { sender: s.id, target: t.id, body });
    log.w(`step${step} prepare by ${s.v}:${s.id.sessionId} -> ${t.id.sessionId}`, res.ok ? res.data.messageId : res);
    if (res.ok) prepared.push({ id: res.data.messageId, s, t, body }); else errors.push({ step, op: "prepare", res });
    continue;
  }
  if (x < 0.6 && prepared.length) { // send (20%: sender's tool version flipped = session upgraded between prepare and send)
    const p = prepared.splice(Math.floor(r() * prepared.length), 1)[0];
    const flip = r() < 0.2; const v = flip ? (p.s.v === "53" ? OLD : "53") : p.s.v;
    const res = cli(v, dir, "send", { sender: p.s.id, messageId: p.id });
    log.w(`step${step} send by ${v}${flip ? "(flipped)" : ""}:${p.s.id.sessionId} id=${p.id}`, res.ok ? res.data : res);
    if (res.ok) { msgs.set(p.id, { ...p, claims: [], acks: 0 }); if (r() < 0.3) { // duplicate send by the other version
      const v2 = v === "53" ? OLD : "53"; const d = cli(v2, dir, "send", { sender: p.s.id, messageId: p.id });
      log.w(`step${step} dup-send by ${v2}`, d.ok ? d.data : d); if (!d.ok || d.data.duplicate !== true) violations.push({ step, kind: "dup-send-not-idempotent", id: p.id, d }); } }
    else errors.push({ step, op: "send", res });
    continue;
  }
  if (x < 0.85) { // claim
    const t = pick(sessions); const res = cli(t.v, dir, "claim", { target: t.id });
    const ids = res.ok ? res.data.messages.map((m) => m.messageId) : [];
    log.w(`step${step} claim by ${t.v}:${t.id.sessionId}`, res.ok ? ids : res);
    if (!res.ok) { errors.push({ step, op: "claim", res }); continue; }
    for (const m of res.data.messages) {
      const k = msgs.get(m.messageId);
      if (!k) { violations.push({ step, kind: "unknown-message-claimed", m }); continue; }
      if (k.t.id.sessionId !== t.id.sessionId) violations.push({ step, kind: "wrong-target", id: m.messageId });
      if (m.body !== k.body) violations.push({ step, kind: "body-mismatch", id: m.messageId });
      if (k.acks > 0) violations.push({ step, kind: "claimed-after-ack", id: m.messageId });
      if (k.claims.length > 0) violations.push({ step, kind: "reclaimed-within-lease", id: m.messageId, prev: k.claims });
      k.claims.push({ step, v: t.v, attempt: m.deliveryAttempt });
      if (r() < 0.7) { // ack with the target's version or (30%) the other version
        const v = r() < 0.3 ? (t.v === "53" ? OLD : "53") : t.v;
        const a = cli(v, dir, "acknowledge", { target: t.id, messageIds: [m.messageId] });
        log.w(`step${step}  ack by ${v} ${m.messageId}`, a.ok ? a.data : a);
        if (a.ok) k.acks += a.data.acknowledged; else errors.push({ step, op: "ack", a });
      } else k.pendingAck = true;
    }
    continue;
  }
  // late ACK of anything claimed but not yet acked
  const pend = [...msgs.entries()].filter(([, k]) => k.pendingAck && k.acks === 0);
  if (pend.length) { const [id, k] = pend[Math.floor(r() * pend.length)]; const v = pick([OLD, "53"]);
    const a = cli(v, dir, "acknowledge", { target: k.t.id, messageIds: [id] }); log.w(`step${step} late-ack by ${v} ${id}`, a.ok ? a.data : a);
    if (a.ok) { k.acks += a.data.acknowledged; k.pendingAck = false; } else errors.push({ step, op: "late-ack", a }); }
}
snap("after-random");
// drain: ack pending claimed ones, claim remaining, check statuses
for (const [id, k] of msgs) if (k.claims.length && k.acks === 0) { const a = cli("53", dir, "acknowledge", { target: k.t.id, messageIds: [id] }); if (a.ok) k.acks += a.data.acknowledged; }
for (const s of sessions) {
  const res = cli(s.v, dir, "claim", { target: s.id, maxMessages: 10 });
  for (const m of res.data?.messages ?? []) { const k = msgs.get(m.messageId); if (!k) { violations.push({ kind: "drain-unknown", m }); continue; }
    if (k.claims.length) violations.push({ kind: "drain-reclaimed", id: m.messageId }); k.claims.push({ step: "drain", v: s.v, attempt: m.deliveryAttempt });
    const a = cli(s.v, dir, "acknowledge", { target: s.id, messageIds: [m.messageId] }); if (a.ok) k.acks += a.data.acknowledged; }
}
for (const [id, k] of msgs) {
  const st = cli(k.s.v, dir, "status", { sender: k.s.id, messageId: id });
  const state = st.data?.status?.state ?? null;
  if (k.acks !== 1) violations.push({ kind: "ack-count", id, acks: k.acks });
  if (k.claims.length !== 1) violations.push({ kind: "claim-count", id, claims: k.claims });
  if (!st.ok || !st.data?.status?.acknowledgedAt) violations.push({ kind: "status-not-acknowledged", id, st });
  k.finalState = state;
}
snap("after-drain");
// concurrent cross-version claim race: 12 messages to one target, 6 simultaneous claimers of mixed versions
const target = sessions[1]; const racers = 6; const raceIds = [];
for (let i = 0; i < 12; i++) { const p = cli(pick([OLD, "53"]), dir, "prepare", { sender: sessions[0].id, target: target.id, body: `race-${seed}-${i}` });
  const s = cli(pick([OLD, "53"]), dir, "send", { sender: sessions[0].id, messageId: p.data.messageId }); if (s.ok) raceIds.push(p.data.messageId); }
const order = Array.from({ length: racers }, () => pick([OLD, "53"]));
log.w(`race: ${raceIds.length} msgs, claimers=${JSON.stringify(order)}`);
const runs = await Promise.all(order.map((v) => new Promise((res) => {
  const c = spawn(process.execPath, [path.join(VERSIONS[v], "mcp-server/dist/session-message-cli.mjs")], { env: envFor(dir) });
  let o = ""; c.stdout.on("data", (d) => { o += d; }); c.on("exit", () => { try { res({ v, r: JSON.parse(o) }); } catch { res({ v, r: { raw: o } }); } });
  c.stdin.end(JSON.stringify({ operation: "claim", payload: { target: target.id, maxMessages: 10 } }));
})));
const seen = new Map();
for (const { v, r: rr } of runs) for (const m of rr.data?.messages ?? []) { seen.set(m.messageId, (seen.get(m.messageId) ?? 0) + 1); }
log.w("race results", runs.map(({ v, r: rr }) => [v, rr.ok, (rr.data?.messages ?? []).length, rr.error]));
for (const [id, n] of seen) if (n > 1) violations.push({ kind: "race-double-claim", id, n });
const unclaimed = raceIds.filter((id) => !seen.has(id));
if (unclaimed.length) { const again = cli("53", dir, "claim", { target: target.id, maxMessages: 10 }); log.w("race leftover claim", again.data?.messages?.map((m) => m.messageId));
  for (const m of again.data?.messages ?? []) seen.set(m.messageId, 1); }
for (const id of raceIds) if (!seen.has(id)) violations.push({ kind: "race-lost", id });
for (const id of seen.keys()) cli("53", dir, "acknowledge", { target: target.id, messageIds: [id] });
snap("after-race");
await stopBroker(broker, log);
const final = snap("final");
const summary = { tag, seed, initialBroker, old: OLD, messages: msgs.size, raceMessages: raceIds.length, violations, errors,
  integrity: final.integrity, user_version: final.user_version };
log.w("SUMMARY", summary);
import("node:fs").then((fs) => fs.writeFileSync(`${out}/summary.json`, JSON.stringify(summary, null, 1)));
