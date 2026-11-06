import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type * as Fs from "node:fs";

// AGS 3.6.0 Codex hook boundaries: (1) the Windows host PID is read only for relay recovery, (2) the Codex hook entry
// runs under a budget bound to its hooks.json timeout and names the step a failure stopped in, (3) Codex Stop claims at
// turn end and continues the turn with decision/reason. Messaging requests, child processes, stdin and the clock are
// fixtures; the real store path is in codex-stop-delivery.test.ts.
const f = vi.hoisted(() => ({
  now: 100, request: vi.fn(), spawn: vi.fn(), execFile: vi.fn(), stdin: "" as string,
}));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => f.now, timeOrigin: 0 } }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: f.spawn, execFile: f.execFile,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof Fs>();
  const readFileSync = (file: unknown, ...rest: unknown[]): unknown => file === 0 ? f.stdin
    : (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
  return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const entry = path.join(root, "mcp-server/src/session-message-hook.ts");
const relayId = "22222222-2222-4222-8222-222222222222";
const post = JSON.stringify({ hook_event_name: "PostToolUse", session_id: "codex-boundary", tool_name: "shell", tool_input: {} });
const stop = (extra: Record<string, unknown> = {}) => ({ hook_event_name: "Stop", session_id: "codex-boundary", ...extra });
const message = {
  messageId: "synthetic-stop-id", sender: { host: "claude-code", sessionId: "sender" },
  recipient: { host: "codex", sessionId: "codex-boundary" }, body: "Synthetic stop body",
  createdAt: "2026-11-04T00:00:00.000Z", expiresAt: "2099-11-04T01:00:00.000Z",
  deliveryAttempt: 1, firstDeliveredAt: "2026-11-04T00:00:01.000Z",
};
/** Claims answer with a recovery hint for generation I2 reported by host 4242; grant-relay grants a fresh relay. */
const recovering = (operation: string) => operation === "grant-relay" ? { relayId }
  : { messages: [], relayRecovery: { instanceId: "I2", hostPid: 4242 } };

type ExecCall = [string, string[], { timeout?: number }, (error: Error | null, stdout?: string) => void];
const decoded = (args: string[]) => {
  const index = args.indexOf("-EncodedCommand");
  return index >= 0 ? Buffer.from(args[index + 1]!, "base64").toString("utf16le") : args.join(" ");
};
const lookups = () => (f.execFile.mock.calls as ExecCall[]).filter(([file, args]) => file === "ps" || decoded(args).includes("Get-CimInstance"));
const launches = () => (f.execFile.mock.calls as ExecCall[]).filter(([, args]) => decoded(args).includes("Start-Process"));
const hookFailures = () => vi.mocked(console.error).mock.calls.map((call) => String(call[0]))
  .filter((line) => line.startsWith("{") && JSON.parse(line).event === "peer-hook-failure")
  .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);

const originalArgv = process.argv;
const originalPlatform = process.platform;
let stateDir = "";
let written: string[] = [];
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "ags-codex-boundary-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", stateDir);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(stateDir, "trust.sqlite3"));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  f.now = 100;
  for (const mock of [f.request, f.spawn, f.execFile]) mock.mockReset();
  f.request.mockResolvedValue({ messages: [] });
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  // The parent lookup answers 4242; the Windows relay launcher answers a started process.
  f.execFile.mockImplementation((file: string, args: string[], _options: unknown, callback: ExecCall[3]) => {
    callback(null, file === "ps" || decoded(args).includes("Get-CimInstance") ? "4242\n" : "5555");
    return new EventEmitter();
  });
  written = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown, callback?: unknown) => {
    written.push(String(chunk));
    if (typeof callback === "function") (callback as () => void)();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  process.argv = originalArgv;
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(stateDir, { recursive: true, force: true });
});

/** Runs the production CLI block of the source module, as the bundled Codex hook command does. */
async function runCli(raw: string, args: readonly string[]): Promise<void> {
  f.stdin = raw;
  process.argv = [originalArgv[0]!, entry, ...args];
  vi.resetModules();
  await import("../../mcp-server/src/session-message-hook.js");
}

type Hook = { command: string; commandWindows?: string; timeout?: number };
const codexHooks = (file: string) => (JSON.parse(readFileSync(path.join(root, file), "utf8")) as { hooks: Record<string, Array<{ hooks: Hook[] }>> }).hooks;
const runs = (hook: Hook, script: string) => hook.command.includes(script);
const messageHooks = (hooks: ReturnType<typeof codexHooks>, event: string) => (hooks[event] ?? []).flatMap((group) => group.hooks)
  .filter((hook) => runs(hook, "session-message-hook.mjs"));

it.each(["hooks/hooks.json", "codex-plugin-en/hooks/hooks.json"])("%s: Windows input, after-tool and Stop hooks run no host process query", (file) => {
  const hooks = codexHooks(file);
  const [start] = messageHooks(hooks, "SessionStart");
  const [end] = messageHooks(hooks, "SessionEnd");
  // SessionStart and SessionEnd still report their host through the same expression.
  expect(start!.commandWindows).toContain("--host-pid (Get-CimInstance Win32_Process");
  expect(end!.commandWindows).toBe(start!.commandWindows);
  for (const event of ["UserPromptSubmit", "PostToolUse", "Stop"]) {
    const consumers = messageHooks(hooks, event);
    expect(consumers, event).toHaveLength(1);
    for (const hook of consumers) {
      expect(hook.commandWindows, event).not.toMatch(/Get-CimInstance|Win32_Process/u);
      expect(hook.commandWindows, event).toMatch(/ --host-shell-pid \$PID$/u);
      // POSIX keeps the host PID the shell already knows.
      expect(hook.command, event).toBe(start!.command);
    }
  }
});

it.each(["hooks/hooks.json", "codex-plugin-en/hooks/hooks.json"])("%s: Codex Stop runs the session message hook after the continuity phase check", (file) => {
  const stopHooks = codexHooks(file).Stop!.flatMap((group) => group.hooks);
  const continuity = stopHooks.findIndex((hook) => runs(hook, "continuity-hook.mjs"));
  const messaging = stopHooks.findIndex((hook) => runs(hook, "session-message-hook.mjs"));
  // Codex runs Stop hooks concurrently and joins every block reason in configured order (codex-rs hooks stop.rs).
  expect(continuity).toBeGreaterThanOrEqual(0);
  expect(messaging).toBeGreaterThan(continuity);
});

it("binds the hook command budget to every timed hooks.json entry that runs the session message hook", async () => {
  const { HOOK_COMMAND_TIMEOUT_MS, HOOK_COMMAND_BUDGET } = await import("../../mcp-server/src/session-message-hook.js");
  for (const file of ["hooks/hooks.json", "codex-plugin-en/hooks/hooks.json"]) {
    const hooks = codexHooks(file);
    for (const event of Object.keys(hooks)) for (const hook of messageHooks(hooks, event)) {
      // SessionEnd takes Codex's own SessionEnd limit (default 1 s, at most 3 s); the budget does not reach it.
      if (event === "SessionEnd") { expect(hook.timeout, event).toBeUndefined(); continue; }
      expect(hook.timeout! * 1000, `${file} ${event}`).toBe(HOOK_COMMAND_TIMEOUT_MS);
    }
  }
  expect(HOOK_COMMAND_BUDGET.deadlineMonotonicMs).toBeLessThan(HOOK_COMMAND_TIMEOUT_MS);
  expect(HOOK_COMMAND_BUDGET.postClaimReserveMs).toBeGreaterThan(0);
  expect(HOOK_COMMAND_BUDGET.postClaimReserveMs).toBeLessThan(HOOK_COMMAND_BUDGET.deadlineMonotonicMs);
});

it("the Codex hook command claims under its budget and reads no host process without a recovery hint", async () => {
  const { HOOK_COMMAND_BUDGET } = await import("../../mcp-server/src/session-message-hook.js");
  await runCli(post, ["--host-shell-pid", String(process.ppid)]);
  await vi.waitFor(() => expect(f.request).toHaveBeenCalledTimes(1));
  await new Promise((resolve) => setImmediate(resolve));
  const [operation, , , options] = f.request.mock.calls[0]! as [string, unknown, unknown, { deadlineMonotonicMs?: number }];
  expect(operation).toBe("claim-deferred");
  // A claim must leave its post-claim reserve before the command budget's deadline.
  expect(options.deadlineMonotonicMs).toBe(HOOK_COMMAND_BUDGET.deadlineMonotonicMs - HOOK_COMMAND_BUDGET.postClaimReserveMs);
  expect(lookups()).toHaveLength(0);
  expect(hookFailures()).toEqual([]);
});

it("relay recovery reads the host as the parent of the hook's own shell, once, and grants for that host", async () => {
  f.request.mockImplementation(async (operation: string) => recovering(operation));
  await runCli(post, ["--host-shell-pid", String(process.ppid)]);
  await vi.waitFor(() => expect(f.request.mock.calls.map(([operation]) => operation)).toContain("grant-relay"));
  expect(lookups()).toHaveLength(1);
  const [file, args, options] = lookups()[0]!;
  expect(file === "ps" ? args : decoded(args)).toEqual(file === "ps" ? ["-o", "ppid=", "-p", String(process.ppid)]
    : expect.stringContaining(`ProcessId=${process.ppid}`));
  expect(options.timeout).toBeGreaterThan(0);
  const grant = f.request.mock.calls.find(([operation]) => operation === "grant-relay")!;
  expect(grant[1]).toMatchObject({ instanceId: "I2", hostPid: 4242 });
  expect(hookFailures()).toEqual([]);
});

it("a shell that is not the hook's parent names no host: recovery is refused with its reason and step", async () => {
  f.request.mockImplementation(async (operation: string) => recovering(operation));
  await runCli(post, ["--host-shell-pid", String(process.ppid + 1)]);
  await vi.waitFor(() => expect(hookFailures()).toHaveLength(1));
  expect(hookFailures()[0]).toMatchObject({ phase: "recovery", reason: "HOOK_SHELL_PID_MISMATCH", step: "host-pid" });
  expect(lookups()).toHaveLength(0);
  expect(f.request.mock.calls.map(([operation]) => operation)).not.toContain("grant-relay");
});

it("a host PID that does not match the generation's reported host is refused as before", async () => {
  f.request.mockImplementation(async (operation: string) => recovering(operation));
  f.execFile.mockImplementation((_file: string, _args: string[], _options: unknown, callback: ExecCall[3]) => { callback(null, "4343\n"); return new EventEmitter(); });
  await runCli(post, ["--host-shell-pid", String(process.ppid)]);
  await vi.waitFor(() => expect(hookFailures()).toHaveLength(1));
  expect(hookFailures()[0]).toMatchObject({ phase: "recovery", reason: "RELAY_RECOVERY_PARENT_MISMATCH" });
  expect(f.request.mock.calls.map(([operation]) => operation)).not.toContain("grant-relay");
});

it("an explicit --host-pid needs no lookup", async () => {
  f.request.mockImplementation(async (operation: string) => recovering(operation));
  await runCli(post, ["--host-pid", "4242", "--host-shell-pid", String(process.ppid)]);
  await vi.waitFor(() => expect(f.request.mock.calls.map(([operation]) => operation)).toContain("grant-relay"));
  expect(lookups()).toHaveLength(0);
});

it("the host PID lookup and the Windows relay launcher wait no longer than the remaining budget", async () => {
  const { handleSessionMessageHook } = await import("../../mcp-server/src/session-message-hook.js");
  f.request.mockImplementation(async (operation: string) => recovering(operation));
  Object.defineProperty(process, "platform", { value: "win32" });
  const resolveHostPid = vi.fn(async () => 4242);
  const executionBudget = { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 };
  await handleSessionMessageHook(JSON.parse(post) as Record<string, unknown>, "codex", undefined, { executionBudget, resolveHostPid, isolateDetachedHandles: true });
  expect(resolveHostPid).toHaveBeenCalledWith(900);
  expect(launches()).toHaveLength(1);
  const [, , options, done] = launches()[0]!;
  expect(options.timeout).toBe(900);
  // The launcher ended at the deadline: the failure names the expired budget and the launcher step.
  f.now = 1000;
  done(Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM" }));
  expect(hookFailures()).toEqual([expect.objectContaining({ phase: "relay-start", reason: "HOOK_BUDGET_EXPIRED", step: "relay-launcher" })]);
});

it("Codex Stop claims at turn end and continues the turn with the envelope as decision/reason", async () => {
  const { handleSessionMessageHook } = await import("../../mcp-server/src/session-message-hook.js");
  f.request.mockImplementation(async (operation: string) => operation === "claim-turn-end" ? { messages: [message] } : {});
  const output = await handleSessionMessageHook(stop(), "codex", 4242);
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-turn-end"]);
  expect(Object.keys(output).sort()).toEqual(["decision", "reason"]);
  expect(output.decision).toBe("block");
  expect(String(output.reason)).toContain("[agent-governance-suite peer message BEGIN]");
  expect(String(output.reason)).toContain("Synthetic stop body");
});

it("Codex Stop without a message blocks nothing", async () => {
  const { handleSessionMessageHook } = await import("../../mcp-server/src/session-message-hook.js");
  expect(await handleSessionMessageHook(stop(), "codex", 4242)).toEqual({});
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-turn-end"]);
});

it("a Stop the host already continued (stop_hook_active) claims nothing, so messaging adds no second continuation", async () => {
  const { handleSessionMessageHook } = await import("../../mcp-server/src/session-message-hook.js");
  f.request.mockImplementation(async (operation: string) => operation.startsWith("claim") ? { messages: [message] } : {});
  expect(await handleSessionMessageHook(stop({ stop_hook_active: true }), "codex", 4242)).toEqual({});
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["clear-deferred"]);
});

it("a budget that expires right after the claim reports the claim step and outputs nothing", async () => {
  const { runSessionMessageHookOutcome } = await import("../../mcp-server/src/session-message-hook.js");
  f.request.mockImplementation(async (operation: string) => { f.now = 999.5; return operation === "claim-turn-end" ? { messages: [message] } : {}; });
  const outcome = await runSessionMessageHookOutcome("codex", JSON.stringify(stop()), 4242, { executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 } });
  expect(outcome).toEqual({ ok: false, output: "", failure: expect.objectContaining({ phase: "handle", reason: "HOOK_BUDGET_EXPIRED", step: "claim-turn-end" }) });
  expect(hookFailures()).toEqual([expect.objectContaining({ phase: "handle", reason: "HOOK_BUDGET_EXPIRED", step: "claim-turn-end" })]);
});
