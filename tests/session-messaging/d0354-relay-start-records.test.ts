import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { ActorObservation } from "../../mcp-server/src/input-observation.js";
import { performance } from "node:perf_hooks";
import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import type { WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const verifiedHost = "synthetic-d0354-verified";
registerHookHostAdapter(verifiedHost, {
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host, callId: "d0354-call", actor: payload.syntheticActor as ActorObservation } };
  },
  deliveryProfile: () => ({ transport: "antigravity-queue", capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, blocksEmptyWakePrompt: false }),
  processPid: (pid, observation) => observation ? pid : undefined,
});
const verifiedRoot: ActorObservation = { role: "root", basis: "observed", reasonCode: "SYNTHETIC_D0354_ROOT" };

// D0354: a generation whose relay never started or ended early must leave a local record with a fixed reason.
// Hosts may discard hook stderr, so the stderr line alone left "registered, no heartbeat" sessions unexplained.
const port: WakeDispatchPort = { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, resendBaseMs: 600_000,
  dispatch: async () => ({ result: "not-delivered", kind: "transient", reasonCode: "SYNTHETIC_TRANSIENT" }) };
const relayOptions = { host: "synthetic-host", sessionId: "relay-d0354", instanceId: "instance-1",
  transport: "codex-deferred", parentPid: 424242, relayId: "11111111-1111-4111-8111-111111111111" };
let root: string;
let state: string;

function records(): Array<Record<string, unknown>> {
  const history = path.join(state, "relay-failures");
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history).map(name => JSON.parse(fs.readFileSync(path.join(history, name), "utf8")) as Record<string, unknown>);
}

/** A host watcher the test drives: bound and exited settle only when the test says so. */
function controlledWatch(token = "T1") {
  let exit!: (reason: string) => void;
  const exited = new Promise<string>((resolve) => { exit = resolve; });
  const watch: HostWatch = { bound: Promise.resolve(token), exited, close: vi.fn() };
  return { watch: () => watch, exit };
}
/** The relay's loop wait returns only when the relay stops, so every loop turn is driven by an event, not a timer. */
const untilStopped = (_milliseconds: number, stop: Promise<void>) => stop;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0354-"));
  state = path.join(root, "state");
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  // The messaging state directory already exists; hook records are written only into an existing one.
  fs.mkdirSync(state, { recursive: true });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  for (const mock of Object.values(f)) mock.mockReset();
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D0354 relay start and end records", () => {
  it.each(["HOST_UNREPORTED", "GENERATION_CHANGED", undefined])("records a refused SessionStart grant (%s) and starts no relay", async (reason) => {
    f.request.mockResolvedValue({ presence: {}, relayId: null, ...(reason ? { reason } : {}) });
    await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "refused-grant", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, 424242);
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
    expect(f.request.mock.calls[0]![1]).toMatchObject({ hostPid: 424242 });
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_SPAWN_NOT_GRANTED", grantReason: reason ?? "UNREPORTED" })]);
  });

  it("records a SessionStart whose host process is unresolved, without contacting the store", async () => {
    await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "no-host", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, undefined);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_HOST_PID_UNRESOLVED" })]);
  });

  it("creates no state directory for a refused hook when none exists (antigravity R05: unverified hosts leave no state)", async () => {
    fs.rmSync(state, { recursive: true, force: true });
    f.request.mockResolvedValue({ presence: {}, relayId: null, reason: "HOST_UNREPORTED" });
    await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "no-state-yet", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, 424242);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(fs.existsSync(state)).toBe(false);
  });

  it("records a relay that lost its lease (fenced by a newer grant) and releases only its own relay_id", async () => {
    f.request.mockImplementation(async (operation: string) => operation === "relay-tick" ? { alive: false, count: 0, hostBound: false } : {});
    const watch = controlledWatch();
    await runSessionMessageRelay(relayOptions, port, { request: f.request, watch: watch.watch, delay: untilStopped });
    expect(records()).toEqual([{ phase: "run", reason: "RELAY_LEASE_LOST", context: expect.any(Object) }]);
    const release = f.request.mock.calls.find(([operation]) => operation === "release-relay")!;
    expect(release[1]).toMatchObject({ relayId: relayOptions.relayId, instanceId: relayOptions.instanceId, reason: "relay-ended" });
  });

  it("records a relay whose watcher bound another birth than the generation's (the first hostStart tick is refused)", async () => {
    f.request.mockImplementation(async (operation: string, payload: Record<string, unknown>) =>
      operation === "relay-tick" ? (payload.hostStart ? { alive: false, count: 0, hostBound: false } : { alive: true, count: 0, hostBound: false }) : {});
    const watch = controlledWatch("T-other");
    // The first tick runs before the bound settles; the next turn waits for nothing but carries the bound birth.
    let turns = 0;
    await runSessionMessageRelay(relayOptions, port, { request: f.request, watch: watch.watch,
      delay: async (_milliseconds, stop) => { if ((turns += 1) > 2) await stop; } });
    expect(f.request.mock.calls.filter(([operation, payload]) => operation === "relay-tick" && (payload as { hostStart?: string }).hostStart === "T-other")).toHaveLength(1);
    expect(records()).toEqual([{ phase: "run", reason: "RELAY_HOST_BIRTH_MISMATCH", context: expect.any(Object) }]);
  });

  it.each([["GENERATION_CHANGED", 1], ["RELAY_ALIVE", 0], [undefined, 1]] as const)(
    "records a refused verified relay grant (%s) unless its relay is alive", async (grantReason, recorded) => {
      f.request.mockResolvedValue({ spawn: false, relayId: null, instanceId: "host-process-v1:" + "c".repeat(64), ...(grantReason ? { reason: grantReason } : {}) });
      await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "verified-refused", syntheticActor: verifiedRoot }, verifiedHost, 424242, {
        ensureRelay: true, hostProcess: { pid: 424242, startToken: "T1" },
        executionBudget: { deadlineMonotonicMs: performance.now() + 30_000, postClaimReserveMs: 200 } });
      expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["ensure-relay"]);
      expect(f.spawn).not.toHaveBeenCalled();
      expect(records()).toEqual(recorded ? [expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_SPAWN_NOT_GRANTED",
        grantReason: grantReason ?? "UNREPORTED" })] : []);
    });

  it("leaves no record when the relay ends because its host exited, and ends the presence as host-process-ended", async () => {
    f.request.mockImplementation(async (operation: string) => operation === "relay-tick" ? { alive: true, count: 0, hostBound: true } : {});
    const watch = controlledWatch();
    const running = runSessionMessageRelay(relayOptions, port, { request: f.request, watch: watch.watch, delay: untilStopped });
    watch.exit("HOST_PROCESS_ENDED");
    await running;
    expect(records()).toEqual([]);
    const release = f.request.mock.calls.find(([operation]) => operation === "release-relay")!;
    expect(release[1]).toMatchObject({ relayId: relayOptions.relayId, reason: "host-process-ended" });
  });

  it("starts no relay and leaves no record when the store keeps a generation its live relay serves (compact)", async () => {
    f.request.mockImplementation(async (operation: string) => operation === "presence-start" ? { presence: {}, kept: true, relayId: null } : {});
    await handleSessionMessageHook({ hook_event_name: "SessionStart", source: "compact", session_id: "kept-generation", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, 424242);
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });
});
