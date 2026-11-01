import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { SessionMessageStore, MESSAGE_DRAFT_TTL_MS } from "../../mcp-server/src/session-message-store.js";
import { dispatchSessionMessageOperation as dispatch } from "../../mcp-server/src/session-message-operations.js";
import { closeSessionMessaging, runSessionMessageOperation } from "../../mcp-server/src/session-message-client.js";
import type { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { SessionMessageHookOptions } from "../../mcp-server/src/session-message-hook.js";
import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { readRelayCodeDigest } from "../../mcp-server/src/relay-code-identity.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";

const sender = { host: "test-host", sessionId: "issued-owner" };
const target = { host: "test-host", sessionId: "issued-recipient" };
const root = process.env.PEER_WAIT_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
/** State directories this process opened through the in-process client; closed before removal. */
const stateDirectories: string[] = [];
/** Directories a built bundle opened in this process; that bundle exposes no close, so Windows cannot remove them. */
const bundleDirectories: string[] = [];
const children: ChildProcess[] = [];
const stores: SessionMessageStore[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  }
  for (const directory of stateDirectories.splice(0)) closeSessionMessaging(directory);
  for (const directory of directories.splice(0)) {
    if (process.platform === "win32" && bundleDirectories.includes(directory)) continue;
    await rm(directory, { recursive: true, force: true, maxRetries: 10 });
  }
});
const fixture = (database = ":memory:") => { const store = new SessionMessageStore(database); stores.push(store); return store; };
const prepare = (store: SessionMessageStore, now = 1000) => store.prepare({ sender, target, body: "Immutable synthetic message", ttlSeconds: 30 }, now);
const count = (store: SessionMessageStore, table = "messages") => Number((store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count);

const transport = "test-transport";
const instanceId = "generation-1";
const HOST_PID = 4242;
/** A granted relay lease of the current birth (the hook's presence-start grant); the relay's first tick binds the host birth. */
function startTick(store: SessionMessageStore, nowMs = 1000) {
  store.startPresence({ ...target, instanceId, transport, wakeVisibility: "none", canWakeSilently: false, hostPid: HOST_PID }, nowMs);
  const grant = store.grantRelay({ ...target, transport, instanceId, codeDigest: null, hostPid: HOST_PID }, nowMs);
  expect(grant.relayId).toMatch(/^[0-9a-f-]{36}$/u);
  return { ...target, transport, relayId: grant.relayId!, instanceId, includePending: true };
}
const leases = (store: SessionMessageStore) => JSON.stringify([
  store.database.prepare("SELECT * FROM relay_leases").all(), store.database.prepare("SELECT * FROM session_presence").all(),
]);

it("one tick renews both leases, binds the host birth once and optionally counts pending messages", () => {
  const store = fixture(); const tick = startTick(store);
  store.submitPrepared(sender, prepare(store).messageId, 1001);
  expect(store.relayTick(tick, 2000)).toEqual({ alive: true, count: 1, hostBound: false });
  expect(store.presence(target, 2000).heartbeatAt).toBe(new Date(2000).toISOString());
  expect(store.liveRelay(target, transport, 16_999)).not.toBeNull();
  expect(store.liveRelay(target, transport, 17_000)).toBeNull();
  expect(store.relayTick({ ...tick, includePending: false, hostStart: "start-1" }, 3000)).toEqual({ alive: true, count: 0, hostBound: true });
  expect(store.presenceHost(target, instanceId)).toEqual({ pid: HOST_PID, start: "start-1" });
  expect(store.relayTick({ ...tick, includePending: false }, 4000)).toEqual({ alive: true, count: 0, hostBound: true });
  expect(store.pendingCount(target, 4000)).toBe(1);
});

it("stale generation, ended presence, transport, relay, host birth and expired leases have zero renewal effect", () => {
  for (const failure of ["generation", "ended", "transport", "relay", "host-birth", "relay-expiry", "presence-expiry"]) {
    const store = fixture(); const tick = startTick(store);
    // Bound tick at 1000: relay lease until 16000, presence lease until 21000.
    expect(store.relayTick({ ...tick, hostStart: "start-1" }, 1000)).toMatchObject({ alive: true, hostBound: true });
    let nowMs = 2000;
    const input: typeof tick & { hostStart?: string } = { ...tick };
    if (failure === "generation") store.startPresence({ ...target, instanceId: "generation-2", transport, wakeVisibility: "none", canWakeSilently: false }, 1500);
    if (failure === "ended") store.endPresence(target, "test-ended", instanceId, 1500);
    if (failure === "transport") input.transport = "wrong-transport";
    if (failure === "relay") input.relayId = "wrong-relay";
    if (failure === "host-birth") input.hostStart = "start-2";
    if (failure === "relay-expiry") nowMs = 16_000;
    if (failure === "presence-expiry") {
      store.database.prepare("UPDATE relay_leases SET lease_until = ?").run(new Date(40_000).toISOString());
      nowMs = 21_000;
    }
    const before = leases(store);
    expect(store.relayTick(input, nowMs), failure).toEqual({ alive: false, count: 0, hostBound: false });
    expect(leases(store), failure).toBe(before);
  }
});

it("tick validation and a pending-query failure cannot partially update leases", () => {
  const store = fixture(); const tick = startTick(store); const before = leases(store);
  expect(() => dispatch(store, "relay-tick", { target, transport, relayId: tick.relayId, instanceId, includePending: "true" })).toThrow(/boolean/u);
  expect(leases(store)).toBe(before);
  const pending = vi.spyOn(store, "pendingCount").mockImplementation(() => { throw new Error("synthetic pending failure"); });
  expect(() => store.relayTick(tick, 2000)).toThrow(/synthetic/u);
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
  expect(count(store, "wake_nonces")).toBe(0);
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
/** A state directory used through this process's in-process client. */
async function stateDirectory() { const value = await directory(); stateDirectories.push(value); return value; }

it.each(["success", "receipt-failure"])("the actual hook retains claim phases and receipt handling in process: %s", async (mode) => {
  const state = await stateDirectory();
  // The client reads the trust path when it first opens the state directory.
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(state, "trust.sqlite3"));
  const recipient = { host: "claude-code", sessionId: "budgeted-recipient" };
  const draft = runSessionMessageOperation<{ messageId: string }>("prepare", { sender, target: recipient, body: "Synthetic budgeted hook body", ttlSeconds: 60 }, state);
  runSessionMessageOperation("send", { sender, messageId: draft.messageId }, state);
  const phases: { phase: string; messageIds: readonly string[] }[] = [];
  const close = vi.spyOn(TrustStore.prototype, "close");
  const verify = mode === "receipt-failure" ? vi.spyOn(TrustStore.prototype, "verify").mockReturnValue(false) : undefined;
  try {
    const output = await runSessionMessageHook("claude-code", JSON.stringify({ hook_event_name: "Stop", session_id: recipient.sessionId }), undefined, {
      executionBudget: { deadlineMonotonicMs: performance.now() + 7000, postClaimReserveMs: 500 },
      onClaimState: (value) => { phases.push(value); },
    });
    expect(phases).toEqual([{ phase: "request-attempted", messageIds: [] }, { phase: "response-received", messageIds: [draft.messageId] }]);
    if (mode === "success") expect(output).toContain("Synthetic budgeted hook body");
    else expect(output).toBe("");
    expect(close).toHaveBeenCalledTimes(1);
    // One claim and no ACK: the hook never acknowledges on behalf of the model.
    const store = fixture(path.join(state, "session-messages.sqlite3"));
    expect(store.status(sender, draft.messageId)).toMatchObject({ state: "delivered", deliveryAttempts: 1, acknowledgedAt: null });
  } finally { verify?.mockRestore(); close.mockRestore(); }
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
  // A file from before system-issued IDs: no prepared_messages table and an older schema version, so opening migrates it.
  old.database.exec("DROP TABLE prepared_messages; PRAGMA user_version = 2;"); old.close(); stores.splice(stores.indexOf(old), 1);
  const reopened = fixture(database);
  expect(reopened.status(sender, "legacy-unissued-id", 1001)).toMatchObject({ state: "queued" });
  expect(() => reopened.submitPrepared(sender, "legacy-unissued-id", 1001)).toThrow(/unavailable/u);
  const claimed = reopened.claim(target, 1002);
  expect(claimed).toMatchObject([{ messageId: "legacy-unissued-id", body: "Legacy fixture" }]);
  expect(reopened.acknowledge(target, ["legacy-unissued-id"], 1003, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
});

it("packaged CLI discovers prepare/send and rejects old or unknown send with zero queue effect", async () => {
  const state = await directory();
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
// options against the actual built consumer (not native evidence).
it("r11 adapter consumes actual built common fourth options", async () => {
  const state = await directory(); bundleDirectories.push(state);
  const recipient = { host: 'synthetic-message-core', sessionId: 'r11-built-consumer-recipient' };
  const store = fixture(path.join(state, 'session-messages.sqlite3'));
  const drafts: { messageId: string }[] = [];
  for (const body of ['Synthetic r11 A', 'Synthetic r11 B']) {
    const draft = store.prepare({ sender, target: recipient, body, ttlSeconds: 60 });
    store.submitPrepared(sender, draft.messageId);
    drafts.push(draft);
  }
  // 합성 root 역할은 adapter 라우팅만 제공한다. 신원은 adapter가 관측한 {pid, startToken}이며 store는 OS를 조회하지 않는다.
  // 공통 번들의 instance 계산과 store의 현재 presence 세대 일치를 모두 통과해야 원 phases까지 도달한다.
  const hostProcess = { pid: process.pid, startToken: 'synthetic-r11-host-start' };
  const instanceId = 'host-process-v1:' + createHash('sha256')
    .update(JSON.stringify([recipient.host, recipient.sessionId, hostProcess.pid, hostProcess.startToken])).digest('hex');
  // The built hook's installed relay code holds a live grant, so its recovery sees a live relay and spawns no relay child.
  const codeDigest = readRelayCodeDigest(pathToFileURL(path.join(root, 'mcp-server/dist/session-message-relay.mjs')));
  expect(store.ensureVerifiedGeneration({ ...recipient, instanceId, transport: 'codex-deferred', hostPid: hostProcess.pid,
    hostStart: hostProcess.startToken, codeDigest, wakeVisibility: 'none', canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ['tool-boundary'], idleWake: 'none' },
  })).toMatchObject({ spawn: true, instanceId });
  expect(store.presence(recipient).instanceId).toBe(instanceId);
  drafts.forEach((draft, index) => store.database.prepare('UPDATE messages SET created_at = ? WHERE message_id = ?')
    .run(new Date(Date.now() - 2000 + index * 1000).toISOString(), draft.messageId));
  vi.stubEnv('AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR', state);
  vi.stubEnv('AGENT_GOVERNANCE_TRUST_DB_PATH', path.join(state, 'r11-trust.sqlite3'));
  vi.stubEnv('AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE', '0');
  const { executeAntigravityHookEvent, createClaimStateTracker, finalizeConnectorOutput } = await import(
    pathToFileURL(path.join(root, 'antigravity-connector/hooks/antigravity-hook-runner.mjs')).href);
  const built = await import(pathToFileURL(path.join(root, 'mcp-server/dist/session-message-hook.mjs')).href) as {
    registerHookHostAdapter: typeof registerHookHostAdapter;
    handleSessionMessageHook: typeof import("../../mcp-server/src/session-message-hook.js").handleSessionMessageHook;
  };
  const syntheticCore = await import(new URL('./fixtures/synthetic-core-hook-driver.mjs', import.meta.url).href) as {
    registerSyntheticCoreAdapters: (register: typeof registerHookHostAdapter, selectTransport: () => "codex-deferred") => void;
  };
  syntheticCore.registerSyntheticCoreAdapters(built.registerHookHostAdapter, () => "codex-deferred");
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
  expect(phases).toEqual([
    { phase: 'request-attempted', messageIds: [] }, { phase: 'response-received', messageIds: [drafts[0]!.messageId] },
  ]);
  expect(tracker.getSnapshot().state).toBe('after-claim-before-output');
  expect(JSON.stringify(output)).toContain('Synthetic r11 A');
  // One claim of the oldest body and no ACK.
  expect(store.status(sender, drafts[0]!.messageId)).toMatchObject({ state: 'delivered', deliveryAttempts: 1, acknowledgedAt: null });
  expect(store.status(sender, drafts[1]!.messageId)).toMatchObject({ state: 'queued', deliveryAttempts: 0, acknowledgedAt: null });
  const diagnostics: string[] = [];
  let writes = 0;
  finalizeConnectorOutput(JSON.stringify(output), tracker, {
    env: {}, writeStdout: (_text: string, callback: (error: Error | null) => void) => { writes++; callback(null); },
    writeStderr: (line: string) => { diagnostics.push(line); },
  });
  expect(writes).toBe(1);
  expect(tracker.getSnapshot().state).toBe('stdout-written-not-consumed');
  expect(tracker.getSnapshot().hostConsumedConfirmed).toBe(false);
  expect(diagnostics).toEqual([]);
}, 15_000);
