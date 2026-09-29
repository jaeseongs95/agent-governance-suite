// Audit: real v2.7.2-created DB reopened by the candidate (C2) and the previous CLI against the candidate broker (C3).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore, MESSAGE_SENDER_RECEIPT_LIMIT } from "../../mcp-server/src/session-message-store.js";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";

const previousRoot = process.env.AGS_PREVIOUS_ROOT;
const root = fileURLToPath(new URL("../../", import.meta.url));
const H = 3600_000;
const target = { host: "audit-host", sessionId: "audit-target" };
const sender = { host: "audit-host", sessionId: "audit-sender" };
const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  }
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});
async function stateDir() { const value = await mkdtemp(path.join(tmpdir(), "ags-audit-compat-")); directories.push(value); return value; }
async function broker(pluginRoot: string, state: string) {
  const child = spawn(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000);
  return child;
}
async function stop(child: ChildProcess) { const exit = once(child, "exit"); child.kill(); await exit; }
function cli(pluginRoot: string, state: string, operation: string, payload: Record<string, unknown>) {
  const result = spawnSync(process.execPath, [path.join(pluginRoot, "mcp-server/dist/session-message-cli.mjs")], {
    env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state }, input: JSON.stringify({ operation, payload }), encoding: "utf8", windowsHide: true, timeout: 10_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: (() => { try { return JSON.parse(result.stdout); } catch { return null; } })() };
}
const receiptExpiry = (db: DatabaseSync, id: string) => (db.prepare("SELECT expires_at AS v FROM prepared_messages WHERE message_id = ?").get(id) as { v: string } | undefined)?.v;

it.skipIf(!previousRoot)("C2 a DB written by the previous release keeps its receipts; ACK+1h applies only to new ACKs", async () => {
  const state = await stateDir();
  const old = await broker(previousRoot!, state);
  const prepare = (body: string) => cli(previousRoot!, state, "prepare", { sender, target, body, ttlSeconds: 86400 }).json.data.messageId as string;
  const acked = prepare("acked by previous release");
  const pending = prepare("left unacknowledged");
  expect(cli(previousRoot!, state, "send", { sender, messageId: acked }).json.ok).toBe(true);
  expect(cli(previousRoot!, state, "send", { sender, messageId: pending }).json.ok).toBe(true);
  const oldAck = cli(previousRoot!, state, "acknowledge", { target, messageIds: [acked] });
  expect(oldAck.json).toMatchObject({ ok: true });
  await stop(old);
  const file = path.join(state, "session-messages.sqlite3");
  const before = new DatabaseSync(file, { readOnly: true });
  const legacyAckedExpiry = receiptExpiry(before, acked)!;
  const legacyPendingExpiry = receiptExpiry(before, pending)!;
  const ackedAt = (before.prepare("SELECT acknowledged_at AS v FROM messages WHERE message_id = ?").get(acked) as { v: string }).v;
  const messageExpiry = (before.prepare("SELECT expires_at AS v FROM messages WHERE message_id = ?").get(acked) as { v: string }).v;
  before.close();
  // previous release: receipt = message expiry + 1h regardless of ACK
  expect(legacyAckedExpiry).toBe(new Date(Date.parse(messageExpiry) + H).toISOString());
  console.log(`C2 legacy ${JSON.stringify({ ackedAt, legacyAckedExpiry, legacyPendingExpiry })}`);

  await broker(root, state);
  const service = new SessionMessageService(state);
  expect(await service.send({ messageId: acked, _sessionBinding: sender })).toMatchObject({ ok: true, data: { duplicate: true } });
  expect(await service.acknowledge({ messageIds: [acked], _sessionBinding: target })).toMatchObject({ ok: true, data: { acknowledged: 0 } });
  const acknowledgedNow = Date.now();
  expect(await service.acknowledge({ messageIds: [pending], _sessionBinding: target })).toMatchObject({ ok: true, data: { acknowledged: 1 } });
  const after = new DatabaseSync(file, { readOnly: true });
  expect(receiptExpiry(after, acked)).toBe(legacyAckedExpiry); // not retroactive
  const shortened = Date.parse(receiptExpiry(after, pending)!);
  expect(shortened).toBeGreaterThanOrEqual(acknowledgedNow + H - 5000);
  expect(shortened).toBeLessThanOrEqual(Date.now() + H);
  expect(shortened).toBeLessThan(Date.parse(legacyPendingExpiry));
  expect((after.prepare("SELECT count(*) AS v FROM messages").get() as { v: number }).v).toBe(2);
  after.close();
  // candidate store opening the same file has no migration to do and keeps both rows
  const store = new SessionMessageStore(file);
  expect(store.status(sender, acked)).toMatchObject({ state: "acknowledged" });
  store.close();
}, 60_000);

it.skipIf(!previousRoot)("C3 the previous CLI against the candidate broker still reads a capacity rejection", async () => {
  const state = await stateDir();
  await broker(root, state);
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  const now = Date.now();
  for (let i = 0; i < MESSAGE_SENDER_RECEIPT_LIMIT; i++) {
    const draft = store.prepare({ sender, target, body: "fill" }, now);
    store.submitPrepared(sender, draft.messageId, now);
  }
  store.close();
  const rejected = cli(previousRoot!, state, "prepare", { sender, target, body: "over" });
  console.log(`C3 previous CLI output ${JSON.stringify({ status: rejected.status, stdout: rejected.stdout.trim() })}`);
  expect(rejected.json).toMatchObject({ ok: false });
  expect(String(rejected.json.error)).toMatch(/receipt store is full for this sender; no draft was created/u);
}, 60_000);
