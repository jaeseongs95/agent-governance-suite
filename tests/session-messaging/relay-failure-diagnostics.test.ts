import { EventEmitter } from "node:events";
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
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const syntheticRootHost = syntheticCore.SYNTHETIC_CORE_HOST;
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { tagProducerFailure } from "../../mcp-server/src/failure-diagnostics.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";

const port: WakeDispatchPort = {
  capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" },
  dispatch: async () => "definite-failure",
};
const relayOptions = { host: "synthetic-host", sessionId: "relay-diagnostic", instanceId: "instance-1",
  transport: "codex-deferred", parentPid: 424242, parentStartToken: "T1" };

function lines(spy: { mock: { calls: unknown[][] } }, prefix: string): Array<Record<string, unknown>> {
  return spy.mock.calls
    .map((call: unknown[]) => String(call[0]))
    .filter((line: string) => line.startsWith(prefix))
    .map((line: string) => JSON.parse(line.slice(line.indexOf("{"))) as Record<string, unknown>);
}
function allText(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((call: unknown[]) => String(call[0])).join("\n");
}

beforeEach(() => {
  f.request.mockReset(); f.token.mockReset(); f.exists.mockReset(); f.identity.mockReset(); f.spawn.mockReset();
  f.token.mockReturnValue("T1"); f.identity.mockReturnValue("match"); f.exists.mockReturnValue(false);
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

it("reports an asynchronous legacy relay spawn failure instead of escaping the hook", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockResolvedValue({});
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "legacy-spawn", syntheticActor: "root" }, syntheticRootHost, 424242);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  const child = f.spawn.mock.results[0]!.value as EventEmitter;
  expect(() => child.emit("error", Object.assign(new Error("secret-canary spawn"), { code: "ENOENT" }))).not.toThrow();
  const reported = lines(stderr, "[agent-governance-suite] peer-hook-failure");
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ phase: "relay-start", reason: "ENOENT" });
  expect(allText(stderr)).not.toContain("secret-canary");
  expect(f.request).toHaveBeenCalledTimes(1);
});

it("reports a failed relay release with the original producer reason", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "acquire-relay") return { acquired: true };
    throw tagProducerFailure(new Error("secret-canary release"), "BROKER_TRANSPORT_FAILED");
  });
  await runSessionMessageRelay(relayOptions, port);
  const reported = lines(stderr, "[agent-governance-suite] relay-failure");
  expect(reported).toHaveLength(1);
  expect(reported[0]).toMatchObject({ phase: "release", reason: "BROKER_TRANSPORT_FAILED" });
  expect(allText(stderr)).not.toContain("secret-canary");
});

it("reports acquire and tick failures while keeping retry and loop behavior", async () => {
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  f.exists.mockReturnValueOnce(true).mockReturnValue(false);
  let acquireCalls = 0;
  f.request.mockImplementation(async (operation: string) => {
    if (operation === "acquire-relay") {
      acquireCalls += 1;
      if (acquireCalls === 1) throw tagProducerFailure(new Error("secret-canary acquire"), "BROKER_TRANSPORT_FAILED");
      return { acquired: true };
    }
    if (operation === "relay-tick") throw tagProducerFailure(new Error("secret-canary tick"), "BROKER_DEADLINE_EXPIRED");
    return {};
  });
  vi.useFakeTimers();
  let finished = false;
  const running = runSessionMessageRelay(relayOptions, port).then(() => { finished = true; });
  for (let index = 0; index < 30 && !finished; index += 1) await vi.advanceTimersByTimeAsync(1000);
  await running;
  expect(acquireCalls).toBe(2);
  const reported = lines(stderr, "[agent-governance-suite] relay-failure");
  expect(reported.map((entry: Record<string, unknown>) => entry.phase)).toEqual(["acquire", "tick"]);
  expect(reported[0]).toMatchObject({ reason: "BROKER_TRANSPORT_FAILED" });
  expect(reported[1]).toMatchObject({ reason: "BROKER_DEADLINE_EXPIRED" });
  expect(allText(stderr)).not.toContain("secret-canary");
});

it.each(["gemini"])("unsupported native %s cannot reach legacy relay spawn", async (host) => {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "legacy-spawn", agent_id: "" }, host, 424242,
    { hostProcess: { pid: 424242, startToken: "T1" } });
  expect(f.request).not.toHaveBeenCalled(); expect(f.token).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});
