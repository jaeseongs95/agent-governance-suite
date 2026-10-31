import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { ActorObservation } from "../../mcp-server/src/input-observation.js";
import { performance } from "node:perf_hooks";
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
  deliveryProfile: () => ({ transport: "gemini-queue", capabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, blocksEmptyWakePrompt: false }),
  processPid: (pid, observation) => observation ? pid : undefined,
});
const verifiedRoot: ActorObservation = { role: "root", basis: "observed", reasonCode: "SYNTHETIC_D0354_ROOT" };

// D0354: a generation whose relay never started or ended early must leave a local record with a fixed reason.
// Hosts may discard hook stderr, so the stderr line alone left "registered, no heartbeat" sessions unexplained.
const port: WakeDispatchPort = { capabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" }, dispatch: async () => "definite-failure" };
const relayOptions = { host: "synthetic-host", sessionId: "relay-d0354", instanceId: "instance-1",
  transport: "codex-deferred", parentPid: 424242, parentStartToken: "T1" };
const SECRET = "secret-canary-d0354";
let root: string;
let state: string;

function records(): Array<Record<string, unknown>> {
  const history = path.join(state, "relay-failures");
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history).map(name => JSON.parse(fs.readFileSync(path.join(history, name), "utf8")) as Record<string, unknown>);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0354-"));
  state = path.join(root, "state");
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  for (const mock of Object.values(f)) mock.mockReset();
  f.token.mockReturnValue("T1"); f.identity.mockReturnValue("match"); f.exists.mockReturnValue(true);
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D0354 relay start and end records", () => {
  it("records an unreadable host birth with the identity query diagnostic and starts no relay", async () => {
    const diagnostic = { stage: "windows-query", elapsedMs: 5016, timeoutMs: 5000, nativeCode: "ETIMEDOUT", status: null, signal: "SIGTERM", stderrIndication: null };
    f.token.mockImplementation((_pid: number, _platform: string, _timeout: number | undefined, onFailure?: (cause: unknown, value: unknown) => void) => {
      onFailure?.(new Error(SECRET), diagnostic);
      return null;
    });
    f.request.mockResolvedValue({});
    await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "unreadable-birth", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, 424242);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_HOST_START_UNREADABLE", identity: diagnostic })]);
    expect(JSON.stringify(records())).not.toContain(SECRET);
  });

  it("records a relay that lost its lease while its parent no longer matches", async () => {
    f.request.mockImplementation(async (operation: string) => {
      if (operation === "acquire-relay") return { acquired: true };
      if (operation === "relay-tick") return { alive: false, count: 0 };
      return {};
    });
    f.identity.mockReturnValueOnce("match").mockReturnValue("mismatch");
    await runSessionMessageRelay(relayOptions, port);
    expect(records()).toEqual([{ phase: "run", reason: "RELAY_LEASE_LOST_PARENT_MISMATCH", context: expect.any(Object) }]);
  });

  it("records a relay whose lease could not be re-acquired", async () => {
    f.request.mockImplementation(async (operation: string) => {
      if (operation === "acquire-relay") return { acquired: f.request.mock.calls.filter(([name]) => name === "acquire-relay").length === 1 };
      if (operation === "relay-tick") return { alive: false, count: 0 };
      return {};
    });
    await runSessionMessageRelay(relayOptions, port);
    expect(records()).toEqual([{ phase: "run", reason: "RELAY_LEASE_LOST_REACQUIRE_REFUSED", context: expect.any(Object) }]);
  });

  it.each([["RELAY_GRANT_UNCONFIRMED", 1], ["RELAY_ALIVE", 0], [undefined, 1]] as const)(
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

  it("leaves no record when the relay ends because its parent exited", async () => {
    f.exists.mockReturnValue(false);
    f.request.mockImplementation(async (operation: string) => operation === "acquire-relay" ? { acquired: true } : {});
    await runSessionMessageRelay(relayOptions, port);
    expect(records()).toEqual([]);
  });

  it("starts no relay and leaves no record when the broker keeps a generation its live relay serves (compact)", async () => {
    f.request.mockImplementation(async (operation: string) => operation === "presence-start" ? { presence: {}, kept: true } : {});
    await handleSessionMessageHook({ hook_event_name: "SessionStart", source: "compact", session_id: "kept-generation", syntheticActor: "root" }, syntheticCore.SYNTHETIC_CORE_HOST, 424242);
    expect(f.request.mock.calls.map(([operation]) => operation)).toContain("presence-start");
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([]);
  });
});
