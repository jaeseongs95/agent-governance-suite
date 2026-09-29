import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...(await original<typeof import("../../mcp-server/src/session-message-client.js")>()),
  sessionMessageRequest: vi.fn(),
}));

const { sessionMessageRequest } = await import("../../mcp-server/src/session-message-client.js");
const { SessionMessageService } = await import("../../mcp-server/src/session-message-service.js");
const request = vi.mocked(sessionMessageRequest);
type Target = { host: string; sessionId: string };
const targets = (count: number): Target[] => Array.from({ length: count }, (_, index) => ({ host: "portable", sessionId: `session-${index}` }));
// The client's default per-call deadline, which a board lookup also uses as its overall bound.
const CLIENT_DEADLINE_MS = 20_000;
let arrivals: Target[][] = [];

/**
 * A stub client and broker on fake time. The broker answers each batch after `answerAfter` ms. Like the real client, the
 * call gives up at its own deadline (`totalTimeoutMs`, else the default) with a transport error; the broker's answer
 * still arrives later and is recorded, but that call has already failed.
 */
function broker(answerAfter: (batch: Target[]) => number) {
  request.mockImplementation((_operation: string, payload: Record<string, unknown>, _directory?: string, options: { totalTimeoutMs?: number } = {}) => {
    const batch = payload.targets as Target[];
    const budget = options.totalTimeoutMs ?? CLIENT_DEADLINE_MS;
    const delay = answerAfter(batch);
    if (Number.isFinite(delay)) setTimeout(() => arrivals.push(batch), delay);
    return new Promise((resolve, reject) => {
      if (delay <= budget) setTimeout(() => resolve({ sessions: batch.map((item) => ({ ...item, state: "online" })) } as never), delay);
      else setTimeout(() => reject(new Error("The session message request timed out.")), Math.max(budget, 0));
    });
  });
}

async function lookup(board: Target[]) {
  let settledAt: number | null = null;
  // Elapsed time on the monotonic clock, which a wall-clock step does not move.
  const started = performance.now();
  const pending = new SessionMessageService().listPresence(board).then((result) => { settledAt = performance.now() - started; return result; });
  return { pending, settledAt: () => settledAt };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "setImmediate", "clearImmediate", "Date", "performance"] });
  request.mockReset(); arrivals = [];
});
afterEach(() => { vi.useRealTimers(); });

it("ends a lookup against a slow but answering broker at one overall deadline, keeping answers and leaving the rest unanswered", async () => {
  // 300 board sessions are 100 batches. Each answer takes 1.9 s, inside every per-request limit, so without an overall
  // bound the lookup would take 190 s.
  const board = targets(300);
  broker(() => 1900);
  const { pending, settledAt } = await lookup(board);
  await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS);
  expect(settledAt()).toBe(CLIENT_DEADLINE_MS);
  const result = await pending;
  expect(result.ok).toBe(true);
  // Ten batches answered by 19 s; the eleventh had 1 s left and gave up at the deadline.
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(board.slice(0, 30).map((item) => item.sessionId));
  expect(result.data!.unanswered).toEqual(board.slice(30));
  expect(request).toHaveBeenCalledTimes(11);
  const budgets = request.mock.calls.map(([, , , options]) => (options as { totalTimeoutMs: number }).totalTimeoutMs);
  expect(budgets[0]).toBe(CLIENT_DEADLINE_MS);
  expect(budgets.at(-1)).toBe(CLIENT_DEADLINE_MS - 10 * 1900);
});

it("does not let an answer that arrives after the deadline change the result", async () => {
  const board = targets(12);
  // The first three batches answer at once; the fourth answers only after the overall deadline.
  broker((batch) => batch.some((item) => item.sessionId === "session-9") ? CLIENT_DEADLINE_MS + 5000 : 0);
  const { pending, settledAt } = await lookup(board);
  // Timers of the immediate answers each take the 1 ms minimum, so the fourth batch starts after the lookup did.
  await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS);
  expect(settledAt()).toBe(CLIENT_DEADLINE_MS);
  const result = await pending;
  const snapshot = structuredClone(result);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(arrivals.at(-1)!.map((item) => item.sessionId)).toEqual(["session-9", "session-10", "session-11"]);
  expect(result).toEqual(snapshot);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(board.slice(0, 9).map((item) => item.sessionId));
  expect(result.data!.unanswered).toEqual(board.slice(9));
});

it("bounds an unresponsive broker by the same deadline and asks only once", async () => {
  const board = targets(9);
  broker(() => Number.POSITIVE_INFINITY);
  const { pending, settledAt } = await lookup(board);
  await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS);
  expect(settledAt()).toBe(CLIENT_DEADLINE_MS);
  const result = await pending;
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.data).toEqual({ sessions: [], unanswered: board });
});

it("returns every identity exactly once, in order, from a normal broker", async () => {
  const board = [...targets(301), { host: "portable", sessionId: "has space" }];
  broker(() => 5);
  const { pending, settledAt } = await lookup(board);
  await vi.advanceTimersByTimeAsync(101 * 5);
  expect(settledAt()).not.toBeNull();
  const result = await pending;
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(board.slice(0, 301).map((item) => item.sessionId));
  // An identity outside the broker pattern is never asked and stays unanswered on its own.
  expect(result.data!.unanswered).toEqual([{ host: "portable", sessionId: "has space" }]);
  expect(request).toHaveBeenCalledTimes(101);
});

it("keeps the overall deadline when the wall clock steps back during a lookup", async () => {
  // Five seconds into a slow lookup the wall clock is set back 60 s (a time sync or manual correction). The deadline is
  // measured on the monotonic clock, so the lookup still ends 20 s after it began, with the same answers.
  const board = targets(300);
  broker(() => 1900);
  const { pending, settledAt } = await lookup(board);
  await vi.advanceTimersByTimeAsync(5000);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(CLIENT_DEADLINE_MS - 5000);
  expect(settledAt()).toBe(CLIENT_DEADLINE_MS);
  const result = await pending;
  expect(request).toHaveBeenCalledTimes(11);
  expect(result.data!.sessions.map((session) => session.sessionId)).toEqual(board.slice(0, 30).map((item) => item.sessionId));
  expect(result.data!.unanswered).toEqual(board.slice(30));
});
