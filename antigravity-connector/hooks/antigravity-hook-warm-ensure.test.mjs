import { test } from "vitest";
import assert from "node:assert/strict";
import {
  executeAntigravityHookEvent,
  resolveLongLivedHostProcess,
  startAntigravitySessionPresenceAndRelay,
} from "./antigravity-hook-runner.mjs";

test("warm ensure and host process identity scenarios", async () => {
const pair = Object.freeze({ pid: 1234, startToken: "synthetic-T1" });
const payload = (event, extra = {}) => ({ conversationId: "warm-fixture", agent_id: "", hook_event_name: event, ...extra });
const calls = [];
let resolutions = 0;
const options = () => ({
  now: () => 100, entryMonotonicMs: 100,
  resolveHostProcess: () => { resolutions++; return pair; },
  sessionMessageHook: async (...args) => { calls.push(args); return {}; },
});
const reset = () => { calls.length = 0; resolutions = 0; };

// Source-proposed only: these injected callbacks do not exercise native PowerShell or a broker.
{
  reset();
  await executeAntigravityHookEvent(payload("SessionStart"), "SessionStart", "session-message", options());
  assert.equal(resolutions, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].hook_event_name, "SessionStart");
  assert.equal(calls[0][1], "gemini");
  assert.equal(calls[0][2], pair.pid);
  assert.equal(calls[0][3].ensureRelay, true);
  assert.equal(calls[0][3].defaultQueueWake, true);
  assert.deepEqual(calls[0][3].hostProcess, pair);
  assert.ok(Number.isFinite(calls[0][3].executionBudget.deadlineMonotonicMs));
}
for (const event of ["PreInvocation", "PostInvocation", "Stop"]) {
  reset();
  await executeAntigravityHookEvent(payload(event), event, "session-message", options());
  assert.equal(resolutions, 0, event);
  assert.equal(calls.length, 1, event);
  assert.equal(calls[0][0].hook_event_name, "PostToolUse", event);
  assert.equal(calls[0][3].ensureRelay, undefined, event);
  assert.equal(calls[0][3].recoverExistingSession, true, event);
  assert.equal(calls[0][3].defaultQueueWake, true, event);
  assert.equal(typeof calls[0][3].resolveHostProcess, "function", event);
  assert.deepEqual(calls[0][3].resolveHostProcess(), pair, event);
  assert.equal(resolutions, 1, event);
}
for (const event of ["PreToolUse", "PostToolUse"]) {
  reset();
  await executeAntigravityHookEvent(payload(event, { toolCall: { name: "read_file", args: {} } }),
    event, "session-message", options());
  assert.equal(resolutions, 0, event);
  assert.equal(calls.length, 0, event);
}
for (const extra of [{ terminationReason: "USER_CANCELED" }, { error: "synthetic-error" }, { fullyIdle: false }, { executionNum: 4 }]) {
  reset();
  await executeAntigravityHookEvent(payload("Stop", extra), "Stop", "session-message", options());
  assert.equal(resolutions, 0);
  assert.equal(calls.length, 0);
}
{
  reset();
  await executeAntigravityHookEvent(payload("SessionStart", { agent_id: "synthetic-child" }),
    "SessionStart", "session-message", options());
  assert.equal(resolutions, 0);
  assert.equal(calls.length, 0);
}
{
  reset();
  await executeAntigravityHookEvent(payload("PreInvocation", { agent_id: "synthetic-child" }),
    "PreInvocation", "session-message", options());
  assert.equal(resolutions, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][3].ensureRelay, undefined);
}
for (const unverified of [null, { pid: 0, startToken: "T1" }, { pid: 1234, startToken: "" }]) {
  reset();
  await startAntigravitySessionPresenceAndRelay(payload("SessionStart"), {
    ...options(), resolveHostProcess: () => unverified,
    deadlineMonotonicMs: 1000, remainingBudgetMs: () => 900,
  });
  assert.equal(calls.length, 0);
}
{
  reset();
  await startAntigravitySessionPresenceAndRelay(payload("SessionStart"), {
    ...options(), remainingBudgetMs: () => 99, deadlineMonotonicMs: 1000,
  });
  assert.equal(resolutions, 0);
  assert.equal(calls.length, 0);
}

const shell = { pid: 10, parentPid: 20, name: "cmd.exe", command: "C:/Windows/System32/cmd.exe", startToken: "shell-T" };
const host = { pid: 20, parentPid: 1, name: "Antigravity.exe",
  command: "C:/Program Files/Antigravity/Antigravity.exe", startToken: "host-T" };
{
  const inspections = [];
  const result = resolveLongLivedHostProcess(10, "win32", { now: () => 0, timeoutMs: 1500, maxDepth: 100, env: {},
    inspectProcessChain: (...args) => { inspections.push(args); return [shell, host]; } });
  assert.deepEqual(result, { pid: 20, startToken: "host-T" });
  assert.equal(inspections.length, 1);
  assert.deepEqual(inspections[0], [10, 6, 1500]);
}
for (const rows of [
  [{ ...shell, pid: 11 }, host],
  [shell, { ...host, pid: 21 }],
  [shell, { ...host, startToken: "" }],
  [shell, { ...host, command: "C:/Users/Public/Antigravity.exe" }],
  [shell, { ...host, name: "foreign.exe" }],
  [],
  Array.from({ length: 7 }, () => shell),
]) {
  assert.equal(resolveLongLivedHostProcess(10, "win32", { now: () => 0, timeoutMs: 1500, env: {},
    inspectProcessChain: () => rows }), null);
}
{
  let inspections = 0;
  assert.equal(resolveLongLivedHostProcess(10, "win32", { timeoutMs: 99, now: () => 0,
    inspectProcessChain: () => { inspections++; return [shell, host]; } }), null);
  assert.equal(inspections, 0);
}
{
  let time = 0;
  assert.equal(resolveLongLivedHostProcess(10, "win32", { timeoutMs: 1500, now: () => time, env: {},
    inspectProcessChain: () => { time = 1401; return [shell, host]; } }), null);
}

// A valid process pair never upgrades an absent or malformed actor identity to main.
for (const actor of [{}, { agent_id: null }, { agent_id: 0 }]) {
  reset();
  await executeAntigravityHookEvent({ conversationId: "unknown-actor-fixture", ...actor },
    "SessionStart", "session-message", options());
  assert.equal(resolutions, 0);
  assert.equal(calls.length, 0);
}

});
