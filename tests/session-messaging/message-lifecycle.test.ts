import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { SessionMessageStore, MESSAGE_DRAFT_TTL_MS } from "../../mcp-server/src/session-message-store.js";
import { dispatchSessionMessageBrokerOperation as dispatch } from "../../mcp-server/src/session-message-broker.js";
import { requestSessionMessageOnce, sessionMessageRequest, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";

const sender = { host: "test-host", sessionId: "issued-owner" };
const target = { host: "test-host", sessionId: "issued-recipient" };
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
const prepare = (store: SessionMessageStore, now = 1000) => store.prepare({ sender, target, body: "Immutable synthetic message", ttlSeconds: 30 }, now);
const count = (store: SessionMessageStore, table = "messages") => Number((store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);

it("issues opaque IDs without queue, peer relationship, claim or wake effect", () => {
  const store = fixture(); const draft = prepare(store);
  expect(draft.messageId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(draft.expiresAt).toBe(new Date(1000 + MESSAGE_DRAFT_TTL_MS).toISOString());
  expect(count(store)).toBe(0);
  expect(store.pendingCount(target, 1001)).toBe(0);
  expect(store.claim(target, 1001)).toEqual([]);
  expect(store.peerWaitState(sender, target, 1001).related).toBe(false);
  expect(store.reserveWake(target, "nonce-prepare-no-delivery", 1001)).toBe(false);
  expect(store.status(sender, draft.messageId, 1001)).toMatchObject({ state: "prepared" });
});

it("rejects unknown, another sender and mutated public payload without enqueue", () => {
  const store = fixture(); const draft = prepare(store, Date.now());
  for (const payload of [{ sender, messageId: "caller-made-id" }, { sender: target, messageId: draft.messageId }, { sender, messageId: draft.messageId, body: "changed" }, { sender, messageId: draft.messageId, target }, { sender, messageId: draft.messageId, ttlSeconds: 31 }]) {
    expect(() => dispatch(store, "send", payload)).toThrow();
    expect(count(store)).toBe(0);
  }
  expect(() => dispatch(store, "prepare", { sender, target, body: "hello", messageId: "caller-made-id" })).toThrow(/system-issued/u);
  expect(store.status(target, draft.messageId)).toBeNull();
});

it("keeps the first immutable receipt and does not enqueue or wake after ACK/prune", () => {
  const store = fixture(); const draft = prepare(store);
  const first = store.submitPrepared(sender, draft.messageId, 2000);
  expect(first.expiresAt).toBe(new Date(32_000).toISOString());
  expect(store.submitPrepared(sender, draft.messageId, 3000)).toEqual({ ...first, duplicate: true });
  expect(count(store)).toBe(1);
  const firstClaim = store.claim(target, 3001)[0]!;
  expect(firstClaim).toMatchObject({ messageId: draft.messageId, body: "Immutable synthetic message" });
  expect(store.acknowledge(target, [draft.messageId], 3002)).toBe(1);
  expect(store.acknowledge(target, [draft.messageId], 3003)).toBe(0);
  expect(store.status(sender, draft.messageId, 3003)?.acknowledgedAt).toBe(new Date(3002).toISOString());
  store.prune(32_000);
  expect(count(store)).toBe(0);
  expect(store.submitPrepared(sender, draft.messageId, 33_000)).toEqual({ ...first, duplicate: true });
  expect(count(store)).toBe(0);
  expect(store.status(sender, draft.messageId, 33_000)).toMatchObject({ state: "submitted", deliveryState: "unknown" });
  store.prune(3_632_000);
  expect(() => store.submitPrepared(sender, draft.messageId, 3_632_000)).toThrow(/unavailable/u);
  expect(count(store)).toBe(0);
});

it("rejects exact draft expiry and validates Unicode, TTL and sender draft capacity", () => {
  const store = fixture(); const draft = prepare(store);
  expect(() => store.submitPrepared(sender, draft.messageId, 1000 + MESSAGE_DRAFT_TTL_MS)).toThrow(/unavailable/u);
  expect(() => store.prepare({ sender, target, body: "가".repeat(2048) }, 1000)).toThrow(/UTF-8/u);
  for (const ttlSeconds of [29, 86401, 1.5]) expect(() => store.prepare({ sender, target, body: "hello", ttlSeconds }, 1000)).toThrow(/ttlSeconds/u);
  for (let index = 0; index < 99; index++) prepare(store);
  expect(count(store, "prepared_messages")).toBe(100);
  expect(() => prepare(store)).toThrow(/full/u);
  expect(count(store)).toBe(0);
  store.prune(1000 + MESSAGE_DRAFT_TTL_MS);
  expect(count(store, "prepared_messages")).toBe(0);
  expect(prepare(store, 1000 + MESSAGE_DRAFT_TTL_MS).messageId).toBeTruthy();
});

it("applies global draft, receipt and byte backpressure without evicting valid records", () => {
  const store = fixture();
  for (let index = 0; index < 1000; index++) store.prepare({ sender: { ...sender, sessionId: `owner-${index}` }, target, body: "x" }, 1000);
  expect(() => store.prepare({ sender, target, body: "x" }, 1000)).toThrow(/full/u);
  expect(count(store, "prepared_messages")).toBe(1000);
  store.prune(601_000);
  for (let index = 0; index < 1000; index++) {
    const owner = { ...sender, sessionId: `receipt-owner-${index}` };
    const draft = store.prepare({ sender: owner, target, body: "x" }, 602_000);
    store.submitPrepared(owner, draft.messageId, 602_000);
    store.acknowledge(target, [draft.messageId], 602_000);
  }
  const blocked = prepare(store, 602_001);
  expect(() => store.submitPrepared(sender, blocked.messageId, 602_001)).toThrow(/receipt store is full/u);
  expect(store.status(sender, blocked.messageId, 602_001)).toMatchObject({ state: "prepared" });
  const bytes = fixture();
  let accepted = 0;
  for (let index = 0; index < 1000; index++) {
    try { bytes.prepare({ sender: { ...sender, sessionId: `bytes-${index}` }, target, body: "\u0001".repeat(4096) }, 1000); accepted++; }
    catch (error) { expect(String(error)).toMatch(/full/u); break; }
  }
  expect(accepted).toBeGreaterThan(0); expect(accepted).toBeLessThan(1000);
  expect(count(bytes, "prepared_messages")).toBe(accepted);
  expect(count(bytes)).toBe(0);
});

async function directory() { const value = await mkdtemp(path.join(tmpdir(), "ags-issued-")); directories.push(value); return value; }
async function launch(drop = "") {
  const state = await directory();
  const child = spawn(process.execPath, ["--import", new URL("./fixtures/message-response-loss.mjs", import.meta.url).href, path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_DROP_MESSAGE_OPERATION: drop, AGS_MESSAGE_COUNTS_PATH: path.join(state, "operation-counts.json") } }); children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000); return { state, child };
}
it("a real post-commit prepare reply loss leaves only orphan drafts", async () => {
  const { state } = await launch("prepare");
  await expect(requestSessionMessageOnce("prepare", { sender, target, body: "Lost preparation" }, state, 300)).rejects.toThrow();
  const second = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target, body: "Lost preparation" }, state);
  const store = fixture(path.join(state, "session-messages.sqlite3"));
  expect(count(store, "prepared_messages")).toBe(2); expect(count(store)).toBe(0);
  expect(store.status(sender, second.messageId)).toMatchObject({ state: "prepared" });
  expect(store.pendingCount(target)).toBe(0);
}, 15_000);

it("a real send reply loss retries the known ID once and survives broker restart", async () => {
  const { state, child } = await launch("send");
  const draft = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target, body: "Lost send reply", ttlSeconds: 60 }, state);
  const result = await sessionMessageRequest<{ messageId: string; createdAt: string; expiresAt: string; duplicate: boolean }>("send", { sender, messageId: draft.messageId }, state, { totalTimeoutMs: 7000 });
  expect(result).toMatchObject({ messageId: draft.messageId, duplicate: true });
  expect(JSON.parse(await readFile(path.join(state, "operation-counts.json"), "utf8"))).toMatchObject({ send: 2, responseDrops: 1 });
  const store = fixture(path.join(state, "session-messages.sqlite3")); expect(count(store)).toBe(1);
  const exit = once(child, "exit"); child.kill(); await exit;
  const replacement = spawn(process.execPath, [path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore" }); children.push(replacement);
  await waitForSessionMessageBrokerReady(state, replacement, 5000);
  expect(await requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, state)).toEqual(result);
  expect(count(store)).toBe(1);
}, 15_000);

it("two independent processes submit one ID atomically and enforce sender preparation capacity", async () => {
  const state = await directory(); const database = path.join(state, "race.sqlite3"); const store = fixture(database);
  const draft = prepare(store);
  async function race(operation: "prepare" | "send", nowMs: number) {
    const workers = [0, 1].map(() => spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/issued-send-worker.ts", import.meta.url)), database], { windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"] })); children.push(...workers);
    await Promise.all(workers.map((worker) => once(worker, "message")));
    const results = workers.map((worker) => once(worker, "message"));
    const exits = workers.map((worker) => once(worker, "exit"));
    workers.forEach((worker) => worker.send({ operation, sender, target, messageId: draft.messageId, nowMs }));
    const output = (await Promise.all(results)).map(([value]) => value as { result?: { duplicate: boolean }; error?: string });
    await Promise.all(exits); return output;
  }
  const sent = await race("send", 2000);
  expect(sent.filter((value) => value.result?.duplicate === false)).toHaveLength(1);
  expect(sent.filter((value) => value.result?.duplicate === true)).toHaveLength(1);
  expect(count(store)).toBe(1);
  for (let index = 0; index < 99; index++) prepare(store, 3000);
  const preparations = await race("prepare", 3001);
  expect(preparations.filter((value) => value.error)).toHaveLength(1);
  expect(count(store, "prepared_messages")).toBe(101);
}, 20_000);

it("preserves old messages across additive schema initialization but refuses old IDs as new sends", async () => {
  const state = await directory(); const database = path.join(state, "legacy.sqlite3");
  const old = fixture(database); old.send({ sender, target, body: "Legacy fixture", messageId: "legacy-unissued-id" }, 1000);
  old.database.exec("DROP TABLE prepared_messages"); old.close(); stores.splice(stores.indexOf(old), 1);
  const reopened = fixture(database);
  expect(reopened.status(sender, "legacy-unissued-id", 1001)).toMatchObject({ state: "queued" });
  expect(() => reopened.submitPrepared(sender, "legacy-unissued-id", 1001)).toThrow(/unavailable/u);
  expect(reopened.claim(target, 1002)).toMatchObject([{ messageId: "legacy-unissued-id", body: "Legacy fixture" }]);
  expect(reopened.acknowledge(target, ["legacy-unissued-id"], 1003)).toBe(1);
});

it("packaged CLI discovers prepare/send and rejects old or unknown send with zero queue effect", async () => {
  const { state } = await launch();
  const cli = (operation: string, payload: unknown) => spawnSync(process.execPath, [path.join(root, "mcp-server/dist/session-message-cli.mjs")], { input: JSON.stringify({ operation, payload }), encoding: "utf8", windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state } });
  const draft = JSON.parse(cli("prepare", { sender, target, body: "CLI synthetic" }).stdout).data;
  const sent = JSON.parse(cli("send", { sender, messageId: draft.messageId }).stdout).data;
  expect(JSON.parse(cli("send", { sender, messageId: draft.messageId }).stdout).data).toEqual({ ...sent, duplicate: true });
  const legacy = cli("send", { sender, target, body: "old shape", messageId: "caller-legacy-id" });
  expect(legacy.status).toBe(1); expect(JSON.parse(legacy.stdout).error).toMatch(/prepare/u);
  const unknown = cli("send", { sender, messageId: "unknown-issued-id" });
  expect(unknown.status).toBe(1); expect(JSON.parse(unknown.stdout).error).toMatch(/delivery may be unknown/u);
  expect(JSON.parse(cli("pending", { target }).stdout).data.count).toBe(1);
}, 15_000);
