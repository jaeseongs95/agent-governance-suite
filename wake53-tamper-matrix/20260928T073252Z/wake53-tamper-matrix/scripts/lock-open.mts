// Store already open (broker steady state); another process holds BEGIN EXCLUSIVE on session or trust DB during claimHostWake.
import { spawn } from "node:child_process"; import { existsSync, readFileSync, rmSync } from "node:fs"; import path from "node:path"; import { DatabaseSync } from "node:sqlite";
const WT = process.env.WT!; const [dir, which] = process.argv.slice(2);
const { SessionMessageStore } = await import(`${WT}/mcp-server/src/session-message-store.ts`);
const { createWakeHookObservationReader } = await import(`${WT}/mcp-server/src/session-message-wake-port.ts`);
const meta = JSON.parse(readFileSync(path.join(dir, "..", path.basename(dir) + ".meta.json"), "utf8"));
const db = path.join(dir, which === "trust" ? "trust.sqlite3" : "session-messages.sqlite3");
const store = new SessionMessageStore(path.join(dir, "session-messages.sqlite3"));
const flag = db + ".locked"; rmSync(flag, { force: true });
const locker = spawn(process.execPath, ["-e", `const {DatabaseSync}=require("node:sqlite"); const d=new DatabaseSync(${JSON.stringify(db)}); d.exec("BEGIN EXCLUSIVE"); require("fs").writeFileSync(${JSON.stringify(flag)},"1"); setTimeout(()=>{d.exec("ROLLBACK");d.close()},8000);`], { stdio: "inherit" });
while (!existsSync(flag)) await new Promise((r) => setTimeout(r, 20));
const t = Date.now(); const out: any = {};
try { const r = store.claimHostWake(meta.target, meta.obs, meta.receipt, createWakeHookObservationReader(path.join(dir, "trust.sqlite3")), meta.T + 10); Object.assign(out, { recognized: r.recognized, messages: r.messages.length, managed: r.binding !== null }); }
catch (e: any) { out.error = `${e.code ?? ""} ${e.errcode ?? ""} ${e.message}`; }
out.elapsedMs = Date.now() - t; store.close(); await new Promise((r) => locker.once("exit", r));
const d = new DatabaseSync(path.join(dir, "session-messages.sqlite3"), { readOnly: true });
out.post = { wake: d.prepare("SELECT state, late_observed_at FROM wake_nonces").all(), msgs: d.prepare("SELECT claimed_at FROM messages").all() }; d.close();
console.log(JSON.stringify(out));
