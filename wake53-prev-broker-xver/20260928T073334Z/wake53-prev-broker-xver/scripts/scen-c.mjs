// (c) 53 builds state (incl. 53-only row shapes), then an older broker+hook+CLI reopens it (downgrade), then 53 again.
// usage: node scen-c.mjs <downVersion>
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { startBroker, stopBroker, cli, hook, rpc, dump, Log, schemaOnly } from "./lib.mjs";

const D = process.argv[2] ?? "2.7.1";
const tag = `c-down-${D}`;
const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true });
const log = new Log(`${out}/run.log`);
let n = 0; const snap = (l) => { const d = dump(dir, `${out}/${String(n++).padStart(2, "0")}-${l}.json`);
  log.w(`  [dump ${l}] wake=${JSON.stringify(d.tables?.wake_nonces?.map((r) => [r.session_id, r.state, r.late_observed_at ? "late" : "-"]))} msgs=${JSON.stringify(d.tables?.messages?.map((r) => [r.target_session_id, r.delivery_attempts, r.acknowledged_at ? "acked" : "open"]))} drafts=${d.tables?.prepared_messages?.length} integrity=${d.integrity} uv=${d.user_version}`); return d; };
const sender = { host: "claude-code", sessionId: "sender" }; const transport = "codex-queue"; const pid = process.pid;
const T = (s) => ({ host: "codex", sessionId: s });
const wakePrompt = (t, nonce) => ({ hook_event_name: "UserPromptSubmit", session_id: t.sessionId, agent_id: "", prompt: `[agent-governance-suite:wake:${nonce}]` });
const F = { tag, down: D, obs: {} };
async function start(v, t) { hook(v, dir, { hook_event_name: "SessionStart", session_id: t.sessionId, source: "startup" }); return (await rpc(dir, "presence", { target: t })).data.presence; }
function send(v, t, body) { const p = cli(v, dir, "prepare", { sender, target: t, body }); const s = cli(v, dir, "send", { sender, messageId: p.data?.messageId }); return { id: p.data?.messageId, ok: s.ok, err: s.error ?? p.error }; }
async function wake(t, inst, relayId, outcome = "submitted") {
  await rpc(dir, "acquire-relay", { target: t, transport, relayId, pid, parentPid: pid, instanceId: inst });
  const nonce = randomBytes(24).toString("base64url");
  const r = await rpc(dir, "reserve-wake", { target: t, nonce, instanceId: inst, relayId, transport });
  if (!r.ok || !r.data.dispatch) return { nonce, dispatch: false, r };
  if (!r.data.attempt) { log.w(`reserve-wake returned no managed attempt (legacy reservation)`, r); return { nonce, dispatch: true, legacy: true, r }; }
  const s = await rpc(dir, "start-wake", { attempt: r.data.attempt });
  if (!s.ok || !s.data?.attempt) { log.w("start-wake failed", s); return { nonce, dispatch: false, r, s }; }
  const o = await rpc(dir, "record-wake-outcome", { attempt: s.data.attempt, outcome });
  if (!o.ok) log.w("record-wake-outcome failed", o); return { nonce, dispatch: true };
}

// ---- 53 builds state
let b = await startBroker("53", dir, log);
const tLate = T("late"), tSub = T("sub"), tPlain = T("plain");
let pLate = await start("53", tLate); const pSub = await start("53", tSub);
send("53", tLate, "late-body-1");
const oldWake = await wake(tLate, pLate.instanceId, "r53-late-1");
pLate = await start("53", tLate); // restart -> new generation
await rpc(dir, "acquire-relay", { target: tLate, transport, relayId: "r53-late-2", pid, parentPid: pid, instanceId: pLate.instanceId });
const lateArr = hook("53", dir, wakePrompt(tLate, oldWake.nonce)); log.w("53 late arrival", lateArr.out);
const subMsg = send("53", tSub, "sub-body-1"); const subWake = await wake(tSub, pSub.instanceId, "r53-sub-1");
const claimedNoAck = send("53", tPlain, "plain-claimed"); const c = cli("53", dir, "claim", { target: tPlain }); log.w("53 claim no ack", c.data?.messages?.map((m) => m.messageId));
const queued = send("53", tPlain, "plain-queued");
const draft = cli("53", dir, "prepare", { sender, target: tPlain, body: "draft-by-53" }); log.w("53 draft", draft.data?.messageId);
F.obs.wake53 = { late: (await rpc(dir, "wake-status", { target: tLate })).data.wake, sub: (await rpc(dir, "wake-status", { target: tSub })).data.wake };
const s53 = snap("built-by-53");
await stopBroker(b, log);

// ---- downgrade
b = await startBroker(D, dir, log);
F.obs.downBrokerServing = !b.notServing;
const sDown = snap(`opened-by-${D}`);
F.obs.schemaChangedByDowngradeOpen = schemaOnly(s53) !== schemaOnly(sDown);
if (!b.notServing) {
  F.obs.pingCaps = (await rpc(dir, "ping", {})).data?.capabilities;
  F.obs.wakeStatusDown = { late: (await rpc(dir, "wake-status", { target: tLate })), sub: (await rpc(dir, "wake-status", { target: tSub })) };
  // old CLI sends the draft prepared by 53
  F.obs.sendDraftByDown = cli(D, dir, "send", { sender, messageId: draft.data?.messageId });
  // old hook: wake arrival for 53-submitted wake
  await rpc(dir, "presence-heartbeat", { target: tSub, instanceId: pSub.instanceId });
  const arr = hook(D, dir, wakePrompt(tSub, subWake.nonce));
  F.obs.downArrival = { keys: Object.keys(arr.out), decision: arr.out.decision ?? null, body: JSON.stringify(arr.out).includes("sub-body-1") };
  const ids = [...JSON.stringify(arr.out).matchAll(/messageIds: \[\\?"([0-9a-f-]{36})/g)].map((x) => x[1]);
  if (ids.length) F.obs.downArrivalAck = cli(D, dir, "acknowledge", { target: tSub, messageIds: ids }).data;
  // old: new wake for the current generation of tLate (53 retired the old attempt as observed+late)
  await rpc(dir, "presence-heartbeat", { target: tLate, instanceId: pLate.instanceId });
  const w = await wake(tLate, pLate.instanceId, `r${D.replace(/\./g, "")}-late-3`);
  F.obs.downNewWakeLate = { dispatch: w.dispatch, legacy: w.legacy ?? false, reserve: w.r, start: w.s ?? null };
  if (w.dispatch) { const a = hook(D, dir, wakePrompt(tLate, w.nonce)); F.obs.downNewWakeLateDelivered = JSON.stringify(a.out).includes("late-body-1");
    const ids2 = [...JSON.stringify(a.out).matchAll(/messageIds: \[\\?"([0-9a-f-]{36})/g)].map((x) => x[1]); if (ids2.length) cli(D, dir, "acknowledge", { target: tLate, messageIds: ids2 }); }
  // old CLI claim/ack of queued
  const cq = cli(D, dir, "claim", { target: tPlain, maxMessages: 10 }); F.obs.downClaimPlain = cq.ok ? cq.data.messages.map((m) => [m.body, m.deliveryAttempt]) : cq;
  if (cq.ok) F.obs.downAckPlain = cli(D, dir, "acknowledge", { target: tPlain, messageIds: cq.data.messages.map((m) => m.messageId) }).data;
  F.obs.downStatusClaimedNoAck = cli(D, dir, "status", { sender, messageId: claimedNoAck.id }).data?.status?.state ?? null;
  F.obs.downNewMessage = send(D, tPlain, `new-by-${D}`);
}
snap(`after-ops-${D}`);
await stopBroker(b, log);
// ---- upgrade back to 53
b = await startBroker("53", dir, log);
const sBack = snap("reopened-by-53");
F.obs.schemaAfterRoundTripEqual = schemaOnly(s53) === schemaOnly(sBack);
const back = cli("53", dir, "claim", { target: tPlain, maxMessages: 10 }); F.obs.backClaimPlain = back.data?.messages?.map((m) => [m.body, m.deliveryAttempt]);
if (back.ok) cli("53", dir, "acknowledge", { target: tPlain, messageIds: back.data.messages.map((m) => m.messageId) });
for (const t of [tLate, tSub, tPlain]) F.obs[`pendingEnd_${t.sessionId}`] = (await rpc(dir, "pending", { target: t })).data?.count;
const fin = snap("final");
await stopBroker(b, log);
F.integrity = fin.integrity; F.user_version = fin.user_version;
F.activeRows = fin.tables.wake_nonces.filter((r) => ["reserved", "started", "submitted", "unknown"].includes(r.state)).map((r) => [r.session_id, r.state, r.late_observed_at]);
F.unacked = fin.tables.messages.filter((r) => !r.acknowledged_at).map((r) => [r.target_session_id, r.body, r.delivery_attempts]);
log.w("FINDINGS", F); writeFileSync(`${out}/findings.json`, JSON.stringify(F, null, 1));
