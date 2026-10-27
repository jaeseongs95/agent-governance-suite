import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawnMock, requestMock, startTokenMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), requestMock: vi.fn(), startTokenMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: spawnMock }));
vi.mock("../../mcp-server/src/session-message-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: requestMock,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: startTokenMock,
}));
import { registerHookHostAdapter, resolveHookProcessPid } from "../../mcp-server/src/host-input-adapter.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

// Owned synthetic schema; these are core process-generation tests, not native capture.
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
const directHost = "synthetic-direct-relay-pid";
const pairedHost = "synthetic-paired-relay-pid";
syntheticCore.registerSyntheticCoreAdapters((_host, adapter) => {
  registerHookHostAdapter(directHost, adapter);
  registerHookHostAdapter(pairedHost, { ...adapter, processPid: (pid, observation) => observation ? pid : undefined });
}, () => "codex-deferred");

beforeEach(() => {
  spawnMock.mockReset(); requestMock.mockReset(); startTokenMock.mockReset();
  requestMock.mockResolvedValue({}); startTokenMock.mockReturnValue("synthetic-start-token");
  spawnMock.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "0");
});
afterEach(() => vi.unstubAllEnvs());
const input = { hook_event_name: "SessionStart", session_id: "synthetic-relay-host", syntheticActor: "root" };

it.each([directHost, pairedHost])("uses the explicit %s host PID and its observed start token", async (host) => {
  await handleSessionMessageHook(input, host, 424242, host === pairedHost
    ? { hostProcess: { pid: 424242, startToken: "synthetic-start-token" } } : undefined);
  expect(startTokenMock).toHaveBeenCalledWith(424242);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = spawnMock.mock.calls[0]![1] as string[];
  expect(args.slice(args.indexOf("--parent-pid"), args.indexOf("--parent-pid") + 2)).toEqual(["--parent-pid", "424242"]);
  expect(args.slice(args.indexOf("--parent-start-token"), args.indexOf("--parent-start-token") + 2)).toEqual(["--parent-start-token", "synthetic-start-token"]);
});

it("does not substitute a short-lived hook shell for an unknown Gemini host PID", async () => {
  expect(resolveHookProcessPid("gemini")).toBeUndefined();
  expect(resolveHookProcessPid("gemini", 424242)).toBeUndefined();
  await handleSessionMessageHook(input, "gemini");
  expect(startTokenMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it("preserves the Claude launcher parent selection", async () => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: input.session_id }, "claude-code", 424242);
  expect(startTokenMock).toHaveBeenCalledWith(process.ppid);
});

it("does not start a relay when the explicit identity is unobservable or the actor is a subagent", async () => {
  startTokenMock.mockReturnValue(null);
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: { pid: 424242, startToken: "synthetic-start-token" } });
  expect(spawnMock).not.toHaveBeenCalled();
  requestMock.mockClear(); startTokenMock.mockClear();
  await handleSessionMessageHook({ ...input, syntheticActor: "child" }, pairedHost, 424242, { hostProcess: { pid: 424242, startToken: "synthetic-start-token" } });
  expect(requestMock).not.toHaveBeenCalled(); expect(startTokenMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

const observedHostProcess = () => ({ pid: 424242, startToken: "synthetic-start-token" });

it("keeps the observed process generation and exact presence instance across the await", async () => {
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: observedHostProcess() });
  expect(requestMock).toHaveBeenCalledTimes(1);
  expect(requestMock.mock.calls[0]![0]).toBe("presence-start");
  const presence = requestMock.mock.calls[0]![1] as { instanceId: string; transport: string };
  expect(startTokenMock).toHaveBeenCalledTimes(2);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = spawnMock.mock.calls[0]![1] as string[];
  expect(args[args.indexOf("--instance-id") + 1]).toBe(presence.instanceId);
  expect(args[args.indexOf("--transport") + 1]).toBe(presence.transport);
  expect(args[args.indexOf("--parent-start-token") + 1]).toBe("synthetic-start-token");
});

it.each(["replacement-generation", null])("does not adopt a changed or unknown process token after presence: %s", async (afterToken) => {
  let releasePresence!: () => void;
  requestMock.mockImplementationOnce(() => new Promise<void>((resolve) => { releasePresence = resolve; }));
  const pending = handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: observedHostProcess() });
  expect(requestMock).toHaveBeenCalledTimes(1);
  expect(spawnMock).not.toHaveBeenCalled();
  startTokenMock.mockReturnValue(afterToken);
  releasePresence();
  await pending;
  expect(spawnMock).not.toHaveBeenCalled();
});

it("snapshots the caller observation before presence instead of accepting its later mutation", async () => {
  const hostProcess = observedHostProcess();
  requestMock.mockImplementationOnce(async () => {
    hostProcess.startToken = "replacement-generation";
    startTokenMock.mockReturnValue("replacement-generation");
    return {};
  });
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess });
  expect(spawnMock).not.toHaveBeenCalled();
});

it("requires a complete matching Gemini observation before starting presence", async () => {
  await handleSessionMessageHook(input, pairedHost, 424242);
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: { pid: 424243, startToken: "synthetic-start-token" } });
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: { pid: 424242, startToken: "" } });
  startTokenMock.mockReturnValue("replacement-generation");
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: observedHostProcess() });
  expect(requestMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it.each(["gemini"])("denies unsupported native %s lifecycle before presence and process effects", async (host) => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: input.session_id, agent_id: "" }, host, 424242,
    { hostProcess: observedHostProcess() });
  expect(requestMock).not.toHaveBeenCalled(); expect(startTokenMock).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
});
