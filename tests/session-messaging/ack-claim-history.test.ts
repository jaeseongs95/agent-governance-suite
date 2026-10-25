import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

const sender = { host: "opaque-sender", sessionId: "ack-source" };
const target = { host: "opaque-target", sessionId: "ack-recipient" };
const stores = new Set<SessionMessageStore>();
const directories: string[] = [];
function open(database = ":memory:") { const store = new SessionMessageStore(database); stores.add(store); return store; }
function close(store: SessionMessageStore) { store.close(); stores.delete(store); }
afterEach(async () => { for (const store of stores) store.close(); stores.clear(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
function send(store: SessionMessageStore, now = 1000, recipient = target) {
  const prepared = store.prepare({ sender, target: recipient, body: "Synthetic ACK boundary payload", ttlSeconds: 86400 }, now);
  return store.submitPrepared(sender, prepared.messageId, now).messageId;
}
function snapshot(store: SessionMessageStore) {
  // Only message/receipt effects are forbidden: existing ACK activity tracking is a separate contract.
  return { messages: store.database.prepare("SELECT * FROM messages ORDER BY message_id").all(),
    receipts: store.database.prepare("SELECT * FROM prepared_messages ORDER BY message_id").all() };
}
function row(store: SessionMessageStore, messageId: string) {
  return store.database.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as Record<string, unknown>;
}
function receiptExpiry(store: SessionMessageStore, messageId: string) {
  return (store.database.prepare("SELECT expires_at FROM prepared_messages WHERE message_id = ?").get(messageId) as { expires_at: string }).expires_at;
}

describe("AGS-D-0001 ACK requires recipient claim history", () => {
  it("leaves unclaimed messages and receipts untouched, then permits their normal claim and ACK", () => {
    const store = open(); const id = send(store); const before = snapshot(store);
    expect(store.acknowledge(target, [id], 2000)).toBe(0);
    expect(snapshot(store)).toEqual(before);
    expect(store.status(sender, id, 2001)).toMatchObject({ state: "queued", acknowledgedAt: null, claimedAt: null });
    expect(store.claim(target, 2002).map(message => message.messageId)).toEqual([id]);
    expect(store.acknowledge(target, [id], 2003)).toBe(1);
    expect(store.status(sender, id, 2004)).toMatchObject({ state: "acknowledged", acknowledgedAt: new Date(2003).toISOString() });
  });

  it("rejects a different host, a different session and a forged ID even after a real claim", () => {
    const store = open(); const id = send(store);
    expect(store.claim(target, 2000).map(message => message.messageId)).toEqual([id]);
    const before = snapshot(store);
    for (const recipient of [{ ...target, host: "other-host" }, { ...target, sessionId: "other-session" }]) {
      expect(store.acknowledge(recipient, [id], 2001)).toBe(0);
      expect(snapshot(store)).toEqual(before);
    }
    expect(store.acknowledge(target, ["unissued-ACK-id"], 2001)).toBe(0);
    expect(snapshot(store)).toEqual(before);
    expect(store.acknowledge(target, [id], 2002)).toBe(1);
  });

  it("allows a late ACK after lease expiry across connections and never extends its first receipt or ACK", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-history-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3"); const left = open(database), right = open(database);
    const id = send(left);
    const before = snapshot(left);
    expect(right.acknowledge(target, [id], 2000)).toBe(0); expect(snapshot(left)).toEqual(before);
    expect(left.claim(target, 2001).map(message => message.messageId)).toEqual([id]);
    const late = Date.parse(String(row(right, id).claim_until)) + 1;
    expect(right.acknowledge(target, [id], late)).toBe(1);
    const acknowledgedAt = new Date(late).toISOString(); const expiry = receiptExpiry(left, id);
    expect(expiry).toBe(new Date(late + 3600_000).toISOString());
    expect(left.acknowledge(target, [id, id], late + 1000)).toBe(0);
    expect(row(right, id).acknowledged_at).toBe(acknowledgedAt); expect(receiptExpiry(right, id)).toBe(expiry);
    close(left); close(right);
    const reopened = open(database);
    expect(reopened.acknowledge(target, [id], late + 2000)).toBe(0);
    expect(row(reopened, id).acknowledged_at).toBe(acknowledgedAt); expect(receiptExpiry(reopened, id)).toBe(expiry);
  });

  it("accepts legacy claimed history without newer delivery fields while refusing legacy unclaimed rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-legacy-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3"); const old = open(database);
    const delivered = send(old, 1000); const queued = send(old, 1001);
    expect(old.claim(target, 2000, { maxMessages: 1 }).map(message => message.messageId)).toEqual([delivered]);
    old.database.exec("ALTER TABLE messages DROP COLUMN delivery_attempts; ALTER TABLE messages DROP COLUMN first_delivered_at;");
    close(old); const reopened = open(database);
    expect(reopened.status(sender, delivered, 2001)).toMatchObject({ state: "delivered", deliveryAttempts: 0, firstDeliveredAt: null });
    expect(row(reopened, delivered).claimed_at).not.toBeNull();
    const queuedBefore = row(reopened, queued); const expiry = receiptExpiry(reopened, queued);
    expect(reopened.acknowledge(target, [queued], 2002)).toBe(0);
    expect(row(reopened, queued)).toEqual(queuedBefore); expect(receiptExpiry(reopened, queued)).toBe(expiry);
    expect(reopened.acknowledge(target, [delivered], 2003)).toBe(1);
  });

  it("counts only the first valid ID in a mixed batch and preserves other queued recipients", () => {
    const store = open(); const delivered = send(store, 1000), queued = send(store, 1001);
    const foreign = send(store, 1002, { ...target, sessionId: "foreign-recipient" });
    expect(store.claim(target, 2000, { maxMessages: 1 }).map(message => message.messageId)).toEqual([delivered]);
    const queuedBefore = row(store, queued), foreignBefore = row(store, foreign);
    const queuedExpiry = receiptExpiry(store, queued), foreignExpiry = receiptExpiry(store, foreign);
    expect(store.acknowledge(target, [queued, delivered, foreign, "forged-id", delivered], 2001)).toBe(1);
    expect(row(store, queued)).toEqual(queuedBefore); expect(row(store, foreign)).toEqual(foreignBefore);
    expect(receiptExpiry(store, queued)).toBe(queuedExpiry); expect(receiptExpiry(store, foreign)).toBe(foreignExpiry);
    expect(row(store, delivered).acknowledged_at).toBe(new Date(2001).toISOString());
    expect(receiptExpiry(store, delivered)).toBe(new Date(2001 + 3600_000).toISOString());
  });
});
