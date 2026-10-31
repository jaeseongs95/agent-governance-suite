import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), token: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: f.token,
}));
import { handleSessionMessageHook, runSessionMessageHookOutcome } from "../../mcp-server/src/session-message-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const host = syntheticCore.SYNTHETIC_CORE_HOST;

// D0011: the detached relay child runs with ignored stdio, so a relay that dies early must leave a local record.
// Mocked broker/process fixture only; the child is an EventEmitter and no real process is started.
const SECRET = "secret-canary-d0011";
let root: string;
let state: string;
let stderr: { mock: { calls: unknown[][] } };

function records(): Array<Record<string, unknown>> {
  const history = path.join(state, "relay-failures");
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history).map(name => JSON.parse(fs.readFileSync(path.join(history, name), "utf8")) as Record<string, unknown>);
}

function hookFailureLines(): Array<Record<string, unknown>> {
  const prefix = "[agent-governance-suite] peer-hook-failure ";
  return stderr.mock.calls.map(([line]: unknown[]) => line)
    .filter((line: unknown): line is string => typeof line === "string" && line.startsWith(prefix))
    .map((line: string) => JSON.parse(line.slice(prefix.length)) as Record<string, unknown>);
}

function relayChild(): EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> } {
  return Object.assign(new EventEmitter(), { pid: 515151, unref: vi.fn() });
}

async function startSession(sessionId: string): Promise<EventEmitter & { pid: number; unref: ReturnType<typeof vi.fn> }> {
  const child = relayChild();
  f.spawn.mockReturnValue(child);
  f.request.mockResolvedValue({});
  expect(await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: sessionId, syntheticActor: "root" }, host, 424242)).toEqual({});
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
  expect(f.spawn).toHaveBeenCalledTimes(1);
  // The healthy relay stays detached, unreferenced and without inherited stdio; observing its exit does not change that.
  expect(f.spawn.mock.calls[0]![2]).toMatchObject({ detached: true, stdio: "ignore", windowsHide: true });
  expect(child.unref).toHaveBeenCalledTimes(1);
  return child;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0011-"));
  state = path.join(root, "state");
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  // A running broker has created the state directory; hook records are written only into an existing one.
  fs.mkdirSync(state, { recursive: true });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGS_D0011_ENVIRONMENT_CANARY", SECRET);
  for (const mock of Object.values(f)) mock.mockReset();
  f.token.mockReturnValue("T1");
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D0011 relay child diagnostics", () => {
  it.each([
    [2, null],
    [1, null],
    [null, "SIGKILL"],
  ] as const)("records a spawned relay child that exits abnormally (code %s, signal %s)", async (exitCode, signal) => {
    const child = await startSession("relay-child-exit");
    expect(records()).toEqual([]);
    child.emit("spawn");
    child.emit("exit", exitCode, signal);
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_CHILD_EXITED",
      reasonBasis: "producer", exitCode, signal })]);
    expect(hookFailureLines()).toEqual([expect.objectContaining({ phase: "relay-start", reason: "RELAY_CHILD_EXITED" })]);
    // Only the exit status is recorded: never the environment, argv or child output.
    expect(JSON.stringify(records())).not.toContain(SECRET);
    expect(JSON.stringify(records())).not.toContain("relay-child-exit");
  });

  it("records nothing for a normal relay end or an exit without a confirmed spawn", async () => {
    const normal = await startSession("relay-child-normal-end");
    normal.emit("spawn");
    normal.emit("exit", 0, null);
    expect(records()).toEqual([]);
    f.spawn.mockReset();
    f.request.mockReset();
    const unspawned = await startSession("relay-child-unspawned");
    unspawned.emit("exit", 1, null);
    expect(records()).toEqual([]);
    expect(hookFailureLines()).toEqual([]);
  });

  it("records rejected relay arguments from the relay entrypoint itself", async () => {
    const argv = process.argv;
    const exitCode = process.exitCode;
    process.argv = [process.execPath, "session-message-relay.mjs", "--host", host, "--session-id", "rejected-arguments"];
    try {
      await import("../../mcp-server/src/session-message-relay-cli.js");
      expect(process.exitCode).toBe(2);
    } finally {
      process.argv = argv;
      process.exitCode = exitCode;
    }
    expect(records()).toEqual([{ phase: "arguments", reason: "RELAY_ARGUMENTS_REJECTED", context: expect.any(Object) }]);
    expect(JSON.stringify(records())).not.toContain("rejected-arguments");
    expect(f.request).not.toHaveBeenCalled();
  });

  it("records a failed presence start and starts no relay", async () => {
    f.request.mockRejectedValue(Object.assign(new Error(SECRET), { code: "ECONNREFUSED" }));
    expect(await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: "presence-start-failed", syntheticActor: "root" }, host, 424242)).toEqual({});
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-presence-start", reason: "ECONNREFUSED",
      reasonBasis: "unverified-observation", context: expect.any(Object) })]);
    expect(hookFailureLines()).toEqual([expect.objectContaining({ phase: "presence-start", reason: "ECONNREFUSED" })]);
    expect(JSON.stringify(records())).not.toContain(SECRET);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(SECRET);
  });

  it("reports a failed turn-end clear-deferred as a local peer-hook-failure line and stays fail-open", async () => {
    f.request.mockRejectedValue(Object.assign(new Error(SECRET), { code: "ETIMEDOUT" }));
    const outcome = await runSessionMessageHookOutcome(host, JSON.stringify({ hook_event_name: "Stop", session_id: "clear-deferred-failed", syntheticActor: "root" }), 424242);
    expect(outcome).toEqual({ ok: false, output: "", failure: expect.objectContaining({ phase: "handle", reason: "ETIMEDOUT" }) });
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["clear-deferred"]);
    expect(hookFailureLines()).toEqual([expect.objectContaining({ phase: "handle", reason: "ETIMEDOUT", reasonBasis: "unverified-observation" })]);
    expect(JSON.stringify(stderr.mock.calls)).not.toContain(SECRET);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
