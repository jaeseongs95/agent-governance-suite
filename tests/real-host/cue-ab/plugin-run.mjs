// Linux TEST native-plugin path. Installation, cache fingerprinting and restoration belong to root.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { TURNS } from "./tasks.mjs";
import { requireLinux, retireGroup, spawnOwned, stopGroups, stopRecordedGroups } from "./owned-process.mjs";

const [mode, host, pluginArgument, runArgument, specArgument, model, effort] = process.argv.slice(2);
if (!["prepare", "execute"].includes(mode) || !["codex", "claude"].includes(host) || !pluginArgument || !runArgument || !specArgument || !model || !effort) throw new Error("usage: node plugin-run.mjs <prepare|execute> <codex|claude> <installed-pin.json|claudePluginDir> <freshRunDir> <cue|spec.json> <model> <effort>");
requireLinux();
const runDir = path.resolve(runArgument), here = import.meta.dirname;
if (existsSync(runDir)) throw new Error("Never reuse an earlier trial directory");
const spec = specArgument === "cue" ? { turns: TURNS } : JSON.parse(readFileSync(specArgument, "utf8"));
if (!Array.isArray(spec.turns) || !spec.turns.length || spec.turns.some(turn => typeof turn.id !== "string" || typeof turn.prompt !== "string" || (turn.compactAfter !== undefined && typeof turn.compactAfter !== "boolean"))) throw new Error("Invalid trial turns");
if (spec.awaitNativePeerTurn !== undefined && typeof spec.awaitNativePeerTurn !== "boolean") throw new Error("Invalid awaitNativePeerTurn");
const awaitNativePeerTurn = spec.awaitNativePeerTurn === true;
if (awaitNativePeerTurn && host !== "claude") throw new Error("Native peer turn requires Claude");
const timeoutSec = spec.timeoutSec === undefined ? 600 : spec.timeoutSec;
const outerMs = (spec.turns.length + spec.turns.filter(turn => turn.compactAfter).length + 1) * timeoutSec * 1000 + 10_000;
if (!Number.isFinite(timeoutSec) || timeoutSec <= 0 || !Number.isFinite(outerMs) || outerMs > 2 ** 31 - 1) throw new Error("Invalid timeoutSec");
if (host === "claude" && spec.turns.some(turn => turn.compactAfter)) throw new Error("Claude manual compact NOT_CONFIRMED; never substitute resume");
const candidateSha = spec.candidateSha ?? process.env.CUE_CANDIDATE_SHA;
if (!/^[a-f0-9]{40}$/u.test(candidateSha ?? "")) throw new Error("Exact candidateSha required");
const hashFile = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const suppliedPin = host === "codex" ? JSON.parse(readFileSync(pluginArgument, "utf8")) : {};
const pluginRoot = realpathSync(host === "codex" ? suppliedPin.pluginRoot : pluginArgument);
const files = { manifest: path.join(pluginRoot, host === "codex" ? ".codex-plugin/plugin.json" : ".claude-plugin/plugin.json"),
  hooks: path.join(pluginRoot, "hooks/hooks.json"), server: path.join(pluginRoot, "mcp-server/dist/server.mjs") };
const publicHashes = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, hashFile(file)]));
const manifest = JSON.parse(readFileSync(files.manifest, "utf8"));
if (host === "codex" && (typeof suppliedPin.pluginId !== "string" || !suppliedPin.pluginId
  || !/^[a-f0-9]{64}$/u.test(suppliedPin.cacheSha256 ?? "") || suppliedPin.serverSha256 !== publicHashes.server || suppliedPin.hooksSha256 !== publicHashes.hooks)) throw new Error("Installed plugin pin or public candidate hashes do not match");
const pin = { host, candidateSha, pluginId: host === "codex" ? suppliedPin.pluginId : manifest.name,
  pluginRoot, cacheSha256: suppliedPin.cacheSha256 ?? null, publicHashes,
  cacheHashVerification: host === "codex" ? "ROOT_EXTERNAL_OBSERVATION_REQUIRED" : "PER_SESSION_PLUGIN_DIR",
  stateIsolation: "NATIVE_PLUGIN_STATE_NOT_ASSUMED_ISOLATED" };
mkdirSync(runDir, { recursive: true });
const repo = path.join(runDir, "repo"), tasksFile = path.join(runDir, "tasks.json"), pinFile = path.join(runDir, "native-plugin-pin.json");
writeFileSync(pinFile, JSON.stringify(pin, null, 2));
writeFileSync(tasksFile, JSON.stringify(spec.turns, null, 2));
// Preserve native login and native plugin data resolution. No config, settings, MCP or state-path overrides.
const environment = { ...process.env, CUE_TASKS_FILE: tasksFile, CUE_PLUGIN_PIN_FILE: pinFile,
  CUE_AWAIT_NATIVE_PEER_TURN: awaitNativePeerTurn ? "1" : "0", DISABLE_AUTOUPDATER: "1" };
let failure, attempted = false, rejectSignal;
const interrupted = new Promise((_, reject) => { rejectSignal = reject; }); interrupted.catch(() => {});
const onSignal = signal => { failure ??= new Error(`Wrapper interrupted by ${signal}`); writeFileSync(path.join(runDir, "wrapper-failure.json"), JSON.stringify({ reason: failure.message, signal })); rejectSignal(failure); };
const onTerm = () => onSignal("SIGTERM"), onInt = () => onSignal("SIGINT");
process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
async function waitChild(child, timeoutMs) {
  let timer;
  try { return await Promise.race([interrupted, new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Owned child deadline exceeded")), timeoutMs); })]); }
  finally { clearTimeout(timer); }
}
try {
  if (spec.files) {
    mkdirSync(repo);
    for (const [relative, content] of Object.entries(spec.files)) {
      const target = path.resolve(repo, relative);
      if (!target.startsWith(repo + path.sep) || /(^|[/\\])(auth|credentials|config\.toml)([/\\.]|$)/iu.test(relative) || typeof content !== "string") throw new Error("Invalid fixture file");
      mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, content, { flag: "wx" });
    }
  } else {
    const fixture = spawnOwned(process.execPath, [path.join(here, "fixture.mjs"), repo], { stdio: "inherit" }, runDir, "fixture");
    const result = await waitChild(fixture, 30_000), cleanup = await stopGroups([fixture.pid]);
    if (cleanup.groupCleanup !== "CONFIRMED") throw new Error("Fixture cleanup unconfirmed");
    retireGroup(runDir, fixture.pid);
    if (result.code !== 0 || result.signal) throw new Error("Fixture preparation failed");
  }
  const args = host === "codex" ? [runDir, repo, String(timeoutSec), model, effort]
    : [runDir, repo, String(timeoutSec), "--session-id", randomUUID(), "--model", model, "--effort", effort, "--plugin-dir", pluginRoot, "--permission-mode", "bypassPermissions"];
  if (mode === "prepare") console.log(JSON.stringify({ state: "PREPARED_NOT_EXECUTED", host, runDir }));
  else {
    attempted = true;
    const child = spawnOwned(process.execPath, [path.join(here, `${host}-stream.mjs`), ...args], { cwd: repo, env: environment, stdio: "inherit" }, runDir, "driver");
    const result = await waitChild(child, outerMs);
    process.exitCode = result.code ?? 1;
    if (result.signal) throw new Error(`Driver ended by ${result.signal}`);
  }
} catch (error) { failure ??= error; process.exitCode = 1; writeFileSync(path.join(runDir, "wrapper-failure.json"), JSON.stringify({ reason: failure.message })); }
finally {
  let cleanup;
  try { cleanup = await stopRecordedGroups(runDir); } catch (error) { failure ??= error; cleanup = { groupCleanup: "UNCONFIRMED" }; }
  if (failure || cleanup.groupCleanup !== "CONFIRMED") process.exitCode = 1;
  const turnsFile = path.join(runDir, "turns.jsonl");
  let rows = [];
  try {
    if (existsSync(turnsFile)) rows = readFileSync(turnsFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    if (attempted && !rows.length) { rows = spec.turns.map((turn, index) => index === 0 ? { turn: 1, id: turn.id, exit: 1, reason: failure?.message ?? "Driver wrote no turns" } : { turn: index + 1, id: turn.id, skipped: true }); writeFileSync(turnsFile, rows.map(row => JSON.stringify(row)).join("\n") + "\n"); }
  } catch (error) { failure ??= error; process.exitCode = 1; }
  if (attempted && (rows.length !== spec.turns.length || rows.some(row => row.exit !== 0 || row.skipped))) process.exitCode = 1;
  let nativePeerTurn;
  if (attempted && awaitNativePeerTurn) {
    try { nativePeerTurn = JSON.parse(readFileSync(path.join(runDir, "native-peer-result.json"), "utf8")); }
    catch (error) { failure ??= error; }
    if (nativePeerTurn?.state !== "RESULT_RECEIVED" || nativePeerTurn.actualResult?.event?.type !== "result"
      || nativePeerTurn.stdinWritesAfterReady !== 0) process.exitCode = 1;
  }
  writeFileSync(path.join(runDir, "transport-summary.json"), JSON.stringify({ processExit: process.exitCode ?? 0, mode, host, failure: failure?.message ?? null,
    plannedTurns: spec.turns.length, recordedTurns: rows.length, pluginPin: pin, cleanup,
    ...(awaitNativePeerTurn ? { nativePeerTurn: nativePeerTurn ?? null } : {}),
    sessionStartCount: null, userPromptSubmitCount: null, lifecycleObservation: "CORRELATE_OWN_NATIVE_CALLBACK_EVENTS",
    actualAdmission: "REQUIRES_OWN_MCP_CALLBACK_DB_CORRELATION", cueDelivery: "NOT_PROVEN_BY_CALLBACK_ALONE", semanticResult: "NOT_EVALUATED",
    processTreeCleanup: "ESCAPED_DESCENDANTS_REQUIRE_ROOT_OBSERVATION" }, null, 2));
  process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt);
}
