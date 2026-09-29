// Re-audit: scope of the N4 fault-injection trigger used by message-retention.test.ts. Audit only.
import { expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
const target = { host: "audit-host", sessionId: "audit-target" };
const hot = { host: "audit-host", sessionId: "audit-hot" };
it("the trigger fails only UPDATEs of prepared_messages.expires_at; other paths keep working", () => {
  const store = new SessionMessageStore(":memory:");
  const d = store.prepare({ sender: hot, target, body: "x", ttlSeconds: 86400 }, 1000);
  const sent = store.submitPrepared(hot, d.messageId, 1000);
  store.database.exec(`CREATE TRIGGER retention_fail_receipt BEFORE UPDATE OF expires_at ON prepared_messages
    BEGIN SELECT RAISE(ABORT, 'injected receipt update failure'); END;`);
  expect(store.claim(target, 1500)).toHaveLength(1);                      // messages UPDATE unaffected
  expect(store.status(hot, sent.messageId, 1600)).toMatchObject({ state: "delivered" });
  const other = store.prepare({ sender: hot, target, body: "y" }, 1700);  // INSERT unaffected
  expect(store.submitPrepared(hot, sent.messageId, 1800).duplicate).toBe(true); // duplicate path has no UPDATE
  expect(store.acknowledge(target, ["unknown-id-xyz"], 1900)).toBe(0);   // no receipt update attempted
  store.prune(1000 + 600_001);                                           // DELETE unaffected (draft expires)
  // Also affected, but not exercised by the product test while the trigger exists:
  const d2 = store.prepare({ sender: hot, target, body: "z" }, 1000 + 600_001);
  expect(() => store.submitPrepared(hot, d2.messageId, 1000 + 600_002)).toThrow(/injected/u);
  expect(() => store.acknowledge(target, [sent.messageId], 2000)).toThrow(/injected/u);
  expect(store.status(hot, sent.messageId, 2001)).toMatchObject({ acknowledgedAt: null });
  store.database.exec("DROP TRIGGER retention_fail_receipt");
  expect(store.database.prepare("SELECT count(*) AS v FROM sqlite_master WHERE type = 'trigger'").get()).toEqual({ v: 0 });
  expect(store.acknowledge(target, [sent.messageId], 3000)).toBe(1);
  expect(other.messageId).toBeTruthy();
  store.close();
});
