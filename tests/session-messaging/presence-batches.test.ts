import { beforeEach, expect, it, vi } from "vitest";

vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...(await original<typeof import("../../mcp-server/src/session-message-client.js")>()),
  sessionMessageRequest: vi.fn(),
}));

const { sessionMessageRequest } = await import("../../mcp-server/src/session-message-client.js");
const { SessionMessageService } = await import("../../mcp-server/src/session-message-service.js");
const request = vi.mocked(sessionMessageRequest);
type Target = { host: string; sessionId: string };
const target = (sessionId: string, host = "portable"): Target => ({ host, sessionId });
const view = ({ host, sessionId }: Target) => ({ host, sessionId, state: "online" });

beforeEach(() => {
  request.mockReset();
  // A stub broker: answers every batch except the one holding "fail", which it refuses.
  request.mockImplementation(async (_operation: string, payload: Record<string, unknown>) => {
    const targets = payload.targets as Target[];
    if (targets.some((item) => item.sessionId === "fail")) throw new Error("Broker request refused.");
    return { sessions: targets.map(view) } as never;
  });
});

it("keeps successful batches when one batch fails and reports only the failed batch as unanswered", async () => {
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
