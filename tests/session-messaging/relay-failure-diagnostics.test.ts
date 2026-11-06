import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const syntheticRootHost = syntheticCore.SYNTHETIC_CORE_HOST;
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { tagProducerFailure } from "../../mcp-server/src/failure-diagnostics.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";
import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";

const port: WakeDispatchPort = {
  capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, resendBaseMs: 600_000,
  dispatch: async () => ({ result: "not-delivered", kind: "transient", reasonCode: "SYNTHETIC_TRANSIENT" }),
};
const relayId = "11111111-1111-4111-8111-111111111111";
const relayOptions = { host: "synthetic-host", sessionId: "relay-diagnostic", instanceId: "instance-1",
  transport: "codex-deferred", parentPid: 424242, relayId, hostAliveAt: "100" };

/** A host watcher the test ends explicitly; bound never settles unless bind() is called. */
function controlledWatch() {
  let end!: (reason: string) => void, bind!: (token: string) => void;
  const exited = new Promise<string>((resolve) => { end = resolve; });
  const bound = new Promise<string>((resolve) => { bind = resolve; });
  const watch: HostWatch = { bound, exited, close: vi.fn() };
  return { watch, end, bind };
}

function lines(spy: { mock: { calls: unknown[][] } }, prefix: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith("{") && JSON.parse(line).event === prefix)
    .map((line: string) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}
function allText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

let state: string;
beforeEach(() => {
  // Hook relay-start records go only to this test's own state directory.
  state = mkdtempSync(path.join(os.tmpdir(), "ags-relay-diagnostics-"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  f.request.mockReset(); f.spawn.mockReset();
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); rmSync(state, { recursive: true, force: true }); });

it("reports an asynchronous relay spawn failure instead of escaping the hook", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockResolvedValue({ relayId });
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "relay-spawn", syntheticActor: "root" }, syntheticRootHost, 424242);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const child = f.spawn.mock.results[0]!.value as EventEmitter;
  expect(() => child.emit("error", Object.assign(new Error("secret-canary spawn"), { code: "ENOENT" }))).not.toThrow();
  const reported = lines(stderr, "peer-hook-failure");
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ phase: "relay-start", reason: "ENOENT" });
  expect(allText(stderr)).not.toContain("secret-canary");
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("reports a failed relay release with the original producer reason after its host ended", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const { watch, end } = controlledWatch();
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "relay-tick") { end("HOST_PROCESS_ENDED"); return { alive: true, count: 0, hostBound: false }; }
    throw tagProducerFailure(new Error("secret-canary release"), "MESSAGING_STORAGE_FAILED");
  });
  await runSessionMessageRelay(relayOptions, port, { watch: () => watch, delay: (_ms, stop) => stop });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["relay-tick", "release-relay"]);
  expect(f.request.mock.calls[1]![1]).toMatchObject({ relayId, instanceId: "instance-1", reason: "host-process-ended" });
  const reported = lines(stderr, "relay-failure");
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ phase: "release", reason: "MESSAGING_STORAGE_FAILED" });
  expect(allText(stderr)).not.toContain("secret-canary");
  expect(watch.close).toHaveBeenCalledTimes(1);
});

it("reports each tick failure and keeps the loop running until its host ends", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const { watch, end } = controlledWatch();
  let ticks = 0;
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "relay-tick") { ticks += 1; throw tagProducerFailure(new Error("secret-canary tick"), "MESSAGING_BUSY"); }
    return { released: true };
  });
  const waits: number[] = [];
  // The injected loop wait: the host ends during the second one, which then returns only when the relay was told to stop.
  const delay = async (milliseconds: number, stop: Promise<void>) => {
    waits.push(milliseconds);
    if (waits.length === 2) { end("HOST_PROCESS_ENDED"); await stop; }
  };
  await runSessionMessageRelay(relayOptions, port, { watch: () => watch, delay });
  expect(ticks).toBe(2);
  expect(waits).toEqual([5000, 5000]);
  const reported = lines(stderr, "relay-failure");
  expect(reported.map((entry: Record<string, unknown>) => entry.phase)).toEqual(["tick", "tick"]);
  for (const entry of reported) expect(entry).toMatchObject({ reason: "MESSAGING_BUSY" });
  expect(f.request.mock.calls.at(-1)![0]).toBe("release-relay");
  expect(f.request.mock.calls.at(-1)![1]).toMatchObject({ reason: "host-process-ended" });
  expect(allText(stderr)).not.toContain("secret-canary");
});

it("records a relay fenced by its lease as an abnormal end and releases only its own grant", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  const { watch } = controlledWatch();
  f.request.mockImplementation(async (operation: string) => operation === "relay-tick" ? { alive: false, count: 0, hostBound: false } : { released: false });
  await runSessionMessageRelay(relayOptions, port, { watch: () => watch, delay: (_ms, stop) => stop });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["relay-tick", "release-relay"]);
  expect(f.request.mock.calls[1]![1]).toMatchObject({ relayId, reason: "relay-ended" });
  expect(lines(stderr, "relay-failure")).toEqual([expect.objectContaining({ phase: "run", reason: "RELAY_LEASE_LOST" })]);
});

it.each(["gemini"])("unsupported native %s cannot reach relay spawn", async (host) => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "relay-spawn", agent_id: "" }, host, 424242,
    { hostProcess: { pid: 424242, startToken: "T1" } });
  expect(f.request).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
