import { EventEmitter } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  now: 100, request: vi.fn(), token: vi.fn(), spawn: vi.fn(), exec: vi.fn(), connect: vi.fn(),
  open: vi.fn(), record: vi.fn(), verify: vi.fn(), close: vi.fn(), wake: vi.fn(), read: vi.fn(), mkdir: vi.fn(), chmod: vi.fn(), exists: vi.fn(),
}));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => f.now } }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn, execFileSync: f.exec }));
vi.mock("node:tls", () => ({ default: { connect: f.connect } }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), existsSync: f.exists }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), readFile: f.read, mkdir: f.mkdir, chmod: f.chmod }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: f.token,
}));
vi.mock("../../mcp-server/src/trust-store.js", () => ({ TrustStore: class {
  constructor(...args: unknown[]) { f.open(...args); }
  recordInputSource(...args: unknown[]) { return f.record(...args); }
  verify(...args: unknown[]) { return f.verify(...args); }
  close() { return f.close(); }
} }));
vi.mock("../../mcp-server/src/session-message-wake-port.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-wake-port.js")>(), recordWakeHookObservation: f.wake,
}));

import { handleSessionMessageHook, runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { requestSessionMessageOnce, sessionMessageRequest as mockedRequest } from "../../mcp-server/src/session-message-client.js";
import { SESSION_MESSAGE_PROTOCOL } from "../../mcp-server/src/session-message-protocol.js";

const budget = () => ({ deadlineMonotonicMs: 1000, postClaimReserveMs: 200 });
const input = { hook_event_name: "Stop", session_id: "budget-target", agent_id: "" };
const start = { ...input, hook_event_name: "SessionStart" };
const message = {
  messageId: "synthetic-issued-id", sender: { host: "claude-code", sessionId: "sender" },
  recipient: { host: "claude-code", sessionId: "budget-target" }, body: "Synthetic peer body",
  createdAt: "2026-10-22T00:00:00.000Z", expiresAt: "2026-10-22T01:00:00.000Z",
  deliveryAttempt: 1, firstDeliveredAt: "2026-10-22T00:00:01.000Z",
};
beforeEach(() => {
  for (const mock of [f.request, f.token, f.spawn, f.exec, f.connect, f.open, f.record, f.verify, f.close, f.wake, f.read, f.mkdir, f.chmod, f.exists]) mock.mockReset();
  f.mkdir.mockResolvedValue(undefined); f.chmod.mockResolvedValue(undefined);
  f.exists.mockReturnValue(true);
  f.now = 100;
  f.token.mockReturnValue("T1"); f.spawn.mockReturnValue({ unref: vi.fn() });
  f.record.mockReturnValue({ receiptId: "source-synthetic" }); f.verify.mockReturnValue(true);
  f.request.mockImplementation(async (_operation, _payload, _directory, options) => {
    options?.onOperationWrite?.(); return { messages: [message] };
  });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it.each([
  { deadlineMonotonicMs: NaN, postClaimReserveMs: 0 },
  { deadlineMonotonicMs: Infinity, postClaimReserveMs: 0 },
  { deadlineMonotonicMs: 1000, postClaimReserveMs: -1 },
  { deadlineMonotonicMs: 1000, postClaimReserveMs: NaN },
  { deadlineMonotonicMs: 100, postClaimReserveMs: 0 },
])("invalid or expired budget is fail-open with no request or provenance effect: %j", async (executionBudget) => {
  expect(await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget })).toBe("");
  expect(f.request).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it("cannot begin a claim using its reserved postclaim time", async () => {
  const onClaimState = vi.fn();
  expect(await runSessionMessageHook("claude-code", JSON.stringify(input), undefined,
    { executionBudget: { deadlineMonotonicMs: 300, postClaimReserveMs: 200 }, onClaimState })).toBe("");
  expect(f.request).not.toHaveBeenCalled(); expect(onClaimState).not.toHaveBeenCalled();
});

it("uses one absolute claim deadline and observes immutable IDs before receipt/output work", async () => {
  const phases: string[] = [];
  const observations: { frozen: boolean; idsFrozen: boolean; ids: readonly string[]; keys: string[]; openCalls: number }[] = [];
  const onClaimState = vi.fn((state) => {
    phases.push(state.phase);
    observations.push({ frozen: Object.isFrozen(state), idsFrozen: Object.isFrozen(state.messageIds), ids: [...state.messageIds], keys: Object.keys(state).sort(), openCalls: f.open.mock.calls.length });
  });
  const output = await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget(), onClaimState });
  expect(phases).toEqual(["request-attempted", "response-received"]);
  expect(observations).toEqual([
    { frozen: true, idsFrozen: true, ids: [], keys: ["messageIds", "phase"], openCalls: 0 },
    { frozen: true, idsFrozen: true, ids: [message.messageId], keys: ["messageIds", "phase"], openCalls: 0 },
  ]);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![3]).toMatchObject({ totalTimeoutMs: 8000, deadlineMonotonicMs: 800, noOperationReplay: true });
  expect(f.open.mock.calls[0]!.slice(1)).toEqual([undefined, { busyTimeoutMs: 0 }]);
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(JSON.parse(output).hookSpecificOutput.additionalContext).toContain(message.body);
  expect(f.request.mock.calls.some(([operation]) => operation === "ack")).toBe(false);
});

it("empty success is still a received response and opens no receipt database", async () => {
  const onClaimState = vi.fn();
  f.request.mockImplementationOnce(async (_op, _payload, _directory, options) => {
    options.onOperationWrite(); return { messages: [] };
  });
  expect(await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget(), onClaimState })).toBe("");
  expect(onClaimState.mock.calls.map(([state]) => state)).toEqual([
    { phase: "request-attempted", messageIds: [] }, { phase: "response-received", messageIds: [] },
  ]);
  expect(f.open).not.toHaveBeenCalled();
});

it.each(["record", "verify", "expiry-after-open", "expiry-after-record", "expiry-after-verify"])("closes the receipt store after %s while retaining the received IDs", async (failure) => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const onClaimState = vi.fn();
  if (failure === "record") f.record.mockImplementationOnce(() => { throw new Error("record failed"); });
  if (failure === "verify") f.verify.mockReturnValueOnce(false);
  if (failure === "expiry-after-open") f.open.mockImplementationOnce(() => { f.now = 1000; });
  if (failure === "expiry-after-record") f.record.mockImplementationOnce(() => { f.now = 1000; return { receiptId: "source" }; });
  if (failure === "expiry-after-verify") f.verify.mockImplementationOnce(() => { f.now = 1000; return true; });
  expect(await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget(), onClaimState })).toBe("");
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(onClaimState.mock.lastCall?.[0]).toEqual({ phase: "response-received", messageIds: [message.messageId] });
  if (failure === "verify") expect(diagnostic.mock.calls[0]![0]).toContain("PEER_RECEIPT_VERIFICATION_FAILED");
});

it.each(["throw", "reject"])("observer %s cannot cause replay or lose cleanup", async (failure) => {
  const onClaimState = vi.fn(() => {
    if (failure === "throw") throw new Error("observer failed");
    return Promise.reject(new Error("observer rejected"));
  });
  const output = await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget(), onClaimState });
  expect(output).toContain("source-synthetic"); expect(f.request).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
  await Promise.resolve();
});

it("snapshots the budget and T1 before an await, then refuses relay spawn after expiry", async () => {
  const executionBudget = budget();
  const hostProcess = { pid: 424242, startToken: "T1" };
  f.request.mockImplementationOnce(async () => {
    executionBudget.deadlineMonotonicMs = 9000; hostProcess.startToken = "T2"; f.now = 1000; return {};
  });
  expect(await runSessionMessageHook("gemini", JSON.stringify(start), 424242, { executionBudget, hostProcess })).toBe("");
  expect(f.token).toHaveBeenCalledWith(424242, process.platform, 900); expect(f.spawn).not.toHaveBeenCalled();
});

it("synchronous observer reentry cannot start another hook claim", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  const nested: Promise<string>[] = [];
  const onClaimState = () => { nested.push(runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget() })); };
  const output = await runSessionMessageHook("claude-code", JSON.stringify(input), undefined, { executionBudget: budget(), onClaimState });
  expect(output).toContain("source-synthetic");
  expect(await Promise.all(nested)).toEqual(["", ""]);
  expect(diagnostic.mock.calls.map(([line]) => line)).toHaveLength(2);
  for (const [line] of diagnostic.mock.calls) expect(line).toContain("CLAIM_OBSERVER_REENTRY");
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalledTimes(1);
});

it("rejects unsupported budgeted peer wake before recording its source", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "1");
  const wake = { hook_event_name: "UserPromptSubmit", session_id: "budget-target", prompt: "[agent-governance-suite:wake:abcdefghijklmnopqrstuvwxyz]" };
  expect(await runSessionMessageHook("codex", JSON.stringify(wake), undefined, { executionBudget: budget() })).toBe("");
  expect(f.wake).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
  expect(diagnostic.mock.calls[0]![0]).toContain("BUDGETED_PEER_WAKE_UNSUPPORTED");
});

it.each(["envelope", "output"])("checks actual time after %s serialization, preserving cleanup and phase", async (stage) => {
  const stringify = JSON.stringify;
  const onClaimState = vi.fn();
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    const serialized = stringify(value, replacer, space);
    if (value && typeof value === "object" && (stage === "output" ? "hookSpecificOutput" in value : "messageEncoding" in value)) f.now = 1000;
    return serialized;
  });
  expect(await runSessionMessageHook("claude-code", stringify(input), undefined, { executionBudget: budget(), onClaimState })).toBe("");
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(onClaimState.mock.lastCall?.[0].phase).toBe("response-received");
});

it("keeps no-options request and standalone receipt defaults unchanged", async () => {
  await handleSessionMessageHook(input, "claude-code");
  expect(mockedRequest).toHaveBeenCalledWith("claim-turn-end", expect.any(Object), undefined, { totalTimeoutMs: 8000 });
  expect(f.open.mock.calls[0]).toHaveLength(1);
});

it.each(["win32", "darwin"] as const)("clips the actual %s token subprocess leaf and preserves the old cap", async (platform) => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/process-identity.js")>("../../mcp-server/src/process-identity.js");
  f.exec.mockReturnValue("T1\n");
  expect(actual.processStartToken(424242, platform, 17.9)).toBe("T1");
  expect(f.exec.mock.calls[0]![2]).toMatchObject({ timeout: 17 });
  f.exec.mockClear(); actual.processStartToken(424242, platform);
  expect(f.exec.mock.calls[0]![2]).toMatchObject({ timeout: platform === "win32" ? 5000 : 3000 });
  f.exec.mockClear(); expect(actual.processStartToken(424242, platform, 0)).toBeNull(); expect(f.exec).not.toHaveBeenCalled();
});

const fingerprint = Array(32).fill("AA").join(":");
function fakeSocket() {
  return Object.assign(new EventEmitter(), {
    getPeerCertificate: vi.fn(() => ({ fingerprint256: fingerprint })), write: vi.fn((frame: string) => { void frame; return true; }), destroy: vi.fn(),
  });
}
function stubEndpoint() {
  f.read.mockImplementation(async (name: string) => name.endsWith("endpoint.json")
    ? JSON.stringify({ protocolVersion: SESSION_MESSAGE_PROTOCOL, address: "127.0.0.1", port: 12345, certificateFingerprint256: fingerprint })
    : name.endsWith("broker.token") ? "a".repeat(43) : "synthetic certificate");
}
async function connecting() {
  const socket = fakeSocket(); f.connect.mockReturnValue(socket);
  stubEndpoint();
  const onOperationWrite = vi.fn();
  const pending = requestSessionMessageOnce("claim", {}, "synthetic-state", 500, undefined, { enforceDeadline: true, onOperationWrite });
  // Attach a rejection handler before deliberately emitting a failing event.
  const settled = pending.then((value) => ({ value, error: undefined }), (error: Error) => ({ value: undefined, error }));
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
  return { socket, onOperationWrite, settled };
}

it("a delayed secureConnect cannot write even before the expiry timer gets its event-loop turn", async () => {
  const { socket, onOperationWrite, settled } = await connecting();
  f.now = 600; socket.emit("secureConnect");
  expect((await settled).error).toBeInstanceOf(Error);
  expect(socket.write).not.toHaveBeenCalled(); expect(onOperationWrite).not.toHaveBeenCalled(); expect(socket.destroy).toHaveBeenCalledTimes(1);
});

it("expired prepare ping cannot start state-directory effects or the target operation", async () => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  stubEndpoint();
  const socket = fakeSocket(); f.connect.mockReturnValue(socket);
  const prepareStateDirectory = vi.fn(); const onOperationWrite = vi.fn();
  const pending = actual.sessionMessageRequest("claim", {}, "synthetic-state", {
    totalTimeoutMs: 500, deadlineMonotonicMs: 600, noOperationReplay: true, prepareStateDirectory, onOperationWrite,
  });
  const settled = pending.then(() => undefined, (error: Error) => error);
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
  socket.emit("secureConnect"); f.now = 600; socket.emit("data", Buffer.from("invalid-json\n"));
  expect(await settled).toBeInstanceOf(Error);
  expect(prepareStateDirectory).not.toHaveBeenCalled(); expect(onOperationWrite).not.toHaveBeenCalled();
  expect(socket.write).toHaveBeenCalledTimes(1);
  expect(JSON.parse(socket.write.mock.calls[0]![0]).operation).toBe("ping");
});

it("the socket still caps a larger caller timeout at 2500ms", async () => {
  stubEndpoint(); const socket = fakeSocket(); f.connect.mockReturnValue(socket);
  const pending = requestSessionMessageOnce("claim", {}, "synthetic-state", 7000, undefined, { enforceDeadline: true });
  const settled = pending.then(() => undefined, (error: Error) => error);
  await vi.waitFor(() => expect(f.connect).toHaveBeenCalledTimes(1));
  f.now = 2600; socket.emit("secureConnect");
  expect(await settled).toBeInstanceOf(Error); expect(socket.write).not.toHaveBeenCalled();
});

it("default preparation cannot start chmod or spawn after mkdir consumes the deadline", async () => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  f.read.mockRejectedValue(new Error("endpoint unavailable"));
  f.mkdir.mockImplementationOnce(async () => { f.now = 600; });
  await expect(actual.sessionMessageRequest("claim", {}, "synthetic-state", {
    totalTimeoutMs: 500, deadlineMonotonicMs: 600, noOperationReplay: true,
  })).rejects.toThrow();
  expect(f.mkdir).toHaveBeenCalledTimes(1); expect(f.chmod).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
});

it("broker-path filesystem work cannot enable a spawn after the deadline", async () => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  f.read.mockRejectedValue(new Error("endpoint unavailable"));
  f.exists.mockImplementationOnce(() => { f.now = 600; return true; });
  await expect(actual.sessionMessageRequest("claim", {}, "synthetic-state", {
    totalTimeoutMs: 500, deadlineMonotonicMs: 600, noOperationReplay: true,
  })).rejects.toThrow();
  expect(f.exists).toHaveBeenCalledTimes(1); expect(f.spawn).not.toHaveBeenCalled();
});

it.each(["backpressure", "throw"])("write %s is still one attempted operation, and observer errors cannot replace it", async (mode) => {
  const { socket, onOperationWrite, settled } = await connecting();
  const failure = new Error("original write error");
  onOperationWrite.mockImplementation(() => { throw new Error("observer error"); });
  socket.write.mockImplementation(() => { if (mode === "throw") throw failure; return false; });
  socket.emit("secureConnect");
  if (mode !== "throw") socket.emit("end");
  const result = await settled;
  if (mode === "throw") expect(result.error).toBe(failure);
  else expect(result.error?.message).toMatch(/closed/u);
  expect(onOperationWrite).toHaveBeenCalledTimes(1); expect(socket.destroy).toHaveBeenCalledTimes(1);
});

it("serialization consuming the remaining socket deadline prevents a late write", async () => {
  const { socket, onOperationWrite, settled } = await connecting();
  const stringify = JSON.stringify;
  vi.spyOn(JSON, "stringify").mockImplementation((value, replacer, space) => {
    const output = stringify(value, replacer, space);
    if (value && typeof value === "object" && "operation" in value) f.now = 600;
    return output;
  });
  socket.emit("secureConnect");
  expect((await settled).error).toBeInstanceOf(Error);
  expect(socket.write).not.toHaveBeenCalled(); expect(onOperationWrite).not.toHaveBeenCalled();
});

it.each(["late-response", "partial-close", "success"])("actual response settling enforces the deadline and EOF: %s", async (mode) => {
  const { socket, onOperationWrite, settled } = await connecting();
  socket.emit("secureConnect");
  if (mode === "late-response") f.now = 600;
  socket.emit("data", Buffer.from(mode === "partial-close" ? '{"ok":true' : '{"ok":true,"data":{"messages":[]}}\n'));
  if (mode === "partial-close") socket.emit("close");
  const result = await settled;
  if (mode === "success") expect(result.value).toEqual({ messages: [] });
  else expect(result.error).toBeInstanceOf(Error);
  expect(onOperationWrite).toHaveBeenCalledTimes(1); expect(socket.destroy).toHaveBeenCalledTimes(1);
});
