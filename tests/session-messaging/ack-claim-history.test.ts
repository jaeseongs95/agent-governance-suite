import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
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
    const claimed = store.claim(target, 2002);
    expect(claimed.map(message => message.messageId)).toEqual([id]);
    expect(store.acknowledge(target, [id], 2003, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    expect(store.status(sender, id, 2004)).toMatchObject({ state: "acknowledged", acknowledgedAt: new Date(2003).toISOString() });
  });

  it("rejects a different host, a different session and a forged ID even after a real claim", () => {
    const store = open(); const id = send(store);
    const claimed = store.claim(target, 2000);
    expect(claimed.map(message => message.messageId)).toEqual([id]);
    const before = snapshot(store);
    for (const recipient of [{ ...target, host: "other-host" }, { ...target, sessionId: "other-session" }]) {
      expect(store.acknowledge(recipient, [id], 2001, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
      expect(snapshot(store)).toEqual(before);
    }
    expect(store.acknowledge(target, ["unissued-ACK-id"], 2001)).toBe(0);
    expect(snapshot(store)).toEqual(before);
    expect(store.acknowledge(target, [id], 2002, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  });

  it("allows a late ACK after lease expiry across connections and never extends its first receipt or ACK", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-history-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3"); const left = open(database), right = open(database);
    const id = send(left);
    const before = snapshot(left);
    expect(right.acknowledge(target, [id], 2000)).toBe(0); expect(snapshot(left)).toEqual(before);
    const claimed = left.claim(target, 2001);
    expect(claimed.map(message => message.messageId)).toEqual([id]);
    const late = Date.parse(String(row(right, id).claim_until)) + 1;
    expect(right.acknowledge(target, [id], late, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    const acknowledgedAt = new Date(late).toISOString(); const expiry = receiptExpiry(left, id);
    expect(expiry).toBe(new Date(late + 3600_000).toISOString());
    expect(left.acknowledge(target, [id, id], late + 1000, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
    expect(row(right, id).acknowledged_at).toBe(acknowledgedAt); expect(receiptExpiry(right, id)).toBe(expiry);
    close(left); close(right);
    const reopened = open(database);
    expect(reopened.acknowledge(target, [id], late + 2000, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
    expect(row(reopened, id).acknowledged_at).toBe(acknowledgedAt); expect(receiptExpiry(reopened, id)).toBe(expiry);
  });

  it("accepts legacy claimed history without newer delivery fields while refusing legacy unclaimed rows", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-legacy-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3"); const old = open(database);
    const delivered = send(old, 1000); const queued = send(old, 1001);
    const claimed = old.claim(target, 2000, { maxMessages: 1 });
    expect(claimed.map(message => message.messageId)).toEqual([delivered]);
    old.database.exec("ALTER TABLE messages DROP COLUMN acknowledgement_receipt; ALTER TABLE messages DROP COLUMN claim_receipt; ALTER TABLE messages DROP COLUMN legacy_claim_attempt; ALTER TABLE messages DROP COLUMN delivery_attempts; ALTER TABLE messages DROP COLUMN first_delivered_at; PRAGMA user_version = 1;");
    close(old); const reopened = open(database);
    expect(reopened.status(sender, delivered, 2001)).toMatchObject({ state: "delivered", deliveryAttempts: 0, firstDeliveredAt: null });
    expect(row(reopened, delivered).claimed_at).not.toBeNull();
    const queuedBefore = row(reopened, queued); const expiry = receiptExpiry(reopened, queued);
    expect(reopened.acknowledge(target, [queued], 2002)).toBe(0);
    expect(row(reopened, queued)).toEqual(queuedBefore); expect(receiptExpiry(reopened, queued)).toBe(expiry);
    expect(row(reopened, delivered).claim_receipt).toBeNull();
    expect(reopened.acknowledge(target, [delivered], 2003)).toBe(1);
  });

  it("counts only the first valid ID in a mixed batch and preserves other queued recipients", () => {
    const store = open(); const delivered = send(store, 1000), queued = send(store, 1001);
    const foreign = send(store, 1002, { ...target, sessionId: "foreign-recipient" });
    const claimed = store.claim(target, 2000, { maxMessages: 1 });
    expect(claimed.map(message => message.messageId)).toEqual([delivered]);
    const queuedBefore = row(store, queued), foreignBefore = row(store, foreign);
    const queuedExpiry = receiptExpiry(store, queued), foreignExpiry = receiptExpiry(store, foreign);
    expect(store.acknowledge(target, [queued, delivered, foreign, "forged-id", delivered], 2001, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    expect(row(store, queued)).toEqual(queuedBefore); expect(row(store, foreign)).toEqual(foreignBefore);
    expect(receiptExpiry(store, queued)).toBe(queuedExpiry); expect(receiptExpiry(store, foreign)).toBe(foreignExpiry);
    expect(row(store, delivered).acknowledged_at).toBe(new Date(2001).toISOString());
    expect(receiptExpiry(store, delivered)).toBe(new Date(2001 + 3600_000).toISOString());
  });
});

// 구 연결의 SQL에도 적용되는 DB 불변조건을 실제 SQLite 경계에서 검사한다.
function allRows(store: SessionMessageStore) {
  return Object.fromEntries([
    "messages", "prepared_messages", "input_observations", "session_activity",
    "wake_nonces", "session_presence", "relay_leases",
  ].map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}

describe("D0354 혼합 버전 SQL의 claim 영수증 경계", () => {
  it("새 회차 뒤 구 SQL의 delivery_attempts 단독 증가는 CHECK 실패이며 모든 행을 보존한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-old-claim-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3");
    const store = open(database), legacy = new DatabaseSync(database);
    try {
      const id = send(store);
      const oldUpdate = legacy.prepare("UPDATE messages SET delivery_attempts = delivery_attempts + 1 WHERE message_id = ?");
      const first = store.claim(target, 2000);
      const current = store.claim(target, 122_001);
      expect(first).toMatchObject([{ messageId: id, deliveryAttempt: 1 }]);
      expect(current).toMatchObject([{ messageId: id, deliveryAttempt: 2 }]);
      expect(current[0]!.claimReceipt).toMatch(/^2:[0-9a-f-]{36}$/u);
      const before = allRows(store);
      expect(() => oldUpdate.run(id)).toThrow(/CHECK constraint failed/u);
      expect(allRows(store)).toEqual(before);
      expect(store.acknowledge(target, [id], 122_002, current.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    } finally { legacy.close(); }
  });

  it("새 회차 뒤 구 SQL의 acknowledged_at 단독 설정은 CHECK 실패이며 모든 행을 보존한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-old-update-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3");
    const store = open(database), legacy = new DatabaseSync(database);
    try {
      const id = send(store);
      const oldUpdate = legacy.prepare("UPDATE messages SET acknowledged_at = ? WHERE message_id = ?");
      expect(store.claim(target, 2000)).toMatchObject([{ messageId: id, deliveryAttempt: 1 }]);
      const current = store.claim(target, 122_001);
      expect(current).toMatchObject([{ messageId: id, deliveryAttempt: 2 }]);
      const before = allRows(store);
      expect(() => oldUpdate.run(new Date(122_002).toISOString(), id)).toThrow(/CHECK constraint failed/u);
      expect(allRows(store)).toEqual(before);
      expect(store.acknowledge(target, [id], 122_003, current.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    } finally { legacy.close(); }
  });

  it("재인수 없는 임대 만료 뒤에도 해당 회차의 원영수증 ACK와 그 중복 방지는 유지한다", () => {
    const store = open(), id = send(store);
    const first = store.claim(target, 2000);
    const current = store.claim(target, 122_001);
    expect(current).toMatchObject([{ messageId: id, deliveryAttempt: 2 }]);
    expect(current[0]!.claimReceipt).not.toBe(first[0]!.claimReceipt);
    const before = allRows(store);
    const late = 362_002; // 두 번째 240초 임대가 끝난 뒤이며 추가 claim은 없다.
    expect(store.acknowledge(target, [id], late, first.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(0);
    expect(allRows(store)).toEqual(before);
    const receipts = current.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! }));
    expect(store.acknowledge(target, [id], late, receipts)).toBe(1);
    expect(row(store, id)).toMatchObject({ claim_receipt: current[0]!.claimReceipt,
      acknowledgement_receipt: current[0]!.claimReceipt, acknowledged_at: new Date(late).toISOString() });
    const after = allRows(store);
    expect(store.acknowledge(target, [id], late + 1, receipts)).toBe(0);
    expect(allRows(store)).toEqual(after);
  });
});


describe("D0354 구 SQL의 NULL 영수증 재인수 차단", () => {
  it("v1 대기 행은 이전 뒤 구 writer의 첫 claim을 거부하고 모든 행을 보존한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-v1-queued-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3");
    const previous = open(database), id = send(previous);
    previous.database.exec("ALTER TABLE messages DROP COLUMN acknowledgement_receipt; ALTER TABLE messages DROP COLUMN claim_receipt; ALTER TABLE messages DROP COLUMN legacy_claim_attempt; PRAGMA user_version = 1;");
    close(previous);
    const legacy = new DatabaseSync(database);
    try {
      const oldClaim = legacy.prepare("UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE message_id = ?");
      const current = open(database);
      expect(row(current, id)).toMatchObject({ claimed_at: null, claim_receipt: null, legacy_claim_attempt: 0, delivery_attempts: 0 });
      const before = allRows(current);
      expect(() => oldClaim.run(new Date(2000).toISOString(), new Date(122_000).toISOString(), id)).toThrow(/CHECK constraint failed/u);
      expect(allRows(current)).toEqual(before);
      const claimed = current.claim(target, 2000);
      expect(claimed).toMatchObject([{ messageId: id, deliveryAttempt: 1 }]);
      expect(current.acknowledge(target, [id], 2001, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    } finally { legacy.close(); }
  });

  it("v1 역사 NULL 행은 원회차 상한을 보존하고 구 writer의 재claim을 거부한다", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "ags-ack-v1-claimed-")); directories.push(directory);
    const database = path.join(directory, "messages.sqlite3");
    const previous = open(database), id = send(previous);
    expect(previous.claim(target, 2000)).toMatchObject([{ messageId: id, deliveryAttempt: 1 }]);
    previous.database.exec("ALTER TABLE messages DROP COLUMN acknowledgement_receipt; ALTER TABLE messages DROP COLUMN claim_receipt; ALTER TABLE messages DROP COLUMN legacy_claim_attempt; PRAGMA user_version = 1;");
    close(previous);
    const legacy = new DatabaseSync(database);
    try {
      const oldClaim = legacy.prepare("UPDATE messages SET claimed_at = ?, claim_until = ?, delivery_attempts = delivery_attempts + 1 WHERE message_id = ?");
      const current = open(database);
      expect(row(current, id)).toMatchObject({ claim_receipt: null, legacy_claim_attempt: 1, delivery_attempts: 1 });
      const before = allRows(current);
      expect(() => oldClaim.run(new Date(122_001).toISOString(), new Date(362_001).toISOString(), id)).toThrow(/CHECK constraint failed/u);
      expect(allRows(current)).toEqual(before);
      const claimed = current.claim(target, 122_001);
      expect(claimed).toMatchObject([{ messageId: id, deliveryAttempt: 2 }]);
      expect(current.acknowledge(target, [id], 122_002, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
      expect(row(current, id).legacy_claim_attempt).toBe(1);
    } finally { legacy.close(); }
  });
});
