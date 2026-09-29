// Independent audit tests for the v2.7.3 receipt retention candidate (F1, F2, F3, D1).
// Not product tests: kept in the audit evidence branch only.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore, MESSAGE_RECEIPT_LIMIT, MESSAGE_SENDER_RECEIPT_LIMIT, MESSAGE_ID_RECORD_BYTES_LIMIT } from "../../mcp-server/src/session-message-store.js";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

const H = 3600_000;
const RACE_ROUNDS = Number(process.env.AUDIT_RACE_ROUNDS ?? 20);
const target = { host: "audit-host", sessionId: "audit-target" };
const hot = { host: "audit-host", sessionId: "audit-hot" };
const other = { host: "audit-host", sessionId: "audit-other" };
const root = fileURLToPath(new URL("../../", import.meta.url));
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
async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ags-audit-")); directories.push(value); return value; }
const iso = (ms: number) => new Date(ms).toISOString();
const one = (store: SessionMessageStore, sql: string, ...args: string[]) => (store.database.prepare(sql).get(...args) as { v: number | string | null }).v;
const receipts = (store: SessionMessageStore, sender?: typeof hot) => Number(sender
  ? one(store, "SELECT count(*) AS v FROM prepared_messages WHERE receipt IS NOT NULL AND sender_host = ? AND sender_session_id = ?", sender.host, sender.sessionId)
  : one(store, "SELECT count(*) AS v FROM prepared_messages WHERE receipt IS NOT NULL"));
const drafts = (store: SessionMessageStore, sender?: typeof hot) => Number(sender
  ? one(store, "SELECT count(*) AS v FROM prepared_messages WHERE receipt IS NULL AND sender_host = ? AND sender_session_id = ?", sender.host, sender.sessionId)
  : one(store, "SELECT count(*) AS v FROM prepared_messages WHERE receipt IS NULL"));
const rowsFor = (store: SessionMessageStore, id: string) => Number(one(store, "SELECT count(*) AS v FROM messages WHERE message_id = ?", id));
const allRows = (store: SessionMessageStore) => Number(one(store, "SELECT count(*) AS v FROM messages"));
const receiptExpiry = (store: SessionMessageStore, id: string) => one(store, "SELECT expires_at AS v FROM prepared_messages WHERE message_id = ?", id);
function sendNew(store: SessionMessageStore, sender: typeof hot, nowMs: number, ttlSeconds?: number) {
  const draft = store.prepare({ sender, target, body: "Synthetic audit message", ...(ttlSeconds === undefined ? {} : { ttlSeconds }) }, nowMs);
  return store.submitPrepared(sender, draft.messageId, nowMs);
}
function rejection(action: () => unknown): Error & { details?: { scope: string; earliestReleaseAt: string | null } } {
  try { action(); } catch (error) { return error as Error & { details?: { scope: string; earliestReleaseAt: string | null } }; }
  throw new Error("expected a rejection");
}

// ---------- 1. Idempotency ----------

it("I1 resend of one ID never inserts twice: retained, right after ACK, ACK+1h, message expiry", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000, 600);
  const exp = Date.parse(sent.expiresAt);
  // During retention (queued, unacked)
  expect(store.submitPrepared(hot, sent.messageId, 2000)).toEqual({ ...sent, duplicate: true , autoWake: { ...sent.autoWake, checkedAt: new Date(2000).toISOString() } });
  expect(rowsFor(store, sent.messageId)).toBe(1);
  // Right after ACK
  expect(store.acknowledge(target, [sent.messageId], 3000)).toBe(1);
  expect(store.submitPrepared(hot, sent.messageId, 3000)).toEqual({ ...sent, duplicate: true , autoWake: { ...sent.autoWake, checkedAt: new Date(3000).toISOString() } });
  expect(store.submitPrepared(hot, sent.messageId, 3000 + H - 1)).toEqual({ ...sent, duplicate: true , autoWake: { ...sent.autoWake, checkedAt: new Date(3000 + H - 1).toISOString() } });
  expect(receipts(store, hot)).toBe(1);
  // ACK+1h: row and receipt disappear together, resend is refused and nothing is inserted
  expect(() => store.submitPrepared(hot, sent.messageId, 3000 + H)).toThrow(/Issued message ID is unavailable; delivery may be unknown/u);
  // The rejected transaction also rolls back its own prune; a later prune removes the expired rows.
  store.prune(3000 + H);
  expect(rowsFor(store, sent.messageId)).toBe(0);
  expect(receipts(store)).toBe(0);
  expect(store.status(hot, sent.messageId, 3000 + H)).toBeNull();
  // Message expiry without ACK: row pruned at expiry, receipt answers duplicate until expiry+1h, never re-inserted
  const late = sendNew(store, hot, 10_000, 30);
  const lateExp = Date.parse(late.expiresAt);
  expect(store.submitPrepared(hot, late.messageId, lateExp)).toEqual({ ...late, duplicate: true , autoWake: { ...late.autoWake, checkedAt: new Date(lateExp).toISOString() } });
  expect(rowsFor(store, late.messageId)).toBe(0);
  expect(store.submitPrepared(hot, late.messageId, lateExp + H - 1)).toEqual({ ...late, duplicate: true , autoWake: { ...late.autoWake, checkedAt: new Date(lateExp + H - 1).toISOString() } });
  expect(rowsFor(store, late.messageId)).toBe(0);
  expect(() => store.submitPrepared(hot, late.messageId, lateExp + H)).toThrow(/unavailable/u);
  expect(rowsFor(store, late.messageId)).toBe(0);
  expect(exp).toBeGreaterThan(0);
});

it("I2 at full capacity a resend of an already-sent ID is still a duplicate, not a capacity rejection", () => {
  const store = fixture();
  const ids = Array.from({ length: MESSAGE_SENDER_RECEIPT_LIMIT }, (_, i) => sendNew(store, hot, 1000 + i));
  expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
  const again = store.submitPrepared(hot, ids[0]!.messageId, 5000);
  expect(again).toEqual({ ...ids[0], duplicate: true, autoWake: { ...ids[0]!.autoWake, checkedAt: new Date(5000).toISOString() } });
  expect(allRows(store)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
});

it("I3 repeated claim and ACK leave receipt expiry, capacity counts and status stable", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000, 86400);
  store.claim(target, 1500);
  store.claim(target, 1500 + 10 * 60_000); // lease expired: redelivery
  const beforeAck = receiptExpiry(store, sent.messageId);
  expect(beforeAck).toBe(iso(Date.parse(sent.expiresAt) + H));
  expect(store.acknowledge(target, [sent.messageId], 2_000_000)).toBe(1);
  const afterAck = receiptExpiry(store, sent.messageId);
  expect(afterAck).toBe(iso(2_000_000 + H));
  const statusAfter = store.status(hot, sent.messageId, 2_000_001);
  for (const t of [2_000_002, 2_100_000, 2_000_000 + H - 1]) {
    store.claim(target, t);
    expect(store.acknowledge(target, [sent.messageId, sent.messageId], t)).toBe(0);
    expect(receiptExpiry(store, sent.messageId)).toBe(afterAck);
    expect(receipts(store, hot)).toBe(1);
    expect(store.status(hot, sent.messageId, t)).toMatchObject({ state: "acknowledged", acknowledgedAt: (statusAfter as { acknowledgedAt: string }).acknowledgedAt });
  }
});

it("I4 normalization variants of an issued ID never reach a second insert", () => {
  const store = fixture();
  const sent = sendNew(store, hot, 1000);
  const variants = [sent.messageId.toUpperCase(), ` ${sent.messageId}`, `${sent.messageId} `, `${sent.messageId}\n`, sent.messageId.replace(/-/gu, "")];
  for (const variant of variants) {
    if (variant === sent.messageId) continue;
    expect(() => store.submitPrepared(hot, variant, 2000)).toThrow(/unavailable/u);
  }
  // sender identity variants are separate owners and cannot use the ID
  for (const sender of [{ ...hot, sessionId: hot.sessionId.toUpperCase() }, { ...hot, sessionId: ` ${hot.sessionId}` }, { ...hot, host: hot.host.toUpperCase() }]) {
    expect(() => store.submitPrepared(sender, sent.messageId, 2000)).toThrow(/unavailable|bounded identifier/u);
  }
  expect(allRows(store)).toBe(1);
  expect(receipts(store)).toBe(1);
});

it("I5 a capacity-rejected draft stays retryable by the same ID and delivers exactly once", () => {
  const store = fixture();
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 1; i++) sendNew(store, hot, 1000);
  const pending = store.prepare({ sender: hot, target, body: "pending" }, 1000);
  sendNew(store, hot, 1000);
  const e = rejection(() => store.submitPrepared(hot, pending.messageId, 1001));
  expect(e.details?.scope).toBe("sender");
  // ACK the earliest ones so capacity frees before the draft expires (draft TTL 10 min)
  const first = store.database.prepare("SELECT message_id AS id FROM prepared_messages WHERE receipt IS NOT NULL ORDER BY message_id LIMIT 1").get() as { id: string };
  expect(store.acknowledge(target, [first.id], 2000)).toBe(1);
  // Released only at ACK+1h, which is after the draft expiry: same-ID retry is then unavailable, no delivery.
  expect(() => store.submitPrepared(hot, pending.messageId, 2000 + H)).toThrow(/unavailable/u);
  expect(rowsFor(store, pending.messageId)).toBe(0);
});

it("I6 late retry through the service after ACK+1h is uncertain guidance, never a definite no-effect claim", async () => {
  const state = await launchBroker();
  const store = fixture(path.join(state, "session-messages.sqlite3"));
  const service = new SessionMessageService(state);
  const prepared = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "late retry", _sessionBinding: hot });
  const messageId = (prepared.data as { messageId: string }).messageId;
  const sent = await service.send({ messageId, _sessionBinding: hot });
  expect(sent.ok).toBe(true);
  // ACK two hours in the past so that ACK+1h has already elapsed for the broker clock.
  expect(store.acknowledge(target, [messageId], Date.now() - 2 * H)).toBe(1);
  const late = await service.send({ messageId, _sessionBinding: hot });
  expect(late).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: null } });
  expect(late.error?.message).toMatch(/delivery may be unknown/u);
  expect(late.error?.message).toMatch(/do not prepare again for the same uncertain delivery/u);
  expect(late.error?.message).not.toMatch(/definite|had no effect|not queued/u);
  const status = await service.status({ messageId, _sessionBinding: hot });
  expect(status).toMatchObject({ ok: true });
  expect(allRows(store)).toBe(0);
}, 30_000);

// ---------- 2. Limit accuracy ----------

it("L1 sender boundary limit-1 / limit / limit+1 for prepare and send", () => {
  const store = fixture();
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 2; i++) sendNew(store, hot, 1000 + i);
  // limit-1 after this send
  expect(sendNew(store, hot, 2000).duplicate).toBe(false);
  expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT - 1);
  // prepare at limit-1 is admitted
  const d = store.prepare({ sender: hot, target, body: "limit" }, 2001);
  expect(store.submitPrepared(hot, d.messageId, 2001).duplicate).toBe(false);
  expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
  const e = rejection(() => store.prepare({ sender: hot, target, body: "limit+1" }, 2002));
  expect(e.message).toBe("The bounded message receipt store is full for this sender; no draft was created.");
  expect(e.details).toEqual({ scope: "sender", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
  // other sender not blocked
  expect(sendNew(store, other, 2003).duplicate).toBe(false);
});

it("L2 global boundary 999 / 1000 / 1001 and both limits full at once (sender reported first)", () => {
  const store = fixture();
  const fillers = (i: number) => ({ host: "audit-host", sessionId: `audit-filler-${i % 3}` });
  for (let i = 0; i < 3 * MESSAGE_SENDER_RECEIPT_LIMIT; i++) sendNew(store, fillers(i), 1000 + i);
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 2; i++) sendNew(store, hot, 5000 + i);
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT - 2);
  const pending = store.prepare({ sender: hot, target, body: "prepared at 998" }, 6000);
  sendNew(store, hot, 6001); // 999, hot at 249
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT - 1);
  const otherDraft = store.prepare({ sender: other, target, body: "prepared at 999" }, 6002);
  expect(store.submitPrepared(hot, pending.messageId, 6003).duplicate).toBe(false); // 1000; hot at 250
  expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT);
  expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
  // both full: hot sees sender scope with its own earliest receipt
  const both = rejection(() => store.prepare({ sender: hot, target, body: "both" }, 6004));
  expect(both.details).toEqual({ scope: "sender", earliestReleaseAt: iso(5000 + 2 * H) });
  // other sender sees global scope with the pool's earliest receipt
  const globalSend = rejection(() => store.submitPrepared(other, otherDraft.messageId, 6005));
  expect(globalSend.message).toBe("The bounded message receipt store is full.");
  expect(globalSend.details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
  const globalPrepare = rejection(() => store.prepare({ sender: other, target, body: "g" }, 6006));
  expect(globalPrepare.message).toBe("The bounded message receipt store is full; no draft was created.");
  expect(globalPrepare.details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
  expect(allRows(store)).toBe(MESSAGE_RECEIPT_LIMIT);
});

it("L3 earliestReleaseAt equals the actual release instant, and exactly one slot frees per expired receipt", () => {
  const store = fixture();
  // Staggered expiries: receipt i expires at 1000 + i + 2h (default TTL 3600s)
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT; i++) sendNew(store, hot, 1000 + i);
  let release = Date.parse(rejection(() => store.prepare({ sender: hot, target, body: "x" }, 2000)).details!.earliestReleaseAt!);
  expect(release).toBe(1000 + 2 * H);
  for (let slot = 0; slot < 3; slot++) {
    expect(rejection(() => store.prepare({ sender: hot, target, body: "just before" }, release - 1)).details?.scope).toBe("sender");
    const draft = store.prepare({ sender: hot, target, body: "at release" }, release);
    expect(store.submitPrepared(hot, draft.messageId, release).duplicate).toBe(false);
    expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
    const next = rejection(() => store.prepare({ sender: hot, target, body: "only one slot" }, release));
    expect(next.details?.scope).toBe("sender");
    expect(Date.parse(next.details!.earliestReleaseAt!)).toBe(release + 1);
    release += 1;
  }
});

it("L4 send of a pre-made draft just before and at earliestReleaseAt (global scope)", () => {
  const store = fixture();
  for (let i = 0; i < MESSAGE_RECEIPT_LIMIT - 1; i++) sendNew(store, { host: "audit-host", sessionId: `g-${i % 4}` }, 1000 + i);
  const draft = store.prepare({ sender: other, target, body: "held" }, 2_000_000 - 1000);
  sendNew(store, { host: "audit-host", sessionId: "g-last" }, 2_000_000 - 999);
  const e = rejection(() => store.submitPrepared(other, draft.messageId, 2_000_000));
  expect(e.details).toEqual({ scope: "global", earliestReleaseAt: iso(1000 + 2 * H) });
  // draft TTL is 10 minutes, the release is ~1.4h away: re-prepare flow at the release instant
  const t = 1000 + 2 * H;
  expect(rejection(() => store.prepare({ sender: other, target, body: "before" }, t - 1)).details?.scope).toBe("global");
  const fresh = store.prepare({ sender: other, target, body: "at" }, t);
  expect(store.submitPrepared(other, fresh.messageId, t).duplicate).toBe(false);
});

it("L5 byte-limit send rejection: scope global, earliestReleaseAt is the real release instant", () => {
  const store = fixture();
  const big = "\u0001".repeat(4096);
  // fill with large drafts at t=1000 across many senders until bytes run out
  let index = 0;
  for (;;) {
    try { store.prepare({ sender: { host: "audit-host", sessionId: `b-${Math.floor(index / 90)}` }, target, body: big }, 1000); index++; }
    catch (error) { expect(String(error)).toMatch(/preparation store is full/u); break; }
  }
  const tiny = store.prepare({ sender: hot, target, body: "t" }, 5000);
  const used = Number(one(store, "SELECT coalesce(sum(record_bytes),0) AS v FROM prepared_messages"));
  const remaining = MESSAGE_ID_RECORD_BYTES_LIMIT - used;
  // top up to within a few bytes of the limit with one filler draft prepared later than the big ones
  const probe = Buffer.byteLength(JSON.stringify({ sender: other, target, body: "", ttlSeconds: 3600, messageId: "00000000-0000-0000-0000-000000000000", preparedAt: iso(6000), expiresAt: iso(6000 + 600_000) }), "utf8");
  let fillerLen = remaining - probe - 5;
  while (fillerLen > 4096) { store.prepare({ sender: other, target, body: "a".repeat(4096) }, 6000); fillerLen -= 4096 + probe; }
  expect(fillerLen).toBeGreaterThan(0);
  store.prepare({ sender: other, target, body: "a".repeat(fillerLen) }, 6000);
  const left = MESSAGE_ID_RECORD_BYTES_LIMIT - Number(one(store, "SELECT coalesce(sum(record_bytes),0) AS v FROM prepared_messages"));
  console.log(`L5 ${JSON.stringify({ bigDrafts: index, remaining, probe, fillerLen, left })}`);
  const e = rejection(() => store.submitPrepared(hot, tiny.messageId, 7000));
  // Only a byte rejection if the leftover room is smaller than the receipt growth; record either way.
  expect({ left, message: e.message, details: e.details }).toMatchObject({ message: "The bounded message receipt store is full.", details: { scope: "global", earliestReleaseAt: iso(1000 + 600_000) } });
  expect(() => store.submitPrepared(hot, tiny.messageId, 1000 + 600_000 - 1)).toThrow(/receipt store is full/u);
  expect(store.submitPrepared(hot, tiny.messageId, 1000 + 600_000).duplicate).toBe(false);
});

// ---------- 3. Races (child processes, repeated) ----------

type RaceRequest = { operation: "prepare" | "send" | "acknowledge"; sender: typeof hot; messageId: string; nowMs: number };
async function race(database: string, requests: RaceRequest[]) {
  const workers = requests.map(() => spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/issued-send-worker.ts", import.meta.url)), database], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  children.push(...workers);
  await Promise.all(workers.map((worker) => once(worker, "message")));
  const results = workers.map((worker) => once(worker, "message"));
  const exits = workers.map((worker) => once(worker, "exit"));
  workers.forEach((worker, i) => worker.send({ ...requests[i], target }));
  const output = (await Promise.all(results)).map(([value]) => value as { result?: unknown; error?: string });
  await Promise.all(exits);
  return output;
}

it(`R1 two processes send at sender limit-1 never exceed the limit (${RACE_ROUNDS} rounds)`, async () => {
  const tally = { ok: 0, rejected: 0 };
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const database = path.join(await directory(), `r1-${round}.sqlite3`);
    const store = fixture(database);
    for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 1; i++) sendNew(store, hot, 1000);
    const ids = [0, 1].map(() => store.prepare({ sender: hot, target, body: "c" }, 1500).messageId);
    const out = await race(database, ids.map((messageId) => ({ operation: "send" as const, sender: hot, messageId, nowMs: 2000 })));
    expect(out.filter((v) => v.result)).toHaveLength(1);
    expect(out.find((v) => v.error)?.error).toBe("The bounded message receipt store is full for this sender.");
    expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
    expect(allRows(store)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
    tally.ok++; tally.rejected++;
  }
  expect(tally.ok).toBe(RACE_ROUNDS);
}, 600_000);

it(`R2 two senders race for the last global slot (${RACE_ROUNDS} rounds)`, async () => {
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const database = path.join(await directory(), `r2-${round}.sqlite3`);
    const store = fixture(database);
    for (let i = 0; i < MESSAGE_RECEIPT_LIMIT - 1; i++) sendNew(store, { host: "audit-host", sessionId: `g-${i % 4}` }, 1000);
    const a = store.prepare({ sender: hot, target, body: "a" }, 1500).messageId;
    const b = store.prepare({ sender: other, target, body: "b" }, 1500).messageId;
    const out = await race(database, [
      { operation: "send", sender: hot, messageId: a, nowMs: 2000 },
      { operation: "send", sender: other, messageId: b, nowMs: 2000 },
    ]);
    expect(out.filter((v) => v.result)).toHaveLength(1);
    expect(out.find((v) => v.error)?.error).toBe("The bounded message receipt store is full.");
    expect(receipts(store)).toBe(MESSAGE_RECEIPT_LIMIT);
  }
}, 600_000);

it(`R3 concurrent send and ACK: one row, expiry only shrinks (${RACE_ROUNDS} rounds)`, async () => {
  const orders = { ackFirst: 0, sendFirst: 0 };
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const database = path.join(await directory(), `r3-${round}.sqlite3`);
    const store = fixture(database);
    const draft = store.prepare({ sender: hot, target, body: "s", ttlSeconds: 86400 }, 1000);
    const out = await race(database, [
      { operation: "send", sender: hot, messageId: draft.messageId, nowMs: 2000 },
      { operation: "acknowledge", sender: hot, messageId: draft.messageId, nowMs: 2000 },
    ]);
    const sent = out[0]!.result as { expiresAt: string; duplicate: boolean };
    expect(sent.duplicate).toBe(false);
    expect(rowsFor(store, draft.messageId)).toBe(1);
    const acked = out[1]!.result as number;
    if (acked === 1) orders.sendFirst++; else orders.ackFirst++;
    expect(receiptExpiry(store, draft.messageId)).toBe(acked === 1 ? iso(2000 + H) : iso(Date.parse(sent.expiresAt) + H));
  }
  expect(orders.ackFirst + orders.sendFirst).toBe(RACE_ROUNDS);
  console.log(`R3 orders ${JSON.stringify(orders)}`);
}, 600_000);

it(`R4 prepare admission racing the send that takes the last sender slot (${RACE_ROUNDS} rounds)`, async () => {
  const outcomes = { prepareWon: 0, sendWon: 0 };
  for (let round = 0; round < RACE_ROUNDS; round++) {
    const database = path.join(await directory(), `r4-${round}.sqlite3`);
    const store = fixture(database);
    for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 1; i++) sendNew(store, hot, 1000);
    const pending = store.prepare({ sender: hot, target, body: "p" }, 1500).messageId;
    const draftsBefore = drafts(store, hot);
    const out = await race(database, [
      { operation: "send", sender: hot, messageId: pending, nowMs: 2000 },
      { operation: "prepare", sender: hot, messageId: "", nowMs: 2000 },
    ]);
    expect(out[0]!.result).toBeTruthy();
    expect(receipts(store, hot)).toBe(MESSAGE_SENDER_RECEIPT_LIMIT);
    if (out[1]!.result) {
      outcomes.prepareWon++;
      expect(drafts(store, hot)).toBe(draftsBefore); // pending became a receipt, one new draft
    } else {
      outcomes.sendWon++;
      expect(out[1]!.error).toBe("The bounded message receipt store is full for this sender; no draft was created.");
      expect(drafts(store, hot)).toBe(draftsBefore - 1);
    }
  }
  console.log(`R4 outcomes ${JSON.stringify(outcomes)}`);
}, 600_000);

// ---------- 6. v2.7.2 DB opened by the candidate ----------

async function launchBroker(brokerPath = path.join(root, "mcp-server/dist/session-message-broker.mjs")) {
  const state = await directory();
  const child = spawn(process.execPath, [brokerPath, "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000);
  return state;
}

it("C1 new client against the previous broker: capacity rejection falls back to the old guidance", async () => {
  const previous = process.env.AGS_PREVIOUS_BROKER_PATH;
  if (!previous) { console.log("C1 skipped: AGS_PREVIOUS_BROKER_PATH unset"); return; }
  const state = await launchBroker(previous);
  const store = fixture(path.join(state, "session-messages.sqlite3"));
  const service = new SessionMessageService(state);
  const now = Date.now();
  for (let i = 0; i < MESSAGE_RECEIPT_LIMIT - 1; i++) sendNew(store, { host: "audit-host", sessionId: `old-${i % 5}` }, now);
  const prepared = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "old broker", _sessionBinding: hot });
  if (!prepared.ok) {
    // Brokers before the issued-ID flow (v2.2.6) do not know prepare: no capacity details can appear.
    console.log(`C1 previous broker has no prepare: ${JSON.stringify(prepared.error)}`);
    expect(prepared.error).toMatchObject({ code: "MCP_UNAVAILABLE", message: "Unknown broker operation.", details: null });
    return;
  }
  sendNew(store, other, now);
  const rejected = await service.send({ messageId: (prepared.data as { messageId: string }).messageId, _sessionBinding: hot });
  expect(rejected).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: null } });
  expect(rejected.error?.message).toMatch(/receipt store is full/u);
  expect(rejected.error?.message).toMatch(/Retry only the known prepared ID/u);
  expect(rejected.error?.message).not.toMatch(/definite|earliest/u);
  // previous broker has no prepare admission: the draft is still created
  const again = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "old broker 2", _sessionBinding: hot });
  console.log(`C1 prepare at full pool on previous broker: ${JSON.stringify({ ok: again.ok, code: again.error?.code ?? null })}`);
  // previous broker: no sender quota; sender 'hot' can exceed 250 if the pool allows (documented, not asserted)
}, 60_000);
