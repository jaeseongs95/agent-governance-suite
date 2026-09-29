// Sends initialize, notifications/initialized, tools/list to the installed server over stdio (newline-delimited JSON-RPC).
import { spawn } from "node:child_process";
const server = process.argv[2];
const child = spawn(process.execPath, [server], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
let buf = ""; const pending = new Map();
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } else console.log("NOTIFY", line.slice(0, 300)); } });
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d));
const req = (id, method, params) => new Promise((res, rej) => { pending.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); setTimeout(() => rej(new Error("timeout " + method)), 20000); });
try {
  const init = await req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ev-smoke", version: "0" } });
  console.log("INITIALIZE", JSON.stringify(init.result?.serverInfo), "protocol", init.result?.protocolVersion, init.error ? JSON.stringify(init.error) : "");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await req(2, "tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  console.log("TOOLS_COUNT", names.length); console.log("TOOLS", names.join(","));
  if (list.error) console.log("TOOLS_ERROR", JSON.stringify(list.error));
  const ok = init.result?.serverInfo?.version === "2.7.2" && names.length > 0;
  console.log("VERDICT", ok ? "PASS" : "FAIL"); process.exitCode = ok ? 0 : 1;
} catch (e) { console.log("ERROR", e.message); process.exitCode = 1; }
child.stdin.end(); setTimeout(() => { child.kill(); process.exit(); }, 1500);
