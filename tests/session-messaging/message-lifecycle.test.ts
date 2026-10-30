import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMessageStore, MESSAGE_DRAFT_TTL_MS } from "../../mcp-server/src/session-message-store.js";
import { dispatchSessionMessageBrokerOperation as dispatch } from "../../mcp-server/src/session-message-broker.js";
import { requestSessionMessageOnce, sessionMessageRequest, waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import type { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { SessionMessageHookOptions } from "../../mcp-server/src/session-message-hook.js";
import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";
import { processStartToken } from "../../mcp-server/src/process-identity.js";

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

const tickIdentity = { ...target, transport: "test-transport", relayId: "test-relay", instanceId: "generation-1", includePending: true };
function startTick(store: SessionMessageStore, nowMs = 1000) {
  store.startPresence({ ...tickIdentity, wakeVisibility: "none", canWakeSilently: false }, nowMs);
  expect(store.acquireRelay({ ...tickIdentity, pid: process.pid, parentPid: process.pid }, nowMs)).toBe(true);
}
const leases = (store: SessionMessageStore) => JSON.stringify([
  store.database.prepare("SELECT * FROM relay_leases").all(), store.database.prepare("SELECT * FROM session_presence").all(),
]);

it("one tick renews both leases and optionally counts pending messages", () => {
  const store = fixture(); startTick(store);
  store.submitPrepared(sender, prepare(store).messageId, 1001);
  expect(store.relayTick(tickIdentity, 2000)).toEqual({ alive: true, count: 1 });
  expect(store.presence(target, 2000).heartbeatAt).toBe(new Date(2000).toISOString());
  expect(store.liveRelay(target, tickIdentity.transport, 16_500)).not.toBeNull();
  expect(store.relayTick({ ...tickIdentity, includePending: false }, 3000)).toEqual({ alive: true, count: 0 });
  expect(store.pendingCount(target, 3000)).toBe(1);
});

it("stale generation, ended presence, transport, relay and expired leases have zero renewal effect", () => {
  for (const failure of ["generation", "ended", "transport", "relay", "relay-expiry", "presence-expiry"]) {
    const store = fixture(); startTick(store);
    let nowMs = 2000;
    const input = { ...tickIdentity };
    if (failure === "generation") store.startPresence({ ...input, instanceId: "generation-2", wakeVisibility: "none", canWakeSilently: false }, 1500);
    if (failure === "ended") store.endPresence(target, "test-ended", input.instanceId, 1500);
    if (failure === "transport") input.transport = "wrong-transport";
    if (failure === "relay") input.relayId = "wrong-relay";
    if (failure === "relay-expiry") nowMs = 16_000;
    if (failure === "presence-expiry") { store.heartbeatRelay(input, 15_000); nowMs = 21_000; }
    const before = leases(store);
    expect(store.relayTick(input, nowMs)).toEqual({ alive: false, count: 0 });
    expect(leases(store)).toBe(before);
  }
});

it("tick validation and a pending-query failure cannot partially update leases", () => {
  const store = fixture(); startTick(store, Date.now()); const before = leases(store);
  expect(() => dispatch(store, "relay-tick", { target, ...tickIdentity, includePending: "true" })).toThrow(/boolean/u);
  expect(leases(store)).toBe(before);
  const pending = vi.spyOn(store, "pendingCount").mockImplementation(() => { throw new Error("synthetic pending failure"); });
  expect(() => store.relayTick(tickIdentity)).toThrow(/synthetic/u);
  expect(leases(store)).toBe(before); pending.mockRestore();
});

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
  // The receipt is immutable; autoWake is a fresh advisory snapshot at each call.
  expect(store.submitPrepared(sender, draft.messageId, 3000)).toEqual({ ...first, duplicate: true, autoWake: { ...first.autoWake, checkedAt: new Date(3000).toISOString() } });
  expect(count(store)).toBe(1);
  const firstClaim = store.claim(target, 3001)[0]!;
  expect(firstClaim).toMatchObject({ messageId: draft.messageId, body: "Immutable synthetic message" });
  expect(store.acknowledge(target, [draft.messageId], 3002, [{ messageId: firstClaim.messageId, claimReceipt: firstClaim.claimReceipt! }])).toBe(1);
  expect(store.acknowledge(target, [draft.messageId], 3003, [{ messageId: firstClaim.messageId, claimReceipt: firstClaim.claimReceipt! }])).toBe(0);
  expect(store.status(sender, draft.messageId, 3003)?.acknowledgedAt).toBe(new Date(3002).toISOString());
  store.prune(32_000);
  expect(count(store)).toBe(1);
  expect(store.submitPrepared(sender, draft.messageId, 33_000)).toEqual({ ...first, duplicate: true, autoWake: { ...first.autoWake, checkedAt: new Date(33_000).toISOString() } });
  expect(count(store)).toBe(1);
  expect(store.status(sender, draft.messageId, 33_000)).toMatchObject({ state: "acknowledged", acknowledgedAt: new Date(3002).toISOString() });
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
  const fillReceipt = (index: number) => {
    const owner = { ...sender, sessionId: `receipt-owner-${index}` };
    const draft = store.prepare({ sender: owner, target, body: "x" }, 602_000);
    store.submitPrepared(owner, draft.messageId, 602_000);
    const claimed = store.claim(target, 602_000);
    expect(claimed.map(message => message.messageId)).toEqual([draft.messageId]);
    expect(store.acknowledge(target, [draft.messageId], 602_000, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  };
  for (let index = 0; index < 999; index++) fillReceipt(index);
  // Prepared while one global receipt slot remains; the slot is then taken before this draft is sent.
  const blocked = prepare(store, 602_000);
  fillReceipt(999);
  const release = { scope: "global", earliestReleaseAt: new Date(602_000 + 3600_000).toISOString() };
  const beforeDrafts = count(store, "prepared_messages");
  let admission: unknown;
  expect(() => { try { prepare(store, 602_001); } catch (error) { admission = error; throw error; } }).toThrow(/^The bounded message receipt store is full; no draft was created\.$/u);
  expect(admission).toMatchObject({ details: release });
  expect(count(store, "prepared_messages")).toBe(beforeDrafts);
  const beforeMessages = count(store);
  let submission: unknown;
  expect(() => { try { store.submitPrepared(sender, blocked.messageId, 602_001); } catch (error) { submission = error; throw error; } }).toThrow(/^The bounded message receipt store is full\.$/u);
  expect(submission).toMatchObject({ details: release });
  expect(count(store)).toBe(beforeMessages);
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
  const child = spawn(process.execPath, ["--import", new URL("./fixtures/message-response-loss.mjs", import.meta.url).href, path.join(root, "mcp-server/dist/session-message-broker.mjs"), "--state-directory", state], { windowsHide: true, stdio: "ignore", env: { ...process.env, AGS_DROP_MESSAGE_OPERATION: drop, AGS_MESSAGE_COUNTS_PATH: path.join(state, "operation-counts.json"), AGS_MESSAGE_SEQUENCE_PATH: path.join(state, "operation-sequence.json") } }); children.push(child);
  await waitForSessionMessageBrokerReady(state, child, 5000); return { state, child };
}
it("packaged TLS cycles use one request instead of three or two without changing pending state", async () => {
  const { state } = await launch();
  const operationCounts = async () => JSON.parse(await readFile(path.join(state, "operation-counts.json"), "utf8")) as Record<string, number>;
  const metrics = [];
  for (const includePending of [true, false]) {
    const transport = includePending ? "test-inbox" : "codex-deferred";
    const identity = { target, transport, relayId: "count-relay", instanceId: transport };
    await requestSessionMessageOnce("presence-start", { ...identity, wakeVisibility: "none", canWakeSilently: false }, state);
    await requestSessionMessageOnce("acquire-relay", { ...identity, pid: process.pid, parentPid: process.pid }, state);
    const before = await operationCounts();
    for (let cycle = 0; cycle < 10; cycle++) {
      expect(await requestSessionMessageOnce("heartbeat-relay", identity, state)).toEqual({ alive: true });
      expect(await requestSessionMessageOnce("presence-heartbeat", identity, state)).toEqual({ alive: true });
      if (includePending) expect(await requestSessionMessageOnce("pending", { target }, state)).toEqual({ count: 0 });
    }
    const middle = await operationCounts();
    for (let cycle = 0; cycle < 10; cycle++) expect(await requestSessionMessageOnce("relay-tick", { ...identity, includePending }, state)).toEqual({ alive: true, count: 0 });
    const after = await operationCounts();
    const baselineRequests = ["heartbeat-relay", "presence-heartbeat", "pending"].reduce((sum, op) => sum + (middle[op] ?? 0) - (before[op] ?? 0), 0);
    const tickRequests = (after["relay-tick"] ?? 0) - (middle["relay-tick"] ?? 0);
    expect(baselineRequests).toBe(includePending ? 30 : 20); expect(tickRequests).toBe(10);
    metrics.push({ transport, cycles: 10, baselineRequests, tickRequests });
  }
  console.info("relay tick measured TLS request counts", JSON.stringify(metrics));
  if (process.env.AGS_RELAY_TICK_EVIDENCE_PATH) await writeFile(process.env.AGS_RELAY_TICK_EVIDENCE_PATH, JSON.stringify({ observedAt: new Date().toISOString(), scope: "disposable packaged TLS broker, ten sequential synthetic cycles per transport, no CPU or installed-runtime claim", metrics }, null, 2) + "\n", "utf8");
}, 15_000);
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
  const { autoWake, ...receipt } = result as typeof result & { autoWake: Record<string, unknown> };
  expect(await requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, state)).toEqual({ ...receipt, autoWake: { ...autoWake, checkedAt: expect.any(String) } });
  expect(count(store)).toBe(1);
}, 15_000);

it.each([false, true])("claim response loss never replays a non-idempotent request (noOperationReplay=%s)", async (noOperationReplay) => {
  const { state } = await launch("claim");
  const drafts = [];
  for (const body of ["Synthetic A", "Synthetic B"]) {
    const draft = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target, body, ttlSeconds: 60 }, state);
    await requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, state);
    drafts.push(draft);
  }
  const sequence = async () => JSON.parse(await readFile(path.join(state, "operation-sequence.json"), "utf8")) as string[];
  const store = fixture(path.join(state, "session-messages.sqlite3"));
  // Set two distinct synthetic creation instants; scheduling cannot decide the expected claim order.
  drafts.forEach((draft, index) => store.database.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?")
    .run(new Date(Date.now() - 2000 + index * 1000).toISOString(), draft.messageId));
  const before = (await sequence()).length;
  const onOperationWrite = vi.fn();
  const pending = sessionMessageRequest<{ messages: { messageId: string }[] }>("claim", { target, maxMessages: 1 }, state,
    { totalTimeoutMs: 7000, onOperationWrite, ...(noOperationReplay ? { noOperationReplay, deadlineMonotonicMs: performance.now() + 7000 } : {}) });
  await expect(pending).rejects.toThrow();
  const operations = (await sequence()).slice(before);
  expect(operations.filter((operation) => operation === "claim")).toHaveLength(1);
  expect(operations).toEqual(noOperationReplay ? ["ping", "claim"] : ["claim"]);
  expect(onOperationWrite).toHaveBeenCalledTimes(1);
  expect(JSON.parse(await readFile(path.join(state, "operation-counts.json"), "utf8"))).toMatchObject({ claim: 1, responseDrops: 1 });
  expect(store.status(sender, drafts[0]!.messageId)).toMatchObject({ state: "delivered", deliveryAttempts: 1, acknowledgedAt: null });
  expect(store.status(sender, drafts[1]!.messageId)).toMatchObject({ state: "queued", deliveryAttempts: 0, acknowledgedAt: null });
}, 15_000);

it.each(["lost-reply", "success", "receipt-failure"])("the actual hook retains claim phases across real TLS and receipt handling: %s", async (mode) => {
  const { state } = await launch(mode === "lost-reply" ? "claim-turn-end" : "");
  const recipient = { host: "claude-code", sessionId: "budgeted-tls-recipient" };
  const draft = await requestSessionMessageOnce<{ messageId: string }>("prepare", { sender, target: recipient, body: "Synthetic budgeted hook body", ttlSeconds: 60 }, state);
  await requestSessionMessageOnce("send", { sender, messageId: draft.messageId }, state);
  const phases: { phase: string; messageIds: readonly string[] }[] = [];
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(state, "trust.sqlite3"));
  const close = vi.spyOn(TrustStore.prototype, "close");
  const verify = mode === "receipt-failure" ? vi.spyOn(TrustStore.prototype, "verify").mockReturnValue(false) : undefined;
  try {
    const output = await runSessionMessageHook("claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: recipient.sessionId }), undefined, {
      executionBudget: { deadlineMonotonicMs: performance.now() + 7000, postClaimReserveMs: 500 },
      onClaimState: (value) => { phases.push(value); },
    });
    expect(phases).toEqual(mode === "lost-reply" ? [{ phase: "request-attempted", messageIds: [] }] : [
      { phase: "request-attempted", messageIds: [] }, { phase: "response-received", messageIds: [draft.messageId] },
    ]);
    if (mode === "success") expect(output).toContain("Synthetic budgeted hook body");
    else expect(output).toBe("");
    expect(close).toHaveBeenCalledTimes(mode === "lost-reply" ? 0 : 1);
    const counts = JSON.parse(await readFile(path.join(state, "operation-counts.json"), "utf8"));
    expect(counts["claim-turn-end"]).toBe(1); expect(counts.acknowledge ?? 0).toBe(0);
    const store = fixture(path.join(state, "session-messages.sqlite3"));
    expect(store.status(sender, draft.messageId)).toMatchObject({ state: "delivered", deliveryAttempts: 1, acknowledgedAt: null });
  } finally { verify?.mockRestore(); close.mockRestore(); vi.unstubAllEnvs(); }
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
  const claimed = reopened.claim(target, 1002);
  expect(claimed).toMatchObject([{ messageId: "legacy-unissued-id", body: "Legacy fixture" }]);
  expect(reopened.acknowledge(target, ["legacy-unissued-id"], 1003, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
});

it("packaged CLI discovers prepare/send and rejects old or unknown send with zero queue effect", async () => {
  const { state } = await launch();
  const cli = (operation: string, payload: unknown) => spawnSync(process.execPath, [path.join(root, "mcp-server/dist/session-message-cli.mjs")], { input: JSON.stringify({ operation, payload }), encoding: "utf8", windowsHide: true, timeout: 5000, env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state } });
  const draft = JSON.parse(cli("prepare", { sender, target, body: "CLI synthetic" }).stdout).data;
  const sent = JSON.parse(cli("send", { sender, messageId: draft.messageId }).stdout).data;
  expect(JSON.parse(cli("send", { sender, messageId: draft.messageId }).stdout).data).toEqual({ ...sent, duplicate: true, autoWake: { ...sent.autoWake, checkedAt: expect.any(String) } });
  const legacy = cli("send", { sender, target, body: "old shape", messageId: "caller-legacy-id" });
  expect(legacy.status).toBe(1); expect(JSON.parse(legacy.stdout).error).toMatch(/prepare/u);
  const unknown = cli("send", { sender, messageId: "unknown-issued-id" });
  expect(unknown.status).toBe(1); expect(JSON.parse(unknown.stdout).error).toMatch(/delivery may be unknown/u);
  expect(JSON.parse(cli("pending", { target }).stdout).data.count).toBe(1);
}, 15_000);

// r11: native default remains denied; an explicit fake-root bridge tests fourth
// options against the actual built consumer over real TLS (not native evidence).
let builtSyntheticRegistered = false;
it.each(['success', 'lost-reply'])('r11 adapter consumes actual built common fourth options over real TLS: %s', async (mode) => {
  const { state } = await launch(mode === 'lost-reply' ? 'claim-deferred' : '');
  const recipient = { host: 'synthetic-message-core', sessionId: 'r11-built-consumer-recipient' };
  const drafts: { messageId: string }[] = [];
  for (const body of ['Synthetic r11 A', 'Synthetic r11 B']) {
    const draft = await requestSessionMessageOnce<{ messageId: string }>('prepare', { sender, target: recipient, body, ttlSeconds: 60 }, state);
    await requestSessionMessageOnce('send', { sender, messageId: draft.messageId }, state);
    drafts.push(draft);
  }
  const store = fixture(path.join(state, 'session-messages.sqlite3'));
  // 합성 root 역할은 adapter 라우팅만 제공한다. 신원 근거는 시험 소유 PID의 실제 OS 출생 토큰이며,
  // 공통 번들의 재검증과 store의 현재 presence 세대 일치를 모두 통과해야 원 phases까지 도달한다.
  const startToken = processStartToken(process.pid);
  expect(startToken).not.toBeNull();
  const hostProcess = { pid: process.pid, startToken: startToken! };
  const instanceId = 'host-process-v1:' + createHash('sha256')
    .update(JSON.stringify([recipient.host, recipient.sessionId, hostProcess.pid, hostProcess.startToken])).digest('hex');
  // 미기동 grant를 명시적으로 보유해 recovery가 별도 relay 자식을 만들지 않게 한다.
  expect(store.prepareVerifiedRelay({ ...recipient, instanceId, transport: 'codex-deferred',
    parentPid: hostProcess.pid, expectedOwner: null, wakeVisibility: 'none', canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ['tool-boundary'], idleWake: 'none' },
  })).toMatchObject({ spawn: true, instanceId });
  expect(store.presence(recipient).instanceId).toBe(instanceId);
  drafts.forEach((draft, index) => store.database.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?')
    .run(new Date(Date.now() - 2000 + index * 1000).toISOString(), draft.messageId));
  vi.stubEnv('AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR', state);
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', path.join(state, 'r11-trust.sqlite3'));
  vi.stubEnv('AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE', '0');
  try {
    const { executeAntigravityHookEvent, createClaimStateTracker, finalizeConnectorOutput } = await import(
      pathToFileURL(path.join(root, 'antigravity-connector/hooks/antigravity-hook-runner.mjs')).href);
    const built = await import(pathToFileURL(path.join(root, 'mcp-server/dist/session-message-hook.mjs')).href) as {
      registerHookHostAdapter: typeof registerHookHostAdapter;
      handleSessionMessageHook: typeof import("../../mcp-server/src/session-message-hook.js").handleSessionMessageHook;
    };
    const syntheticCore = await import(new URL('./fixtures/synthetic-core-hook-driver.mjs', import.meta.url).href) as {
      registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
    };
    // This bundle namespace is cached across the two modes; register only once.
    if (!builtSyntheticRegistered) {
      syntheticCore.registerSyntheticCoreAdapters(built.registerHookHostAdapter, () => "codex-deferred");
      builtSyntheticRegistered = true;
    }
    // 3.0 stopgap: a native Antigravity call is inferred root and claims for itself, so the
    // former inert-native check is gone; the adapter-routed claim below is the one under test.
    expect(store.status(sender, drafts[0]!.messageId)).toMatchObject({ state: 'queued', deliveryAttempts: 0, acknowledgedAt: null });
    expect(store.status(sender, drafts[1]!.messageId)).toMatchObject({ state: 'queued', deliveryAttempts: 0, acknowledgedAt: null });
    let callbacks = 0;
    const phases: { phase: string; messageIds: readonly string[] }[] = [];
    const tracker = createClaimStateTracker((value: { phase: string; messageIds: readonly string[] }) => { phases.push(value); });
    const output = await executeAntigravityHookEvent({ conversationId: recipient.sessionId, agent_id: '' }, 'PreInvocation', 'session-message', {
      entryMonotonicMs: performance.now(), totalBudgetMs: 7000, postClaimReserveMs: 500, claimTracker: tracker,
      resolveHostProcess: () => hostProcess,
      sessionMessageHook: (input: Record<string, unknown>, host: string, pid: number | undefined, options: SessionMessageHookOptions) => {
        callbacks++; expect(host).toBe('antigravity');
        return built.handleSessionMessageHook({ ...input, syntheticActor: 'root' }, recipient.host, pid, options);
      },
    });
    expect(callbacks).toBe(1);
    expect(phases).toEqual(mode === 'lost-reply' ? [{ phase: 'request-attempted', messageIds: [] }] : [
      { phase: 'request-attempted', messageIds: [] }, { phase: 'response-received', messageIds: [drafts[0]!.messageId] },
    ]);
    expect(tracker.getSnapshot().state).toBe(mode === 'lost-reply' ? 'claim-result-unknown' : 'after-claim-before-output');
    if (mode === 'success') expect(JSON.stringify(output)).toContain('Synthetic r11 A');
    else expect(output).toEqual({});
    const counts = JSON.parse(await readFile(path.join(state, 'operation-counts.json'), 'utf8'));
    expect(counts['claim-deferred']).toBe(1); expect(counts.acknowledge ?? 0).toBe(0);
    expect(store.status(sender, drafts[0]!.messageId)).toMatchObject({ state: 'delivered', deliveryAttempts: 1, acknowledgedAt: null });
    expect(store.status(sender, drafts[1]!.messageId)).toMatchObject({ state: 'queued', deliveryAttempts: 0, acknowledgedAt: null });
    const diagnostics: string[] = [];
    let writes = 0;
    finalizeConnectorOutput(mode === 'success' ? JSON.stringify(output) : '', tracker, {
      env: {}, writeStdout: (_text: string, callback: (error: Error | null) => void) => { writes++; callback(null); },
      writeStderr: (line: string) => { diagnostics.push(line); },
    });
    expect(writes).toBe(mode === 'success' ? 1 : 0);
    expect(tracker.getSnapshot().state).toBe(mode === 'success' ? 'stdout-written-not-consumed' : 'claim-result-unknown');
    expect(tracker.getSnapshot().hostConsumedConfirmed).toBe(false);
    expect(diagnostics.length).toBe(mode === 'lost-reply' ? 1 : 0);
    if (diagnostics.length) {
      const diagnostic = JSON.parse(diagnostics[0]!).agsAntigravityHookDiagnostic;
      expect(Object.keys(diagnostic).sort()).toEqual(['claimState', 'hostConsumedConfirmed', 'messageCount', 'observerError', 'reentered']);
      expect(diagnostic).toMatchObject({ claimState: 'claim-result-unknown', hostConsumedConfirmed: false, messageCount: 0 });
      expect(diagnostics.join('')).not.toContain('Synthetic r11');
      for (const draft of drafts) expect(diagnostics.join('')).not.toContain(draft.messageId);
    }
  } finally { vi.unstubAllEnvs(); }
}, 15_000);
