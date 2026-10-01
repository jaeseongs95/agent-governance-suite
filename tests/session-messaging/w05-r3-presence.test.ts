import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { BrokerRequestRejected, sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: vi.fn(),
}));
const request = vi.mocked(sessionMessageRequest);
const targets = Array.from({ length: 12 }, (_, i) => ({ host: "codex", sessionId: `presence-${i}` }));
const views = (batch: typeof targets) => ({ sessions: batch.map(target => ({ ...target, state: "unknown",
  deliveryCapabilities: { supportedInjection: [], idleWake: "none" } })) });
afterEach(() => { vi.restoreAllMocks(); request.mockReset(); });

it("AC005 batches three and retains successes around a definite refusal", async () => {
  let call = 0;
  request.mockImplementation(async (_operation, payload) => {
    call++;
    if (call === 2) throw new BrokerRequestRejected("synthetic refusal");
    return views(payload.targets as typeof targets);
  });
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.ok).toBe(true);
  expect(result.data?.sessions.map(s => s.sessionId)).toEqual([...targets.slice(0, 3), ...targets.slice(6)].map(t => t.sessionId));
  expect(result.data?.unanswered).toEqual(targets.slice(3, 6));
  expect(request.mock.calls.map(call => (call[1].targets as unknown[]).length)).toEqual([3, 3, 3, 3]);
});

it.each(["transport", "identity", "capabilities", "outlook"])("AC005 preserves validated successes then stops at %s failure", async (fault) => {
  let call = 0;
  request.mockImplementation(async (_operation, payload) => {
    const batch = payload.targets as typeof targets;
    if (++call === 1) return views(batch);
    if (fault === "transport") throw new Error("synthetic transport failure");
    const response = views(batch);
    if (fault === "identity") response.sessions[0]!.sessionId = "wrong-target";
    if (fault === "capabilities") Reflect.deleteProperty(response.sessions[0]!, "deliveryCapabilities");
    if (fault === "outlook") Object.assign(response.sessions[0]!, { autoWake: { authorityEffect: "approval-source" } });
    return response;
  });
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.data?.sessions.map(s => s.sessionId)).toEqual(targets.slice(0, 3).map(t => t.sessionId));
  expect(result.data?.unanswered).toEqual(targets.slice(3));
  expect(request).toHaveBeenCalledTimes(2);
});

it("AC005 uses one monotonic 20s budget and passes only the remainder despite wall-clock steps", async () => {
  let monotonic = 100;
  vi.spyOn(performance, "now").mockImplementation(() => monotonic);
  vi.spyOn(Date, "now").mockImplementation(() => monotonic % 2 ? 1 : 9_999_999_999_999);
  request.mockImplementation(async (_operation, payload) => {
    monotonic += 7_000;
    return views(payload.targets as typeof targets);
  });
  const result = await new SessionMessageService().listPresence(targets);
  expect(request.mock.calls.map(call => call[3]?.totalTimeoutMs)).toEqual([20_000, 13_000, 6_000]);
  expect(result.data?.sessions).toHaveLength(9);
  expect(result.data?.unanswered).toEqual(targets.slice(9));
});

it("AC005 excludes invalid bounded identities without weakening the target count contract", async () => {
  request.mockImplementation(async (_operation, payload) => views(payload.targets as typeof targets));
  const invalid = { host: "bad host", sessionId: "bad/session" };
  const service = new SessionMessageService();
  expect((await service.listPresence([invalid, ...targets.slice(0, 3)])).data?.unanswered).toEqual([invalid]);
  expect(request).toHaveBeenCalledTimes(1);
  expect((await service.listPresence(Array.from({ length: 257 }, () => targets[0]!))).ok).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
