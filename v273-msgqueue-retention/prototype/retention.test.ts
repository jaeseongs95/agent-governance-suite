// Scratch prototype for the 2.7.3 retention design. Not part of the repository.
import { expect, it } from "vitest";
import { SessionMessageStore, MESSAGE_RECEIPT_LIMIT, MESSAGE_SENDER_DRAFT_LIMIT } from "/home/user/agent-governance-suite/mcp-server/src/session-message-store.ts";

const target = { host: "grok", sessionId: "worker" };
const hot = { host: "spark", sessionId: "hot" };
const other = { host: "spark", sessionId: "other" };
const H = 3600_000;
const count = (s: SessionMessageStore, sql: string) => (s.database.prepare(sql).get() as { c: number }).c;

// ---- design prototype (F1 sender receipt quota, F2 ACK-bounded receipt, F3 prepare admission) ----
const SENDER_RECEIPT_LIMIT = 250;
class Proposed extends SessionMessageStore {
  private receiptLoad(sender: { host: string; sessionId: string }) {
    const all = count(this, "SELECT count(*) AS c FROM prepared_messages WHERE receipt IS NOT NULL");
    const own = (this.database.prepare("SELECT count(*) AS c FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?").get(sender.host, sender.sessionId) as { c: number }).c;
    return { all, own };
  }
  override prepare(input: Parameters<SessionMessageStore["prepare"]>[0], nowMs = Date.now()) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.prune(nowMs);
      const load = this.receiptLoad(input.sender);
      if (load.all >= MESSAGE_RECEIPT_LIMIT || load.own >= SENDER_RECEIPT_LIMIT) throw new Error("The bounded message receipt store is full; no draft was created.");
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
    return super.prepare(input, nowMs); // prototype only: real change keeps one transaction
  }
  override submitPrepared(sender: { host: string; sessionId: string }, messageId: string, nowMs = Date.now()) {
    const row = this.database.prepare("SELECT receipt FROM prepared_messages WHERE message_id = ? AND sender_host = ? AND sender_session_id = ?").get(messageId, sender.host, sender.sessionId) as { receipt: string | null } | undefined;
    if (row && row.receipt === null) {
      this.prune(nowMs);
      if (this.receiptLoad(sender).own >= SENDER_RECEIPT_LIMIT) throw new Error("The bounded message receipt store is full for this sender.");
    }
    return super.submitPrepared(sender, messageId, nowMs); // prototype only: real change checks inside the same BEGIN IMMEDIATE
  }
  override acknowledge(t: { host: string; sessionId: string }, ids: string[], nowMs = Date.now()) {
    const n = super.acknowledge(t, ids, nowMs);
    const until = new Date(nowMs + H).toISOString();
    const shorten = this.database.prepare(`UPDATE prepared_messages SET expires_at = min(expires_at, ?)
      WHERE receipt IS NOT NULL AND message_id IN (SELECT message_id FROM messages WHERE message_id = ? AND target_host = ? AND target_session_id = ? AND acknowledged_at IS NOT NULL)`);
    for (const id of new Set(ids)) shorten.run(until, id, t.host, t.sessionId);
    return n;
  }
}

function burst(s: SessionMessageStore, sender: typeof hot, n: number, now: number, ttlSeconds?: number, ack = false) {
  let ok = 0, rejected = 0;
  for (let i = 0; i < n; i++) {
    let id: string;
    try { id = s.prepare({ sender, target, body: `m${i}`, ttlSeconds }, now).messageId; } catch { rejected++; continue; }
    try { s.submitPrepared(sender, id, now); ok++; if (ack) s.acknowledge(target, [id], now); } catch { rejected++; }
  }
  return { ok, rejected };
}

it("baseline v2.7.2: ACKed sends still hold the global receipt pool until TTL+1h", () => {
  const s = new SessionMessageStore(":memory:");
  expect(burst(s, hot, 1200, 1000, undefined, true)).toEqual({ ok: 1000, rejected: 200 });
  expect(count(s, "SELECT count(*) AS c FROM messages WHERE acknowledged_at IS NULL")).toBe(0); // spool drained
  expect(burst(s, other, 1, 1000 + H + 1).ok).toBe(0);      // ack+1h: messages pruned, receipts remain
  expect(burst(s, other, 1, 1000 + 2 * H - 1).ok).toBe(0);
  expect(burst(s, other, 1, 1000 + 2 * H).ok).toBe(1);      // TTL(1h)+1h
});

it("baseline v2.7.2: one long-TTL sender blocks every sender for 25h", () => {
  const s = new SessionMessageStore(":memory:");
  expect(burst(s, hot, 1000, 1000, 86400).ok).toBe(1000);
  expect(burst(s, other, 1, 1000 + 25 * H - 1).ok).toBe(0);
  expect(burst(s, other, 1, 1000 + 25 * H).ok).toBe(1);
});

it("baseline v2.7.2: rejected sends leave drafts that exhaust the sender draft limit", () => {
  const s = new SessionMessageStore(":memory:");
  burst(s, hot, 1000, 1000, 86400);
  const r = burst(s, other, 150, 2000);
  expect(r).toEqual({ ok: 0, rejected: 150 });
  expect(count(s, "SELECT count(*) AS c FROM prepared_messages WHERE receipt IS NULL")).toBe(MESSAGE_SENDER_DRAFT_LIMIT);
});

it("proposed: a hot sender is capped by its own quota and cannot block others", () => {
  const s = new Proposed(":memory:");
  expect(burst(s, hot, 1000, 1000, 86400)).toEqual({ ok: SENDER_RECEIPT_LIMIT, rejected: 1000 - SENDER_RECEIPT_LIMIT });
  expect(count(s, "SELECT count(*) AS c FROM prepared_messages WHERE receipt IS NULL")).toBe(0); // F3: no leftover drafts
  expect(burst(s, other, 10, 2000, 86400).ok).toBe(10);
});

it("proposed: ACK bounds receipt retention to ack+1h; same ID is never re-inserted", () => {
  const s = new Proposed(":memory:");
  const draft = s.prepare({ sender: hot, target, body: "x", ttlSeconds: 86400 }, 1000);
  const first = s.submitPrepared(hot, draft.messageId, 1000);
  expect(s.acknowledge(target, [draft.messageId], 2000)).toBe(1);
  expect(s.submitPrepared(hot, draft.messageId, 2000 + H - 1)).toEqual({ ...first, duplicate: true });
  expect(s.status(hot, draft.messageId, 2000 + H - 1)).toMatchObject({ state: "acknowledged" });
  expect(() => s.submitPrepared(hot, draft.messageId, 2000 + H)).toThrow(/unavailable/u);
  // the rejected transaction also rolls back its prune: the old ACKed row may remain, but no second row exists
  expect(count(s, "SELECT count(*) AS c FROM messages WHERE acknowledged_at IS NULL")).toBe(0);
  expect(count(s, "SELECT count(*) AS c FROM messages")).toBeLessThanOrEqual(1);
  s.prune(2000 + H);
  expect(count(s, "SELECT count(*) AS c FROM messages")).toBe(0);
  expect(count(s, "SELECT count(*) AS c FROM prepared_messages")).toBe(0);
  expect(s.status(hot, draft.messageId, 2000 + H)).toBeNull();
  // ACK by a non-target does not shorten the receipt
  const d2 = s.prepare({ sender: hot, target, body: "y", ttlSeconds: 86400 }, 1000);
  s.submitPrepared(hot, d2.messageId, 1000);
  expect(s.acknowledge(other, [d2.messageId], 2000)).toBe(0);
  expect(s.status(hot, d2.messageId, 2000 + 2 * H)).toMatchObject({ state: "queued" });
});

it("proposed: drained senders regain capacity after ack+1h instead of TTL+1h", () => {
  const s = new Proposed(":memory:");
  expect(burst(s, hot, 300, 1000, 86400, true).ok).toBe(SENDER_RECEIPT_LIMIT);
  expect(burst(s, hot, 1, 1000 + H - 1).ok).toBe(0);
  expect(burst(s, hot, 1, 1000 + H).ok).toBe(1);
});

it("proposed: unacknowledged receipts keep message expiry + 1h (unchanged contract)", () => {
  const s = new Proposed(":memory:");
  const d = s.prepare({ sender: hot, target, body: "x", ttlSeconds: 30 }, 1000);
  s.submitPrepared(hot, d.messageId, 1000);
  expect(s.status(hot, d.messageId, 1000 + 30_000 + H - 1)).toMatchObject({ state: "submitted", deliveryState: "unknown" });
  expect(s.status(hot, d.messageId, 1000 + 30_000 + H)).toBeNull();
});
