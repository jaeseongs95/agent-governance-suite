import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const host = syntheticCore.SYNTHETIC_CORE_HOST;

// Boundary recovery (docs/ags30-broker-redesign.md 3.3): the store's hint names the relay-less generation and the host
// process it reported; the hook compares that pid with its own host, asks grant-relay, and spawns with the granted id.
// Mocked request/spawn regression fixture only, not native capture.
const port: WakeDispatchPort = { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, resendBaseMs: 600_000,
  dispatch: async () => ({ result: "not-delivered", kind: "transient", reasonCode: "SYNTHETIC_TRANSIENT" }) };
const relayId = "22222222-2222-4222-8222-222222222222";
const relayOptions = { host: "synthetic-host", sessionId: "relay-recovery", instanceId: "I2",
  transport: "codex-deferred", parentPid: 424242, relayId };
const post = { hook_event_name: "PostToolUse", session_id: "relay-recovery", tool_name: "shell", tool_input: {}, syntheticActor: "root" };
const hint = { instanceId: "I2", hostPid: 424242 };
const hookFailures = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]))
  .filter((line) => line.startsWith("[agent-governance-suite] peer-hook-failure"))
  .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { phase: string; reason: string });
const failures = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => String(call[0]))
  .filter((line) => line.startsWith("[agent-governance-suite] relay-failure"))
  .map((line) => JSON.parse(line.slice(line.indexOf("{"))) as { phase: string; reason: string });
/** Answers the boundary claim with a recovery hint and grant-relay with a fresh relay id. */
const answer = (hinted: string[], recovery: unknown = hint, grant: unknown = { relayId }) => async (operation: string) =>
  hinted.includes(operation) ? { messages: [], relayRecovery: recovery } : operation === "grant-relay" ? grant : {};

let stateDir = "";
beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "ags-relay-recovery-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", stateDir);
  f.request.mockReset(); f.spawn.mockReset();
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(stateDir, { recursive: true, force: true }); });

it("HOOK-1: a boundary claim reporting a relay-less generation grants and starts one detached relay for it", async () => {
  f.request.mockImplementation(answer(["claim-deferred"]));
  await handleSessionMessageHook(post, host, 424242);
  const grant = f.request.mock.calls.find(([operation]) => operation === "grant-relay")!;
  expect(grant[1]).toMatchObject({ target: { host, sessionId: "relay-recovery" }, transport: "codex-deferred", instanceId: "I2", hostPid: 424242 });
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const args = f.spawn.mock.calls[0]![1] as string[];
  for (const [flag, value] of [["--instance-id", "I2"], ["--parent-pid", "424242"], ["--relay-id", relayId]] as const) {
    expect(args[args.indexOf(flag) + 1]).toBe(value);
  }
  expect(args).not.toContain("--recovery");
  expect(args).not.toContain("--parent-start-token"); // no birth is read in the hook; the relay's watcher binds it
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
});

it("HOOK-3: user input and a claim-less turn end also carry the recovery trigger, one grant and relay per signaled hook", async () => {
  f.request.mockImplementation(answer(["observe-native-input", "clear-deferred"]));
  await handleSessionMessageHook({ hook_event_name: "UserPromptSubmit", session_id: "relay-recovery", syntheticActor: "root" }, host, 424242);
  await handleSessionMessageHook({ hook_event_name: "Stop", session_id: "relay-recovery", syntheticActor: "root" }, host, 424242);
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(expect.arrayContaining(["observe-native-input", "clear-deferred"]));
  expect(f.request.mock.calls.filter(([operation]) => operation === "grant-relay")).toHaveLength(2);
  expect(f.spawn).toHaveBeenCalledTimes(2);
  for (const call of f.spawn.mock.calls) expect(call[1]).toEqual(expect.arrayContaining(["--instance-id", "I2", "--relay-id", relayId]));
});

it("HOOK-2: no recovery signal, no host pid, or a child actor starts no relay; a missing host pid is recorded, not silent", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockResolvedValue({ messages: [] });
  await handleSessionMessageHook(post, host, 424242);
  f.request.mockImplementation(answer(["claim-deferred", "observe-native-input"]));
  await handleSessionMessageHook(post, host, undefined);
  await handleSessionMessageHook({ hook_event_name: "UserPromptSubmit", session_id: "relay-recovery", syntheticActor: "root" }, host, undefined);
  await handleSessionMessageHook({ ...post, syntheticActor: "child" }, host, 424242);
  expect(hookFailures(stderr)).toHaveLength(2);
  for (const failure of hookFailures(stderr)) expect(failure).toMatchObject({ phase: "recovery", reason: "RELAY_RECOVERY_HOST_UNIDENTIFIED" });
  expect(f.request.mock.calls.some(([operation]) => operation === "grant-relay")).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("HOOK-6: every packaged hook that can receive a recovery hint passes the host identity SessionStart reported", () => {
  type Hook = { command: string; commandWindows?: string; args?: string[] };
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const read = (file: string) => (JSON.parse(readFileSync(path.join(root, file), "utf8")) as { hooks: Record<string, Array<{ hooks: Hook[] }>> }).hooks;
  const messageHooks = (hooks: ReturnType<typeof read>, event: string) => (hooks[event] ?? []).flatMap((group) => group.hooks)
    .filter((hook) => [hook.command, ...(hook.args ?? [])].some((part) => part.includes("session-message-hook.mjs")));
  const hostPid = (command: string | undefined) => / --host-pid .+$/u.exec(command ?? "")?.[0];
  // User input, the after-tool boundary and turn end are the hook events whose replies carry relayRecovery.
  const consumers = ["UserPromptSubmit", "PostToolUse", "Stop"];
  // Codex passes its host explicitly; each consumer must pass the same host expression as SessionStart.
  const codex = read("hooks/hooks.json");
  const [start] = messageHooks(codex, "SessionStart");
  expect(hostPid(start?.command)).toBeTruthy();
  expect(hostPid(start?.commandWindows)).toBeTruthy();
  expect(messageHooks(codex, "UserPromptSubmit")).toHaveLength(1);
  for (const event of consumers) for (const hook of messageHooks(codex, event)) {
    expect(hostPid(hook.command), event).toBe(hostPid(start!.command));
    expect(hostPid(hook.commandWindows), event).toBe(hostPid(start!.commandWindows));
  }
  // Claude Code reads its host as the hook's direct parent, so its hooks start node with no shell in between.
  const claude = read("claude-overlay/hooks/hooks.json");
  for (const event of ["SessionStart", ...consumers]) {
    expect(messageHooks(claude, event).length, event).toBeGreaterThan(0);
    for (const hook of messageHooks(claude, event)) expect(hook.command, event).toBe("node");
  }
});

it("HOOK-4: a recovery relay is refused, with a recorded reason, unless this hook's host is the generation's reported host", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const cases = [
    [{ instanceId: "I2" }, "RELAY_RECOVERY_PARENT_UNREPORTED"], // a generation without a reported host: nothing to bind
    [{ ...hint, hostPid: 515151 }, "RELAY_RECOVERY_PARENT_MISMATCH"], // another process of the same session
  ] as const;
  for (const [recovery, reason] of cases) {
    f.request.mockImplementation(answer(["claim-deferred"], recovery));
    await handleSessionMessageHook(post, host, 424242);
    expect(hookFailures(stderr).at(-1)).toMatchObject({ phase: "recovery", reason });
  }
  expect(hookFailures(stderr)).toHaveLength(cases.length);
  expect(f.request.mock.calls.some(([operation]) => operation === "grant-relay")).toBe(false);
  expect(f.spawn).not.toHaveBeenCalled();
});

it.each([["HOST_MISMATCH", 1], ["GENERATION_CHANGED", 1], ["RELAY_ALIVE", 0]] as const)(
  "HOOK-7: a refused recovery grant (%s) spawns nothing and is recorded unless the relay is alive", async (reason, recorded) => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    f.request.mockImplementation(answer(["claim-deferred"], hint, { relayId: null, reason }));
    await handleSessionMessageHook(post, host, 424242);
    expect(f.request.mock.calls.filter(([operation]) => operation === "grant-relay")).toHaveLength(1);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(hookFailures(stderr).filter((failure) => failure.phase === "relay-start")).toHaveLength(recorded);
  });

it("HOOK-5: SessionStart reports its host process to presence-start and parents the relay it grants", async () => {
  const sessionStart = { hook_event_name: "SessionStart", session_id: "relay-recovery", syntheticActor: "root" };
  f.request.mockImplementation(async (operation: string) => operation === "presence-start" ? { presence: {}, relayId } : {});
  await handleSessionMessageHook(sessionStart, host, 424242);
  const start = f.request.mock.calls.find(([operation]) => operation === "presence-start")!;
  expect(start[1]).toMatchObject({ hostPid: 424242 });
  expect(start[1]).not.toHaveProperty("hostStart"); // only an adapter that read the birth reports it
  const args = f.spawn.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--instance-id") + 1]).toBe((start[1] as { instanceId: string }).instanceId);
  expect(args[args.indexOf("--relay-id") + 1]).toBe(relayId);
  expect(args[args.indexOf("--parent-pid") + 1]).toBe("424242");
  // A malformed relay id in the reply is not spawned.
  f.spawn.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockImplementation(async (operation: string) => operation === "presence-start" ? { presence: {}, relayId: "not-a-uuid" } : {});
  await handleSessionMessageHook(sessionStart, host, 424242);
  expect(f.spawn).not.toHaveBeenCalled();
});

it("RELAY-3: a fenced relay stops at its first refused tick and its exit releases only its own relay_id", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockImplementation(async (operation: string) => operation === "relay-tick" ? { alive: false, count: 0, hostBound: false } : {});
  const watch: HostWatch = { bound: new Promise<string>(() => {}), exited: new Promise<string>(() => {}), close: vi.fn() };
  await runSessionMessageRelay(relayOptions, port, { request: f.request, watch: () => watch, delay: (_milliseconds, stop) => stop });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["relay-tick", "release-relay"]);
  expect(f.request.mock.calls[1]![1]).toMatchObject({ instanceId: "I2", relayId, transport: "codex-deferred", reason: "relay-ended" });
  expect(watch.close).toHaveBeenCalledTimes(1);
  expect(failures(stderr)).toEqual([expect.objectContaining({ phase: "run", reason: "RELAY_LEASE_LOST" })]);
});
