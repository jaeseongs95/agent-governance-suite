// Control (single version V): submitted wake whose marker never reaches the host; body drained via CLI claim+ACK.
// Then a V broker with shifted clock: can a new wake be reserved for a fresh message?
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { startBroker, stopBroker, cli, rpc, dump, Log, sleep, envFor, VERSIONS } from "./lib.mjs";
const [V, OFF] = process.argv.slice(2);
const tag = `ctl-undelivered-submitted-${V}-off${OFF}`; const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true }); const log = new Log(`${out}/run.log`);
const target = { host: "codex", sessionId: "t" }, sender = { host: "claude-code", sessionId: "s" }, transport = "codex-queue", pid = process.pid;
const pres = (inst) => rpc(dir, "presence-start", { target, instanceId: inst, transport, wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" });
async function wake(inst, relayId) { await rpc(dir, "acquire-relay", { target, transport, relayId, pid, parentPid: pid, instanceId: inst });
  const r = await rpc(dir, "reserve-wake", { target, nonce: randomBytes(24).toString("base64url"), instanceId: inst, relayId, transport });
  if (!r.data?.attempt) return r; const s = await rpc(dir, "start-wake", { attempt: r.data.attempt });
  await rpc(dir, "record-wake-outcome", { attempt: s.data.attempt, outcome: "submitted" }); return r; }
let b = await startBroker(V, dir, log); await pres("i1");
const p = cli(V, dir, "prepare", { sender, target, body: "b1" }); cli(V, dir, "send", { sender, messageId: p.data.messageId });
log.w("wake1", (await wake("i1", "r1")).data?.dispatch);
const c = cli(V, dir, "claim", { target }); cli(V, dir, "acknowledge", { target, messageIds: c.data.messages.map((m) => m.messageId) });
dump(dir, `${out}/00-built.json`); await stopBroker(b, log);
const child = spawn(process.execPath, ["--import", "/tmp/ev/scripts/clock-shift.mjs", path.join(VERSIONS[V], "mcp-server/dist/session-message-broker.mjs"), "--state-directory", dir],
  { env: { ...envFor(dir), AGS_CLOCK_OFFSET_MS: OFF }, stdio: "ignore" }); const exited = new Promise((r) => child.once("exit", r));
for (let i = 0; i < 100; i++) { try { if (JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8")).pid === child.pid && (await rpc(dir, "ping", {})).ok) break; } catch {} await sleep(50); }
await pres("i2"); const p2 = cli(V, dir, "prepare", { sender, target, body: "b2" }); cli(V, dir, "send", { sender, messageId: p2.data.messageId });
const r2 = await wake("i2", "r2"); const ws = await rpc(dir, "wake-status", { target });
const fin = dump(dir, `${out}/01-final.json`); child.kill("SIGTERM"); await exited;
const F = { tag, newWakeDispatch: r2.data?.dispatch ?? null, wake: ws.data?.wake?.state, observation: ws.data?.wake?.observation,
  active: fin.tables.wake_nonces.filter((x) => ["reserved", "started", "submitted", "unknown"].includes(x.state)).map((x) => [x.state, x.instance_id, x.expires_at]) };
log.w("FINDINGS", F); writeFileSync(`${out}/findings.json`, JSON.stringify(F, null, 1));
