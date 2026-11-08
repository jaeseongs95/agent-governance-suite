import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  now: 100, request: vi.fn(), spawn: vi.fn(),
  open: vi.fn(), record: vi.fn(), verify: vi.fn(), close: vi.fn(), wake: vi.fn(),
}));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => f.now } }));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
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
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
const syntheticCore = await import(new URL("./fixtures/synthetic-core-hook-driver.mjs", import.meta.url).href) as {
  SYNTHETIC_CORE_HOST: string;
  registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
};
syntheticCore.registerSyntheticCoreAdapters(registerHookHostAdapter, () => "codex-deferred");
const syntheticRootHost = syntheticCore.SYNTHETIC_CORE_HOST;
import { sessionMessageRequest as mockedRequest } from "../../mcp-server/src/session-message-client.js";

// The hook budget is a same-process performance.now() deadline (mocked here). Messaging runs in this process
// (docs/archive/ags30-broker-redesign.md 3.1): no socket, endpoint or broker spawn exists to bound.
const budget = () => ({ deadlineMonotonicMs: 1000, postClaimReserveMs: 200 });
const input = { hook_event_name: "Stop", session_id: "budget-target" };
const start = { ...input, agent_id: "", hook_event_name: "SessionStart" };
const message = {
  messageId: "synthetic-issued-id", sender: { host: "claude-code", sessionId: "sender" },
  recipient: { host: "claude-code", sessionId: "budget-target" }, body: "Synthetic peer body",
  createdAt: "2026-10-22T00:00:00.000Z", expiresAt: "2026-10-22T01:00:00.000Z",
  deliveryAttempt: 1, firstDeliveredAt: "2026-10-22T00:00:01.000Z",
};
const directories: string[] = [];
beforeEach(() => {
  for (const mock of [f.request, f.spawn, f.open, f.record, f.verify, f.close, f.wake]) mock.mockReset();
  f.now = 100;
  f.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  f.record.mockReturnValue({ receiptId: "source-synthetic" }); f.verify.mockReturnValue(true);
  f.request.mockImplementation(async (_operation, _payload, _directory, options) => {
    options?.onOperationWrite?.(); return { messages: [message] };
  });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE", "0");
});
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  for (const directory of directories.splice(0)) { actual.closeSessionMessaging(directory); rmSync(directory, { recursive: true, force: true }); }
});

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

it("snapshots the budget and host observation before an await, then refuses relay spawn after expiry", async () => {
  const executionBudget = budget();
  const hostProcess = { pid: 424242, startToken: "T1" };
  f.request.mockImplementationOnce(async () => {
    executionBudget.deadlineMonotonicMs = 9000; hostProcess.startToken = "T2"; f.now = 1000;
    return { presence: {}, relayId: "11111111-1111-4111-8111-111111111111" };
  });
  expect(await runSessionMessageHook(syntheticRootHost, JSON.stringify({ ...start, syntheticActor: "root" }), 424242, { executionBudget, hostProcess })).toBe("");
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["presence-start"]);
  expect(f.request.mock.calls[0]![1]).toMatchObject({ hostPid: 424242, hostStart: "T1" });
  expect(f.request.mock.calls[0]![3]).toMatchObject({ deadlineMonotonicMs: 1000 });
  expect(f.spawn).not.toHaveBeenCalled();
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

it("records a budgeted peer wake's source without a lock wait, then claims it under the budget (3.6.0)", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "1");
  f.wake.mockReturnValue("wake-source-synthetic");
  f.request.mockImplementation(async () => ({ recognized: true, managed: true, messages: [message] }));
  const wake = { hook_event_name: "UserPromptSubmit", session_id: "budget-target", prompt: "[agent-governance-suite:wake:abcdefghijklmnopqrstuvwxyz]" };
  expect(await runSessionMessageHook("codex", JSON.stringify(wake), undefined, { executionBudget: budget() })).toContain("source-synthetic");
  expect(f.wake).toHaveBeenCalledTimes(1);
  expect(f.wake.mock.calls[0]![2]).toEqual({ busyTimeoutMs: 0 });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake"]);
  expect(f.request.mock.calls[0]![1]).toMatchObject({ sourceReceiptId: "wake-source-synthetic" });
  expect(f.request.mock.calls[0]![3]).toMatchObject({ deadlineMonotonicMs: 800 });
  expect(diagnostic).not.toHaveBeenCalled();
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


// The in-process client's own deadline (session-message-client.ts sessionMessageRequest): an expired deadline runs
// nothing and the remaining time bounds the writer-lock wait; nothing is retried.
async function actualClient() {
  return await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
}
function stateDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-hook-budget-"));
  directories.push(directory);
  return directory;
}
const sender = { host: "claude-code", sessionId: "budget-sender" };
const recipient = { host: "claude-code", sessionId: "budget-target" };
async function expiredRejection(pending: Promise<unknown>): Promise<unknown> {
  const failure = await pending.then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(Error);
  return failure;
}

it("an expired deadline starts no state-directory preparation and no operation", async () => {
  const actual = await actualClient();
  const directory = stateDirectory();
  const prepareStateDirectory = vi.fn(async () => {}); const onOperationWrite = vi.fn();
  const failure = await expiredRejection(actual.sessionMessageRequest("claim", { target: recipient }, directory, {
    totalTimeoutMs: 500, deadlineMonotonicMs: 100, noOperationReplay: true, prepareStateDirectory, onOperationWrite,
  }));
  expect(producerFailureReason(failure)).toBe("BROKER_DEADLINE_EXPIRED");
  expect(onOperationWrite).not.toHaveBeenCalled();
  expect(existsSync(path.join(directory, "session-messages.sqlite3"))).toBe(false);
  expect(prepareStateDirectory).not.toHaveBeenCalled();
});

it("state-directory preparation that consumes the deadline prevents the operation", async () => {
  const actual = await actualClient();
  const directory = stateDirectory();
  const prepareStateDirectory = vi.fn(async () => { f.now = 600; }); const onOperationWrite = vi.fn();
  const failure = await expiredRejection(actual.sessionMessageRequest("claim", { target: recipient }, directory, {
    totalTimeoutMs: 500, deadlineMonotonicMs: 600, noOperationReplay: true, prepareStateDirectory, onOperationWrite,
  }));
  expect(producerFailureReason(failure)).toBe("BROKER_DEADLINE_EXPIRED");
  expect(prepareStateDirectory).toHaveBeenCalledTimes(1);
  expect(onOperationWrite).not.toHaveBeenCalled();
  expect(existsSync(path.join(directory, "session-messages.sqlite3"))).toBe(false);
});

it("a live deadline runs the operation once, and the caller timeout caps the absolute deadline", async () => {
  const actual = await actualClient();
  const directory = stateDirectory();
  const onOperationWrite = vi.fn();
  expect(await actual.sessionMessageRequest("claim", { target: recipient }, directory, {
    totalTimeoutMs: 500, deadlineMonotonicMs: 9000, noOperationReplay: true, onOperationWrite,
  })).toEqual({ messages: [] });
  expect(onOperationWrite).toHaveBeenCalledTimes(1);
  // A zero caller timeout caps the later absolute deadline: nothing runs.
  f.now = 600;
  const failure = await expiredRejection(actual.sessionMessageRequest("claim", { target: recipient }, directory, {
    totalTimeoutMs: 0, deadlineMonotonicMs: 9000, onOperationWrite,
  }));
  expect(producerFailureReason(failure)).toBe("BROKER_DEADLINE_EXPIRED");
  expect(onOperationWrite).toHaveBeenCalledTimes(1);
});

it("another process's writer lock within the remaining budget is MESSAGING_BUSY with nothing written, not a retry", async () => {
  const actual = await actualClient();
  const directory = stateDirectory();
  actual.runSessionMessageOperation("pending", { target: recipient }, directory);
  // A second connection holds the writer lock; the remaining 2 ms is the whole lock wait (busy_timeout), no retry.
  const holder = new DatabaseSync(path.join(directory, "session-messages.sqlite3"));
  const drafts = () => (holder.prepare("SELECT count(*) AS n FROM prepared_messages").get() as { n: number }).n;
  try {
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    const onOperationWrite = vi.fn();
    const failure = await expiredRejection(actual.sessionMessageRequest("prepare", { sender, target: recipient, body: "busy body" }, directory, {
      deadlineMonotonicMs: 102, onOperationWrite,
    }));
    expect(producerFailureReason(failure)).toBe("MESSAGING_BUSY");
    expect(onOperationWrite).toHaveBeenCalledTimes(1);
    holder.exec("COMMIT;");
    expect(drafts()).toBe(0);
    expect(await actual.sessionMessageRequest("prepare", { sender, target: recipient, body: "busy body" }, directory, {
      deadlineMonotonicMs: 102 })).toMatchObject({ messageId: expect.any(String) });
    expect(drafts()).toBe(1);
  } finally { if (holder.isTransaction) holder.exec("ROLLBACK;"); holder.close(); }
});

it.each(["gemini"])("does not spend a native %s lifecycle budget on presence", async (host) => {
  expect(await runSessionMessageHook(host, JSON.stringify(start), 424242,
    { executionBudget: budget(), hostProcess: { pid: 424242, startToken: "T1" } })).toBe("");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.spawn).not.toHaveBeenCalled(); expect(f.open).not.toHaveBeenCalled();
});
