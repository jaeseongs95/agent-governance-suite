// Usage: node mcp-probe.mjs <cwd> <command> <args...>  (env passed through)
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
const [cwd, command, ...args] = process.argv.slice(2);
const entry = path.resolve(cwd, args[0]);
console.log(JSON.stringify({ cwd, command, args, entry, entrySha256: createHash("sha256").update(readFileSync(entry)).digest("hex") }));
const child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
let buf = "", stderr = "";
const pending = new Map();
child.stderr.on("data", (d) => { stderr += d; });
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { console.log("NONJSON_STDOUT", line); continue; }
    if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    else console.log("SERVER_MSG", JSON.stringify(msg));
  }
});
let nextId = 1;
const req = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++; pending.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  setTimeout(() => reject(new Error(`timeout ${method}`)), 15000);
});
const exitP = new Promise((r) => child.on("exit", (code, signal) => r({ code, signal })));
try {
  const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "install-tree-probe", version: "0" } });
  console.log("INITIALIZE", JSON.stringify(init.result ? { protocolVersion: init.result.protocolVersion, serverInfo: init.result.serverInfo, capabilities: init.result.capabilities, hasInstructions: typeof init.result.instructions === "string", instructionsLen: init.result.instructions?.length } : init));
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const list = await req("tools/list", {});
  const tools = list.result?.tools ?? [];
  console.log("TOOLS_COUNT", tools.length);
  console.log("TOOLS", JSON.stringify(tools.map((t) => t.name).sort()));
  const plan = tools.find((t) => t.name === "plan_workflow");
  console.log("PLAN_WORKFLOW_TOP_ONEOF", Boolean(plan?.inputSchema?.oneOf));
  if (!list.result) console.log("TOOLS_LIST_RAW", JSON.stringify(list));
} catch (e) { console.log("PROBE_ERROR", e.message); }
child.stdin.end();
const t = setTimeout(() => child.kill("SIGTERM"), 5000);
const ex = await exitP; clearTimeout(t);
console.log("SERVER_EXIT", JSON.stringify(ex));
console.log("SERVER_STDERR_BEGIN\n" + stderr + "\nSERVER_STDERR_END");
