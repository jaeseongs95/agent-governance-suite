#!/usr/bin/env node
// Capture launcher: runs one host case with exact argv (no shell). Model output stays in out/<case>.log on the
// test server; only event-type counts are summarized. Usage: node run.mjs <case> ; env CODEX_CMD / CLAUDE_CMD / AGY_CMD = JSON argv prefix.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const fwd = (p) => p.replaceAll("\\", "/");
const kase = process.argv[2];
const host = kase.split("-")[0];
const out = path.join(here, `out-${host}`);
mkdirSync(out, { recursive: true });
const recorder = fwd(path.join(here, "recorder.mjs"));
const hook = fwd(path.join(here, "hook.mjs"));
const work = path.join(here, "work");
mkdirSync(work, { recursive: true });
const status = (row) => appendFileSync(path.join(out, "status.jsonl"), JSON.stringify({ t: new Date().toISOString(), case: kase, ...row }) + "\n");

const P_MAIN = "This is an automated metadata capture test; follow exactly. 1) Call the MCP tool probe (server capture) with label main-1. "
  + "2) Then, in ONE assistant message, issue two probe calls in parallel with labels par-a and par-b. "
  + "3) Then start exactly one subagent and tell it to call the probe tool with label sub-1; wait for it to finish. 4) Reply DONE.";
const P_NESTED = "Automated metadata capture test; follow exactly. 1) Call the MCP tool probe (server capture) with label nest-0. "
  + "2) Start exactly one subagent A. Tell A: call the probe tool with label nest-1, then start exactly one subagent B of your own and tell B "
  + "to call the probe tool with label nest-2; wait for B. 3) Wait for A to finish. 4) Reply DONE.";
const P_ONE = (label) => `Automated capture test. Call the MCP tool probe (server capture) once with label ${label}, then reply DONE.`;

function codexArgs(label, tail) {
  const prefix = CMD.codex;
  return [...prefix, "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
    "--dangerously-bypass-approvals-and-sandbox", "--dangerously-bypass-hook-trust", "-C", work,
    "-c", 'mcp_servers.capture.command="node"', "-c", `mcp_servers.capture.args=["${recorder}"]`,
    "-c", `mcp_servers.capture.env={CAPTURE_DIR="${fwd(out)}",CAPTURE_LABEL="${label}"}`,
    "-c", `hooks.PreToolUse=[{matcher="^mcp__capture__.*$",hooks=[{type="command",command="node ${hook} --dir=${fwd(out)}"}]}]`,
    ...(process.env.CODEX_EXTRA ? JSON.parse(process.env.CODEX_EXTRA) : []), ...tail];
}
const win = process.platform === "win32";
const home = process.env.USERPROFILE || process.env.HOME;
const CMD = {
  codex: process.env.CODEX_CMD ? JSON.parse(process.env.CODEX_CMD) : win
    ? ["node", path.join(process.env.APPDATA ?? "", "npm/node_modules/@openai/codex/bin/codex.js")] : [path.join(home, ".local/share/ssh-approval-cli/codex")],
  agy: process.env.AGY_CMD ? JSON.parse(process.env.AGY_CMD) : win
    ? [path.join(process.env.LOCALAPPDATA ?? "", "agy/bin/agy.exe")] : ["agy"],
  claude: process.env.CLAUDE_CMD ? JSON.parse(process.env.CLAUDE_CMD) : win
    ? [path.join(home, ".local/bin/claude.exe")] : [path.join(home, ".local/share/ssh-approval-cli/claude")],
};
const threadFile = path.join(out, "thread-id");

let argv; let stdinText = null;
if (kase === "codex-main") argv = codexArgs("codex-main", [P_MAIN]);
else if (kase === "codex-nested") argv = codexArgs("codex-nested", [P_NESTED]);
else if (kase === "codex-resume") argv = codexArgs("codex-resume", ["resume", readFileSync(threadFile, "utf8").trim(), P_ONE("resume-1")]);
else if (kase === "codex-fork") argv = codexArgs("codex-fork", ["fork", readFileSync(threadFile, "utf8").trim(), P_ONE("fork-1")]);
else if (kase === "codex-features") argv = [...CMD.codex, "features", "list"];
else if (kase === "claude-main" || kase === "claude-nested") {
  const mcp = path.join(out, "mcp.json");
  writeFileSync(mcp, JSON.stringify({ mcpServers: { capture: { command: "node", args: [recorder], env: { CAPTURE_DIR: fwd(out), CAPTURE_LABEL: kase } } } }));
  const settings = path.join(out, "settings.json");
  writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^mcp__capture__.*$", hooks: [{ type: "command", command: "node", args: [hook, `--dir=${fwd(out)}`] }] }] } }));
  argv = [...CMD.claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--mcp-config", mcp, "--strict-mcp-config", "--settings", settings, "--dangerously-skip-permissions"];
  stdinText = JSON.stringify({ type: "user", message: { role: "user", content: (kase === "claude-main" ? P_MAIN : P_NESTED).replaceAll("start exactly one subagent", "use the Agent tool to start exactly one general-purpose subagent") } }) + "\n";
} else if (kase === "agy-main" || kase === "agy-resume" || kase === "agy-nested") {
  // agy 1.4.12 reads MCP servers from its global config (`agy mcp add`, done by the operator) and
  // PreToolUse hooks from <workspace>/.agents/hooks.json; the hook must answer {"decision":"allow"}.
  mkdirSync(path.join(work, ".agents"), { recursive: true });
  writeFileSync(path.join(work, ".agents", "hooks.json"), JSON.stringify({ capture: { PreToolUse: [{ matcher: ".*",
    hooks: [{ type: "command", command: `node ${hook} --agy --dir=${fwd(out)}` }] }] } }));
  argv = [...CMD.agy, "-p", kase === "agy-main" ? P_MAIN : kase === "agy-nested" ? P_NESTED : P_ONE("resume-1"), "--output-format", "stream-json",
    "--dangerously-skip-permissions", "--print-timeout", "420s", ...(kase === "agy-resume" ? ["--continue"] : [])];
} else throw new Error(`unknown case ${kase}`);

status({ phase: "start", argc: argv.length });
const child = spawn(argv[0], argv.slice(1), { cwd: work, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
const log = path.join(out, `${kase}.log`);
const events = {};
let lineBuf = "";
child.stdout.on("data", (d) => {
  appendFileSync(log, d);
  lineBuf += d.toString("utf8");
  let i;
  while ((i = lineBuf.indexOf("\n")) >= 0) {
    const line = lineBuf.slice(0, i); lineBuf = lineBuf.slice(i + 1);
    try {
      const e = JSON.parse(line);
      const type = e.type ?? "?";
      events[type] = (events[type] ?? 0) + 1;
      if (kase === "codex-main" && type === "thread.started" && e.thread_id && !existsSync(threadFile)) writeFileSync(threadFile, e.thread_id);
    } catch { /* not json */ }
  }
});
child.stderr.on("data", (d) => appendFileSync(path.join(out, `${kase}.stderr`), d));
if (stdinText) child.stdin.end(stdinText); else child.stdin.end();
const timer = setTimeout(() => { status({ phase: "timeout" }); child.kill(); }, 8 * 60_000);
child.on("exit", (code, signal) => { clearTimeout(timer); status({ phase: "exit", code, signal, events }); });
child.on("error", (e) => status({ phase: "spawn-error", code: e.code ?? null }));
