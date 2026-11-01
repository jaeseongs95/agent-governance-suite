import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn(), execFile: vi.fn() }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn, execFile: f.execFile }));
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

// D0353 (Windows, ported from cf81921c): Codex runs hook commands through PowerShell and waits for EOF on the hook's
// output pipes. PowerShell hands the hook its inherited host pipe handles as inheritable handles, and node's spawn passes
// them to the detached relay, so Codex timed the hook out after 10 s and terminated the hook's job with the relay in it.
// There is no broker process any more (docs/ags30-broker-redesign.md), so only the relay launch is isolated.
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const relayId = "0b7f6c1e-5d3a-4c8e-9f21-7a6b5c4d3e2f";
let root: string;
let state: string;

function records(): Array<Record<string, unknown>> {
  const history = path.join(state, "relay-failures");
  if (!fs.existsSync(history)) return [];
  return fs.readdirSync(history).map(name => JSON.parse(fs.readFileSync(path.join(history, name), "utf8")) as Record<string, unknown>);
}

async function startSession(sessionId: string, isolateDetachedHandles?: boolean) {
  await handleSessionMessageHook({ hook_event_name: "SessionStart", session_id: sessionId, syntheticActor: "root" },
    syntheticCore.SYNTHETIC_CORE_HOST, 424242, isolateDetachedHandles === undefined ? {} : { isolateDetachedHandles });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ags-d0353-win-"));
  state = path.join(root, "state");
  fs.mkdirSync(state, { recursive: true });
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  for (const mock of Object.values(f)) mock.mockReset();
  // The hook starts a relay only for the relay_id its presence-start grant returned.
  f.request.mockImplementation(async (operation: string) => operation === "presence-start" ? { presence: {}, relayId } : {});
  f.spawn.mockImplementation(() => ({ once: vi.fn(), unref: vi.fn() }));
  vi.spyOn(console, "error").mockImplementation(() => {});
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("D0353 Windows relay launch without the hook's handles", () => {
  it("starts the detached relay through ShellExecute with its parent-liveness arguments intact", async () => {
    await startSession("a b\"c\\", true);
    expect(f.spawn).not.toHaveBeenCalled();
    expect(f.execFile).toHaveBeenCalledTimes(1);
    const [executable, args, options, done] = f.execFile.mock.calls[0] as [string, string[], Record<string, unknown>, (error: unknown, stdout: string) => void];
    expect(executable).toMatch(/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/u);
    const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
    // Start-Process without -NoNewWindow or redirection is ShellExecuteEx, which inherits no handles.
    expect(script).toMatch(/^\$p = Start-Process -FilePath '[^']+' -ArgumentList '.+' -WindowStyle Hidden -PassThru; /u);
    expect(script).not.toMatch(/-NoNewWindow|-Redirect/u);
    expect(script).toContain("--session-id \"a b\\\"c\\\\\" ");
    expect(script).toContain(`--parent-pid 424242 --relay-id ${relayId}`);
    expect(options).toMatchObject({ windowsHide: true, timeout: 5000, env: expect.objectContaining({ AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state }) });
    done(null, "5150");
    expect(records()).toEqual([]);

    await startSession("not-isolated");
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.execFile).toHaveBeenCalledTimes(1);
  });

  it("records a launcher that ends without a relay process as a relay that was not started", async () => {
    await startSession("launcher-failed", true);
    const done = f.execFile.mock.calls[0]![3] as (error: unknown, stdout: string) => void;
    done(Object.assign(new Error("launcher exited"), { code: 1, signal: null }), "");
    expect(records()).toEqual([expect.objectContaining({ phase: "hook-relay-start", reason: "RELAY_LAUNCHER_FAILED", exitCode: 1, signal: null })]);
  });
});
