import {performance} from "node:perf_hooks";
import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({read: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), spawn: vi.fn(), connect: vi.fn()}));
vi.mock("node:tls", () => ({default: {connect: f.connect}}));
vi.mock("node:child_process", async original => ({...await original<typeof import("node:child_process")>(), spawn: f.spawn}));
vi.mock("node:fs/promises", async original => ({...await original<typeof import("node:fs/promises")>(), readFile: f.read, mkdir: f.mkdir, chmod: f.chmod}));

import {runSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {requestSessionMessageOnce, sessionMessageRequest} from "../../mcp-server/src/session-message-client.js";
import {hookFailureContext, hookFailureReason} from "../../mcp-server/src/hook-error-diagnostics.js";

const host = "client-stage-fixture";
registerHookHostAdapter(host, {deliveryProfile: () => ({
  transport: "claude-inbox", capabilities: {supportedInjection: ["tool-boundary"], idleWake: "none"}, blocksEmptyWakePrompt: false,
}), processPid: () => undefined});
const input = JSON.stringify({hook_event_name: "PostToolUse", session_id: "PRIVATE_SESSION", agent_id: "", tool_name: "read_file"});

beforeEach(() => {
  for (const mock of [f.read, f.mkdir, f.chmod, f.spawn, f.connect]) mock.mockReset();
  f.chmod.mockResolvedValue(undefined);
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", "/PRIVATE_STATE");
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", "/PRIVATE_TRUST");
});
afterEach(() => {vi.restoreAllMocks(); vi.unstubAllEnvs();});

describe("AGS-D-0024 client stage failures outside the OS code allowlist", () => {
  it("tags an endpoint read failure on the same native error", async () => {
    const readFailure = Object.assign(new Error("PRIVATE_READ"), {code: "EMFILE"});
    f.read.mockRejectedValue(readFailure);
    const failure = await requestSessionMessageOnce("claim-deferred", {}, "/PRIVATE_STATE", 1000).catch((error: unknown) => error);
    expect(failure).toBe(readFailure);
    expect((failure as {code: string}).code).toBe("EMFILE");
    expect(hookFailureReason(failure)).toBe("BROKER_ENDPOINT_READ_FAILED");
    expect(f.connect).not.toHaveBeenCalled();
  });

  it("tags a state directory failure and keeps the initial ping failure as secondary", async () => {
    const readFailure = Object.assign(new Error("PRIVATE_READ"), {code: "ENOENT"});
    const mkdirFailure = Object.assign(new Error("PRIVATE_MKDIR"), {code: "EROFS"});
    f.read.mockRejectedValue(readFailure);
    f.mkdir.mockRejectedValue(mkdirFailure);
    const failure = await sessionMessageRequest("acknowledge", {}, "/PRIVATE_STATE", {totalTimeoutMs: 1000, noOperationReplay: true})
      .catch((error: unknown) => error);
    expect(failure).toBe(mkdirFailure);
    expect(hookFailureReason(failure)).toBe("BROKER_STATE_DIRECTORY_FAILED");
    expect(hookFailureContext(failure).secondary).toEqual(expect.arrayContaining([
      expect.objectContaining({producerReason: "BROKER_ENDPOINT_READ_FAILED"})]));
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("reports the producer stage through the actual hook instead of UNEXPECTED_FAILURE", async () => {
    f.read.mockRejectedValue(Object.assign(new Error("PRIVATE_READ"), {code: "ENOENT"}));
    f.mkdir.mockRejectedValue(Object.assign(new Error("PRIVATE_MKDIR"), {code: "EROFS"}));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const options = {executionBudget: {deadlineMonotonicMs: performance.now() + 5000, postClaimReserveMs: 100}};
    expect(await runSessionMessageHook(host, input, undefined, options)).toBe("");
    const line = spy.mock.calls.map((args: unknown[]) => args[0])
      .find((value: unknown): value is string => typeof value === "string" && value.includes("peer-hook-failure "));
    if (typeof line !== "string") throw new Error("Expected hook failure diagnostic");
    expect(line).not.toContain("PRIVATE_");
    const value = JSON.parse(line.slice(line.indexOf("{")));
    expect(value).toMatchObject({phase: "handle", reason: "BROKER_STATE_DIRECTORY_FAILED", reasonBasis: "producer",
      producerReason: "BROKER_STATE_DIRECTORY_FAILED"});
    expect(f.spawn).not.toHaveBeenCalled();
  });
});
