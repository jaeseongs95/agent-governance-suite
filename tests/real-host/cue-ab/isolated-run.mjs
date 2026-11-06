// Explicit prepare/execute entry point. Never calls legacy prepare/snapshot/host-loop/cleanup scripts.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { TURNS } from "./tasks.mjs";
import { requireLinux, retireGroup, spawnOwned, stopGroups, stopRecordedGroups } from "./owned-process.mjs";
import { normalizeHooks, sha256 } from "./trial-preflight.mjs";

const [mode, host, armArgument, runArgument, specArgument, model, effort] = process.argv.slice(2);
if (!["prepare", "execute"].includes(mode) || !["codex", "claude"].includes(host) || !armArgument || !runArgument || !specArgument || !model || !effort) {
  throw new Error("usage: node isolated-run.mjs <prepare|execute> <codex|claude> <armRoot> <freshRunDir> <cue|spec.json> <model> <effort>");
}
const arm = path.resolve(armArgument), runDir = path.resolve(runArgument), here = import.meta.dirname;
if (existsSync(runDir)) throw new Error("Trial directory already exists; never reuse or delete an earlier run");
const spec = specArgument === "cue" ? { turns: TURNS } : JSON.parse(readFileSync(specArgument, "utf8"));
if (!Array.isArray(spec.turns) || !spec.turns.length || spec.turns.some(turn => typeof turn.id !== "string" || typeof turn.prompt !== "string")) throw new Error("spec requires nonempty turns with id/prompt");
const timeoutSec = spec.timeoutSec === undefined ? 600 : spec.timeoutSec;
const outerTimeoutMs = (spec.turns.length + spec.turns.filter(turn => turn.compactAfter).length + 1) * timeoutSec * 1000 + 10_000;
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || !Number.isFinite(outerTimeoutMs) || outerTimeoutMs > 2 ** 31 - 1) throw new Error("timeoutSec must be finite, positive, and within native timer limits");
if (spec.turns.some(turn => turn.compactAfter !== undefined && typeof turn.compactAfter !== "boolean")) throw new Error("compactAfter must be a boolean");
const candidateSha = spec.candidateSha ?? process.env.CUE_CANDIDATE_SHA;
if (!/^[a-f0-9]{40}$/u.test(candidateSha ?? "")) throw new Error("Set the exact candidateSha or CUE_CANDIDATE_SHA");
requireLinux();
if (host === "claude" && spec.turns.some(turn => turn.compactAfter)) throw new Error("Claude stream manual compaction is NOT_CONFIRMED; do not silently substitute resume");
const hooksRoot = host === "claude" ? path.join(arm, "claude-plugin") : arm;
const hooksFile = path.join(hooksRoot, "hooks/hooks.json");
const serverFile = path.join(hooksRoot, "mcp-server/dist/server.mjs");
for (const file of [hooksFile, serverFile, path.join(arm, "skills/registry.json")]) if (!existsSync(file)) throw new Error(`Missing candidate artifact: ${file}`);
mkdirSync(runDir, { recursive: true });
const repo = path.join(runDir, "repo"), state = path.join(runDir, "state");
let environment = {}, wrapperFailure, runAttempted = false;
let rejectInterrupted;
const interrupted = new Promise((_, reject) => { rejectInterrupted = reject; });
interrupted.catch(() => {}); // The failure is also retained synchronously, including during prepare.
const onSignal = signal => {
  wrapperFailure ??= new Error(`Wrapper interrupted by ${signal}`);
  writeFileSync(path.join(runDir, "wrapper-failure.json"), JSON.stringify({ reason: wrapperFailure.message, signal }));
  rejectInterrupted(wrapperFailure);
};
const onTerm = () => onSignal("SIGTERM"), onInt = () => onSignal("SIGINT");
process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
async function waitChild(child, timeoutMs) {
  let timer;
  try {
    return await Promise.race([interrupted, new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    }), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned child deadline exceeded")), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
try {
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
  const fixture = spawnOwned(process.execPath, [path.join(here, "fixture.mjs"), repo], { stdio: "inherit" }, runDir, "fixture");
  const result = await waitChild(fixture, 30_000);
  const fixtureCleanup = await stopGroups([fixture.pid]);
  if (fixtureCleanup.groupCleanup !== "CONFIRMED") throw new Error("Fixture group cleanup unconfirmed");
  retireGroup(runDir, fixture.pid);
  if (result.code !== 0 || result.signal) throw new Error(`Fixture preparation failed: ${result.code}/${result.signal}`);
}
const tasksFile = path.join(runDir, "tasks.json");
writeFileSync(tasksFile, JSON.stringify(spec.turns, null, 2));
environment = { ...process.env, CUE_TASKS_FILE: tasksFile,
  CUE_LIFECYCLE_FILE: path.join(runDir, "lifecycle.jsonl"),
  XDG_STATE_HOME: state, AGENT_GOVERNANCE_SHARED_STATE_DIR: path.join(state, "shared"),
  AGENT_GOVERNANCE_DB_PATH: path.join(state, ...(host === "claude" ? ["plugin-data", "workflows.sqlite3"] : ["workflow.sqlite3"])),
  AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(state, ...(host === "claude" ? ["plugin-data", "continuity.sqlite3"] : ["continuity.sqlite3"])),
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
  if (typeof value === "string") return value.replaceAll("${CLAUDE_PLUGIN_ROOT}", hooksRoot).replaceAll("$env:PLUGIN_ROOT", hooksRoot).replaceAll("$PLUGIN_ROOT", hooksRoot).replaceAll("${CLAUDE_PLUGIN_DATA}", environment.CLAUDE_PLUGIN_DATA);
  if (Array.isArray(value)) return value.map(replaceRoot);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRoot(item)]));
  return value;
};
const hooks = replaceRoot(JSON.parse(readFileSync(hooksFile, "utf8")).hooks);
const matcherChanges = [];
if (host === "claude") {
  const mapping = new Map([
    ["^mcp__plugin_agent-governance-suite_agent-governance-suite__.+$", "^mcp__agent-governance-suite__.+$"],
    ["^mcp__(?!plugin_agent-governance-suite_agent-governance-suite__).+$", "^mcp__(?!agent-governance-suite__).+$"],
  ]);
  for (const [event, entries] of Object.entries(hooks)) for (const [index, entry] of entries.entries()) {
    if (mapping.has(entry.matcher)) {
      if (event !== "PreToolUse") throw new Error("Claude MCP matcher must remain in PreToolUse");
      matcherChanges.push({ event, index, before: entry.matcher, after: mapping.get(entry.matcher) });
      entry.matcher = mapping.get(entry.matcher);
    } else if (entry.matcher?.includes("plugin_agent-governance-suite_agent-governance-suite")) throw new Error("Unrecognized Claude plugin matcher; no broad namespace rewrite");
  }
  if (matcherChanges.length !== mapping.size || new Set(matcherChanges.map(change => change.before)).size !== mapping.size) throw new Error("Expected exactly the positive and exclusion Claude MCP matchers");
}
for (const event of ["SessionStart", "UserPromptSubmit"]) {
  (hooks[event] ??= []).push({ hooks: [{ type: "command", command: `node "${path.join(here, "lifecycle-hook.mjs")}"`, timeout: 5 }] });
}
const envNames = ["AGENT_GOVERNANCE_SHARED_STATE_DIR", "AGENT_GOVERNANCE_DB_PATH", "AGENT_GOVERNANCE_CONTINUITY_DB_PATH",
  "AGENT_GOVERNANCE_TRUST_DB_PATH", "AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH", "AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR",
  "XDG_STATE_HOME", "CLAUDE_PLUGIN_DATA", "CUE_LIFECYCLE_FILE", "AGENT_GOVERNANCE_LOCALE"];
const sourceMcpFile = path.join(hooksRoot, host === "claude" ? ".claude-plugin/plugin.json" : ".mcp.json");
const sourceMcp = JSON.parse(readFileSync(sourceMcpFile, "utf8")).mcpServers?.["agent-governance-suite"];
if (!sourceMcp) throw new Error("Candidate MCP descriptor missing");
const mcpServer = { command: process.execPath, args: [serverFile], cwd: host === "claude" ? repo : hooksRoot,
  env: { ...replaceRoot(sourceMcp.env ?? {}), ...Object.fromEntries(envNames.map(name => [name, environment[name]])) }, env_vars: envNames };
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
  args = [runDir, repo, String(timeoutSec), model, effort];
} else {
  // Source composition keeps candidate hook semantics and MCP/skills bytes, with all state paths explicit.
  // Do not pass --plugin-dir: its host-generated CLAUDE_PLUGIN_DATA can supersede the trial environment.
  const settings = path.join(runDir, "claude-settings.json"), mcp = path.join(runDir, "claude-mcp.json");
  writeFileSync(settings, JSON.stringify({ hooks }));
  // Claude's documented stdio descriptor has no cwd override; observe the inherited trial cwd externally.
  writeFileSync(mcp, JSON.stringify({ mcpServers: { "agent-governance-suite": { command: mcpServer.command, args: mcpServer.args,
    env: { ...Object.fromEntries(envNames.map(name => [name, environment[name]])), ...mcpServer.env } } } }));
  driver = "claude-stream.mjs";
  args = [runDir, repo, String(timeoutSec), "--session-id", randomUUID(), "--model", model, "--effort", effort,
    "--settings", settings, "--setting-sources", "project", "--mcp-config", mcp, "--strict-mcp-config", "--permission-mode", "acceptEdits"];
}
// Native workspace skill discovery; no installation and no writes to source arm directories.
const skillsDirectory = path.join(repo, host === "codex" ? ".agents/skills" : ".claude/skills");
mkdirSync(path.dirname(skillsDirectory), { recursive: true });
// Preserve the candidate's relative runtime imports; do not copy user settings or host history.
symlinkSync(path.join(hooksRoot, "skills"), skillsDirectory, "dir");
const skills = readdirSync(path.join(hooksRoot, "skills"), { withFileTypes: true }).filter(entry => entry.isDirectory() && existsSync(path.join(hooksRoot, "skills", entry.name, "SKILL.md"))).map(entry => {
  const file = realpathSync(path.join(hooksRoot, "skills", entry.name, "SKILL.md"));
  return { name: entry.name, path: file, sha256: sha256(readFileSync(file)) };
}).sort((a, b) => a.name.localeCompare(b.name));
const composition = { candidateSha, host, sourceHooksSha256: sha256(readFileSync(hooksFile)), composedHooksSha256: sha256(hooks),
  specSha256: sha256(spec), skillsSha256: sha256(skills), normalizedHooks: normalizeHooks(hooks), matcherChanges, skills,
  mcp: { name: "agent-governance-suite", command: mcpServer.command, args: mcpServer.args, cwd: mcpServer.cwd,
    bundleSha256: sha256(readFileSync(serverFile)), env: mcpServer.env } };
writeFileSync(path.join(runDir, "composition.json"), JSON.stringify(composition, null, 2));
writeFileSync(path.join(runDir, "candidate.json"), JSON.stringify({ arm, candidateSha, host, model, effort, locale: environment.AGENT_GOVERNANCE_LOCALE,
  composition: "native-process-config-and-workspace-skills; plugin-loader NOT_TESTED",
  serverSha256: createHash("sha256").update(readFileSync(serverFile)).digest("hex"),
  hooksSha256: createHash("sha256").update(readFileSync(hooksFile)).digest("hex"),
  compositionSha256: sha256(composition),
  turns: spec.turns.map(turn => turn.id), mode, semanticResult: "NOT_EVALUATED" }, null, 2));
if (mode === "prepare") {
  console.log(JSON.stringify({ state: "PREPARED_NOT_EXECUTED", runDir, host, driver }));
} else {
  runAttempted = true;
  const child = spawnOwned(process.execPath, [path.join(here, driver), ...args], { cwd: repo, env: environment, stdio: "inherit" }, runDir, "driver");
  const result = await waitChild(child, outerTimeoutMs);
  process.exitCode = result.code ?? 1;
  if (result.signal) throw new Error(`Driver ended by ${result.signal}`);
}
} catch (error) {
  wrapperFailure ??= error;
  process.exitCode = 1;
  writeFileSync(path.join(runDir, "wrapper-failure.json"), JSON.stringify({ reason: wrapperFailure.message }));
} finally {
  let cleanup;
  try { cleanup = await stopRecordedGroups(runDir); }
  catch (error) { wrapperFailure ??= error; cleanup = { groupCleanup: "UNCONFIRMED", reason: error.code ?? "CLEANUP_ERROR" }; }
  if (cleanup.groupCleanup !== "CONFIRMED") process.exitCode = 1;
  if (wrapperFailure) process.exitCode = 1;
  const turnsFile = path.join(runDir, "turns.jsonl");
  if (runAttempted && !existsSync(turnsFile)) writeFileSync(turnsFile, spec.turns.map((turn, index) => JSON.stringify(index === 0
    ? { turn: 1, id: turn.id, exit: 1, reason: wrapperFailure?.message ?? "Driver wrote no turns" }
    : { turn: index + 1, id: turn.id, skipped: true, reason: "driver failure" })).join("\n") + "\n");
  // Wrapper exit is never semantic acceptance; validate the retained per-turn outcomes too.
  let rows = [];
  try { if (existsSync(turnsFile)) rows = readFileSync(turnsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { wrapperFailure ??= error; process.exitCode = 1; }
  if (runAttempted && (rows.length !== spec.turns.length || rows.some(row => row.exit !== 0 || row.skipped))) process.exitCode = 1;
  let events = [];
  try { if (typeof environment.CUE_LIFECYCLE_FILE === "string" && existsSync(environment.CUE_LIFECYCLE_FILE)) events = readFileSync(environment.CUE_LIFECYCLE_FILE, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { wrapperFailure ??= error; process.exitCode = 1; }
  writeFileSync(path.join(runDir, "transport-summary.json"), JSON.stringify({ processExit: process.exitCode ?? 0, mode, wrapperFailure: wrapperFailure?.message ?? null,
    plannedTurns: spec.turns.length, recordedTurns: rows.length,
    sessionStartCount: events.filter(event => event.event === "SessionStart").length,
    userPromptSubmitCount: events.filter(event => event.event === "UserPromptSubmit").length,
    lifecycleSessionIds: [...new Set(events.map(event => event.sessionId).filter(Boolean))],
    deliveryToModel: "NOT_PROVEN_BY_OBSERVER", semanticResult: "NOT_EVALUATED", cleanup, processTreeCleanup: "ESCAPED_DESCENDANTS_REQUIRE_ROOT_OBSERVATION" }, null, 2));
  process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt);
}
