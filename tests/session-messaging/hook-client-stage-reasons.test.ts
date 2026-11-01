import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {DatabaseSync} from "node:sqlite";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

// Only directory creation for the PRIVATE_ fixture path is replaced; every other path reaches the real file system.
const f = vi.hoisted(() => ({mkdir: vi.fn(), privateRoot: ""}));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const mkdirSync = (...args: Parameters<typeof actual.mkdirSync>) => {
    if (f.privateRoot && String(args[0]).startsWith(f.privateRoot)) return f.mkdir(...args) as ReturnType<typeof actual.mkdirSync>;
    return actual.mkdirSync(...args);
  };
  return {...actual, default: {...actual, mkdirSync}, mkdirSync};
});

import {runSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {adaptHostInput, registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {closeSessionMessaging, runSessionMessageOperation, sessionMessageRequest} from "../../mcp-server/src/session-message-client.js";
import {hookFailureContext, hookFailureReason} from "../../mcp-server/src/hook-error-diagnostics.js";

const host = "client-stage-fixture";
registerHookHostAdapter(host, {
  adaptInput: (input, selectedHost) => {
    const adapted = adaptHostInput(input, "codex");
    return {...adapted, observation: {...adapted.observation, host: selectedHost,
      actor: {role: "root" as const, basis: "observed" as const, reasonCode: "SYNTHETIC_CORE_ROOT"}}};
  },
  deliveryProfile: () => ({
    transport: "claude-inbox", capabilities: {supportedInjection: ["tool-boundary"], idleWake: "none"}, blocksEmptyWakePrompt: false,
  }), processPid: () => undefined});
const input = JSON.stringify({hook_event_name: "PostToolUse", session_id: "PRIVATE_SESSION", agent_id: "", tool_name: "read_file"});
const privateState = path.resolve("/PRIVATE_STATE");
const directories: string[] = [];

beforeEach(() => {
  f.mkdir.mockReset();
  f.privateRoot = privateState;
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", privateState);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.resolve("/PRIVATE_TRUST"));
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    closeSessionMessaging(directory);
    rmSync(directory, {recursive: true, force: true});
  }
  closeSessionMessaging(privateState);
});

function stateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-client-stage-"));
  directories.push(directory);
  return directory;
}

describe("AGS-D-0024 in-process messaging stage failures outside the OS code allowlist", () => {
  it("tags a state directory failure and keeps the native cause only as a bounded fingerprint", async () => {
    const mkdirFailure = Object.assign(new Error("PRIVATE_MKDIR"), {code: "EROFS"});
    f.mkdir.mockImplementation(() => { throw mkdirFailure; });
    const failure = await sessionMessageRequest("acknowledge", {}, privateState, {totalTimeoutMs: 1000}).catch((error: unknown) => error);
    expect(hookFailureReason(failure)).toBe("MESSAGING_STATE_DIRECTORY_FAILED");
    expect(JSON.stringify(hookFailureContext(failure))).not.toContain("PRIVATE_");
    expect(f.mkdir).toHaveBeenCalledTimes(1);
  });

  it("tags a caller state preparation failure before anything is opened", async () => {
    const prepared = Object.assign(new Error("PRIVATE_PREPARE"), {code: "EACCES"});
    const failure = await sessionMessageRequest("acknowledge", {}, privateState,
      {prepareStateDirectory: async () => { throw prepared; }}).catch((error: unknown) => error);
    expect(hookFailureReason(failure)).toBe("MESSAGING_STATE_DIRECTORY_FAILED");
    expect(f.mkdir).not.toHaveBeenCalled();
  });

  it("refuses an expired same-process deadline without opening the store", async () => {
    const failure = await sessionMessageRequest("claim-deferred", {target: {host, sessionId: "s"}}, privateState,
      {deadlineMonotonicMs: performance.now() - 1}).catch((error: unknown) => error);
    expect(hookFailureReason(failure)).toBe("BROKER_DEADLINE_EXPIRED");
    expect(f.mkdir).not.toHaveBeenCalled();
  });

  it("reports another connection's writer lock as MESSAGING_BUSY with nothing written, then succeeds after it commits", () => {
    const directory = stateDirectory();
    const sender = {host, sessionId: "busy-sender"}, target = {host, sessionId: "busy-target"};
    // Creates the schema without contention; the lock below then only competes with the operation itself.
    expect(runSessionMessageOperation("pending", {target}, directory)).toEqual({count: 0});
    const holder = new DatabaseSync(path.join(directory, "session-messages.sqlite3"));
    try {
      holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
      let failure: unknown;
      try { runSessionMessageOperation("prepare", {sender, target, body: "PRIVATE_BODY"}, directory, {busyTimeoutMs: 0}); }
      catch (error) { failure = error; }
      expect(hookFailureReason(failure)).toBe("MESSAGING_BUSY");
      expect(JSON.stringify(hookFailureContext(failure))).not.toContain("PRIVATE_");
      expect(holder.prepare("SELECT count(*) AS count FROM prepared_messages").get()).toEqual({count: 0});
      holder.exec("COMMIT");
    } finally { holder.close(); }
    const prepared = runSessionMessageOperation<{messageId: string}>("prepare", {sender, target, body: "after commit"}, directory, {busyTimeoutMs: 0});
    expect(typeof prepared.messageId).toBe("string");
  });

  it("reports the producer stage through the actual hook instead of UNEXPECTED_FAILURE", async () => {
    f.mkdir.mockImplementation(() => { throw Object.assign(new Error("PRIVATE_MKDIR"), {code: "EROFS"}); });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const options = {executionBudget: {deadlineMonotonicMs: performance.now() + 5000, postClaimReserveMs: 100}};
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    const line = spy.mock.calls.map((args: unknown[]) => args[0])
      .find((value: unknown): value is string => typeof value === "string" && value.includes("peer-hook-failure "));
    if (typeof line !== "string") throw new Error("Expected hook failure diagnostic");
    expect(line).not.toContain("PRIVATE_");
    const value = JSON.parse(line.slice(line.indexOf("{")));
    expect(value).toMatchObject({phase: "handle", reason: "MESSAGING_STATE_DIRECTORY_FAILED", reasonBasis: "producer",
      producerReason: "MESSAGING_STATE_DIRECTORY_FAILED"});
  });
});
