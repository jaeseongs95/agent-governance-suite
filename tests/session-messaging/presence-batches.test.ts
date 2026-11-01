import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...(await original<typeof import("../../mcp-server/src/session-message-client.js")>()),
  sessionMessageRequest: vi.fn(),
}));

const { BrokerRequestRejected, sessionMessageRequest } = await import("../../mcp-server/src/session-message-client.js");
const { SessionMessageService } = await import("../../mcp-server/src/session-message-service.js");
const request = vi.mocked(sessionMessageRequest);
type Target = { host: string; sessionId: string };
const target = (sessionId: string, host = "portable"): Target => ({ host, sessionId });
const view = ({ host, sessionId }: Target) => ({ host, sessionId, state: "online" });
// The client's failure for an operation that did not answer (an expired deadline or a busy writer lock); not a refusal.
const unanswered = () => Object.assign(new Error("The session message request deadline expired."), { code: "BROKER_DEADLINE_EXPIRED" });

beforeEach(() => {
  request.mockReset();
  // A stub client: answers every batch except the one holding "fail", which it explicitly refuses, and the one holding
  // "hang", which does not answer: the client reports that as a failure that is not a domain refusal.
  request.mockImplementation(async (_operation: string, payload: Record<string, unknown>) => {
    const targets = payload.targets as Target[];
    if (targets.some((item) => item.sessionId === "fail")) throw new BrokerRequestRejected("Broker request refused.");
    if (targets.some((item) => item.sessionId === "hang")) throw unanswered();
    return { sessions: targets.map(view) } as never;
  });
});

it("keeps successful batches when the broker refuses one batch and reports only that batch as unanswered", async () => {
  const targets = ["a", "b", "c", "fail", "e", "f", "g"].map((sessionId) => target(sessionId));
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.ok).toBe(true);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(["a", "b", "c", "g"]);
  expect(result.data!.unanswered).toEqual([target("fail"), target("e"), target("f")]);
  expect(request).toHaveBeenCalledTimes(3);
  expect(result.data!.sessions[0]!.relayCode).toEqual({status: "unknown", runningDigest: null, expectedDigest: null});
});

it("never asks the broker for identities outside its identifier pattern", async () => {
  const targets = [target("a"), target("has space"), target("b"), target("c", "bad host"), target(`x${"y".repeat(200)}`), target("d")];
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.ok).toBe(true);
  const asked = request.mock.calls.flatMap(([, payload]) => (payload as { targets: Target[] }).targets);
  expect(asked).toEqual([target("a"), target("b"), target("d")]);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(["a", "b", "d"]);
  expect(result.data!.unanswered).toEqual([target("has space"), target("c", "bad host"), target(`x${"y".repeat(200)}`)]);
});

it("stops after an unanswered batch, so an unanswering store costs one batch deadline, not one per batch", async () => {
  // Every batch is unanswered; one call proves the lookup waits at most one deadline (presence-deadline.test.ts times it).
  const targets = Array.from({ length: 9 }, (_, index) => target(`session-${index}`));
  request.mockImplementation(async () => { throw unanswered(); });
  const result = await new SessionMessageService().listPresence(targets);
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.ok).toBe(true);
  expect(result.data!.sessions).toEqual([]);
  expect(result.data!.unanswered).toEqual(targets);
});

it("keeps earlier answers and marks the failed and remaining batches unanswered after an unanswered batch", async () => {
  const targets = ["a", "b", "c", "hang", "e", "f", "fail", "h", "i"].map((sessionId) => target(sessionId));
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(["a", "b", "c"]);
  expect(result.data!.unanswered).toEqual(["hang", "e", "f", "fail", "h", "i"].map((sessionId) => target(sessionId)));
  expect(request).toHaveBeenCalledTimes(2);
});
