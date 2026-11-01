import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { spawnMock, requestMock } = vi.hoisted(() => ({ spawnMock: vi.fn(), requestMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({ ...await importOriginal<typeof import("node:child_process")>(), spawn: spawnMock }));
vi.mock("../../mcp-server/src/session-message-client.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: requestMock,
}));
import { registerHookHostAdapter, resolveHookProcessPid } from "../../mcp-server/src/host-input-adapter.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

// Owned synthetic schema; these are core host-process binding tests, not native capture.
// The hook never queries a process identity (D0331): it passes the host PID it resolved and, only when the adapter
// observed one, that birth; the relay's host watcher binds and compares it (docs/ags30-broker-redesign.md 3.4).
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
const directHost = "synthetic-direct-relay-pid";
const pairedHost = "synthetic-paired-relay-pid";
syntheticCore.registerSyntheticCoreAdapters((_host, adapter) => {
  registerHookHostAdapter(directHost, adapter);
  registerHookHostAdapter(pairedHost, { ...adapter, processPid: (pid, observation) => observation ? pid : undefined });
}, () => "codex-deferred");

const relayId = "33333333-3333-4333-8333-333333333333";
let state: string;
beforeEach(() => {
  state = mkdtempSync(path.join(os.tmpdir(), "ags-relay-host-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  spawnMock.mockReset(); requestMock.mockReset();
  requestMock.mockResolvedValue({ relayId });
  spawnMock.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE", "0");
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(state, { recursive: true, force: true }); });
const input = { hook_event_name: "SessionStart", session_id: "synthetic-relay-host", syntheticActor: "root" };
const argument = (args: string[], flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;

it.each([directHost, pairedHost])("reports and parents the relay with the explicit %s host PID, and an observed birth only when given", async (host) => {
  await handleSessionMessageHook(input, host, 424242, host === pairedHost
    ? { hostProcess: { pid: 424242, startToken: "synthetic-start-token" } } : undefined);
  expect(requestMock.mock.calls[0]![0]).toBe("presence-start");
  const presence = requestMock.mock.calls[0]![1] as Record<string, unknown>;
  expect(presence.hostPid).toBe(424242);
  expect(presence.hostStart).toBe(host === pairedHost ? "synthetic-start-token" : undefined);
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = spawnMock.mock.calls[0]![1] as string[];
  expect(argument(args, "--parent-pid")).toBe("424242");
  expect(argument(args, "--relay-id")).toBe(relayId);
  expect(argument(args, "--parent-start-token")).toBe(host === pairedHost ? "synthetic-start-token" : undefined);
  // The watcher's bound is this hook's own start, never a queried host identity.
  if (process.platform === "linux") expect(argument(args, "--host-alive-at")).toMatch(/^[0-9]+$/u);
});

it("does not substitute a short-lived hook shell for an unknown Gemini host PID", async () => {
  expect(resolveHookProcessPid("gemini")).toBeUndefined();
  expect(resolveHookProcessPid("gemini", 424242)).toBeUndefined();
  await handleSessionMessageHook(input, "gemini");
  expect(requestMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it("preserves the Claude launcher parent selection", async () => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: input.session_id }, "claude-code", 424242);
  expect((requestMock.mock.calls[0]![1] as Record<string, unknown>).hostPid).toBe(process.ppid);
  expect(argument(spawnMock.mock.calls[0]![1] as string[], "--parent-pid")).toBe(String(process.ppid));
});

it("does not start presence or a relay for a subagent actor", async () => {
  await handleSessionMessageHook({ ...input, syntheticActor: "child" }, pairedHost, 424242, { hostProcess: { pid: 424242, startToken: "synthetic-start-token" } });
  expect(requestMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

const observedHostProcess = () => ({ pid: 424242, startToken: "synthetic-start-token" });

it("spawns the relay for the exact presence instance and grant it started", async () => {
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: observedHostProcess() });
  expect(requestMock).toHaveBeenCalledTimes(1);
  expect(requestMock.mock.calls[0]![0]).toBe("presence-start");
  const presence = requestMock.mock.calls[0]![1] as { instanceId: string; transport: string };
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = spawnMock.mock.calls[0]![1] as string[];
  expect(argument(args, "--instance-id")).toBe(presence.instanceId);
  expect(argument(args, "--transport")).toBe(presence.transport);
  expect(argument(args, "--relay-id")).toBe(relayId);
  expect(argument(args, "--parent-start-token")).toBe("synthetic-start-token");
});

it("snapshots the caller observation before presence instead of accepting its later mutation", async () => {
  const hostProcess = observedHostProcess();
  requestMock.mockImplementationOnce(async () => {
    hostProcess.startToken = "replacement-generation";
    hostProcess.pid = 515151;
    return { relayId };
  });
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess });
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const args = spawnMock.mock.calls[0]![1] as string[];
  expect(argument(args, "--parent-pid")).toBe("424242");
  expect(argument(args, "--parent-start-token")).toBe("synthetic-start-token");
});

it.each([{ relayId: null, reason: "HOST_UNREPORTED" }, { relayId: "not-a-grant" }, { kept: true, relayId: null }])(
  "spawns nothing without a valid grant from presence-start: %j", async (result) => {
    requestMock.mockResolvedValueOnce(result);
    await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: observedHostProcess() });
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).not.toHaveBeenCalled();
  });

it("requires a complete matching host observation before starting presence", async () => {
  await handleSessionMessageHook(input, pairedHost, 424242);
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: { pid: 424243, startToken: "synthetic-start-token" } });
  await handleSessionMessageHook(input, pairedHost, 424242, { hostProcess: { pid: 424242, startToken: "" } });
  expect(requestMock).not.toHaveBeenCalled();
  expect(spawnMock).not.toHaveBeenCalled();
});

it.each(["gemini"])("denies unsupported native %s lifecycle before presence and process effects", async (host) => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: input.session_id, agent_id: "" }, host, 424242,
    { hostProcess: observedHostProcess() });
  expect(requestMock).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
});
