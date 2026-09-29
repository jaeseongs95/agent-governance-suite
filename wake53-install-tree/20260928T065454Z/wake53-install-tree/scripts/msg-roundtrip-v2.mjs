// Cross-install-tree session message round trip. Each tool call goes through the installed
// PreToolUse hook (as the host would), and the hook's updatedInput is sent to the installed server.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
const HOME = process.argv[2];
const PATH = process.env.PATH;
mkdirSync(HOME + "/plugin-data", { recursive: true });
const hosts = {
  codex: { root: "/tmp/install/codex", sid: "codex-sess-A", cwd: "/tmp/install/codex", args: ["mcp-server/dist/server.mjs"],
    env: { PATH, HOME, AGENT_GOVERNANCE_HOST_ATTESTATION: "codex" }, prefix: "mcp__agent_governance_suite__",
    hook: (evt) => ({ cmd: "bash", args: ["-c", 'node "$PLUGIN_ROOT/mcp-server/dist/session-message-hook.mjs"' + (evt === "SessionStart" ? ' --host-pid "$PPID"' : "")], env: { PATH, HOME, PLUGIN_ROOT: "/tmp/install/codex" } }) },
  claude: { root: "/tmp/install/claude", sid: "claude-sess-B", cwd: HOME, args: ["/tmp/install/claude/mcp-server/dist/server.mjs"],
    env: { PATH, HOME, CLAUDE_PLUGIN_ROOT: "/tmp/install/claude", CLAUDE_PLUGIN_DATA: HOME + "/plugin-data", AGENT_GOVERNANCE_DB_PATH: HOME + "/plugin-data/workflows.sqlite3", AGENT_GOVERNANCE_CONTINUITY_DB_PATH: HOME + "/plugin-data/continuity.sqlite3", AGENT_GOVERNANCE_TOOL_SCHEMA_PROFILE: "anthropic", AGENT_GOVERNANCE_HOST_ATTESTATION: "claude-code" },
    prefix: "mcp__plugin_agent-governance-suite_agent-governance-suite__",
    hook: () => ({ cmd: "node", args: ["/tmp/install/claude/hooks/session-message-hook.mjs"], env: { PATH, HOME, CLAUDE_PLUGIN_ROOT: "/tmp/install/claude", CLAUDE_PLUGIN_DATA: HOME + "/plugin-data" } }) },
};
const runHook = (h, input) => {
  const spec = hosts[h].hook(input.hook_event_name);
  const r = spawnSync(spec.cmd, spec.args, { input: JSON.stringify({ session_id: hosts[h].sid, cwd: "/tmp", transcript_path: HOME + "/t.jsonl", ...input }), env: spec.env, encoding: "utf8", timeout: 15000 });
  console.log(`HOOK ${h} ${input.hook_event_name} ${input.tool_name ?? ""} exit=${r.status} stdout=${r.stdout} stderr=${r.stderr}`);
  return r;
};
const startServer = (h) => {
  const c = hosts[h]; const child = spawn("node", c.args, { cwd: c.cwd, env: c.env, stdio: ["pipe", "pipe", "pipe"] });
  let buf = "", stderr = ""; const pending = new Map(); let id = 1;
  child.stderr.on("data", (d) => stderr += d);
  child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (!l.trim()) continue; const m = JSON.parse(l); pending.get(m.id)?.(m); } });
  const req = (method, params) => new Promise((res, rej) => { const n = id++; pending.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); setTimeout(() => rej(new Error("timeout " + method)), 20000); });
  return { child, req, stderr: () => stderr };
};
const srv = { codex: startServer("codex"), claude: startServer("claude") };
for (const h of ["codex", "claude"]) {
  await srv[h].req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "roundtrip", version: "0" } });
  srv[h].child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}
const call = async (h, tool, args) => {
  const r = runHook(h, { hook_event_name: "PreToolUse", tool_name: hosts[h].prefix + tool, tool_input: args, tool_use_id: "toolu_" + tool });
  let input = args; try { input = JSON.parse(r.stdout).hookSpecificOutput?.updatedInput ?? args; } catch {}
  const res = await srv[h].req("tools/call", { name: tool, arguments: input });
  const text = res.result?.content?.[0]?.text; let parsed; try { parsed = JSON.parse(text); } catch { parsed = res; }
  console.log(`CALL ${h} ${tool} args=${JSON.stringify(input)}\n  => ${JSON.stringify(parsed)}`);
  return parsed;
};
let verdict = "FAIL";
try {
  runHook("codex", { hook_event_name: "SessionStart", source: "startup" });
  runHook("claude", { hook_event_name: "SessionStart", source: "startup" });
  const prep = await call("codex", "prepare_session_message", { schemaVersion: "1.0.0", targetHost: "claude-code", targetSessionId: hosts.claude.sid, body: "install-tree probe: hello from codex tree v2" });
  const messageId = prep?.data?.messageId;
  if (!messageId) throw new Error("prepare failed");
  const sent = await call("codex", "send_session_message", { schemaVersion: "1.0.0", messageId });
  await call("codex", "get_session_message_status", { schemaVersion: "1.0.0", messageId });
  runHook("claude", { hook_event_name: "UserPromptSubmit", prompt: "next" });
  let recv = runHook("claude", { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "true" }, tool_response: {}, tool_use_id: "toolu_post" });
  console.log("RECV_EVENT", recv.stdout ? "PostToolUse" : "none-yet");
  if (!recv.stdout) { recv = runHook("claude", { hook_event_name: "Stop", stop_hook_active: false }); console.log("RECV_EVENT", recv.stdout ? "Stop" : "none"); }
  const delivered = recv.stdout.includes(messageId) || recv.stdout.includes("hello from codex tree v2");
  console.log("DELIVERED_VIA_HOOK", delivered);
  const ack = await call("claude", "acknowledge_session_messages", { schemaVersion: "1.0.0", messageIds: [messageId] });
  const st = await call("codex", "get_session_message_status", { schemaVersion: "1.0.0", messageId });
  const state = st?.data?.status?.state;
  console.log("FINAL_STATE", state);
  verdict = sent?.ok && delivered && ack?.ok && state === "acknowledged" ? "PASS" : "FAIL";
} catch (e) { console.log("ERROR", e.stack); }
for (const h of ["codex", "claude"]) { srv[h].child.stdin.end(); console.log(`SERVER_STDERR ${h}: ${srv[h].stderr()}`); }
console.log("ROUNDTRIP_VERDICT", verdict);
process.exitCode = verdict === "PASS" ? 0 : 1;
setTimeout(() => process.exit(), 3000);
