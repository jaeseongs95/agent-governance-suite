import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setImmediate as turn } from "node:timers/promises";
import { afterEach, beforeEach, test, vi } from "vitest";

const f = vi.hoisted(() => ({ calls: [], sync: [], pending: [], native: false, failure: null, wrongPid: false, birth: "9001", children: [], requests: [] }));
vi.mock("node:child_process", async original => {
  const real = await original();
  const reply = command => command === "powershell.exe"
    ? JSON.stringify([{ pid: process.ppid + (f.wrongPid ? 1 : 0), parentPid: 1, name: "Antigravity.exe", command: "C:/Program Files/Antigravity/Antigravity.exe", startToken: "9001" }])
    : "1 antigravity /opt/antigravity/antigravity";
  return { ...real,
    execFileSync: (command, args, options) => { f.sync.push({ command, args, options }); return reply(command); },
    execFile: (command, args, options, callback) => {
      f.calls.push({ command, args, options });
      if (f.native) {
        const child = real.execFile(process.execPath, ["-e", "setInterval(() => {}, 1000)"], options, callback);
        const record = { child, closed: false, close: null };
        record.close = new Promise(resolve => child.once("close", () => { record.closed = true; resolve(); }));
        f.children.push(record);
        return child;
      }
      f.pending.push(() => callback(f.failure, reply(command)));
      return {};
    },
  };
});
const stat = () => "1 (synthetic) " + Array.from({ length: 20 }, (_, index) => index === 19 ? "9001" : "0").join(" ");
vi.mock("node:fs/promises", async original => {
  const real = await original();
  return { ...real, readFile: (file, ...args) => /^\/proc\/\d+\/stat$/u.test(String(file)) ? Promise.resolve(stat()) : real.readFile(file, ...args),
    readlink: (file, ...args) => /^\/proc\/\d+\/exe$/u.test(String(file)) ? Promise.resolve("/opt/antigravity/antigravity") : real.readlink(file, ...args) };
});
vi.mock("node:fs", async original => {
  const real = await original();
  return { ...real, readFileSync: (file, ...args) => /^\/proc\/\d+\/stat$/u.test(String(file)) ? stat() : real.readFileSync(file, ...args),
    readlinkSync: (file, ...args) => /^\/proc\/\d+\/exe$/u.test(String(file)) ? "/opt/antigravity/antigravity" : real.readlinkSync(file, ...args) };
});
vi.mock("../../mcp-server/src/builtin-hook-host-adapters.js", () => ({}));
vi.mock("../../mcp-server/src/runtime-config.js", () => ({ resolveTrustDatabasePath: () => { throw new Error("DB forbidden"); } }));
vi.mock("../../mcp-server/src/input-observation.js", () => ({ supportsInjection: (capabilities, point) => capabilities.supportedInjection.includes(point) }));
vi.mock("../../mcp-server/src/session-message-client.js", () => ({ sessionMessageRequest: async operation => {
  f.requests.push(operation);
  if (operation === "list-presence") return { sessions: [] };
  if (operation === "ensure-relay") return { spawn: false, instanceId: "no-spawn", relayId: null };
  return { messages: [] };
} }));
vi.mock("../../mcp-server/src/trust-store.js", () => ({ TrustStore: class { constructor() { throw new Error("DB forbidden in AL04 fixture"); } } }));
vi.mock("../../mcp-server/src/process-identity.js", () => ({ processStartToken: () => f.birth }));
vi.mock("../../mcp-server/src/session-message-wake-port.js", () => ({ recordWakeHookObservation: () => { throw new Error("receipt forbidden"); } }));
vi.mock("../../mcp-server/src/host-input-adapter.js", () => ({
  registerHookHostAdapter() {}, resolveHookHost: () => "gemini", isGovernanceHookTool: () => false, nativePeerWait: () => null, resolveHookProcessPid: () => undefined,
  hostDeliveryProfile: () => ({ transport: "gemini-queue", blocksEmptyWakePrompt: false, capabilities: { idleWake: "none", supportedInjection: ["tool-boundary"] } }),
  adaptHostInput: input => ({ lifecycle: "none", outputEventName: "PostToolUse", observation: { host: "gemini", sessionId: "AL04_PRIVATE", kind: "tool-boundary", boundaryPhase: "after",
    actor: { kind: input.agent_id === "" ? "main" : input.agent_id ? "subagent" : "unknown", assurance: input.agent_id === undefined ? "unknown" : "observed" } } }),
}));
import { executeAntigravityHookEvent, resolveVerifiedAntigravityHostProcess } from "./antigravity-hook-runner.mjs";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.ts";
const pair = Object.freeze({ pid: process.ppid, startToken: "9001" });
const main = { conversationId: "AL04_PRIVATE", agent_id: "", hook_event_name: "SessionStart" };
const options = extra => ({ now: () => 100, entryMonotonicMs: 100, onProcessIdentityFailure() {}, ...extra });
async function drain() {
  for (let step = 0; step < 12; step++) { await turn(); const next = f.pending.shift(); if (next) next(); }
}
beforeEach(() => { for (const key of ["calls", "sync", "pending", "children", "requests"]) f[key] = []; f.native = false; f.failure = null; f.wrongPid = false; f.birth = "9001"; });
afterEach(async () => { for (const record of f.children) if (!record.closed) record.child.kill("SIGKILL"); await Promise.all(f.children.map(record => record.close)); });

test("F4 actual cold caller yields during OS query, clips caller budget, and preserves native birth guards", async () => {
  const hooks = [];
  const result = executeAntigravityHookEvent(main, "SessionStart", "session-message", options({ totalBudgetMs: 600,
    pidResolverOptions: { timeoutMs: 1500 }, sessionMessageHook: async (...args) => { hooks.push(args); return {}; } }));
  let unrelated = false; await turn(); unrelated = true;
  assert.equal(unrelated, true); assert.equal(f.sync.length, 0, "actual caller must not execute a synchronous OS query");
  assert.equal(f.calls.length, 1); assert.equal(hooks.length, 0);
  assert.equal(f.calls[0].options.timeout, 600);
  if (f.calls[0].command === "powershell.exe") {
    const script = f.calls[0].args.at(-1);
    assert.equal((script.match(/Get-Process/gu) ?? []).length, 2);
    assert.match(script, /agsStart.Ticks -ne \$agsAfter.StartTime/u);
    assert.match(script, /agsMeta.CreationDate/u);
  }
  await drain(); await result;
  assert.equal(hooks.length, 1); assert.deepEqual(hooks[0][3].hostProcess, pair);
});

test("F4 asynchronous injected provider is awaited without blocking another request", async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }); const hooks = [];
  const result = executeAntigravityHookEvent(main, "SessionStart", "session-message", options({ resolveHostProcess: () => pending,
    sessionMessageHook: async (...args) => { hooks.push(args); return {}; } }));
  await turn(); assert.equal(hooks.length, 0);
  release(pair); await result; assert.equal(hooks.length, 1);
});

test("F4 exhausted caller starts no query even with a larger resolver option", async () => {
  const result = await resolveVerifiedAntigravityHostProcess(options({ remainingBudgetMs: () => 99, pidResolverOptions: { timeoutMs: 1500 } }));
  assert.equal(result, null); assert.equal(f.calls.length + f.sync.length, 0);
});

for (const [name, finish] of [["late success", 701], ["clock reset", 50]]) test(`F4 ${name} cannot mint a verified host pair`, async () => {
  let clock = 100; const failures = []; const hooks = [];
  await executeAntigravityHookEvent(main, "SessionStart", "session-message", { now: () => clock, entryMonotonicMs: 100, totalBudgetMs: 600,
    onProcessIdentityFailure: failure => failures.push(failure), resolveHostProcess: () => { clock = finish; return pair; },
    sessionMessageHook: async (...args) => { hooks.push(args); return {}; } });
  assert.equal(hooks.length, 0); assert.equal(failures.length, 1);
  assert.equal(failures[0].code, name === "late success" ? "HOST_PROCESS_BUDGET_EXHAUSTED" : "HOST_PROCESS_CLOCK_INVALID");
});

test("F4 delayed failure preserves the original typed cause and returns UNKNOWN", async () => {
  const native = Object.assign(new Error("private native detail must not become authority"), { code: "EACCES" });
  const rejected = Promise.reject(native); rejected.catch(() => {}); const failures = [];
  const result = await resolveVerifiedAntigravityHostProcess(options({ resolveHostProcess: () => rejected, onProcessIdentityFailure: failure => failures.push(failure) }));
  assert.equal(result, null); assert.equal(failures.length, 1); assert.equal(failures[0].cause, native); assert.equal(failures[0].cause.code, "EACCES");
});

test("F4 native timeout settles only after the owned child has closed", async () => {
  f.native = true; const failures = [];
  const result = await resolveVerifiedAntigravityHostProcess({ deadlineMonotonicMs: performance.now() + 180,
    onProcessIdentityFailure: failure => failures.push(failure) });
  assert.equal(result, null); assert.equal(f.children.length, 1); assert.equal(f.children[0].closed, true);
  assert.equal(failures.length, 1); assert.equal(failures[0].cause.killed, true);
});

for (const provider of [() => pair, async () => pair]) test(`F4 core actual recovery awaits ${provider.constructor.name} without changing the sync oracle`, async () => {
  const result = await handleSessionMessageHook({ agent_id: "" }, "gemini", undefined, { recoverExistingSession: true, resolveHostProcess: provider,
    executionBudget: { deadlineMonotonicMs: performance.now() + 2000, postClaimReserveMs: 0 } });
  assert.deepEqual(result, {}); assert.equal(f.requests.filter(operation => operation === "ensure-relay").length, 1);
});

test("F4 core recovery consumes the original deadline and rejects late success", async () => {
  let release; const pending = new Promise(resolve => { release = resolve; }); let settled = false;
  const result = handleSessionMessageHook({ agent_id: "" }, "gemini", undefined, { recoverExistingSession: true, resolveHostProcess: () => pending,
    executionBudget: { deadlineMonotonicMs: performance.now() + 120, postClaimReserveMs: 0 } }).then(() => { settled = true; }, () => { settled = true; });
  await turn(); assert.equal(settled, false);
  await new Promise(resolve => setTimeout(resolve, 160)); release(pair); await result;
  assert.equal(f.requests.includes("ensure-relay"), false); assert.equal(f.requests.includes("claim-deferred"), false);
});

for (const actor of [{}, { agent_id: "child" }]) test(`F4 unknown/subagent recovery never invokes identity provider ${JSON.stringify(actor)}`, async () => {
  let calls = 0;
  await handleSessionMessageHook(actor, "gemini", undefined, { recoverExistingSession: true, resolveHostProcess: async () => { calls++; return pair; },
    executionBudget: { deadlineMonotonicMs: performance.now() + 2000, postClaimReserveMs: 0 } });
  assert.equal(calls, 0); assert.equal(f.requests.includes("ensure-relay"), false);
});


test("F4 native permission failure keeps its cause and emits no private diagnostic content", async () => {
  const cause = Object.assign(new Error("AL04_PRIVATE_NATIVE_MESSAGE"), { code: "EACCES", path: "AL04_PRIVATE_NATIVE_PATH" });
  f.failure = cause; const failures = [];
  const result = resolveVerifiedAntigravityHostProcess(options({ onProcessIdentityFailure: failure => failures.push(failure) }));
  await drain(); assert.equal(await result, null); assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "HOST_PROCESS_INSPECTION_FAILED"); assert.equal(failures[0].cause, cause);
});

test("F4 late native query result cannot become a host identity", async () => {
  let clock = 100; const failures = [];
  const result = resolveVerifiedAntigravityHostProcess({ now: () => clock, deadlineMonotonicMs: 600,
    onProcessIdentityFailure: failure => failures.push(failure) });
  await turn(); clock = 700; await drain();
  assert.equal(await result, null); assert.equal(failures[0].code, "HOST_PROCESS_BUDGET_EXHAUSTED");
});

test("F4 reused PID with a different native T2 token cannot ensure a relay", async () => {
  await handleSessionMessageHook({ agent_id: "" }, "gemini", undefined, { recoverExistingSession: true,
    resolveHostProcess: () => { f.birth = "9002"; return pair; },
    executionBudget: { deadlineMonotonicMs: performance.now() + 2000, postClaimReserveMs: 0 } });
  assert.equal(f.requests.includes("ensure-relay"), false);
});


test("F4 clock reset before resolver entry cannot start an OS query", async () => {
  const failures = [];
  const result = await resolveVerifiedAntigravityHostProcess({ now: () => 50, entryMonotonicMs: 100,
    deadlineMonotonicMs: 700, onProcessIdentityFailure: failure => failures.push(failure) });
  assert.equal(result, null); assert.equal(f.calls.length + f.sync.length, 0);
  assert.equal(failures[0].code, "HOST_PROCESS_CLOCK_INVALID");
});
