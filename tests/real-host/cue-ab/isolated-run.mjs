// Explicit prepare/execute entry point. Never calls legacy prepare/snapshot/host-loop/cleanup scripts.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { TURNS } from "./tasks.mjs";

const [mode, host, armArgument, runArgument, specArgument, model, effort] = process.argv.slice(2);
if (!["prepare", "execute"].includes(mode) || !["codex", "claude"].includes(host) || !armArgument || !runArgument || !specArgument || !model || !effort) {
  throw new Error("usage: node isolated-run.mjs <prepare|execute> <codex|claude> <armRoot> <freshRunDir> <cue|spec.json> <model> <effort>");
}
const arm = path.resolve(armArgument), runDir = path.resolve(runArgument), here = import.meta.dirname;
if (existsSync(runDir)) throw new Error("Trial directory already exists; never reuse or delete an earlier run");
const spec = specArgument === "cue" ? { turns: TURNS } : JSON.parse(readFileSync(specArgument, "utf8"));
if (!Array.isArray(spec.turns) || !spec.turns.length || spec.turns.some(turn => typeof turn.id !== "string" || typeof turn.prompt !== "string")) throw new Error("spec requires nonempty turns with id/prompt");
if (host === "claude" && spec.turns.some(turn => turn.compactAfter)) throw new Error("Claude stream manual compaction is NOT_CONFIRMED; do not silently substitute resume");
const hooksRoot = host === "claude" ? path.join(arm, "claude-plugin") : arm;
const hooksFile = path.join(hooksRoot, "hooks/hooks.json");
const serverFile = path.join(hooksRoot, "mcp-server/dist/server.mjs");
for (const file of [hooksFile, serverFile, path.join(arm, "skills/registry.json")]) if (!existsSync(file)) throw new Error(`Missing candidate artifact: ${file}`);
mkdirSync(runDir, { recursive: true });
const repo = path.join(runDir, "repo"), state = path.join(runDir, "state");
mkdirSync(state);
if (spec.files) {
  mkdirSync(repo);
  for (const [relative, content] of Object.entries(spec.files)) {
    const target = path.resolve(repo, relative);
    if (!target.startsWith(repo + path.sep) || /(^|[/\\])(auth|credentials|config\.toml)([/\\.]|$)/iu.test(relative) || typeof content !== "string") throw new Error("Invalid fixture file");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content, { flag: "wx" });
  }
} else {
  const fixture = spawnSync(process.execPath, [path.join(here, "fixture.mjs"), repo], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (fixture.error || fixture.status !== 0) throw new Error(`Fixture preparation failed: ${fixture.error?.code ?? fixture.status}`);
}
const tasksFile = path.join(runDir, "tasks.json");
writeFileSync(tasksFile, JSON.stringify(spec.turns, null, 2));
const environment = { ...process.env, CUE_TASKS_FILE: tasksFile,
  CUE_LIFECYCLE_FILE: path.join(runDir, "lifecycle.jsonl"),
  XDG_STATE_HOME: state, AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
  AGENT_GOVERNANCE_DB_PATH: path.join(state, "workflow.sqlite3"),
  AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, "continuity.sqlite3"),
  AGENT_GOVERNANCE_TRUST_DB_PATH: path.join(state, "trust.sqlite3"),
  AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH: path.join(state, "board.sqlite3"),
  AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: path.join(state, "messaging"),
  AGENT_GOVERNANCE_LOCALE: spec.locale ?? "ko",
  PLUGIN_ROOT: hooksRoot, CLAUDE_PLUGIN_ROOT: hooksRoot, CLAUDE_PLUGIN_DATA: path.join(state, "plugin-data"),
  DISABLE_AUTOUPDATER: "1",
};
delete environment.AGENT_GOVERNANCE_CLASSIFICATION_CONFIG;
delete environment.AGENT_GOVERNANCE_ROOT;
const replaceRoot = value => {
  if (typeof value === "string") return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", hooksRoot).replaceAll("$env:PLUGIN_ROOT", hooksRoot).replaceAll("$PLUGIN_ROOT", hooksRoot);
  if (Array.isArray(value)) return value.map(replaceRoot);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRoot(item)]));
  return value;
};
const hooks = replaceRoot(JSON.parse(readFileSync(hooksFile, "utf8")).hooks);
for (const event of ["SessionStart", "UserPromptSubmit"]) {
  (hooks[event] ??= []).push({ hooks: [{ type: "command", command: `node "${path.join(here, "lifecycle-hook.mjs")}"`, timeout: 5 }] });
}
const envNames = ["AGENT_GOVERNANCE_SHARED_STATE_DIR", "AGENT_GOVERNANCE_DB_PATH", "AGENT_GOVERNANCE_CONTINUITY_DB_PATH",
  "AGENT_GOVERNANCE_TRUST_DB_PATH", "AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH", "AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR",
  "XDG_STATE_HOME", "CLAUDE_PLUGIN_DATA", "CUE_LIFECYCLE_FILE", "AGENT_GOVERNANCE_LOCALE"];
const mcpServer = { command: process.execPath, args: [serverFile], cwd: hooksRoot,
  env: { AGENT_GOVERNANCE_HOST_ATTESTATION: host === "claude" ? "claude-code" : "codex" }, env_vars: envNames };
const toml = value => {
  if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${toml(item)}`).join(",")}}`;
  return JSON.stringify(value);
};
let driver, args;
if (host === "codex") {
  // Per-process overrides only. HOME/CODEX_HOME remain unchanged so native CLI authentication stays native.
  const overrides = { hooks, mcp_servers: { "agent-governance-suite": mcpServer }, plugins: {} };
  const argv = ["--dangerously-bypass-hook-trust"];
  for (const [key, value] of Object.entries(overrides)) argv.push("-c", `${key}=${toml(value)}`);
  writeFileSync(path.join(runDir, "codex-argv.json"), JSON.stringify(argv));
  environment.CUE_CODEX_ARGV_FILE = path.join(runDir, "codex-argv.json");
  driver = "codex-stream.mjs";
  args = [runDir, repo, String(spec.timeoutSec ?? 600), model, effort];
} else {
  // Source composition keeps candidate hook semantics and MCP/skills bytes, with all state paths explicit.
  // Do not pass --plugin-dir: its host-generated CLAUDE_PLUGIN_DATA can supersede the trial environment.
  const settings = path.join(runDir, "claude-settings.json"), mcp = path.join(runDir, "claude-mcp.json");
  writeFileSync(settings, JSON.stringify({ hooks }));
  writeFileSync(mcp, JSON.stringify({ mcpServers: { "agent-governance-suite": { command: mcpServer.command, args: mcpServer.args, cwd: mcpServer.cwd,
    env: { ...Object.fromEntries(envNames.map(name => [name, environment[name]])), ...mcpServer.env } } } }));
  driver = "claude-stream.mjs";
  args = [runDir, repo, String(spec.timeoutSec ?? 600), "--session-id", randomUUID(), "--model", model, "--effort", effort,
    "--settings", settings, "--setting-sources", "project", "--mcp-config", mcp, "--strict-mcp-config", "--permission-mode", "acceptEdits"];
}
// Native workspace skill discovery; no installation and no writes to source arm directories.
const skillsDirectory = path.join(repo, host === "codex" ? ".agents/skills" : ".claude/skills");
mkdirSync(path.dirname(skillsDirectory), { recursive: true });
// Preserve the candidate's relative runtime imports; do not copy user settings or host history.
symlinkSync(path.join(hooksRoot, "skills"), skillsDirectory, process.platform === "win32" ? "junction" : "dir");
writeFileSync(path.join(runDir, "candidate.json"), JSON.stringify({ arm, host, model, effort, locale: environment.AGENT_GOVERNANCE_LOCALE,
  composition: "native-process-config-and-workspace-skills; plugin-loader NOT_TESTED",
  serverSha256: createHash("sha256").update(readFileSync(serverFile)).digest("hex"),
  hooksSha256: createHash("sha256").update(readFileSync(hooksFile)).digest("hex"),
  turns: spec.turns.map(turn => turn.id), mode, semanticResult: "NOT_EVALUATED" }, null, 2));
if (mode === "prepare") {
  console.log(JSON.stringify({ state: "PREPARED_NOT_EXECUTED", runDir, host, driver }));
} else {
  const result = spawnSync(process.execPath, [path.join(here, driver), ...args], { cwd: repo, env: environment,
    stdio: "inherit", timeout: (spec.turns.length + spec.turns.filter(turn => turn.compactAfter).length + 1) * Number(spec.timeoutSec ?? 600) * 1000 + 10_000, windowsHide: true });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  // Wrapper exit is never semantic acceptance. Claude legacy driver may exit0 after a failed turn.
  const rows = readFileSync(path.join(runDir, "turns.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  if (rows.length !== spec.turns.length || rows.some(row => row.exit !== 0 || row.skipped)) process.exitCode = 1;
  const events = existsSync(environment.CUE_LIFECYCLE_FILE) ? readFileSync(environment.CUE_LIFECYCLE_FILE, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  writeFileSync(path.join(runDir, "transport-summary.json"), JSON.stringify({ processExit: process.exitCode,
    plannedTurns: spec.turns.length, recordedTurns: rows.length,
    sessionStartCount: events.filter(event => event.event === "SessionStart").length,
    userPromptSubmitCount: events.filter(event => event.event === "UserPromptSubmit").length,
    lifecycleSessionIds: [...new Set(events.map(event => event.sessionId).filter(Boolean))],
    deliveryToModel: "NOT_PROVEN_BY_OBSERVER", semanticResult: "NOT_EVALUATED", processTreeCleanup: "REQUIRES_REMOTE_OBSERVATION" }, null, 2));
}
