import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), token: vi.fn(), exists: vi.fn(), identity: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(),
  processStartToken: f.token, processExists: f.exists, processIdentityState: f.identity,
}));
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const host = syntheticCore.SYNTHETIC_CORE_HOST;

// Mocked broker/process regression fixture only, not native capture.
const port: WakeDispatchPort = { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, dispatch: async () => "definite-failure" };
const relayOptions = { host: "synthetic-host", sessionId: "relay-recovery", instanceId: "I2",
  transport: "codex-deferred", parentPid: 424242, parentStartToken: "T1" };
const post = { hook_event_name: "PostToolUse", session_id: "relay-recovery", tool_name: "shell", tool_input: {}, syntheticActor: "root" };
const hint = { instanceId: "I2", parentPid: 424242, parentStartToken: "T1" };
const hookFailures = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]))
  .filter((line) => line.startsWith("[agent-governance-suite] peer-hook-failure"))
  .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { phase: string; reason: string });
const failures = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]))
  .filter((line) => line.startsWith("[agent-governance-suite] relay-failure"))
  .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { phase: string; reason: string });

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "ags-relay-recovery-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", stateDir);
  f.request.mockReset(); f.token.mockReset(); f.exists.mockReset(); f.identity.mockReset(); f.spawn.mockReset();
  f.token.mockReturnValue("T1"); f.identity.mockReturnValue("match"); f.exists.mockReturnValue(false);
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(stateDir, { recursive: true, force: true }); });

it("HOOK-1: a boundary claim reporting a relay-less generation starts one detached single-attempt relay for it", async () => {
  f.request.mockImplementation(async (operation: string) =>
    operation === "claim-deferred" ? { messages: [], relayRecovery: hint } : {});
  await handleSessionMessageHook(post, host, 424242);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  expect(f.token).toHaveBeenCalledTimes(1); // the parent check's birth read is reused for the spawn
  const args = f.spawn.mock.calls[0]![1] as string[];
  for (const [flag, value] of [["--instance-id", "I2"], ["--parent-pid", "424242"], ["--parent-start-token", "T1"]] as const) {
    expect(args[args.indexOf(flag) + 1]).toBe(value);
  }
  expect(args).toContain("--recovery");
  expect(args).not.toContain("--relay-id");
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
});

it("HOOK-3: user input and a claim-less turn end also carry the recovery trigger, one relay per signaled hook", async () => {
  f.request.mockImplementation(async (operation: string) =>
    operation === "observe-native-input" || operation === "clear-deferred" ? { relayRecovery: hint } : {});
  await handleSessionMessageHook({ hook_event_name: "UserPromptSubmit", session_id: "relay-recovery", syntheticActor: "root" }, host, 424242);
  await handleSessionMessageHook({ hook_event_name: "Stop", session_id: "relay-recovery", syntheticActor: "root" }, host, 424242);
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(expect.arrayContaining(["observe-native-input", "clear-deferred"]));
  expect(f.spawn).toHaveBeenCalledTimes(2);
  for (const call of f.spawn.mock.calls) expect(call[1]).toEqual(expect.arrayContaining(["--recovery", "I2"]));
});

it("HOOK-2: no recovery signal, no host pid, or a child actor starts no relay", async () => {
  f.request.mockResolvedValue({ messages: [] });
  await handleSessionMessageHook(post, host, 424242);
  f.request.mockImplementation(async (operation: string) =>
    operation === "claim-deferred" ? { messages: [], relayRecovery: { instanceId: "I2" } } : {});
  await handleSessionMessageHook(post, host, undefined);
  await handleSessionMessageHook({ ...post, syntheticActor: "child" }, host, 424242);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("HOOK-4: a recovery relay is refused, with a recorded reason, unless this hook's host is the generation's reported birth", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const cases = [
    [{ instanceId: "I2" }, "T1", "RELAY_RECOVERY_PARENT_UNREPORTED"], // legacy generation: nothing to bind
    [{ ...hint, parentPid: 515151 }, "T1", "RELAY_RECOVERY_PARENT_MISMATCH"], // another process of the same session
    [hint, "T-reused-pid", "RELAY_RECOVERY_PARENT_MISMATCH"], // same PID, different birth
    [hint, null, "RELAY_RECOVERY_PARENT_UNVERIFIED"], // birth unreadable: unknown is not a match
  ] as const;
  for (const [recovery, token, reason] of cases) {
    f.token.mockReturnValue(token);
    f.request.mockImplementation(async (operation: string) =>
      operation === "claim-deferred" ? { messages: [], relayRecovery: recovery } : {});
    await handleSessionMessageHook(post, host, 424242);
    expect(hookFailures(stderr).at(-1)).toMatchObject({ phase: "recovery", reason });
  }
  expect(hookFailures(stderr)).toHaveLength(cases.length);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("HOOK-5: SessionStart reports the host birth it parents its relay with, and re-checks it after the presence await", async () => {
  const sessionStart = { hook_event_name: "SessionStart", session_id: "relay-recovery", syntheticActor: "root" };
  f.request.mockResolvedValue({});
  await handleSessionMessageHook(sessionStart, host, 424242);
  const start = f.request.mock.calls.find(([operation]) => operation === "presence-start")!;
  expect(start[1]).toMatchObject({ reportedParentPid: 424242, reportedParentStartToken: "T1" });
  expect(f.token).toHaveBeenCalledTimes(2); // reported before presence, re-observed before the spawn
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--instance-id") + 1]).toBe((start[1] as { instanceId: string }).instanceId);
  expect(args[args.indexOf("--parent-start-token") + 1]).toBe("T1");
  expect(args).not.toContain("--recovery");
  // A birth that changes across the presence await is neither adopted nor parented.
  f.spawn.mockClear(); f.token.mockReset(); f.token.mockReturnValueOnce("T1").mockReturnValue("T2");
  await handleSessionMessageHook(sessionStart, host, 424242);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("RELAY-1: a recovery relay makes one attempt without waiting and records why it got no lease", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  for (const [current, reason] of [["I2", "RELAY_LEASE_HELD"], ["I3", "RELAY_GENERATION_SUPERSEDED"]] as const) {
    f.request.mockReset();
    f.request.mockImplementation(async (operation: string) =>
      operation === "acquire-relay" ? { acquired: false } : operation === "presence" ? { presence: { instanceId: current } } : {});
    vi.useFakeTimers();
    await runSessionMessageRelay({ ...relayOptions, recovery: true }, port); // resolves without advancing timers
    vi.useRealTimers();
    expect(f.request.mock.calls.filter(([operation]) => operation === "acquire-relay")).toHaveLength(1);
    expect(f.request.mock.calls.some(([operation]) => operation === "presence-end")).toBe(false);
    expect(failures(stderr).at(-1)).toMatchObject({ phase: "acquire", reason });
  }
});

it("RELAY-2: a startup relay outlasts one stale lease (8 attempts) before recording the failure once", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockImplementation(async (operation: string) =>
    operation === "acquire-relay" ? { acquired: false } : operation === "presence" ? { presence: { instanceId: "I2" } } : {});
  vi.useFakeTimers();
  let finished = false;
  const running = runSessionMessageRelay(relayOptions, port).then(() => { finished = true; });
  for (let index = 0; index < 40 && !finished; index += 1) await vi.advanceTimersByTimeAsync(1000);
  await running;
  expect(f.request.mock.calls.filter(([operation]) => operation === "acquire-relay")).toHaveLength(8);
  expect(failures(stderr)).toEqual([expect.objectContaining({ phase: "acquire", reason: "RELAY_LEASE_HELD" })]);
});

it("RELAY-3: a superseded relay is refused re-acquisition and its exit releases only its own lease token", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  f.exists.mockReturnValue(true);
  let acquires = 0;
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "acquire-relay") return { acquired: (acquires += 1) === 1 };
    if (operation === "relay-tick") return { alive: false, count: 0 };
    return {};
  });
  await runSessionMessageRelay(relayOptions, port);
  expect(acquires).toBe(2);
  const end = f.request.mock.calls.find(([operation]) => operation === "presence-end")!;
  const first = f.request.mock.calls.find(([operation]) => operation === "acquire-relay")!;
  expect(end[1]).toMatchObject({ instanceId: "I2", relayId: (first[1] as { relayId: string }).relayId, pid: process.pid });
});
