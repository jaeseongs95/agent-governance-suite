// Re-audit of the N5 wording (544cd6e1): what a sender sees when it follows each branch of
// "either retry that same messageId or prepare again, not both". Audit only, not a product test.
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore, MESSAGE_SENDER_RECEIPT_LIMIT } from "../../mcp-server/src/session-message-store.js";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

const H = 3600_000;
const target = { host: "audit-host", sessionId: "audit-target" };
const hot = { host: "audit-host", sessionId: "audit-hot" };
const root = fileURLToPath(new URL("../../", import.meta.url));
const children: ChildProcess[] = [];
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});
function fill(store: SessionMessageStore, count: number, nowMs: number) {
  for (let i = 0; i < count; i++) {
    const draft = store.prepare({ sender: hot, target, body: "fill" }, nowMs);
    store.submitPrepared(hot, draft.messageId, nowMs);
  }
}

it("N5-a doing both branches after release delivers one intent twice (why 'not both' is required)", () => {
  const store = new SessionMessageStore(":memory:"); stores.push(store);
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT - 1; i++) {
    const d = store.prepare({ sender: hot, target, body: "old", ttlSeconds: 30 }, 0);
    store.submitPrepared(hot, d.messageId, 0);
  }
  const t0 = 30_000 + H - 300_000; // five minutes before the old receipts expire
  const intent = store.prepare({ sender: hot, target, body: "the intent" }, t0);
  fill(store, 1, t0);
  let release = 0;
  try { store.submitPrepared(hot, intent.messageId, t0); } catch (error) { release = Date.parse((error as { details: { earliestReleaseAt: string } }).details.earliestReleaseAt); }
  expect(release).toBe(30_000 + H);
  expect(release).toBeLessThan(Date.parse(intent.expiresAt)); // same-ID retry is possible here
  expect(store.submitPrepared(hot, intent.messageId, release).duplicate).toBe(false);
  const again = store.prepare({ sender: hot, target, body: "the intent" }, release);
  expect(store.submitPrepared(hot, again.messageId, release).duplicate).toBe(false);
  expect((store.database.prepare("SELECT count(*) AS v FROM messages WHERE body = 'the intent'").get() as { v: number }).v).toBe(2);
});

it("N5-b same-ID branch: when earliestReleaseAt is after the draft expiry, the retry lands on uncertain guidance", async () => {
  const state = await mkdtemp(path.join(tmpdir(), "ags-reaudit-")); directories.push(state);
  const child = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000);
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3")); stores.push(store);
  const service = new SessionMessageService(state);
  const now = Date.now();
  fill(store, MESSAGE_SENDER_RECEIPT_LIMIT - 1, now);
  const prepared = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "the intent", _sessionBinding: hot });
  const { messageId, expiresAt: draftExpiresAt } = prepared.data as { messageId: string; expiresAt: string };
  fill(store, 1, now);
  const rejected = await service.send({ messageId, _sessionBinding: hot });
  expect(rejected.ok).toBe(false);
  const release = String((rejected.error!.details as { earliestReleaseAt: string }).earliestReleaseAt);
  expect(rejected.error!.message).toMatch(/either retry that same messageId or prepare again, not both/u);
  // Neither details nor the message give the draft expiry; the sender must remember it from the prepare reply.
  expect(rejected.error!.message).not.toContain(draftExpiresAt);
  expect(Object.keys(rejected.error!.details as object).sort()).toEqual(["earliestReleaseAt", "scope"]);
  expect(Date.parse(release)).toBeGreaterThan(Date.parse(draftExpiresAt));
  // Simulate time passing past the draft expiry and the release: expire the draft and free one receipt.
  store.database.prepare("UPDATE prepared_messages SET expires_at = ? WHERE message_id = ?").run(new Date(now - 1000).toISOString(), messageId);
  store.database.prepare("UPDATE prepared_messages SET expires_at = ? WHERE message_id = (SELECT message_id FROM prepared_messages WHERE receipt IS NOT NULL ORDER BY expires_at LIMIT 1)").run(new Date(now - 1000).toISOString());
  const retried = await service.send({ messageId, _sessionBinding: hot });
  console.log(`N5-b same-ID retry after release: ${JSON.stringify(retried.error)}`);
  expect(retried).toMatchObject({ ok: false, error: { details: null } });
  expect(retried.error!.message).toMatch(/delivery may be unknown/u);
  expect(retried.error!.message).toMatch(/do not prepare again for the same uncertain delivery/u);
  // The message was never queued.
  expect((store.database.prepare("SELECT count(*) AS v FROM messages WHERE message_id = ?").get(messageId) as { v: number }).v).toBe(0);
}, 30_000);
