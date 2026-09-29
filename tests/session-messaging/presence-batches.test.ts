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
const DEADLINE_MS = 400;

beforeEach(() => {
  request.mockReset();
  // A stub broker: answers every batch except the one holding "fail", which it explicitly refuses, and the one holding
  // "hang", which it never answers: the client gives up after its deadline (shortened here) with a transport error.
  request.mockImplementation(async (_operation: string, payload: Record<string, unknown>) => {
    const targets = payload.targets as Target[];
    if (targets.some((item) => item.sessionId === "fail")) throw new BrokerRequestRejected("Broker request refused.");
    if (targets.some((item) => item.sessionId === "hang")) {
      await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS));
      throw new Error("The session message broker did not answer before its deadline.");
    }
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

it("stops after a transport failure, so an unresponsive broker costs one batch deadline, not one per batch", async () => {
  // Every batch hangs, as a broker that is alive but never answers would.
  const targets = Array.from({ length: 9 }, (_, index) => target(`session-${index}`));
  request.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, DEADLINE_MS));
    throw new Error("The session message broker did not answer before its deadline.");
  });
  const started = Date.now();
  const result = await new SessionMessageService().listPresence(targets);
  const elapsed = Date.now() - started;
  expect(request).toHaveBeenCalledTimes(1);
  expect(elapsed).toBeLessThan(2 * DEADLINE_MS);
  expect(result.ok).toBe(true);
  expect(result.data!.sessions).toEqual([]);
  expect(result.data!.unanswered).toEqual(targets);
});

it("keeps earlier answers and marks the failed and remaining batches unanswered after a transport failure", async () => {
  const targets = ["a", "b", "c", "hang", "e", "f", "fail", "h", "i"].map((sessionId) => target(sessionId));
  const result = await new SessionMessageService().listPresence(targets);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(["a", "b", "c"]);
  expect(result.data!.unanswered).toEqual(["hang", "e", "f", "fail", "h", "i"].map((sessionId) => target(sessionId)));
  expect(request).toHaveBeenCalledTimes(2);
});
