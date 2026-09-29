// (c2) After 53 -> OLD -> 53 round trip, is a 53 'submitted' row that OLD delivered around still blocking, now and after expiry?
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { cli, rpc, dump, Log, sleep, envFor, VERSIONS } from "./lib.mjs";
const [SRC, OFF] = process.argv.slice(2);
const tag = `c2-${SRC}-off${OFF}`; const out = `/tmp/ev/dumps/${tag}`; mkdirSync(out, { recursive: true });
const dir = `/tmp/ev-state/${tag}`; rmSync(dir, { recursive: true, force: true }); cpSync(`/tmp/ev-state/${SRC}`, dir, { recursive: true });
for (const f of ["endpoint.json", "broker.lock"]) rmSync(path.join(dir, f), { force: true });
const log = new Log(`${out}/run.log`);
const target = { host: "codex", sessionId: "sub" }, sender = { host: "claude-code", sessionId: "sender" }, transport = "codex-queue", pid = process.pid;
dump(dir, `${out}/00-copied.json`);
const child = spawn(process.execPath, ["--import", "/tmp/ev/scripts/clock-shift.mjs", path.join(VERSIONS["53"], "mcp-server/dist/session-message-broker.mjs"), "--state-directory", dir],
  { env: { ...envFor(dir), AGS_CLOCK_OFFSET_MS: OFF }, stdio: "ignore" });
const exited = new Promise((r) => child.once("exit", r));
for (let i = 0; i < 100; i++) { try { if (JSON.parse(readFileSync(path.join(dir, "endpoint.json"), "utf8")).pid === child.pid && (await rpc(dir, "ping", {})).ok) break; } catch {} await sleep(50); }
await rpc(dir, "presence-start", { target, instanceId: "inst-new", transport, wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" });
const p = cli("53", dir, "prepare", { sender, target, body: "fresh" }); const s = cli("53", dir, "send", { sender, messageId: p.data?.messageId });
await rpc(dir, "acquire-relay", { target, transport, relayId: "relay-new", pid, parentPid: pid, instanceId: "inst-new" });
const r = await rpc(dir, "reserve-wake", { target, nonce: randomBytes(24).toString("base64url"), instanceId: "inst-new", relayId: "relay-new", transport });
const ws = await rpc(dir, "wake-status", { target });
log.w(`offset=${OFF} send=${s.ok} reserve=`, r, "wake-status=", ws.data?.wake);
const fin = dump(dir, `${out}/01-final.json`);
child.kill("SIGTERM"); await exited;
const F = { tag, offsetMs: Number(OFF), newWakeDispatch: r.data?.dispatch ?? null, wake: ws.data?.wake,
  active: fin.tables.wake_nonces.filter((x) => ["reserved", "started", "submitted", "unknown"].includes(x.state)).map((x) => [x.session_id, x.state, x.expires_at]) };
log.w("FINDINGS", F); writeFileSync(`${out}/findings.json`, JSON.stringify(F, null, 1));
