import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import * as storeModule from "../../mcp-server/src/session-message-store.js";
import { SessionMessageStore, MESSAGE_ID_RECORD_BYTES_LIMIT, MESSAGE_RECEIPT_LIMIT } from "../../mcp-server/src/session-message-store.js";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

// Receipt retention limits: sender quota (F1), ACK-bounded receipt expiry (F2), prepare admission (F3)
// and capacity rejection details (D1). The sender quota is fairness between cooperating sessions, not authentication.
const SENDER_LIMIT = 250;
const H = 3600_000;
const target = { host: "test-host", sessionId: "retention-target" };
const hot = { host: "test-host", sessionId: "retention-hot" };
const other = { host: "test-host", sessionId: "retention-other" };
const root = process.env.PEER_WAIT_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const children: ChildProcess[] = [];
const stores: SessionMessageStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});
const fixture = (database = ":memory:") => { const store = new SessionMessageStore(database); stores.push(store); return store; };
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ags-retention-")); directories.push(value); return value; }
const iso = (ms: number) => new Date(ms).toISOString();
const scalar = (store: SessionMessageStore, sql: string, ...args: string[]) => (store.database.prepare(sql).get(...args) as { value: number | string | null }).value;
const receipts = (store: SessionMessageStore, sender?: typeof hot) => Number(sender
  ? scalar(store, "SELECT count(*) AS value FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?", sender.host, sender.sessionId)
  : scalar(store, "SELECT count(*) AS value FROM prepared_messages WHERE receipt IS NOT NULL"));
const drafts = (store: SessionMessageStore) => Number(scalar(store, "SELECT count(*) AS value FROM prepared_messages WHERE receipt IS NULL"));
const rows = (store: SessionMessageStore) => Number(scalar(store, "SELECT count(*) AS value FROM messages"));
const receiptExpiry = (store: SessionMessageStore, messageId: string) => scalar(store, "SELECT expires_at AS value FROM prepared_messages WHERE message_id = ?", messageId);
const earliest = (store: SessionMessageStore, sender?: typeof hot) => sender
  ? scalar(store, "SELECT min(expires_at) AS value FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?", sender.host, sender.sessionId)
  : scalar(store, "SELECT min(expires_at) AS value FROM prepared_messages WHERE receipt IS NOT NULL");
function sendNew(store: SessionMessageStore, sender: typeof hot, nowMs: number, ttlSeconds?: number) {
  const draft = store.prepare({ sender, target, body: "Synthetic retention message", ...(ttlSeconds === undefined ? {} : { ttlSeconds }) }, nowMs);
  return store.submitPrepared(sender, draft.messageId, nowMs);
}
function rejection(action: () => unknown): Error & { details?: unknown } {
  try { action(); } catch (error) { return error as Error & { details?: unknown }; }
  throw new Error("expected a rejection");
}

it("exports the sender receipt limit next to the unchanged global limit", () => {
  expect((storeModule as Record<string, unknown>).MESSAGE_SENDER_RECEIPT_LIMIT).toBe(SENDER_LIMIT);
  expect(MESSAGE_RECEIPT_LIMIT).toBe(1000);
});

it("caps one sender at the sender limit (limit-1, limit, limit+1) without blocking other senders", () => {
  const store = fixture();
  for (let index = 0; index < SENDER_LIMIT - 1; index++) expect(sendNew(store, hot, 1000 + index).duplicate).toBe(false);
  expect(receipts(store, hot)).toBe(SENDER_LIMIT - 1);
  const atLimit = store.prepare({ sender: hot, target, body: "exactly at the limit" }, 2000);
  const overLimit = store.prepare({ sender: hot, target, body: "one over the limit" }, 2000);
  expect(store.submitPrepared(hot, atLimit.messageId, 2001).duplicate).toBe(false);
  expect(receipts(store, hot)).toBe(SENDER_LIMIT);
  const beforeRows = rows(store);
  const sendRejected = rejection(() => store.submitPrepared(hot, overLimit.messageId, 2002));
  expect(sendRejected.message).toMatch(/receipt store is full for this sender/u);
  expect(sendRejected.details).toEqual({ scope: "sender", earliestReleaseAt: earliest(store, hot) });
  expect(sendRejected.details).toEqual({ scope: "sender", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(rows(store)).toBe(beforeRows);
  expect(store.status(hot, overLimit.messageId, 2003)).toMatchObject({ state: "prepared" });
  // F3: prepare admission refuses to create a draft that the authoritative send check would reject.
  const draftsBefore = drafts(store);
  const prepareRejected = rejection(() => store.prepare({ sender: hot, target, body: "no draft" }, 2004));
  expect(prepareRejected.message).toMatch(/receipt store is full for this sender; no draft was created/u);
  expect(prepareRejected.message).not.toMatch(/preparation store/u);
  expect(prepareRejected.details).toEqual({ scope: "sender", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(drafts(store)).toBe(draftsBefore);
  expect(sendNew(store, other, 2005).duplicate).toBe(false);
  expect(receipts(store)).toBe(SENDER_LIMIT + 1);
  // The earliest receipt frees exactly at its expiry; then the same sender can prepare and send again.
  expect(() => store.prepare({ sender: hot, target, body: "still full" }, 1000 + 2 * H - 1)).toThrow(/for this sender/u);
  expect(sendNew(store, hot, 1000 + 2 * H).duplicate).toBe(false);
});

it("rejects prepare and send with global scope when the global receipt pool is full", () => {
  const store = fixture();
  const late = { host: "test-host", sessionId: "retention-late" };
  for (let index = 0; index < MESSAGE_RECEIPT_LIMIT - 1; index++) sendNew(store, { host: "test-host", sessionId: `retention-global-${index % 4}` }, 1000 + index);
  const pending = store.prepare({ sender: late, target, body: "prepared before the pool filled" }, 5000);
  sendNew(store, { host: "test-host", sessionId: "retention-filler" }, 5001);
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT);
  const draftsBefore = drafts(store);
  const prepareRejected = rejection(() => store.prepare({ sender: late, target, body: "no draft" }, 5002));
  expect(prepareRejected.message).toMatch(/^The bounded message receipt store is full; no draft was created\.$/u);
  expect(prepareRejected.details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(drafts(store)).toBe(draftsBefore);
  const sendRejected = rejection(() => store.submitPrepared(late, pending.messageId, 5003));
  expect(sendRejected.message).toMatch(/^The bounded message receipt store is full\.$/u);
  expect(sendRejected.details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(store.status(late, pending.messageId, 5004)).toMatchObject({ state: "prepared" });
});

it("bounds an acknowledged receipt to ACK+1h; the same ID is never re-inserted", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000, 86400);
  const messageExpiry = Date.parse(sent.expiresAt);
  expect(receiptExpiry(store, sent.messageId)).toBe(iso(messageExpiry + H));
  const ackAt = 2000;
  expect(store.acknowledge(target, [sent.messageId], ackAt)).toBe(1);
  expect(receiptExpiry(store, sent.messageId)).toBe(iso(Math.min(messageExpiry + H, ackAt + H)));
  expect(store.submitPrepared(hot, sent.messageId, ackAt + H - 1)).toEqual({ ...sent, duplicate: true, autoWake: { ...sent.autoWake, checkedAt: new Date(ackAt + H - 1).toISOString() } });
  expect(store.status(hot, sent.messageId, ackAt + H - 1)).toMatchObject({ state: "acknowledged" });
  expect(() => store.submitPrepared(hot, sent.messageId, ackAt + H)).toThrow(/unavailable/u);
  expect(Number(scalar(store, "SELECT count(*) AS value FROM messages WHERE message_id = ?", sent.messageId))).toBeLessThanOrEqual(1);
  expect(store.status(hot, sent.messageId, ackAt + H)).toBeNull();
  expect(receipts(store, hot)).toBe(0);
  // An ACK of an expired but not yet pruned row never extends the receipt.
  const shortLived = sendNew(store, hot, 10_000, 30);
  expect(store.acknowledge(target, [shortLived.messageId], 10_000 + 40_000)).toBe(1);
  expect(receiptExpiry(store, shortLived.messageId)).toBe(iso(10_000 + 30_000 + H));
});

it("drained senders regain capacity at ACK+1h instead of message expiry+1h", () => {
  const store = fixture();
  const ids = Array.from({ length: SENDER_LIMIT }, () => sendNew(store, hot, 1000, 86400).messageId);
  for (let index = 0; index < ids.length; index += 50) expect(store.acknowledge(target, ids.slice(index, index + 50), 1000)).toBe(50);
  expect(() => store.prepare({ sender: hot, target, body: "still held" }, 1000 + H - 1)).toThrow(/for this sender/u);
  expect(sendNew(store, hot, 1000 + H, 86400).duplicate).toBe(false);
});

it("second ACK, another session's ACK and unknown-ID ACK leave receipt expiry unchanged", () => {
  const store = fixture();
  const first = sendNew(store, hot, 1000, 86400);
  const second = sendNew(store, hot, 1000, 86400);
  const snapshot = () => store.database.prepare("SELECT message_id, expires_at FROM prepared_messages ORDER BY message_id").all();
  const initial = snapshot();
  expect(store.acknowledge(other, [first.messageId, second.messageId], 2000)).toBe(0);
  expect(store.acknowledge(target, ["unknown-retention-id"], 2000)).toBe(0);
  expect(snapshot()).toEqual(initial);
  expect(store.acknowledge(target, [first.messageId], 3000)).toBe(1);
  expect(receiptExpiry(store, first.messageId)).toBe(iso(3000 + H));
  const afterFirst = snapshot();
  expect(store.acknowledge(target, [first.messageId], 4000)).toBe(0);
  expect(snapshot()).toEqual(afterFirst);
  expect(receiptExpiry(store, second.messageId)).toBe(iso(Date.parse(second.expiresAt) + H));
  expect(store.status(hot, second.messageId, 3000 + 2 * H)).toMatchObject({ state: "queued" });
});

it("unacknowledged receipts keep message expiry + 1h", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000, 30);
  expect(receiptExpiry(store, sent.messageId)).toBe(iso(1000 + 30_000 + H));
  expect(store.status(hot, sent.messageId, 1000 + 30_000)).toMatchObject({ state: "submitted", deliveryState: "unknown" });
  expect(store.status(hot, sent.messageId, 1000 + 30_000 + H - 1)).toMatchObject({ state: "submitted", deliveryState: "unknown" });
  expect(store.status(hot, sent.messageId, 1000 + 30_000 + H)).toBeNull();
});

async function race(database: string, requests: Array<{ operation: "send" | "acknowledge"; sender: typeof hot; messageId: string; nowMs: number }>) {
  const workers = requests.map(() => spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/issued-send-worker.ts", import.meta.url)), database], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  children.push(...workers);
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const results = workers.map((worker) => once(worker, "message"));
  const exits = workers.map((worker) => once(worker, "exit"));
  workers.forEach((worker, index) => worker.send({ ...requests[index], target }));
  const output = (await Promise.all(results)).map(([value]) => value as { result?: unknown; error?: string });
  await Promise.all(exits);
  return output;
}

it("two processes sending for one sender at limit-1 never exceed the sender limit", async () => {
  const database = path.join(await directory(), "sender-race.sqlite3");
  const store = fixture(database);
  for (let index = 0; index < SENDER_LIMIT - 1; index++) sendNew(store, hot, 1000);
  const [left, right] = [0, 1].map(() => store.prepare({ sender: hot, target, body: "concurrent" }, 1500).messageId);
  const output = await race(database, [
    { operation: "send", sender: hot, messageId: left!, nowMs: 2000 },
    { operation: "send", sender: hot, messageId: right!, nowMs: 2000 },
  ]);
  expect(output.filter((value) => value.result)).toHaveLength(1);
  expect(output.filter((value) => value.error)).toHaveLength(1);
  expect(output.find((value) => value.error)?.error).toMatch(/receipt store is full for this sender/u);
  expect(receipts(store, hot)).toBe(SENDER_LIMIT);
  expect(rows(store)).toBe(SENDER_LIMIT);
}, 20_000);

it("concurrent send and ACK keep one row and only shorten receipt expiry", async () => {
  const database = path.join(await directory(), "ack-race.sqlite3");
  const store = fixture(database);
  const draft = store.prepare({ sender: hot, target, body: "send or ack first", ttlSeconds: 86400 }, 1000);
  const output = await race(database, [
    { operation: "send", sender: hot, messageId: draft.messageId, nowMs: 2000 },
    { operation: "acknowledge", sender: hot, messageId: draft.messageId, nowMs: 2000 },
  ]);
  const sent = output[0]!.result as { expiresAt: string; duplicate: boolean };
  expect(sent.duplicate).toBe(false);
  expect(Number(scalar(store, "SELECT count(*) AS value FROM messages WHERE message_id = ?", draft.messageId))).toBe(1);
  const acknowledged = output[1]!.result as number;
  const initial = String(receiptExpiry(store, draft.messageId));
  expect(initial).toBe(acknowledged === 1 ? iso(2000 + H) : iso(Date.parse(sent.expiresAt) + H));
  store.acknowledge(target, [draft.messageId], 3000);
  const later = String(receiptExpiry(store, draft.messageId));
  expect(later <= initial).toBe(true);
  store.acknowledge(target, [draft.messageId], 4000);
  expect(String(receiptExpiry(store, draft.messageId))).toBe(later);
}, 20_000);

it("opens a v2.7.2 receipt without migration and applies ACK+1h only to new ACKs", async () => {
  const database = path.join(await directory(), "v272.sqlite3");
  const legacy = fixture(database);
  const old = sendNew(legacy, hot, 1000, 86400);
  const fresh = sendNew(legacy, hot, 1000, 86400);
  // v2.7.2 acknowledge updated only the messages row; its receipt kept message expiry + 1h.
  legacy.database.prepare("UPDATE messages SET acknowledged_at = ?, claim_until = NULL WHERE message_id = ?").run(iso(2000), old.messageId);
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);
  const reopened = fixture(database);
  const legacyExpiry = iso(Date.parse(old.expiresAt) + H);
  expect(receiptExpiry(reopened, old.messageId)).toBe(legacyExpiry);
  expect(reopened.acknowledge(target, [old.messageId], 3000)).toBe(0);
  expect(receiptExpiry(reopened, old.messageId)).toBe(legacyExpiry);
  expect(reopened.acknowledge(target, [fresh.messageId], 3000)).toBe(1);
  expect(receiptExpiry(reopened, fresh.messageId)).toBe(iso(3000 + H));
  expect(reopened.status(hot, old.messageId, 2000 + H)).toMatchObject({ state: "submitted", deliveryState: "unknown", receiptExpiresAt: legacyExpiry });
  expect(reopened.status(hot, fresh.messageId, 3000 + H)).toBeNull();
});

async function launchBroker() {
  const state = await directory();
  const child = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000);
  return state;
}

it("service reports capacity rejections as definite no-effect with scope and earliest release details", async () => {
  const state = await launchBroker();
  const store = fixture(path.join(state, "session-messages.sqlite3"));
  const service = new SessionMessageService(state);
  const call = { targetHost: target.host, targetSessionId: target.sessionId };
  const now = Date.now();
  const firstSent = sendNew(store, hot, now);
  for (let index = 1; index < SENDER_LIMIT - 1; index++) sendNew(store, hot, now);
  const prepared = await service.prepare({ ...call, body: "prepared before the limit", _sessionBinding: hot });
  expect(prepared.ok).toBe(true);
  sendNew(store, hot, now);
  const release = earliest(store, hot);
  const sendRejected = await service.send({ messageId: (prepared.data as { messageId: string }).messageId, _sessionBinding: hot });
  expect(sendRejected).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { scope: "sender", earliestReleaseAt: release } } });
  expect(sendRejected.error?.message).toMatch(/receipt store is full for this sender/u);
  expect(sendRejected.error?.message).toContain("not queued");
  expect(sendRejected.error?.message).toContain(String(release));
  expect(sendRejected.error?.message).not.toMatch(/do not prepare again/u);
  // The rejected draft remains usable until it expires: one of same-ID retry or new prepare, never both.
  expect(sendRejected.error?.message).toContain("stays prepared until its draft expires");
  expect(sendRejected.error?.message).toMatch(/either retry that same messageId or prepare again, not both/u);
  const prepareRejected = await service.prepare({ ...call, body: "no draft", _sessionBinding: hot });
  expect(prepareRejected).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { scope: "sender", earliestReleaseAt: release } } });
  expect(prepareRejected.error?.message).toContain("no draft was created");
  expect(prepareRejected.error?.message).toContain(String(release));
  // Uncertain outcomes keep the same-ID retry guidance and carry no capacity details.
  const unknown = await service.send({ messageId: "unknown-retention-id", _sessionBinding: hot });
  expect(unknown).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: null } });
  expect(unknown.error?.message).toMatch(/Retry only the known prepared ID/u);
  for (let index = SENDER_LIMIT; index < MESSAGE_RECEIPT_LIMIT; index++) sendNew(store, { host: "test-host", sessionId: `retention-global-${index % 3}` }, now);
  const globalRejected = await service.prepare({ ...call, body: "global", _sessionBinding: other });
  expect(globalRejected).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: { scope: "global", earliestReleaseAt: earliest(store) } } });
  // A resend of an already queued ID stays an idempotent duplicate while both limits are full.
  const rowsBefore = rows(store);
  const resent = await service.send({ messageId: firstSent.messageId, _sessionBinding: hot });
  expect(resent).toMatchObject({ ok: true, error: null, data: { ...firstSent, duplicate: true, autoWake: { ...firstSent.autoWake, checkedAt: expect.any(String) } } });
  expect(rows(store)).toBe(rowsBefore);
}, 30_000);

it("a resend of an already sent ID at full sender and global capacity is a duplicate, not a capacity rejection", () => {
  const store = fixture();
  const sent = Array.from({ length: SENDER_LIMIT }, (_, index) => sendNew(store, hot, 1000 + index));
  expect(receipts(store, hot)).toBe(SENDER_LIMIT);
  expect(store.submitPrepared(hot, sent[0]!.messageId, 5000)).toEqual({ ...sent[0], duplicate: true, autoWake: { ...sent[0]!.autoWake, checkedAt: new Date(5000).toISOString() } });
  expect(store.submitPrepared(hot, sent[SENDER_LIMIT - 1]!.messageId, 5000)).toEqual({ ...sent[SENDER_LIMIT - 1], duplicate: true, autoWake: { ...sent[SENDER_LIMIT - 1]!.autoWake, checkedAt: new Date(5000).toISOString() } });
  expect(rows(store)).toBe(SENDER_LIMIT);
  expect(receipts(store, hot)).toBe(SENDER_LIMIT);
  for (let index = SENDER_LIMIT; index < MESSAGE_RECEIPT_LIMIT; index++) sendNew(store, { host: "test-host", sessionId: `retention-dup-${index % 3}` }, 6000);
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT);
  expect(store.submitPrepared(hot, sent[1]!.messageId, 7000)).toEqual({ ...sent[1], duplicate: true, autoWake: { ...sent[1]!.autoWake, checkedAt: new Date(7000).toISOString() } });
  expect(rows(store)).toBe(MESSAGE_RECEIPT_LIMIT);
});

it("reports sender scope and the sender's own earliest expiry when sender and global limits are both full", () => {
  const store = fixture();
  // Other senders' receipts expire first, so the global earliest differs from the full sender's earliest.
  for (let index = 0; index < MESSAGE_RECEIPT_LIMIT - SENDER_LIMIT; index++) sendNew(store, { host: "test-host", sessionId: `retention-both-${index % 3}` }, 1000);
  const pending = store.prepare({ sender: hot, target, body: "prepared below both limits" }, 2000);
  for (let index = 0; index < SENDER_LIMIT; index++) sendNew(store, hot, 3000 + index);
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT);
  expect(receipts(store, hot)).toBe(SENDER_LIMIT);
  const senderRelease = { scope: "sender", earliestReleaseAt: iso(3000 + 2 * H) };
  expect(earliest(store)).toBe(iso(1000 + 2 * H));
  const prepareRejected = rejection(() => store.prepare({ sender: hot, target, body: "no draft" }, 4000));
  expect(prepareRejected.message).toBe("The bounded message receipt store is full for this sender; no draft was created.");
  expect(prepareRejected.details).toEqual(senderRelease);
  const sendRejected = rejection(() => store.submitPrepared(hot, pending.messageId, 4000));
  expect(sendRejected.message).toBe("The bounded message receipt store is full for this sender.");
  expect(sendRejected.details).toEqual(senderRelease);
  expect(rejection(() => store.prepare({ sender: other, target, body: "global" }, 4000)).details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
});

it("byte-limit send rejection carries global details and releases exactly at the earliest record expiry", () => {
  const store = fixture();
  const bigBody = "\u0001".repeat(4096);
  let bigDrafts = 0;
  for (;;) {
    try { store.prepare({ sender: { host: "test-host", sessionId: `retention-bytes-${Math.floor(bigDrafts / 90)}` }, target, body: bigBody }, 1000); bigDrafts++; }
    catch (error) { expect(String(error)).toMatch(/preparation store is full/u); break; }
  }
  const tiny = store.prepare({ sender: hot, target, body: "t" }, 5000);
  const usedBytes = () => Number(scalar(store, "SELECT coalesce(sum(record_bytes), 0) AS value FROM prepared_messages"));
  // Top up with later drafts until fewer bytes remain than the draft-to-receipt growth of `tiny`.
  const overhead = Buffer.byteLength(JSON.stringify({ sender: other, target, body: "", ttlSeconds: 3600, messageId: "00000000-0000-0000-0000-000000000000", preparedAt: iso(6000), expiresAt: iso(6000 + 600_000) }), "utf8");
  let filler = MESSAGE_ID_RECORD_BYTES_LIMIT - usedBytes() - overhead - 5;
  while (filler > 4096) { store.prepare({ sender: other, target, body: "a".repeat(4096) }, 6000); filler -= 4096 + overhead; }
  expect(filler).toBeGreaterThan(0);
  store.prepare({ sender: other, target, body: "a".repeat(filler) }, 6000);
  expect(MESSAGE_ID_RECORD_BYTES_LIMIT - usedBytes()).toBeLessThan(100);
  expect(receipts(store)).toBe(0);
  const releaseAt = 1000 + 600_000;
  const rejected = rejection(() => store.submitPrepared(hot, tiny.messageId, 7000));
  expect(rejected.message).toBe("The bounded message receipt store is full.");
  expect(rejected.details).toEqual({ scope: "global", earliestReleaseAt: iso(releaseAt) });
  expect(rows(store)).toBe(0);
  const beforeRelease = rejection(() => store.submitPrepared(hot, tiny.messageId, releaseAt - 1));
  expect(beforeRelease.details).toEqual({ scope: "global", earliestReleaseAt: iso(releaseAt) });
  expect(store.submitPrepared(hot, tiny.messageId, releaseAt).duplicate).toBe(false);
  expect(rows(store)).toBe(1);
});

it("rolls back the whole ACK when the receipt update fails inside the same transaction", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000, 86400);
  const before = receiptExpiry(store, sent.messageId);
  // Fault injection through the test database only; product code has no test path.
  store.database.exec(`CREATE TRIGGER retention_fail_receipt BEFORE UPDATE OF expires_at ON prepared_messages
    BEGIN SELECT RAISE(ABORT, 'injected receipt update failure'); END;`);
  expect(() => store.acknowledge(target, [sent.messageId], 2000)).toThrow(/injected receipt update failure/u);
  expect(scalar(store, "SELECT acknowledged_at AS value FROM messages WHERE message_id = ?", sent.messageId)).toBeNull();
  expect(receiptExpiry(store, sent.messageId)).toBe(before);
  expect(store.status(hot, sent.messageId, 2001)).toMatchObject({ state: "queued", acknowledgedAt: null });
  store.database.exec("DROP TRIGGER retention_fail_receipt");
  expect(store.acknowledge(target, [sent.messageId], 3000)).toBe(1);
  expect(receiptExpiry(store, sent.messageId)).toBe(iso(3000 + H));
});
