import { fork, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import { dispatchSessionMessageOperation as dispatch } from "../../mcp-server/src/session-message-operations.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { recordWakeHookObservation, wakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";

// 3.9.0 recall (v390-recall-cases.md RC01-RC09). Real temporary SQLite files; every time is an explicit fixture argument.
// Expected values follow the recall policy (e-mail send cancel), never the implementation under test.
const host = "recall-synthetic";
registerHookHostAdapter(host, {
  adaptInput(input, selectedHost) {
    const adapted = adaptHostInput(input, "codex");
    return { ...adapted, observation: { ...adapted.observation, host: selectedHost,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_RECALL_ROOT" } } };
  },
  deliveryProfile: () => ({ transport: "recall-synthetic", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  processPid: () => undefined,
});

const sender = { host, sessionId: "recall-sender" };
const target = { host, sessionId: "recall-target" };
const other = { host, sessionId: "recall-other-sender" };
// Fixture times sit just before the wall clock, so a default-time (dispatch) call still finds unexpired records.
const T0 = Date.now() - 1000;
const iso = (at: number) => new Date(at).toISOString();
const resources: Array<{ directory: string; close: Array<() => void> }> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, close } of resources.splice(0)) {
    for (const item of close) item();
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ags-recall-"));
  const database = join(directory, "messages.sqlite3");
  const store = new SessionMessageStore(database);
  resources.push({ directory, close: [() => store.close()] });
  return { directory, database, store };
}
function sent(store: SessionMessageStore, at = T0, ttlSeconds = 600): string {
  const { messageId } = store.prepare({ sender, target, body: `recall body ${at}`, ttlSeconds }, at);
  store.submitPrepared(sender, messageId, at);
  return messageId;
}
const rows = (store: SessionMessageStore) => JSON.stringify([
  store.database.prepare("SELECT * FROM messages ORDER BY message_id").all(),
  store.database.prepare("SELECT * FROM prepared_messages ORDER BY message_id").all(),
]);

it("RC01: an unreceived message is recalled; no claim ever returns it and status reads recalled", () => {
  const { store } = fixture();
  const messageId = sent(store);
  const kept = sent(store, T0 + 1);
  const result = store.recall(sender, messageId, T0 + 10);
  expect(result).toEqual({ recalled: true, status: expect.objectContaining({ messageId, state: "recalled", recalledAt: iso(T0 + 10),
    receiptExpiresAt: iso(T0 + 10 + 3600_000) }) });
  expect(store.status(sender, messageId, T0 + 11)).toMatchObject({ state: "recalled", recalledAt: iso(T0 + 10) });
  expect(store.pendingCount(target, T0 + 12)).toBe(1);
  // Every claim path reads the same queue: the recalled body is gone, the other one is delivered.
  const [delivered] = store.claimTurnEnd(target, T0 + 13);
  expect(delivered?.messageId).toBe(kept);
  expect(store.acknowledge(target, [kept], T0 + 14, [{ messageId: kept, claimReceipt: delivered!.claimReceipt! }])).toBe(1);
  expect(store.claim(target, T0 + 300_000)).toEqual([]);
  expect(store.claimDeferred(target, T0 + 300_001)).toEqual([]);
  // A repeated send of the same ID returns the receipt and never queues it again.
  expect(store.submitPrepared(sender, messageId, T0 + 300_002)).toMatchObject({ messageId, duplicate: true, recalledAt: iso(T0 + 10) });
  expect(store.claim(target, T0 + 400_000)).toEqual([]);
});

it("RC02: the same recall again answers the same recalledAt with duplicate and writes nothing", () => {
  const { store } = fixture();
  const messageId = sent(store);
  const first = store.recall(sender, messageId, T0 + 10);
  const before = rows(store);
  const again = dispatch(store, "recall", { sender, messageId });
  expect(again).toEqual({ recalled: true, duplicate: true, status: first.status });
  expect(rows(store)).toBe(before);
  expect(() => dispatch(store, "recall", { sender, messageId, target })).toThrow(/recall accepts only sender/u);
});

it("RC03: a received message is refused with its delivery facts; nothing changes and the recipient still acknowledges", () => {
  const { store } = fixture();
  const messageId = sent(store);
  const [claimed] = store.claim(target, T0 + 5);
  const before = rows(store);
  expect(store.recall(sender, messageId, T0 + 10)).toEqual({ recalled: false, reason: "delivered", status: expect.objectContaining({
    state: "delivered", claimedAt: iso(T0 + 5), firstDeliveredAt: iso(T0 + 5), acknowledgedAt: null }) });
  expect(rows(store)).toBe(before);
  // A lapsed claim lease is still a received message: the refusal holds and the body is redelivered, not recalled.
  expect(store.recall(sender, messageId, T0 + 200_000)).toMatchObject({ recalled: false, reason: "delivered" });
  expect(store.acknowledge(target, [messageId], T0 + 200_001, [{ messageId, claimReceipt: claimed!.claimReceipt! }])).toBe(1);
});

it("RC04: an acknowledged message is refused with its acknowledgement time", () => {
  const { store } = fixture();
  const messageId = sent(store);
  const [claimed] = store.claim(target, T0 + 5);
  store.acknowledge(target, [messageId], T0 + 6, [{ messageId, claimReceipt: claimed!.claimReceipt! }]);
  expect(store.recall(sender, messageId, T0 + 10)).toEqual({ recalled: false, reason: "delivered",
    status: expect.objectContaining({ state: "acknowledged", acknowledgedAt: iso(T0 + 6) }) });
});

it("RC05: another sender and an unknown ID get the same answer as status (null); the message stays deliverable", () => {
  const { store } = fixture();
  const messageId = sent(store);
  const before = rows(store);
  const foreign = store.recall(other, messageId, T0 + 10);
  const unknown = store.recall(sender, "unknown-message-id", T0 + 10);
  expect(foreign).toEqual({ recalled: false, reason: "unknown", status: null });
  expect(unknown).toEqual(foreign);
  expect(store.status(other, messageId, T0 + 10)).toBeNull();
  expect(rows(store)).toBe(before);
  expect(store.claim(target, T0 + 11).map(message => message.messageId)).toEqual([messageId]);
});

it("RC06: a message past its TTL answers expired and is not recalled", () => {
  const { store } = fixture();
  const messageId = sent(store, T0, 30);
  const result = store.recall(sender, messageId, T0 + 30_000);
  expect(result).toMatchObject({ recalled: false, reason: "expired", status: { state: "submitted" } });
  expect(store.status(sender, messageId, T0 + 30_001)).toMatchObject({ state: "submitted", deliveryState: "unknown" });
});

it("RC07: a prepared but unsent ID answers not-sent; recall is no send and no draft is consumed", () => {
  const { store } = fixture();
  const { messageId } = store.prepare({ sender, target, body: "draft only" }, T0);
  expect(store.recall(sender, messageId, T0 + 1)).toMatchObject({ recalled: false, reason: "not-sent", status: { state: "prepared" } });
  expect(store.recall(other, messageId, T0 + 1)).toEqual({ recalled: false, reason: "unknown", status: null });
  expect(store.submitPrepared(sender, messageId, T0 + 2)).toMatchObject({ messageId, duplicate: false });
});

it("RC08: a wake rung before the recall arrives recognized and empty; no new wake rings for the recalled body", () => {
  const { directory, store } = fixture();
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", join(directory, "trust.sqlite3"));
  const trust = new TrustStore(join(directory, "trust.sqlite3"));
  resources.at(-1)!.close.unshift(() => trust.close());
  const at = Date.now();
  const transport = "recall-synthetic";
  store.startPresence({ ...target, instanceId: "recall-birth", transport, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" }, hostPid: process.pid }, at);
  const { relayId } = store.grantRelay({ ...target, instanceId: "recall-birth", transport, codeDigest: null, hostPid: process.pid }, at);
  expect(relayId).toEqual(expect.any(String));
  expect(store.relayTick({ ...target, instanceId: "recall-birth", transport, relayId: relayId!, includePending: false, hostStart: "recall-host-start" }, at))
    .toMatchObject({ alive: true, hostBound: true });
  const { messageId } = store.prepare({ sender, target, body: "rung then recalled" }, at);
  store.submitPrepared(sender, messageId, at);
  const binding = { ...target, instanceId: "recall-birth", relayId: relayId!, transport, resume: true };
  const reserved = store.reserveManagedWake({ ...binding, nonce: "recall-wake-nonce-abcdefghijklmnop" }, at + 1);
  expect(reserved.dispatch).toBe(true);
  const started = store.startManagedWake(reserved.attempt!, 600_000, at + 2);
  expect(started.dispatch).toBe(true);
  expect(store.recordManagedWakeOutcome(started.attempt!, { result: "handed-off" }, 600_000, at + 3)).toBe(true);

  expect(store.recall(sender, messageId, at + 4)).toMatchObject({ recalled: true });
  const observation = adaptHostInput({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "",
    prompt: "[agent-governance-suite:wake:recall-wake-nonce-abcdefghijklmnop]" }, host).observation;
  const receipt = recordWakeHookObservation(observation, at + 5);
  const arrival = store.claimHostWake(target, observation, receipt, wakeHookObservationReader, at + 6);
  // The recognized, managed, empty shape the hook already handles as an empty wake (ags38-peer-wake PE02/PE04), not a failure.
  expect(arrival).toMatchObject({ recognized: true, messages: [], binding: expect.objectContaining({ nonce: "recall-wake-nonce-abcdefghijklmnop" }) });
  expect(arrival.rejectionReason).toBeUndefined();
  store.clearDeferred(target, at + 7);
  expect(store.reserveManagedWake({ ...binding, nonce: "recall-wake-nonce-second-abcdefghij" }, at + 120_000).dispatch).toBe(false);
});

it("RC09: two processes racing recall against claim on one database: every message is recalled or claimed, never both", async () => {
  const { database, store } = fixture();
  const ids = Array.from({ length: 40 }, (_, index) => sent(store, T0 + index, 86_400));
  const worker = fileURLToPath(new URL("./fixtures/recall-race-worker.mjs", import.meta.url));
  const spawnWorker = async (mode: "recall" | "claim") => {
    const child = fork(worker, [mode, database, JSON.stringify({ sender, target, ids })],
      { execArgv: ["--import", "tsx"], silent: true, windowsHide: true } as ForkOptions);
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    const exit = once(child, "exit");
    const [ready] = await Promise.race([once(child, "message"), exit.then(([code]) => { throw new Error(`worker exited early: ${code}; ${stderr}`); })]) as [{ type: string }];
    expect(ready.type, stderr).toBe("ready");
    return { child, exit, stderr: () => stderr };
  };
  const workers = await Promise.all([spawnWorker("recall"), spawnWorker("claim")]);
  const replies = workers.map(w => once(w.child, "message"));
  for (const w of workers) w.child.send({ go: true });
  type Reply = { results: Array<{ id: string; recalled: boolean; reason?: string }>; claimed: string[]; error?: string };
  const [recallReply, claimReply] = (await Promise.all(replies)).map(([message]) => message as Reply);
  for (const w of workers) { const [code] = await w.exit; expect(code, w.stderr()).toBe(0); }
  expect(recallReply!.error).toBeUndefined();
  expect(claimReply!.error).toBeUndefined();
  const recalled = new Set(recallReply!.results.filter(result => result.recalled).map(result => result.id));
  const claimed = new Set(claimReply!.claimed);
  // The split depends on scheduling and is reported, not asserted; the invariant below holds for every split.
  console.info(`RC09 split: recalled ${recalled.size}, claimed ${claimed.size}`);
  expect([...recalled].filter(id => claimed.has(id))).toEqual([]);
  expect(recalled.size + claimed.size).toBe(ids.length);
  for (const result of recallReply!.results.filter(item => !item.recalled)) {
    expect(result.reason, result.id).toBe("delivered");
    expect(claimed.has(result.id), result.id).toBe(true);
  }
  expect(store.pendingCount(target)).toBe(0);
});
