// One native app-server process and one thread; never exec/resume between user turns.
import { appendFileSync, closeSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { requireLinux, retireGroup, spawnOwned, stopGroups } from "./owned-process.mjs";
import { awaitRootPreflight, verifyCodexHooks, verifyCodexSkills, verifyMcpDescriptor } from "./trial-preflight.mjs";

const [runDir, repoDir, timeoutSec, model, effort] = process.argv.slice(2);
if (!runDir || !repoDir || !Number.isFinite(Number(timeoutSec)) || Number(timeoutSec) <= 0 || Number(timeoutSec) * 1000 > 2 ** 31 - 1 || !model || !effort) {
  throw new Error("usage: node codex-stream.mjs <runDir> <repoDir> <timeoutSec> <model> <effort>");
}
const turns = JSON.parse(readFileSync(process.env.CUE_TASKS_FILE, "utf8"));
const overrides = JSON.parse(readFileSync(process.env.CUE_CODEX_ARGV_FILE, "utf8"));
const command = process.env.CODEX_CMD ? JSON.parse(process.env.CODEX_CMD) : [process.env.CODEX_BIN ?? "codex"];
requireLinux();
const errFd = openSync(path.join(runDir, "stream.err"), "wx");
const child = spawnOwned(command[0], [...command.slice(1), ...overrides, "app-server", "--listen", "stdio://"], {
  cwd: repoDir, env: process.env, stdio: ["pipe", "pipe", errFd], windowsHide: true,
}, runDir, "codex-app-server");
let nextId = 0, threadId, turnNumber = 0, fatal;
const pending = new Map();
const notifications = [];
const notificationWaiters = new Set();
const rows = [];
const abort = error => {
  fatal ??= error;
  for (const item of pending.values()) item.reject(error);
  pending.clear();
  for (const item of notificationWaiters) item.reject(error);
  notificationWaiters.clear();
};
let signalFailure;
const onSignal = signal => {
  signalFailure ??= new Error(`Driver interrupted by ${signal}`);
  writeFileSync(path.join(runDir, "driver-failure.json"), JSON.stringify({ reason: signalFailure.message, signal }));
  abort(signalFailure);
};
const onTerm = () => onSignal("SIGTERM"), onInt = () => onSignal("SIGINT");
process.on("SIGTERM", onTerm); process.on("SIGINT", onInt);
child.on("error", abort);
child.stdin.on("error", abort);
child.once("close", (code, signal) => abort(new Error(`app-server closed: ${code}/${signal}`)));
const send = message => child.stdin.write(JSON.stringify(message) + "\n");
function request(method, params) {
  if (fatal) return Promise.reject(fatal);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });
}
function notification(method, predicate = () => true) {
  const index = notifications.findIndex(item => item.method === method && predicate(item.params));
  if (index >= 0) return Promise.resolve(notifications.splice(index, 1)[0].params);
  if (fatal) return Promise.reject(fatal);
  return new Promise((resolve, reject) => notificationWaiters.add({ method, predicate, resolve, reject }));
}
async function deadline(action) {
  let timer;
  try {
    return await Promise.race([action(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("turn or startup timeout")), Number(timeoutSec) * 1000);
    })]);
  } finally { clearTimeout(timer); }
}
createInterface({ input: child.stdout }).on("line", line => {
  let message;
  try { message = JSON.parse(line); } catch { abort(new Error("app-server emitted invalid JSON")); return; }
  // Auth responses never enter event logs; no credentials or account metadata are copied.
  if (message.id !== undefined && !message.method) {
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`RPC error ${message.error.code}: ${message.error.message}`));
    else item.resolve(message.result);
    return;
  }
  if (!/account|auth|login/iu.test(message.method ?? "")) appendFileSync(path.join(runDir, turnNumber ? `turn-${turnNumber}.jsonl` : "startup.jsonl"), line + "\n");
  if (message.id !== undefined) {
    // The harness never auto-approves a permission request or guesses a human answer.
    send({ id: message.id, error: { code: -32601, message: "Trial client does not authorize interactive requests" } });
    abort(new Error(`unhandled server request: ${message.method}`));
    return;
  }
  const waiter = [...notificationWaiters].find(item => item.method === message.method && item.predicate(message.params));
  if (waiter) { notificationWaiters.delete(waiter); waiter.resolve(message.params); }
  else if (message.method === "turn/completed" || (message.method === "item/completed" && message.params?.item?.type === "contextCompaction")) notifications.push(message);
});

let failure;
try {
  await deadline(async () => {
    await request("initialize", { clientInfo: { name: "ags-cue-trial", version: "1" }, capabilities: { experimentalApi: true } });
    send({ method: "initialized", params: {} });
    const account = await request("account/read", {});
    if (!account?.account) throw new Error("AUTH_UNAVAILABLE: native CLI reported no existing login; no credential copying or login fallback");
    const started = await request("thread/start", { cwd: repoDir, model, approvalPolicy: "never", sandbox: "workspace-write" });
    threadId = started.thread?.id;
    if (!threadId) throw new Error("thread/start returned no thread id");
    writeFileSync(path.join(runDir, "session.json"), JSON.stringify({ hostPid: child.pid, threadId, transport: "native-app-server", requestedModel: model, requestedEffort: effort }));
    const expected = JSON.parse(readFileSync(path.join(runDir, "composition.json"), "utf8"));
    const hookInventory = await request("hooks/list", { cwds: [repoDir] });
    const hooks = verifyCodexHooks(hookInventory, expected.normalizedHooks, repoDir);
    writeFileSync(path.join(runDir, "hooks-discovered.json"), JSON.stringify(hooks, null, 2));
    const runtimeConfig = await request("config/read", { includeLayers: false, cwd: repoDir });
    const mcpConfig = runtimeConfig?.config?.mcp_servers;
    if (!mcpConfig || Object.keys(mcpConfig).length !== 1) throw new Error("MCP_CONFIG_MISSING_OR_MIXED");
    const actualMcp = verifyMcpDescriptor(mcpConfig[expected.mcp.name], expected.mcp);
    const skills = verifyCodexSkills(await request("skills/list", { cwds: [repoDir], forceReload: true }), expected.skills, repoDir);
    writeFileSync(path.join(runDir, "skills-discovered.json"), JSON.stringify(skills, null, 2));
    const mcpInventory = await request("mcpServerStatus/list", { threadId, cursor: null, limit: 100 });
    const servers = mcpInventory?.data;
    if (!Array.isArray(servers) || servers.length !== 1 || servers[0].name !== "agent-governance-suite" || mcpInventory.nextCursor) throw new Error("TRIAL_MCP_MISSING_OR_MIXED");
    const toolNames = Array.isArray(servers[0].tools) ? servers[0].tools.map(tool => tool.name) : Object.keys(servers[0].tools ?? {});
    if (!toolNames.includes("start_workflow") || servers[0].runtimeStatus !== "connected" || servers[0].toolsError || servers[0].pluginId) throw new Error("TRIAL_MCP_NOT_READY_OR_MIXED");
    writeFileSync(path.join(runDir, "mcp-discovered.json"), JSON.stringify({ actualMcp, toolNames: toolNames.sort() }, null, 2));
    const gate = await awaitRootPreflight(runDir, child.pid, { hooks, actualMcp, toolNames: toolNames.sort(), skills }, () => Boolean(fatal));
    writeFileSync(path.join(runDir, "preflight-result.json"), JSON.stringify(gate));
  });
  for (const [index, spec] of turns.entries()) {
    turnNumber = index + 1;
    const started = Date.now();
    await deadline(async () => {
      const accepted = await request("turn/start", { threadId, input: [{ type: "text", text: spec.prompt }], model, effort });
      const turnId = accepted.turn?.id;
      if (!turnId) throw new Error("turn/start returned no turn id");
      const done = await notification("turn/completed", params => params.threadId === threadId && params.turn?.id === turnId);
      if (done.turn.status !== "completed") throw new Error(`turn ended ${done.turn.status}`);
    });
    if (spec.compactAfter) {
      await deadline(async () => {
        // A prior automatic compaction is not proof that this explicit boundary completed.
        notifications.length = 0;
        await request("thread/compact/start", { threadId });
        const compacted = await notification("item/completed", params => params.threadId === threadId && params.item?.type === "contextCompaction");
        if (!compacted.turnId) throw new Error("compaction item has no turn id");
        const done = await notification("turn/completed", params => params.threadId === threadId && params.turn?.id === compacted.turnId);
        if (done.turn.status !== "completed") throw new Error(`compaction ended ${done.turn.status}`);
      });
    }
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
    if (cleanup.groupCleanup !== "CONFIRMED") failure ??= new Error("Codex owned group cleanup unconfirmed");
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
