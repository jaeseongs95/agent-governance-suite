import { expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { failureContext } from "../../mcp-server/src/failure-diagnostics.js";

it("keeps the primary failure and records a failed ROLLBACK only as a secondary diagnostic", () => {
  const store = new SessionMessageStore(":memory:");
  const target = { host: "fixture-host", sessionId: "rollback-target" };
  const database = store.database;
  const originalExec = database.exec.bind(database);
  const rollbackFailure = new Error("synthetic rollback failure");
  database.exec = ((sql: string) => {
    if (sql.trim().toUpperCase().startsWith("ROLLBACK")) throw rollbackFailure;
    return originalExec(sql);
  }) as typeof database.exec;
  let caught: unknown;
  try {
    // Limit validation runs inside the store transaction, so the operation fails after BEGIN IMMEDIATE.
    store.claim(target, 2000, { maxMessages: 0 });
  } catch (error) { caught = error; }
  finally {
    database.exec = originalExec;
    try { originalExec("ROLLBACK"); } catch { /* Fixture cleanup only. */ }
  }
  try {
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBe(rollbackFailure);
    expect((caught as Error).message).toMatch(/maxMessages must be an integer/u);
    const context = failureContext(caught);
    expect(context.secondary).toEqual([expect.objectContaining({ type: "error", producerReason: "SESSION_MESSAGE_ROLLBACK_FAILED" })]);
    expect(JSON.stringify(context)).not.toContain("synthetic rollback failure");
    // The connection remains usable after cleanup.
    expect(store.pendingCount(target, 3000)).toBe(0);
  } finally { store.close(); }
});
