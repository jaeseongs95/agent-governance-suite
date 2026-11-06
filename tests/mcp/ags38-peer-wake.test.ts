import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), wake: vi.fn(), record: vi.fn(), verify: vi.fn(), close: vi.fn() }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
vi.mock("../../mcp-server/src/session-message-wake-port.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-wake-port.js")>(), recordWakeHookObservation: f.wake,
}));
vi.mock("../../mcp-server/src/trust-store.js", () => ({ TrustStore: class {
  recordInputSource() { return f.record(); }
  verify() { return f.verify(); }
  close() { f.close(); }
} }));
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { adaptHostInput, hostDeliveryProfile } from "../../mcp-server/src/host-input-adapter.js";

const nonce = "abcdefghijklmnopqrstuvwxyz";
const target = { host: "claude-code", sessionId: "peer-wake-target" };
const input = { hook_event_name: "UserPromptSubmit", session_id: target.sessionId, prompt: `[agent-governance-suite:wake:${nonce}]` };
const message = { messageId: "synthetic-wake-body", sender: { host: "claude-code", sessionId: "sender" },
  recipient: target, body: "synthetic wake body", createdAt: "2026-11-07T00:00:00.000Z", expiresAt: "2026-11-07T01:00:00.000Z", deliveryAttempt: 1 };
beforeEach(() => {
  for (const mock of [f.request, f.wake, f.record, f.verify, f.close]) mock.mockReset();
  f.wake.mockReturnValue("synthetic-wake-receipt");
  f.record.mockReturnValue({ receiptId: "synthetic-peer-receipt" });
  f.verify.mockReturnValue(true);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it("PW01: current verified Claude wake delivers its body at UserPromptSubmit without a Stop", async () => {
  f.request.mockResolvedValue({ recognized: true, managed: true, messages: [message] });
  expect(await handleSessionMessageHook(input, "claude-code")).toMatchObject({ hookSpecificOutput: {
    hookEventName: "UserPromptSubmit", additionalContext: expect.stringContaining(message.body),
  } });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake"]);
  expect(f.close).toHaveBeenCalledTimes(1);
});

it("PW02: rejected wake records only a bounded reason and never falls back to claiming", async () => {
  f.request.mockImplementation(async (operation) => operation === "claim-host-wake"
    ? { recognized: false, managed: false, messages: [], rejectionReason: "WAKE_NONCE_UNKNOWN" } : {});
  expect(await handleSessionMessageHook(input, "claude-code")).toEqual({});
  const diagnostics = vi.mocked(console.error).mock.calls.map(([line]) => String(line)).join("\n");
  expect(diagnostics).toContain("WAKE_NONCE_UNKNOWN");
  expect(diagnostics).not.toContain(nonce);
  expect(diagnostics).not.toContain(target.sessionId);
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake", "observe-native-input"]);
  expect(f.record).not.toHaveBeenCalled();
});

it("PW03: real store distinguishes invalid observation, unavailable reader, bad receipt and unknown nonce", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags38-peer-wake-"));
  const store = new SessionMessageStore(path.join(directory, "messages.sqlite3"));
  try {
    store.send({ sender: { host: "claude-code", sessionId: "sender" }, target,
      messageId: "unclaimed-body", body: "must stay pending" }, 1000);
    const before = store.database.prepare("SELECT * FROM messages").all();
    const observation = adaptHostInput(input, "claude-code").observation;
    const good = { verifyObservation: () => true };
    const bad = { verifyObservation: () => false };
    expect(store.claimHostWake(target, { ...observation, wakeOnly: false }, "receipt", good, 1000)).toMatchObject({
      recognized: false, messages: [], rejectionReason: "WAKE_OBSERVATION_INVALID" });
    expect(store.claimHostWake(target, observation, "receipt", undefined, 1000)).toMatchObject({
      recognized: false, messages: [], rejectionReason: "WAKE_READER_UNAVAILABLE" });
    expect(store.claimHostWake(target, observation, "receipt", bad, 1000)).toMatchObject({
      recognized: false, messages: [], rejectionReason: "WAKE_RECEIPT_REJECTED" });
    expect(store.claimHostWake(target, observation, "receipt", good, 1000)).toMatchObject({
      recognized: false, messages: [], rejectionReason: "WAKE_NONCE_UNKNOWN" });
    expect(store.database.prepare("SELECT * FROM messages").all()).toEqual(before);
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("PE01: the builtin Claude adapter enables the existing verified-empty guard", () => {
  expect(hostDeliveryProfile("claude-code", {}).blocksEmptyWakePrompt).toBe(true);
});

it("PE02: a verified managed empty Claude wake blocks before a model request", async () => {
  f.request.mockResolvedValue({ recognized: true, managed: true, messages: [] });
  expect(await handleSessionMessageHook(input, "claude-code")).toMatchObject({ decision: "block", reason: expect.any(String) });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake"]);
  expect(f.record).not.toHaveBeenCalled();
});

it("PE03: a verified retired empty Claude wake blocks without claiming a newer body", async () => {
  f.request.mockResolvedValue({ recognized: false, managed: false, retired: true, messages: [],
    rejectionReason: "WAKE_GENERATION_NOT_CURRENT" });
  expect(await handleSessionMessageHook(input, "claude-code")).toMatchObject({ decision: "block", reason: expect.any(String) });
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake"]);
  expect(f.record).not.toHaveBeenCalled();
  expect(vi.mocked(console.error).mock.calls.map(([line]) => String(line)).join("\n")).toContain("WAKE_GENERATION_NOT_CURRENT");
});

it("PE04: an empty claim without a managed binding cannot block Claude input", async () => {
  f.request.mockResolvedValue({ recognized: true, managed: false, messages: [] });
  expect(await handleSessionMessageHook(input, "claude-code")).toEqual({});
  expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake"]);
  expect(f.record).not.toHaveBeenCalled();
});

it.each(["WAKE_OBSERVATION_INVALID", "WAKE_READER_UNAVAILABLE", "WAKE_RECEIPT_REJECTED", "WAKE_NONCE_UNKNOWN", "WAKE_GENERATION_NOT_CURRENT"])(
  "PE05: %s remains diagnostic-only with no fallback body claim or block", async (rejectionReason) => {
    f.request.mockImplementation(async (operation) => operation === "claim-host-wake"
      ? { recognized: false, managed: false, messages: [], rejectionReason } : {});
    expect(await handleSessionMessageHook(input, "claude-code")).toEqual({});
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["claim-host-wake", "observe-native-input"]);
    expect(f.record).not.toHaveBeenCalled();
    const diagnostic = vi.mocked(console.error).mock.calls.map(([line]) => String(line)).join("\n");
    expect(diagnostic).toContain(rejectionReason);
    expect(diagnostic).not.toContain(nonce);
    expect(diagnostic).not.toContain(target.sessionId);
  });

it.each(["ordinary user request", `${input.prompt}\nordinary user request`])(
  "PE08: ordinary or mixed user text stays outside the empty-wake guard (%s)", async (prompt) => {
    f.request.mockResolvedValue({});
    expect(await handleSessionMessageHook({ ...input, prompt }, "claude-code")).toEqual({});
    expect(f.request.mock.calls.map(([operation]) => operation)).toEqual(["observe-native-input"]);
    expect(f.wake).not.toHaveBeenCalled();
    expect(f.record).not.toHaveBeenCalled();
  });
