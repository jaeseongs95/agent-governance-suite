// Minimal stdio MCP client (no deps): initialize -> notifications/initialized -> tools/list.
import { spawn } from "node:child_process";
const [cwd, entry, envJson] = process.argv.slice(2);
const child = spawn(process.execPath, [entry], { cwd, env: { ...process.env, ...JSON.parse(envJson || "{}") }, stdio: ["pipe", "pipe", "pipe"] });
let buf = ""; const pending = new Map(); let stderr = "";
child.stderr.on("data", (d) => { stderr += d; });
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue; const m = JSON.parse(line); if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } } });
const send = (m) => child.stdin.write(JSON.stringify(m) + "\n");
const req = (id, method, params) => new Promise((res, rej) => { pending.set(id, res); send({ jsonrpc: "2.0", id, method, params }); setTimeout(() => rej(new Error("timeout " + method)), 20000); });
try {
  const init = await req(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ev-probe", version: "0" } });
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const list = await req(2, "tools/list", {});
  const tools = list.result?.tools ?? [];
  const instr = init.result?.instructions ?? "";
  console.log(JSON.stringify({ ok: !init.error && !list.error, serverInfo: init.result?.serverInfo, protocolVersion: init.result?.protocolVersion,
    instructionsBytes: Buffer.byteLength(instr), instructionsHead: instr.slice(0, 160), hasIntake: instr.includes("접수 규칙"),
    toolCount: tools.length, toolNames: tools.map((t) => t.name).sort(), error: init.error ?? list.error ?? null }, null, 2));
  process.exitCode = (!init.error && !list.error && tools.length > 0) ? 0 : 1;
} catch (e) { console.log("PROBE_ERROR", e.message, "\nstderr:", stderr.slice(0, 2000)); process.exitCode = 1; }
finally { child.kill(); }
