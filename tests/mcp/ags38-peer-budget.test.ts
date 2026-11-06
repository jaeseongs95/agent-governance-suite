import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ now: 100, request: vi.fn(), open: vi.fn(), record: vi.fn(), verify: vi.fn(), close: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => f.now } }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/trust-store.js", () => ({ TrustStore: class {
  constructor() { f.open(); }
  recordInputSource() { return f.record(); }
  verify() { return f.verify(); }
  close() { f.close(); }
} }));
import { runSessionMessageHookOutcome } from "../../mcp-server/src/session-message-hook.js";

const input = JSON.stringify({ hook_event_name: "Stop", session_id: "peer-budget-target" });
const message = { messageId: "synthetic-peer-budget", sender: { host: "claude-code", sessionId: "sender" },
  recipient: { host: "claude-code", sessionId: "peer-budget-target" }, body: "synthetic peer budget body",
  createdAt: "2026-11-07T00:00:00.000Z", expiresAt: "2026-11-07T01:00:00.000Z", deliveryAttempt: 1 };
const budget = { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 };

beforeEach(() => {
  for (const mock of [f.request, f.open, f.record, f.verify, f.close]) mock.mockReset();
  f.now = 100;
  f.request.mockImplementation(async (_operation, _payload, _directory, options) => {
    options?.onOperationWrite?.(); return { messages: [message] };
  });
  f.record.mockReturnValue({ receiptId: "synthetic-source" });
  f.verify.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("PB01: claims once with its reserve, emits the body, closes and never acknowledges", async () => {
  const result = await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
  expect(result.ok).toBe(true);
  expect(result.output).toContain(message.body);
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("claim-turn-end");
  expect(f.request.mock.calls[0]![3]).toMatchObject({ deadlineMonotonicMs: 800, noOperationReplay: true, busyTimeoutMs: 0 });
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("PB02: cannot spend the receipt reserve starting a claim", async () => {
  const result = await runSessionMessageHookOutcome("claude-code", input, undefined,
    { executionBudget: { deadlineMonotonicMs: 300, postClaimReserveMs: 200 } });
  expect(result).toMatchObject({ ok: false, failure: { reason: "HOOK_BUDGET_EXPIRED", step: "claim-turn-end" } });
  expect(f.request).not.toHaveBeenCalled();
  expect(f.open).not.toHaveBeenCalled();
});

it.each(["open", "record", "verify"] as const)("PB03: expiry after %s closes once without another claim", async (phase) => {
  f[phase].mockImplementationOnce(() => { f.now = 1000; return phase === "record" ? { receiptId: "source" } : true; });
  const result = await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
  expect(result).toMatchObject({ ok: false, failure: { reason: "HOOK_BUDGET_EXPIRED", step: "peer-receipt" } });
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
  if (phase === "open") expect(f.record).not.toHaveBeenCalled();
  if (phase !== "verify") expect(f.verify).not.toHaveBeenCalled();
});

it("PB04: receipt failure remains primary when close also fails", async () => {
  f.record.mockImplementationOnce(() => { throw Object.assign(new Error("synthetic record failure"), { code: "EIO" }); });
  f.close.mockImplementationOnce(() => { throw Object.assign(new Error("synthetic close failure"), { code: "EPERM" }); });
  const result = await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
  expect(result).toMatchObject({ ok: false, failure: { reason: "EIO", step: "peer-receipt" } });
  expect(f.close).toHaveBeenCalledTimes(1);
  expect(f.request).toHaveBeenCalledTimes(1);
});

// D0022 is a source design defect: a behavior-only test cannot distinguish a CQS-preserving refactor.
it("PB05: querying time never throws and budgeted receipt operations share an explicit boundary", () => {
  const source = readFileSync(new URL("../../mcp-server/src/session-message-hook.ts", import.meta.url), "utf8");
  const query = source.match(/function remainingBudget\([\s\S]*?\n\}/u)?.[0];
  expect(query).toBeDefined();
  expect(query).not.toContain("throw");
  expect(source).toContain("function assertHookBudget(");
  expect(source).toContain("function budgetedStep<");
  expect(source).not.toMatch(/^\s+remainingBudget\(budget/u);
});

it("PB10: a busy budgeted hook preserves its queue and the next boundary can claim without an ACK", async () => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-peer-budget-"));
  const target = message.recipient;
  let holder: DatabaseSync | undefined;
  try {
    const prepared = actual.runSessionMessageOperation<{ messageId: string }>("prepare", { target, sender: message.sender, body: message.body, ttlSeconds: 600 }, directory);
    actual.runSessionMessageOperation("send", { sender: message.sender, messageId: prepared.messageId }, directory);
    holder = new DatabaseSync(path.join(directory, "session-messages.sqlite3"));
    const snapshot = () => holder!.prepare("SELECT delivery_attempts, claimed_at, claim_receipt, acknowledged_at FROM messages").all();
    const before = snapshot();
    const options: unknown[] = [];
    f.request.mockImplementation((operation, payload, _directory, requestOptions) => {
      options.push(requestOptions);
      return actual.sessionMessageRequest(operation, payload, directory, requestOptions);
    });
    holder.exec("BEGIN IMMEDIATE");
    const busy = await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
    expect(busy).toMatchObject({ ok: false, output: "", failure: { producerReason: "MESSAGING_BUSY", step: "claim-turn-end" } });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ busyTimeoutMs: 0, deadlineMonotonicMs: 800 });
    expect(snapshot()).toEqual(before);
    holder.exec("ROLLBACK");
    const next = await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
    expect(next.ok).toBe(true);
    expect(next.output).toContain(message.body);
    expect(options).toHaveLength(2);
    expect(snapshot()).toEqual([{ delivery_attempts: 1, claimed_at: expect.any(String), claim_receipt: expect.any(String), acknowledged_at: null }]);
  } finally {
    if (holder?.isTransaction) holder.exec("ROLLBACK");
    holder?.close();
    actual.closeSessionMessaging(directory);
    rmSync(directory, { recursive: true, force: true });
  }
});

it("PB11: a hook's nonwaiting call does not leak into the next regular MCP request", async () => {
  const actual = await vi.importActual<typeof import("../../mcp-server/src/session-message-client.js")>("../../mcp-server/src/session-message-client.js");
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-peer-budget-"));
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  try {
    // The hook is the option producer; reuse the same cached client connection as the regular caller.
    f.request.mockImplementation((operation, payload, _directory, options) => actual.sessionMessageRequest(operation, payload, directory, options));
    await runSessionMessageHookOutcome("claude-code", input, undefined, { executionBudget: budget });
    expect(exec.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout = 0;")).toHaveLength(1);
    exec.mockClear();
    await actual.sessionMessageRequest("pending", { target: message.recipient }, directory);
    expect(exec.mock.calls.filter(([sql]) => sql === "PRAGMA busy_timeout = 5000;")).toHaveLength(1);
  } finally { actual.closeSessionMessaging(directory); rmSync(directory, { recursive: true, force: true }); }
});
