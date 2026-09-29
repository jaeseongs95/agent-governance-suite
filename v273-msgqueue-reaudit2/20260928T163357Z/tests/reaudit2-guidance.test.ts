// Re-audit 2 of the conditional retry guidance (d99d768e). Audit only, not a product test.
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
const DRAFT_TTL = 600_000;
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
const iso = (ms: number) => new Date(ms).toISOString();
const count = (store: SessionMessageStore, sql: string, ...args: string[]) => (store.database.prepare(sql).get(...args) as { v: number }).v;
async function broker() {
  const state = await mkdtemp(path.join(tmpdir(), "ags-reaudit2-")); directories.push(state);
  const child = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000);
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3")); stores.push(store);
  return { state, store, service: new SessionMessageService(state) };
}
function fillStore(store: SessionMessageStore, n: number, nowMs: number, ttlSeconds?: number, body = "fill") {
  for (let i = 0; i < n; i++) {
    const d = store.prepare({ sender: hot, target, body, ...(ttlSeconds ? { ttlSeconds } : {}) }, nowMs);
    store.submitPrepared(hot, d.messageId, nowMs);
  }
}
/** 249 short receipts at t=0 expire at 30s+1h; the rejected draft is prepared at `preparedAt`. */
function rejectedScenario(preparedAt: number) {
  const store = new SessionMessageStore(":memory:"); stores.push(store);
  fillStore(store, MESSAGE_SENDER_RECEIPT_LIMIT - 1, 0, 30);
  const intent = store.prepare({ sender: hot, target, body: "the intent" }, preparedAt);
  fillStore(store, 1, preparedAt);
  let release = NaN;
  try { store.submitPrepared(hot, intent.messageId, preparedAt); } catch (error) { release = Date.parse((error as { details: { earliestReleaseAt: string } }).details.earliestReleaseAt); }
  return { store, intent, release, draftExpiresAt: Date.parse(intent.expiresAt) };
}

it("G1 (N5-b) release after draft expiry: the guidance selects prepare again; the intent is delivered once", async () => {
  const { store, service } = await broker();
  const now = Date.now();
  fillStore(store, MESSAGE_SENDER_RECEIPT_LIMIT - 1, now);
  const prepared = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "the intent", _sessionBinding: hot });
  const { messageId, expiresAt } = prepared.data as { messageId: string; expiresAt: string };
  fillStore(store, 1, now);
  const rejected = await service.send({ messageId, _sessionBinding: hot });
  const release = (rejected.error!.details as { earliestReleaseAt: string }).earliestReleaseAt;
  expect(Date.parse(release)).toBeGreaterThan(Date.parse(expiresAt));
  const message = rejected.error!.message;
  console.log(`G1 rejection message: ${message}`);
  expect(message).toContain("If earliestReleaseAt is before that expiresAt, retry that same messageId after earliestReleaseAt; otherwise the draft expires first, so prepare again. Never do both.");
  expect(message).not.toMatch(/do not prepare again|Retry only the known prepared ID/u);
  // Follow the selected branch after both instants: expire the draft and one receipt.
  store.database.prepare("UPDATE prepared_messages SET expires_at = ? WHERE message_id = ?").run(iso(now - 1000), messageId);
  store.database.prepare("UPDATE prepared_messages SET expires_at = ? WHERE message_id = (SELECT message_id FROM prepared_messages WHERE receipt IS NOT NULL ORDER BY expires_at LIMIT 1)").run(iso(now - 1000));
  const again = await service.prepare({ targetHost: target.host, targetSessionId: target.sessionId, body: "the intent", _sessionBinding: hot });
  expect(await service.send({ messageId: (again.data as { messageId: string }).messageId, _sessionBinding: hot })).toMatchObject({ ok: true, data: { duplicate: false } });
  expect(count(store, "SELECT count(*) AS v FROM messages WHERE body = 'the intent'")).toBe(1);
  expect(count(store, "SELECT count(*) AS v FROM messages WHERE message_id = ?", messageId)).toBe(0);
}, 30_000);

it("G2 (N5-a condition) release before draft expiry: same-ID retry enters the queue exactly once", () => {
  const { store, intent, release, draftExpiresAt } = rejectedScenario(30_000 + H - 300_000);
  expect(release).toBe(30_000 + H);
  expect(release).toBeLessThan(draftExpiresAt);
  expect(store.submitPrepared(hot, intent.messageId, release).duplicate).toBe(false);
  expect(store.submitPrepared(hot, intent.messageId, release + 1).duplicate).toBe(true);
  expect(store.submitPrepared(hot, intent.messageId, draftExpiresAt + 1000).duplicate).toBe(true); // receipt now outlives the draft
  expect(count(store, "SELECT count(*) AS v FROM messages WHERE body = 'the intent'")).toBe(1);
});

it("G3 boundary: release == draft expiresAt is the 'otherwise' branch; release == expiresAt-1 still allows the same ID", () => {
  const equal = rejectedScenario(30_000 + H - DRAFT_TTL);
  expect(equal.release).toBe(equal.draftExpiresAt);
  expect(() => equal.store.submitPrepared(hot, equal.intent.messageId, equal.release)).toThrow(/Issued message ID is unavailable/u);
  expect(count(equal.store, "SELECT count(*) AS v FROM messages WHERE message_id = ?", equal.intent.messageId)).toBe(0);
  const before = rejectedScenario(30_000 + H - DRAFT_TTL + 1);
  expect(before.release).toBe(before.draftExpiresAt - 1);
  expect(before.store.submitPrepared(hot, before.intent.messageId, before.release).duplicate).toBe(false);
});

it("G4 an unknown ID without a definite rejection keeps the uncertain guidance and no details", async () => {
  const { service } = await broker();
  const unknown = await service.send({ messageId: "reaudit2-unknown-id", _sessionBinding: hot });
  expect(unknown).toMatchObject({ ok: false, error: { code: "MCP_UNAVAILABLE", details: null } });
  expect(unknown.error!.message).toMatch(/delivery may be unknown/u);
  expect(unknown.error!.message).toMatch(/do not prepare again for the same uncertain delivery/u);
  expect(unknown.error!.message).not.toMatch(/definite|prepare again\. Never|otherwise the draft expires/u);
}, 30_000);
