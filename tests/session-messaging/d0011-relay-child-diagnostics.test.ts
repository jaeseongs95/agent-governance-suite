import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
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
// The hook cases use a mocked messaging request and an EventEmitter child; the guard cases run real node processes.
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
  f.request.mockResolvedValue({ relayId: "22222222-2222-4222-8222-222222222222" });
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
  // Messaging has created the state directory; hook records are written only into an existing one.
  fs.mkdirSync(state, { recursive: true });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGS_D0011_ENVIRONMENT_CANARY", SECRET);
  for (const mock of Object.values(f)) mock.mockReset();
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D0011 relay child diagnostics", () => {
  it("preloads the exit guard into the relay process instead of watching the child from the hook", async () => {
    const child = await startSession("relay-child-guarded");
    const args = f.spawn.mock.calls[0]![1] as string[];
    expect(args.slice(0, 2)).toEqual(["--import", expect.stringMatching(/^file:\/\/.*\/session-message-relay-guard\.mjs$/u)]);
    expect(args[2]).toMatch(/[\\/]session-message-relay\.mjs$/u);
    expect(args[args.indexOf("--relay-id") + 1]).toBe("22222222-2222-4222-8222-222222222222");
    // The hook may exit before its relay (CI 5d210919, TEST codex-d0011-r02: relay ppid 1), so it records nothing itself.
    child.emit("spawn");
    child.emit("exit", 3, null);
    expect(records()).toEqual([]);
    expect(hookFailureLines()).toEqual([]);
  });

  describe("relay exit guard in a real relay process", () => {
    const guard = new URL("../../mcp-server/dist/session-message-relay-guard.mjs", import.meta.url).href;
    // No parent listens: the spawning test only waits for the end, and every record comes from the child itself.
    function runGuarded(entry: string, args: string[] = []): number | null {
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.NODE_OPTIONS;
      const result = spawnSync(process.execPath, ["--import", guard, entry, ...args], { env, stdio: "ignore", windowsHide: true, timeout: 20_000 });
      return result.status;
    }
    function entry(name: string, source: string): string {
      const file = path.join(root, name);
      fs.writeFileSync(file, source);
      return file;
    }

    it.each([
      ["an early non-zero exit", "exit-three.mjs", "process.exit(3);\n", 3],
      ["an entry that fails to load", "syntax-error.mjs", "export const = ;\n", 1],
      ["an uncaught startup throw", "throws.mjs", `throw new Error(${JSON.stringify(SECRET)});\n`, 1],
    ] as const)("records %s with its exit code only", (_label, name, source, exitCode) => {
      expect(runGuarded(entry(name, source))).toBe(exitCode);
      expect(records()).toEqual([{ phase: "relay-exit", reason: "RELAY_PROCESS_EXITED", reasonBasis: "producer", exitCode }]);
      const latest = fs.readFileSync(path.join(state, "relay-failure.latest.json"), "utf8");
      expect(JSON.parse(latest)).toEqual({ phase: "relay-exit", reason: "RELAY_PROCESS_EXITED", reasonBasis: "producer", exitCode });
      // Never the environment, the entry path or child output.
      expect(JSON.stringify(records()) + latest).not.toContain(SECRET);
      expect(JSON.stringify(records()) + latest).not.toContain(name);
    });

    it("records nothing for a relay process that ends normally", () => {
      expect(runGuarded(entry("normal.mjs", "\n"))).toBe(0);
      expect(records()).toEqual([]);
    });

    it("keeps the packaged relay's own cause next to its exit code", () => {
      const relay = fileURLToPath(new URL("../../mcp-server/dist/session-message-relay.mjs", import.meta.url));
      expect(runGuarded(relay, ["--host", host, "--session-id", "guarded-rejected-arguments"])).toBe(2);
      expect(records()).toEqual(expect.arrayContaining([
        expect.objectContaining({ phase: "arguments", reason: "RELAY_ARGUMENTS_REJECTED" }),
        { phase: "relay-exit", reason: "RELAY_PROCESS_EXITED", reasonBasis: "producer", exitCode: 2 },
      ]));
      expect(records()).toHaveLength(2);
      expect(JSON.stringify(records())).not.toContain("guarded-rejected-arguments");
    });
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
