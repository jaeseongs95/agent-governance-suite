// (b-expiry) OLD-latched 'unknown'+late row: does an upgraded broker release it after the row's expires_at?
// usage: node scen-b-expiry.mjs <writer> <afterBroker> <offsetMs>
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { startBroker, stopBroker, cli, hook, rpc, dump, Log, sleep, envFor, VERSIONS } from "./lib.mjs";
const [W = "2.7.1", AB = "53", OFF = String(2 * 3600_000)] = process.argv.slice(2);
const tag = `b-expiry-w${W}-b${AB}-off${OFF}`; const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true }); const log = new Log(`${out}/run.log`);
let n = 0; const snap = (l) => { const d = dump(dir, `${out}/${String(n++).padStart(2, "0")}-${l}.json`);
  log.w(`  [dump ${l}] wake=${JSON.stringify(d.tables?.wake_nonces?.map((r) => [r.state, r.late_observed_at ? "late" : "-", r.expires_at]))} msgs=${JSON.stringify(d.tables?.messages?.map((r) => [r.body, r.acknowledged_at ? "acked" : "open", r.expires_at]))}`); return d; };
const target = { host: "codex", sessionId: "tgt-expiry" }, sender = { host: "claude-code", sessionId: "sender" }, transport = "codex-queue", pid = process.pid;
const caps = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" };
async function presence(inst) { return rpc(dir, "presence-start", { target, instanceId: inst, transport, wakeVisibility: "user-message", canWakeSilently: false, ...caps }); }
async function wake(inst, relayId) { await rpc(dir, "acquire-relay", { target, transport, relayId, pid, parentPid: pid, instanceId: inst });
  const nonce = randomBytes(24).toString("base64url"); const r = await rpc(dir, "reserve-wake", { target, nonce, instanceId: inst, relayId, transport });
  if (!r.data?.dispatch) return { nonce, dispatch: false, r }; const s = await rpc(dir, "start-wake", { attempt: r.data.attempt });
  await rpc(dir, "record-wake-outcome", { attempt: s.data.attempt, outcome: "submitted" }); return { nonce, dispatch: true }; }
let b = await startBroker(W, dir, log);
await presence("inst-1"); const p = cli(W, dir, "prepare", { sender, target, body: "old-body" }); cli(W, dir, "send", { sender, messageId: p.data.messageId });
const w1 = await wake("inst-1", "relay-1"); log.w("writer wake", w1.dispatch);
await presence("inst-2"); await rpc(dir, "acquire-relay", { target, transport, relayId: "relay-2", pid, parentPid: pid, instanceId: "inst-2" });
const h = hook(W, dir, { hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "", prompt: `[agent-governance-suite:wake:${w1.nonce}]` });
log.w("old-generation arrival via hook", W, h.out); const c = cli(W, dir, "claim", { target }); cli(W, dir, "acknowledge", { target, messageIds: c.data.messages.map((m) => m.messageId) });
snap("writer-latched"); await stopBroker(b, log);
// shifted-clock broker
const child = spawn(process.execPath, ["--import", "/tmp/ev/scripts/clock-shift.mjs", path.join(VERSIONS[AB], "mcp-server/dist/session-message-broker.mjs"), "--state-directory", dir],
  { env: { ...envFor(dir), AGS_CLOCK_OFFSET_MS: OFF }, stdio: "ignore" });
const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
for (let i = 0; i < 100; i++) { try { if (JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8")).pid === child.pid && (await rpc(dir, "ping", {})).ok) break; } catch {} await sleep(50); }
log.w(`[broker ${AB} offset ${OFF}ms] pid=${child.pid} ping`, (await rpc(dir, "ping", {})).ok);
snap("opened-shifted");
await presence("inst-3");
const p2 = cli(AB, dir, "prepare", { sender, target, body: "fresh-body" }); const s2 = cli(AB, dir, "send", { sender, messageId: p2.data?.messageId }); log.w("fresh send", s2.ok, s2.error);
const w2 = await wake("inst-3", "relay-3"); log.w("new wake after expiry", w2.dispatch, JSON.stringify(w2.r?.data ?? w2.r?.error ?? null));
const ws = await rpc(dir, "wake-status", { target }); log.w("wake-status", ws.data?.wake);
const fin = snap("final");
child.kill("SIGTERM"); await exited;
const F = { tag, writer: W, afterBroker: AB, offsetMs: Number(OFF), newWakeDispatch: w2.dispatch, wakeStatus: ws.data?.wake,
  active: fin.tables.wake_nonces.filter((r) => ["reserved", "started", "submitted", "unknown"].includes(r.state)).map((r) => [r.state, r.late_observed_at, r.expires_at]) };
log.w("FINDINGS", F); writeFileSync(`${out}/findings.json`, JSON.stringify(F, null, 1));
