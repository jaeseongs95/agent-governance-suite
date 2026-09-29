// (b) OLD broker/hook leaves unACKed messages + active wake rows; then replace with 53 (and controls).
// usage: node scen-b.mjs <variant> <writerVersion> <afterBrokerVersion> <afterHookVersion>
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { startBroker, stopBroker, cli, hook, rpc, dump, Log, sleep } from "./lib.mjs";

const [variant, W = "2.7.1", AB = "53", AH = "53"] = process.argv.slice(2);
const tag = `b-${variant}-w${W}-b${AB}-h${AH}`;
const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true });
const log = new Log(`${out}/run.log`);
let n = 0; const snap = (l) => { const d = dump(dir, `${out}/${String(n++).padStart(2, "0")}-${l}.json`);
  const w = d.tables?.wake_nonces?.map((r) => ({ state: r.state, inst: r.instance_id, late: r.late_observed_at, obs: r.observed_at, consumed: r.consumed_at, exp: r.expires_at }));
  const m = d.tables?.messages?.map((r) => ({ id: r.message_id, att: r.delivery_attempts, claimed: r.claimed_at, acked: r.acknowledged_at }));
  log.w(`  [dump ${l}] wake=${JSON.stringify(w)} messages=${JSON.stringify(m)} integrity=${d.integrity}`); return d; };
const target = { host: "codex", sessionId: `tgt-${variant}` }; const sender = { host: "claude-code", sessionId: "sender" };
const transport = "codex-queue"; const pid = process.pid;
const wakePrompt = (nonce) => ({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "", prompt: `[agent-governance-suite:wake:${nonce}]` });
const findings = { tag, variant, writer: W, afterBroker: AB, afterHook: AH, obs: {} };

async function session(v) { // host SessionStart through the version's hook, then read the presence it created
  const h = hook(v, dir, { hook_event_name: "SessionStart", session_id: target.sessionId, source: "startup" });
  const p = await rpc(dir, "presence", { target }); log.w(`SessionStart via hook ${v}`, h, p.data?.presence?.instanceId, p.data?.presence?.transport);
  return p.data?.presence;
}
const heartbeat = async (inst, relayId) => { await rpc(dir, "presence-heartbeat", { target, instanceId: inst });
  if (relayId) await rpc(dir, "heartbeat-relay", { target, transport, relayId, instanceId: inst }); };
async function send(v, body) { const p = cli(v, dir, "prepare", { sender, target, body }); const s = cli(v, dir, "send", { sender, messageId: p.data.messageId });
  log.w(`send by ${v}`, p.data.messageId, s.ok); return p.data.messageId; }
async function managedWake(inst, relayId, outcome) {
  const acq = await rpc(dir, "acquire-relay", { target, transport, relayId, pid, parentPid: pid, instanceId: inst });
  const nonce = randomBytes(24).toString("base64url");
  const res = await rpc(dir, "reserve-wake", { target, nonce, instanceId: inst, relayId, transport });
  log.w(`acquire-relay ${relayId}`, acq.data, "reserve-wake", res.ok ? { dispatch: res.data.dispatch } : res);
  if (!res.ok || !res.data.dispatch) return { nonce, attempt: null, reserve: res };
  if (outcome === "reserved") return { nonce, attempt: res.data.attempt };
  const st = await rpc(dir, "start-wake", { attempt: res.data.attempt }); log.w("start-wake", st.ok ? { dispatch: st.data.dispatch } : st);
  if (outcome === "started") return { nonce, attempt: st.data?.attempt };
  const rec = await rpc(dir, "record-wake-outcome", { attempt: st.data.attempt, outcome }); log.w(`record-wake-outcome ${outcome}`, rec.data ?? rec);
  return { nonce, attempt: st.data.attempt };
}

let broker = await startBroker(W, dir, log);
let pres = await session(W);
let relayId = `relay-${W.replace(/\./g, "")}-1`;
const m1 = await send(W, `body-${variant}-1`);
let wake;
if (variant === "submitted" || variant === "unknown" || variant === "started" || variant === "reserved") {
  wake = await managedWake(pres.instanceId, relayId, variant === "unknown" ? "accepted-or-unknown" : variant);
} else if (variant === "late-latched") { // old generation arrival after session restart
  wake = await managedWake(pres.instanceId, relayId, "submitted");
  pres = await session(W); // resume/restart: new instanceId / generation
  relayId = `relay-${W.replace(/\./g, "")}-2`;
  await rpc(dir, "acquire-relay", { target, transport, relayId, pid, parentPid: pid, instanceId: pres.instanceId });
  const h = hook(W, dir, wakePrompt(wake.nonce)); log.w(`old-generation wake arrival via hook ${W}`, h);
  findings.obs.writerLateArrivalHook = h.out;
} else if (variant === "lease") { // claimed by W, not ACKed, broker replaced, lease expiry redelivery
  const c = cli(W, dir, "claim", { target }); log.w(`claim by ${W} (no ACK)`, c.data?.messages?.map((m) => [m.messageId, m.deliveryAttempt]));
} else if (variant === "empty-wake") { // wake submitted, body already claimed+ACKed through tool boundary: verified empty wake
  wake = await managedWake(pres.instanceId, relayId, "submitted");
  const c = cli(W, dir, "claim", { target }); cli(W, dir, "acknowledge", { target, messageIds: c.data.messages.map((m) => m.messageId) });
  log.w(`body claimed+ACKed by ${W} before wake arrival`, c.data.messages.map((m) => m.messageId));
}
findings.obs.wakeStatusBefore = (await rpc(dir, "wake-status", { target })).data?.wake;
snap(`writer-${W}-state`);

// ---- upgrade/replace
await stopBroker(broker, log);
snap("broker-stopped");
broker = await startBroker(AB, dir, log);
snap(`after-open-by-${AB}`);
await heartbeat(pres.instanceId, relayId);

if (variant === "lease") {
  const early = cli(AH, dir, "claim", { target }); log.w(`claim by ${AH} within lease`, early.data?.messages?.map((m) => m.messageId));
  findings.obs.claimWithinLease = early.data?.messages?.length ?? null;
  log.w("waiting 125s for 120s claim lease to expire (broker kept alive by pings)");
  for (let i = 0; i < 25; i++) { await sleep(5000); await rpc(dir, "ping", {}); }
  const late = cli(AH, dir, "claim", { target }); log.w(`claim by ${AH} after lease`, late.data?.messages?.map((m) => [m.messageId, m.deliveryAttempt]));
  findings.obs.redelivered = late.data?.messages?.map((m) => ({ id: m.messageId, attempt: m.deliveryAttempt }));
  const a = cli(AH, dir, "acknowledge", { target, messageIds: (late.data?.messages ?? []).map((m) => m.messageId) }); findings.obs.ack = a.data;
} else if (variant === "late-latched") {
  // Can the current generation get a new wake after the upgrade?
  const w2 = await managedWake(pres.instanceId, relayId, "submitted");
  findings.obs.newWakeAfterUpgrade = { dispatch: w2.attempt !== null, reserve: w2.reserve?.data };
  snap("after-new-wake-attempt");
  // Is the body still reachable through the non-wake paths (native input -> PostToolUse deferred claim)?
  const h1 = hook(AH, dir, { hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "", prompt: "native user input" });
  const h2 = hook(AH, dir, { hook_event_name: "PostToolUse", session_id: target.sessionId, agent_id: "", tool_name: "Bash", tool_input: {}, tool_response: {} });
  const h3 = hook(AH, dir, { hook_event_name: "PostToolUse", session_id: target.sessionId, agent_id: "", tool_name: "Bash", tool_input: {}, tool_response: {} });
  const ctx = [h1, h2, h3].map((h) => JSON.stringify(h.out)).join(" ");
  findings.obs.bodyViaToolBoundary = ctx.includes(`body-${variant}-1`);
  log.w("native input + 2x PostToolUse via hook", AH, [h1, h2, h3].map((h) => Object.keys(h.out)), "body delivered:", findings.obs.bodyViaToolBoundary);
  const ids = [...ctx.matchAll(/messageIds: \[\\?"([0-9a-f-]{36})/g)].map((x) => x[1]);
  if (ids.length) findings.obs.ack = cli(AH, dir, "acknowledge", { target, messageIds: ids }).data;
  snap("after-tool-boundary");
  // With nothing pending, send a fresh message: does a new wake dispatch?
  const m2 = await send(AH, `body-${variant}-2`); await heartbeat(pres.instanceId, relayId);
  const w3 = await managedWake(pres.instanceId, relayId, "submitted");
  findings.obs.newWakeForFreshMessage = { dispatch: w3.attempt !== null, reserve: w3.reserve?.data };
  findings.obs.wakeStatusAfter = (await rpc(dir, "wake-status", { target })).data?.wake;
  // replay the old marker with the after-hook (fresh verified receipt): does it retire the latched row?
  const hr = hook(AH, dir, wakePrompt(wake.nonce)); log.w(`replay old marker via hook ${AH}`, hr);
  findings.obs.replayOldMarker = hr.out;
  await heartbeat(pres.instanceId, relayId);
  const w4 = await managedWake(pres.instanceId, relayId, "submitted");
  findings.obs.newWakeAfterReplay = { dispatch: w4.attempt !== null, reserve: w4.reserve?.data };
  if (w4.attempt) { const hd = hook(AH, dir, wakePrompt(w4.nonce)); findings.obs.newWakeDelivery = JSON.stringify(hd.out).includes(`body-${variant}-2`) ? "body-delivered" : hd.out; }
  findings.obs.pendingEnd = (await rpc(dir, "pending", { target })).data;
  void m2;
} else {
  // wake marker arrives at the host after the replacement
  const h = hook(AH, dir, wakePrompt(wake.nonce)); log.w(`wake arrival via hook ${AH}`, h);
  findings.obs.arrival = { keys: Object.keys(h.out), decision: h.out.decision ?? null, bodyDelivered: JSON.stringify(h.out).includes(`body-${variant}-1`) };
  const dup = hook(AH, dir, wakePrompt(wake.nonce)); log.w(`duplicate arrival via hook ${AH}`, dup);
  findings.obs.duplicateArrival = { keys: Object.keys(dup.out), decision: dup.out.decision ?? null, bodyDelivered: JSON.stringify(dup.out).includes(`body-${variant}-1`) };
  const ids = [...JSON.stringify(h.out).matchAll(/messageIds: \[\\?"([0-9a-f-]{36})/g)].map((x) => x[1]);
  if (ids.length) findings.obs.ack = cli(AH, dir, "acknowledge", { target, messageIds: ids }).data;
  findings.obs.wakeStatusAfter = (await rpc(dir, "wake-status", { target })).data?.wake;
  snap("after-arrival");
  // relay of the new version continues: can it wake for a new message?
  await heartbeat(pres.instanceId, relayId);
  const relay2 = `relay-${AB.replace(/\./g, "")}-after`;
  const m2 = await send(AH, `body-${variant}-2`); void m2;
  const w2 = await managedWake(pres.instanceId, relay2, "submitted");
  findings.obs.nextWake = { dispatch: w2.attempt !== null, reserve: w2.reserve?.data };
  findings.obs.pendingEnd = (await rpc(dir, "pending", { target })).data;
  if (!w2.attempt) { // drain via tool boundary to prove no loss
    hook(AH, dir, { hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "", prompt: "native user input" });
    const hs = [1, 2].map(() => hook(AH, dir, { hook_event_name: "PostToolUse", session_id: target.sessionId, agent_id: "", tool_name: "Bash", tool_input: {}, tool_response: {} }));
    findings.obs.drainViaToolBoundary = hs.map((x) => JSON.stringify(x.out).includes(`body-${variant}-2`));
  }
}
const fin = snap("final-live");
await stopBroker(broker, log);
findings.integrity = fin.integrity; findings.user_version = fin.user_version;
findings.activeRows = fin.tables.wake_nonces.filter((r) => ["reserved", "started", "submitted", "unknown"].includes(r.state)).map((r) => ({ state: r.state, inst: r.instance_id, late: r.late_observed_at, exp: r.expires_at }));
findings.unackedMessages = fin.tables.messages.filter((r) => !r.acknowledged_at).map((r) => ({ id: r.message_id, att: r.delivery_attempts, body: r.body }));
log.w("FINDINGS", findings);
writeFileSync(`${out}/findings.json`, JSON.stringify(findings, null, 1));
