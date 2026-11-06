// Sequential messages in one Claude process/session. No resume between turns. Linux TEST only.
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { TURNS as DEFAULT_TURNS } from "./tasks.mjs";
import { requireLinux, retireGroup, spawnOwned, stopGroups } from "./owned-process.mjs";
import { awaitRootPreflight, verifyMcpDescriptor } from "./trial-preflight.mjs";

const [runDir, repoDir, timeoutSec, ...claudeArgs] = process.argv.slice(2);
if (!runDir || !repoDir || !Number.isFinite(Number(timeoutSec)) || Number(timeoutSec) <= 0 || Number(timeoutSec) * 1000 > 2 ** 31 - 1) throw new Error("usage: node claude-stream.mjs <runDir> <repoDir> <turnTimeoutSec> <claude args...>");
requireLinux();
const turns = process.env.CUE_TASKS_FILE ? JSON.parse(readFileSync(process.env.CUE_TASKS_FILE, "utf8")) : DEFAULT_TURNS;
const pluginPin = process.env.CUE_PLUGIN_PIN_FILE ? JSON.parse(readFileSync(process.env.CUE_PLUGIN_PIN_FILE, "utf8")) : null;
const bin = process.env.CLAUDE_BIN ?? "claude";
const command = bin.endsWith(".mjs") ? [process.execPath, bin] : [bin];
const errFd = openSync(path.join(runDir, "stream.err"), "a");
const child = spawnOwned(command[0], [...command.slice(1), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", ...claudeArgs],
  { cwd: repoDir, stdio: ["pipe", "pipe", errFd], env: process.env }, runDir, "claude-stream");
const sessionArgIndex = claudeArgs.indexOf("--session-id");
const requestedSession = sessionArgIndex < 0 ? undefined : claudeArgs[sessionArgIndex + 1];
const observedSessions = new Set();
const saveSession = () => writeFileSync(path.join(runDir, "session.json"), JSON.stringify({ hostPid: child.pid,
  transport: "claude-stream", requestedSession, observedSessionIds: [...observedSessions] }));
saveSession();
const pending = new Map(), rows = [];
let nextId = 0, turnNumber = 0, fatal, resultWaiter, failure, signalFailure;
const send = message => child.stdin.write(JSON.stringify(message) + "\n");
const abort = error => {
  fatal ??= error;
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  resultWaiter?.reject(error); resultWaiter = undefined;
};
const onSignal = signal => {
  signalFailure ??= new Error(`Driver interrupted by ${signal}`);
  writeFileSync(path.join(runDir, "driver-failure.json"), JSON.stringify({ reason: signalFailure.message, signal }));
  abort(signalFailure);
};
const onTerm = () => onSignal("SIGTERM"), onInt = () => onSignal("SIGINT");
process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
child.on("error", abort); child.stdin.on("error", abort);
child.once("close", (code, signal) => abort(new Error(`Claude exited: ${code}/${signal}`)));
function control(request) {
  if (fatal) return Promise.reject(fatal);
  const request_id = `cue-${++nextId}`;
  return new Promise((resolve, reject) => { pending.set(request_id, { resolve, reject }); send({ type: "control_request", request_id, request }); });
}
async function deadline(action) {
  let timer;
  try { return await Promise.race([action(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("turn or startup timeout")), Number(timeoutSec) * 1000); })]); }
  finally { clearTimeout(timer); }
}
createInterface({ input: child.stdout }).on("line", line => {
  let event;
  try { event = JSON.parse(line); } catch { abort(new Error("Claude emitted invalid JSON")); return; }
  // Control responses may contain runtime settings/account data. Project them in memory, never raw-log them.
  if (event.type === "control_response") {
    const response = event.response, item = pending.get(response?.request_id);
    if (!item) return;
    pending.delete(response.request_id);
    if (response.subtype === "error") item.reject(new Error("Claude control request failed"));
    else item.resolve(response.response);
    return;
  }
  if (event.type === "control_request") {
    send({ type: "control_response", response: { subtype: "error", request_id: event.request_id, error: "Trial client does not authorize interactive requests" } });
    abort(new Error("Unhandled Claude control request")); return;
  }
  if (/account|auth|login/iu.test(`${event.type ?? ""}/${event.subtype ?? ""}`)) return;
  if (typeof event.session_id === "string") {
    observedSessions.add(event.session_id); saveSession();
    if (observedSessions.size !== 1 || (requestedSession && event.session_id !== requestedSession)) { abort(new Error("CLAUDE_SESSION_MIXED")); return; }
  }
  appendFileSync(path.join(runDir, turnNumber ? `turn-${turnNumber}.jsonl` : "startup.jsonl"), line + "\n");
  if (pluginPin && event.type === "system" && /^hook_/u.test(event.subtype ?? "")) appendFileSync(path.join(runDir, "native-callbacks.jsonl"), line + "\n");
  if (pluginPin && event.type === "system" && event.subtype === "init") writeFileSync(path.join(runDir, "native-plugin-discovered.json"), JSON.stringify({ pluginPin,
    observedPlugins: event.plugins ?? null, observedMcpServers: event.mcp_servers ?? null, effectiveModel: event.model ?? null,
    nativePluginDataAndMcpDb: "REQUIRES_OWN_CALLBACK_CORRELATION", wholeEffectiveConfiguration: "NOT_CLAIMED" }, null, 2));
  if (event.type !== "result") return;
  if (!resultWaiter) { abort(new Error("Unexpected Claude result without an active trial turn")); return; }
  const waiter = resultWaiter; resultWaiter = undefined;
  if (typeof event.session_id !== "string" || observedSessions.size !== 1) waiter.reject(new Error("CLAUDE_SESSION_UNOBSERVED"));
  else if (event.is_error === true || event.subtype !== "success") waiter.reject(new Error("Claude result failed"));
  else waiter.resolve();
});
try {
  if (process.env.CUE_TASKS_FILE && !pluginPin) await deadline(async () => {
    const initialized = await control({ subtype: "initialize", hooks: null });
    if (!initialized || typeof initialized !== "object") throw new Error("CLAUDE_INITIALIZE_UNOBSERVABLE");
    const inventory = await control({ subtype: "mcp_status" });
    const servers = inventory?.mcpServers;
    if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== "agent-governance-suite" || servers[0].status !== "connected") throw new Error("CLAUDE_MCP_MISSING_MIXED_OR_NOT_READY");
    const expected = JSON.parse(readFileSync(path.join(runDir, "composition.json"), "utf8"));
    const actualMcp = verifyMcpDescriptor(servers[0].config, expected.mcp, true);
    const toolNames = (servers[0].tools ?? []).map(tool => tool.name).sort();
    if (!toolNames.includes("start_workflow")) throw new Error("CLAUDE_MCP_TOOLS_UNOBSERVABLE");
    const native = { actualMcp, toolNames, initialization: { commands: (initialized.commands ?? []).map(item => item.name),
      modelNames: (initialized.models ?? []).map(item => item.value ?? item.name) }, mcpCwd: actualMcp.cwd === null ? "REQUIRES_ROOT_OBSERVATION" : "NATIVE_OBSERVED",
      hooks: "REQUIRES_ROOT_OBSERVATION", skills: "REQUIRES_ROOT_OBSERVATION" };
    writeFileSync(path.join(runDir, "mcp-discovered.json"), JSON.stringify({ actualMcp, toolNames }, null, 2));
    const gate = await awaitRootPreflight(runDir, child.pid, native, () => Boolean(fatal));
    writeFileSync(path.join(runDir, "preflight-result.json"), JSON.stringify(gate));
  });
  for (const [index, spec] of turns.entries()) {
    if (fatal) throw fatal;
    turnNumber = index + 1;
    const started = Date.now();
    await deadline(() => new Promise((resolve, reject) => {
      resultWaiter = { resolve, reject };
      send({ type: "user", message: { role: "user", content: spec.prompt } });
    }));
    rows.push({ turn: turnNumber, id: spec.id, exit: 0, seconds: (Date.now() - started) / 1000 });
  }
} catch (error) {
  failure = error;
  rows.push({ turn: turnNumber || 1, exit: 1, reason: error.message });
  for (let n = (turnNumber || 1) + 1; n <= turns.length; n++) rows.push({ turn: n, skipped: true, reason: "earlier failure" });
} finally {
  writeFileSync(path.join(runDir, "turns.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  child.stdin.end();
  try {
    const cleanup = await stopGroups([child.pid]);
    writeFileSync(path.join(runDir, "driver-cleanup.json"), JSON.stringify(cleanup));
    if (cleanup.groupCleanup !== "CONFIRMED") failure ??= new Error("Claude owned group cleanup unconfirmed");
    else retireGroup(runDir, child.pid);
  } catch (error) { failure ??= error; }
  finally { closeSync(errFd); process.removeListener("SIGTERM", onTerm); process.removeListener("SIGINT", onInt); }
}
failure ??= signalFailure;
if (failure && rows.every(row => row.exit === 0)) {
  rows.push({ phase: "driver-finalization", exit: 1, reason: failure.message });
  writeFileSync(path.join(runDir, "turns.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}
if (failure) { console.error(failure.message); process.exitCode = 1; }
