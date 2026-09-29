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
  let settledAt: number | null = null; let settledMono: number | null = null; const mono0 = performance.now();
  const started = Date.now();
  const pending = new SessionMessageService().listPresence(board).then((result) => { settledAt = Date.now() - started; settledMono = performance.now() - mono0; return result; });
  return { pending, settledAt: () => settledAt, settledMono: () => settledMono };
}

beforeEach(() => { vi.useFakeTimers(); request.mockReset(); arrivals = []; });
afterEach(() => { vi.useRealTimers(); });

// Audit-only: the wall clock steps back 60 s (NTP or manual correction) 5 s into a lookup against a slow broker.
// The service measures its deadline with Date.now; the client measures each call with performance.now.
it("clock step back during a lookup", async () => {
  const board = targets(300);
  broker(() => 1900);
  const { pending, settledAt, settledMono } = await lookup(board);
  await vi.advanceTimersByTimeAsync(5000);
  vi.setSystemTime(Date.now() - 60_000);
  await vi.advanceTimersByTimeAsync(120_000);
  const result = await pending;
  const line = JSON.stringify({ probe: "clock-step-back-60s", commit: process.env.AGS_AUDIT_COMMIT, settledAtWallElapsedMs: settledAt(), settledAtMonotonicElapsedMs: settledMono(), requests: request.mock.calls.length, answered: result.data!.sessions.length });
  (await import("node:fs")).appendFileSync(process.env.AGS_AUDIT_LOG!, line + "\n");
});
