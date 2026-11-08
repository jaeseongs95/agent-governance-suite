import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the operations this process asks the in-process client for; every call still runs the real operation.
const requests = vi.hoisted(() => new Map<string, number>());
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => {
  const actual = await original<typeof import("../../mcp-server/src/session-message-client.js")>();
  function sessionMessageRequest<T>(...args: Parameters<typeof actual.sessionMessageRequest>): Promise<T> {
    requests.set(args[0], (requests.get(args[0]) ?? 0) + 1);
    return actual.sessionMessageRequest<T>(...args);
  }
  return { ...actual, sessionMessageRequest };
});

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { nativePeerWait, adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { PeerWaitPolicy } from "../../mcp-server/src/peer-wait-policy.js";
import { render } from "../../mcp-server/src/i18n.js";
import { dispatchSessionMessageOperation as dispatch } from "../../mcp-server/src/session-message-operations.js";
import { closeSessionMessaging, runSessionMessageOperation } from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageCli } from "../../mcp-server/src/session-message-cli.js";
import { SessionMessageStore, WAKE_QUIET_MS } from "../../mcp-server/src/session-message-store.js";
import { recordWakeHookObservation, wakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";

import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import type { ActorObservation } from "../../mcp-server/src/input-observation.js";

// Explicit fake root for parser/policy core tests; not native capture or R7 evidence.
const syntheticHost = "synthetic-peer-wait";
const syntheticRoot: ActorObservation = {role: "root", basis: "observed", reasonCode: "SYNTHETIC_PEER_WAIT_ROOT"};
registerHookHostAdapter(syntheticHost, {
  adaptInput: (input, host) => {
    const mapped = adaptHostInput(input, "codex");
    return {...mapped, observation: {...mapped.observation, host, actor: input.syntheticActor as ActorObservation}};
  },
  // Delegate to the actual wait argument parser, without treating the synthetic role as native evidence.
  peerWait: observation => nativePeerWait({...observation, host: "codex"}),
  deliveryProfile: () => ({transport: "codex-queue", capabilities: {supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message"}, blocksEmptyWakePrompt: true}),
  processPid: () => undefined,
});
const sender = { host: syntheticHost, sessionId: "peer-wait-owner" };
const target = { host: "codex", sessionId: "peer-wait-worker" };
const secondTarget = { host: "codex", sessionId: "peer-wait-worker-2" };
const root = process.env.PEER_WAIT_TEST_PLUGIN_ROOT ?? fileURLToPath(new URL("../../", import.meta.url));
const HOST_PID = 4242;
const RELAY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const iso = (milliseconds: number) => new Date(milliseconds).toISOString();
const directories: string[] = [];
/** State directories this process opened through the in-process client; closed before removal. */
const stateDirectories: string[] = [];
const stores: SessionMessageStore[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  requests.clear();
  for (const store of stores.splice(0)) store.close();
  for (const directory of stateDirectories.splice(0)) closeSessionMessaging(directory);
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true, maxRetries: 10 });
});

function observedWait(overrides: Record<string, unknown> = {}) {
  return adaptHostInput({ hook_event_name: "PreToolUse", session_id: sender.sessionId, syntheticActor: syntheticRoot,
    tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: target.sessionId }], timeoutMs: 60_000 }, ...overrides }, syntheticHost).observation;
}
type HostWake = { recognized: boolean; messages: Array<{ messageId: string; claimReceipt: string }> };
function wakeObservation(nonces: string[]) {
  return adaptHostInput({ hook_event_name: "UserPromptSubmit", session_id: sender.sessionId, agent_id: "", syntheticActor: syntheticRoot,
    prompt: nonces.map(nonce => `[agent-governance-suite:wake:${nonce}]`).join("\n") }, syntheticHost).observation;
}

// In-process store fixtures run on an injected clock: the test moves `now`, every operation decides with it after the lock.
const T0 = Date.parse("2026-01-01T00:00:00.000Z");
let now = T0;
// 3.0: a wake is reserved for one birth and its granted relay (a fresh relay_id per grant); its arrival is a verified host-wake observation.
let binding = { instanceId: "generation-1", relayId: "", transport: "codex-queue" };
function hostWake(store: SessionMessageStore, nonces: string[]): HostWake {
  const observation = wakeObservation(nonces);
  return dispatch(store, "claim-host-wake", { target: sender, observation, sourceReceiptId: recordWakeHookObservation(observation, now) },
    wakeHookObservationReader) as HostWake;
}
function storeFixture() {
  const trust = mkdtempSync(path.join(tmpdir(), "ags-peer-wait-trust-")); directories.push(trust);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(trust, "trust.sqlite3"));
  now = T0;
  const store = new SessionMessageStore(":memory:", { clock: () => now }); stores.push(store);
  store.send({ sender, target, messageId: "outgoing-peer", body: "Synthetic request" });
  const started = dispatch(store, "presence-start", { target: sender, instanceId: "generation-1", transport: "codex-queue", wakeVisibility: "user-message",
    canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message", hostPid: HOST_PID }) as { relayId: string | null };
  expect(started.relayId).toMatch(RELAY_ID);
  binding = { instanceId: "generation-1", relayId: started.relayId!, transport: "codex-queue" };
  // The relay's first tick binds the host birth; only a host-bound relay rings or proves resume.
  expect(dispatch(store, "relay-tick", { target: sender, ...binding, includePending: false, hostStart: "start-1" })).toMatchObject({ alive: true, hostBound: true });
  return store;
}
function proveWake(store: SessionMessageStore) {
  store.send({ sender: target, target: sender, messageId: "incoming-peer", body: "Synthetic reply" });
  expect(dispatch(store, "reserve-wake", { target: sender, nonce: "nonce-peer-wait-fixture", ...binding })).toMatchObject({ dispatch: true });
  const claimed = hostWake(store, ["nonce-peer-wait-fixture"]);
  expect(claimed).toMatchObject({ recognized: true });
  return claimed.messages.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt }));
}
function decision(store: SessionMessageStore, timeoutMs = 60_000, extra: Record<string, unknown> = {}) {
  return dispatch(store, "peer-wait", { sender, targets: [target], timeoutMs, ...extra });
}

describe("peer wait policy boundaries", () => {
  it.each(["key-order", "local-default", "target-order", "duplicate"])("normalizes actual parser semantic equivalence under a synthetic root: %s", (variant) => {
    const store = storeFixture(); proveWake(store);
    store.send({ sender, target: secondTarget, body: "Second synthetic request" });
    const rows = [{ threadId: target.sessionId, afterCursor: "cursor-a" }, { threadId: secondTarget.sessionId, afterCursor: "cursor-b" }];
    const equivalent = variant === "key-order" ? rows.map(({ threadId, afterCursor }) => ({ afterCursor, threadId }))
      : variant === "local-default" ? rows.map((row) => ({ ...row, hostId: "local" }))
      : variant === "target-order" ? [...rows].reverse() : [...rows, rows[0]];
    const first = nativePeerWait(observedWait({ tool_input: { targets: rows, timeoutMs: 0 } }))!;
    const repeated = nativePeerWait(observedWait({ tool_input: { targets: equivalent, timeoutMs: 0 } }))!;
    expect(repeated).toEqual(first);
    expect(dispatch(store, "peer-wait", { sender, ...first })).toMatchObject({ action: "snapshot" });
    expect(dispatch(store, "peer-wait", { sender, ...repeated })).toMatchObject({ action: "deny", reason: "unchanged-peer-state" });
    const changed = nativePeerWait(observedWait({ tool_input: { targets: [{ ...rows[0], afterCursor: "cursor-c" }, rows[1]], timeoutMs: 0 } }))!;
    expect(dispatch(store, "peer-wait", { sender, ...changed })).toMatchObject({ action: "snapshot" });
  });

  it("normalizes target order and duplicates before both state fingerprints and policy keys", () => {
    const store = storeFixture(); proveWake(store);
    store.send({ sender, target: secondTarget, body: "Second synthetic request" });
    const first = decision(store, 0, { targets: [target, secondTarget] }) as { peers: unknown[] };
    expect(first).toMatchObject({ action: "snapshot" });
    const repeated = decision(store, 0, { targets: [secondTarget, { sessionId: target.sessionId, host: target.host }, secondTarget] });
    expect(repeated).toMatchObject({ action: "deny", reason: "unchanged-peer-state", peers: first.peers });
    const changed = { host: "codex", sessionId: "peer-wait-worker-3" };
    store.send({ sender, target: changed, body: "Changed target request" });
    expect(decision(store, 0, { targets: [target, changed] })).toMatchObject({ action: "snapshot" });
  });

  it("preserves distinct cursors for the same target and leaves malformed cursors fail-open", () => {
    const one = nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId, afterCursor: "a" }], timeoutMs: 0 } }))!;
    const conflict = [{ threadId: target.sessionId, afterCursor: "a" }, { threadId: target.sessionId, afterCursor: "b" }];
    const both = nativePeerWait(observedWait({ tool_input: { targets: conflict, timeoutMs: 0 } }))!;
    expect(both.targets).toEqual([target]);
    expect(both.queryRevision).not.toBe(one.queryRevision);
    expect(nativePeerWait(observedWait({ tool_input: { targets: [...conflict].reverse(), timeoutMs: 0 } }))).toEqual(both);
    expect(nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId, afterCursor: 1 }], timeoutMs: 0 } }))).toBeNull();
  });

  it("parses exactly the supported local wait surface and arguments under a synthetic root", () => {
    expect(nativePeerWait(observedWait())).toMatchObject({ targets: [target], timeoutMs: 60_000 });
    expect(nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId, hostId: "local" }], timeoutMs: 0 } }))).toMatchObject({ timeoutMs: 0 });
    expect(nativePeerWait(observedWait({ tool_input: { targets: [{ threadId: target.sessionId }] } }))).toMatchObject({ timeoutMs: 120_000 });
    for (const tool_name of ["wait_threads", "mcp__other__wait_threads", "clock.sleep", "functions.wait", "exec_command"]) {
      expect(nativePeerWait(observedWait({ tool_name }))).toBeNull();
    }
    for (const tool_input of [{ targets: [] }, { targets: [{ threadId: target.sessionId, hostId: "remote-control:test" }] },
      { targets: [{ threadId: "bad id" }] }, { targets: [{ threadId: target.sessionId }], timeoutMs: -1 }]) {
      expect(nativePeerWait(observedWait({ tool_input }))).toBeNull();
    }
  });

  it("requires a consumed wake in addition to live exact-generation presence", () => {
    const store = storeFixture();
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
    proveWake(store);
    expect(decision(store)).toMatchObject({ action: "deny", reason: "async-resume", resume: "observed" });
  });

  it("allows one snapshot, suppresses unchanged repeats and resets on state change or new user input", () => {
    const store = storeFixture(); const incomingClaim = proveWake(store);
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
    expect(decision(store, 0)).toMatchObject({ action: "deny", reason: "unchanged-peer-state" });
    expect(decision(store, 0, { queryRevision: "new-observed-cursor" })).toMatchObject({ action: "snapshot" });
    store.acknowledge(sender, ["incoming-peer"], undefined, incomingClaim);
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
    dispatch(store, "observe-native-input", { target: sender });
    expect(decision(store, 0)).toMatchObject({ action: "snapshot" });
  });

  it("does not restrict mixed or unrelated targets even with a working resume path", () => {
    const store = storeFixture(); proveWake(store);
    expect(decision(store, 60_000, { targets: [target, { host: "codex", sessionId: "unrelated" }] })).toMatchObject({ action: "bounded", transmission: "unknown" });
  });

  it.each(["presence-expired", "relay-expired", "wake-expired", "new-generation", "instance-mismatch", "no-idle-wake", "host-unbound", "relay-replaced"])("does not deny when %s", (reason) => {
    const store = storeFixture(); proveWake(store);
    expect(decision(store)).toMatchObject({ action: "deny", resume: "observed" });
    if (reason === "presence-expired") store.database.prepare("UPDATE session_presence SET lease_until = ?").run(iso(now - 1));
    if (reason === "relay-expired") store.database.prepare("UPDATE relay_leases SET lease_until = ?").run(iso(now - 1));
    if (reason === "wake-expired") {
      // The relay keeps both leases live; only the observation ages past its 30 s window.
      for (const offset of [10_000, 20_000, 31_000]) {
        now = T0 + offset;
        expect(dispatch(store, "relay-tick", { target: sender, ...binding, includePending: false })).toMatchObject({ alive: true });
      }
    }
    if (reason === "new-generation") dispatch(store, "presence-start", { target: sender, instanceId: "generation-2", transport: "codex-queue", wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message" });
    if (reason === "instance-mismatch") {
      // A grant serves only the current birth, so a lease of another instance is written directly.
      store.database.prepare("DELETE FROM relay_leases").run();
      store.database.prepare(`INSERT INTO relay_leases (host, session_id, transport, instance_id, relay_id, code_digest, granted_at, lease_until, updated_at)
        VALUES (?, ?, 'codex-queue', 'wrong-generation', ?, NULL, ?, ?, ?)`).run(sender.host, sender.sessionId, binding.relayId, iso(now), iso(now + 15_000), iso(now));
    }
    if (reason === "no-idle-wake") store.database.prepare("UPDATE session_presence SET idle_wake = 'none'").run();
    // Resume needs a relay whose watcher bound the host birth.
    if (reason === "host-unbound") store.database.prepare("UPDATE session_presence SET host_start = NULL").run();
    // The observed attempt belongs to a relay the current lease no longer names (a later grant fenced it).
    if (reason === "relay-replaced") store.database.prepare("UPDATE relay_leases SET relay_id = 'replacement-relay'").run();
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("does not promote supplied capability, ACK or old relay registration to resume", () => {
    const store = storeFixture();
    const outgoingClaim = store.claim(target);
    expect(outgoingClaim.map(message => message.messageId)).toContain("outgoing-peer");
    expect(store.acknowledge(target, ["outgoing-peer"], undefined, outgoingClaim.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    expect(decision(store, 60_000, { resumeObserved: true, approved: true, capabilities: { idleWake: "silent" } })).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("does not attach an old generation nonce to a replacement instance", () => {
    const store = storeFixture();
    store.send({ sender: target, target: sender, messageId: "old-generation-reply", body: "Synthetic reply" });
    expect(dispatch(store, "reserve-wake", { target: sender, nonce: "nonce-before-generation-change", ...binding })).toMatchObject({ dispatch: true });
    const replaced = dispatch(store, "presence-start", { target: sender, instanceId: "generation-2", transport: "codex-queue", wakeVisibility: "user-message",
      canWakeSilently: false, supportedInjection: ["peer-wake"], idleWake: "user-message", hostPid: HOST_PID }) as { relayId: string | null };
    expect(replaced.relayId).toMatch(RELAY_ID);
    expect(dispatch(store, "relay-tick", { target: sender, instanceId: "generation-2", transport: "codex-queue", relayId: replaced.relayId,
      includePending: false, hostStart: "start-2" })).toMatchObject({ alive: true, hostBound: true });
    // I2: a marker of the replaced birth claims nothing and proves no resume of the new one.
    expect(hostWake(store, ["nonce-before-generation-change"])).toMatchObject({ recognized: false, messages: [] });
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("requires valid nonces and does not infer resume from ordinary peer delivery", () => {
    const store = storeFixture();
    expect(hostWake(store, ["invalid-nonce-peer-wait"])).toMatchObject({ recognized: false });
    dispatch(store, "claim", { target });
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
  });

  it("carries the guidance as a catalog key with root-locale text, so the hook can render it in its own locale", () => {
    const input = { sender, targets: [target], timeoutMs: 0, peersObserved: true, resumeObserved: true, fingerprint: "keyed" };
    const resumed = new PeerWaitPolicy().decide(input, 1000);
    expect(resumed).toMatchObject({ guidanceKey: "peer.wait.snapshotGuidance", guidanceParams: {},
      guidance: "Use one immediate snapshot (timeoutMs: 0), then continue independent work or return; peer delivery can resume this session. A receipt or ACK is not task completion or approval." });
    const bounded = new PeerWaitPolicy().decide({ ...input, resumeObserved: false }, 1000);
    expect(bounded).toMatchObject({ guidanceKey: "peer.wait.boundedGuidance",
      guidance: "Async resume is unconfirmed. Use a bounded query or bounded wait and continue on the next user turn; do not assume returning will wake this session." });
    expect(render({ key: bounded.guidanceKey, params: bounded.guidanceParams }, "en")).toBe(bounded.guidance);
    expect(render({ key: bounded.guidanceKey, params: bounded.guidanceParams }, "ko")).toBe("비동기 재개가 확인되지 않았다. 제한된 조회나 제한된 대기를 쓰고 다음 사용자 차례에 이어서 하라. 돌아가면 이 세션이 깨어난다고 가정하지 마라.");
  });

  it("expires snapshot records without timers and leaves no state in a fresh in-memory policy", () => {
    const policy = new PeerWaitPolicy();
    const input = { sender, targets: [target], timeoutMs: 0, peersObserved: true, resumeObserved: true, fingerprint: "same" };
    expect(policy.decide(input, 1000).action).toBe("snapshot");
    expect(policy.decide(input, 1001).action).toBe("deny");
    expect(policy.decide({ ...input, sender: { sessionId: sender.sessionId, host: sender.host }, targets: [target, target] }, 30_999).action).toBe("deny");
    expect(policy.decide(input, 31_000).action).toBe("snapshot");
    expect(new PeerWaitPolicy().decide(input, 1002).action).toBe("snapshot");
    policy.reset({ sessionId: sender.sessionId, host: sender.host });
    expect(policy.decide(input, 31_001).action).toBe("snapshot");
  });

  it("keeps durable snapshot records for every policy over one store, with the same expiry and owner reset", () => {
    let at = 1000;
    const store = new SessionMessageStore(":memory:", { clock: () => at }); stores.push(store);
    const policy = () => new PeerWaitPolicy(store.peerWaitSnapshots());
    const rows = () => store.database.prepare("SELECT count(*) AS n FROM peer_wait_snapshots").get() as { n: number };
    const input = { sender, targets: [target], timeoutMs: 0, peersObserved: true, resumeObserved: true, fingerprint: "same" };
    expect(policy().decide(input).action).toBe("snapshot");
    // A new policy (a new hook or CLI process) reads the record instead of starting over.
    at = 1001;
    expect(policy().decide(input).action).toBe("deny");
    at = 30_999;
    expect(policy().decide({ ...input, sender: { sessionId: sender.sessionId, host: sender.host }, targets: [target, target] }).action).toBe("deny");
    expect(policy().decide({ ...input, fingerprint: "changed" }).action).toBe("snapshot");
    at = 60_999;
    expect(policy().decide({ ...input, fingerprint: "changed" }).action).toBe("snapshot");
    expect(rows()).toEqual({ n: 1 });
    policy().reset({ sessionId: sender.sessionId, host: sender.host });
    expect(rows()).toEqual({ n: 0 });
    at = 61_000;
    expect(policy().decide({ ...input, fingerprint: "changed" }).action).toBe("snapshot");
  });

  it("duplicate nonce claims and relay observations never extend consumed wake freshness", () => {
    const store = storeFixture(); const incomingClaim = proveWake(store);
    expect(decision(store)).toMatchObject({ action: "deny", resume: "observed" });
    for (const offset of [10_000, 20_000, 30_000]) {
      now = T0 + offset;
      expect(dispatch(store, "relay-tick", { target: sender, ...binding, includePending: true })).toMatchObject({ alive: true });
      // A repeated marker of the observed attempt brings no body and must not refresh the consumed wake.
      expect(hostWake(store, ["nonce-peer-wait-fixture", "nonce-peer-wait-fixture"])).toMatchObject({ messages: [] });
    }
    expect(decision(store)).toMatchObject({ action: "bounded", resume: "unknown" });
    store.acknowledge(sender, ["incoming-peer"], undefined, incomingClaim);
    expect(dispatch(store, "clear-deferred", { target: sender, ...binding })).toMatchObject({ cleared: true }); // The woken turn ends (3.5.2: a wake opens a turn and its turn-end hook closes it).
    store.send({ sender: target, target: sender, messageId: "fresh-reply", body: "Fresh synthetic reply" });
    // The fresh wake rings only once the session is quiet again (design 2.5); the relay stays live meanwhile.
    const quietAt = T0 + 30_000 + WAKE_QUIET_MS + 1_000;
    for (let at = T0 + 40_000; ; at = Math.min(at + 10_000, quietAt)) {
      now = at;
      expect(dispatch(store, "relay-tick", { target: sender, ...binding, includePending: false })).toMatchObject({ alive: true });
      if (at === quietAt) break;
    }
    expect(dispatch(store, "reserve-wake", { target: sender, nonce: "nonce-peer-wait-fresh-1", ...binding })).toMatchObject({ dispatch: true });
    expect(hostWake(store, ["nonce-peer-wait-fresh-1", "nonce-peer-wait-fresh-1"])).toMatchObject({ recognized: true });
    expect(decision(store)).toMatchObject({ action: "deny", resume: "observed" });
  });
});

// State-directory tests: this process uses the in-process client; packaged hook and CLI processes open the same file.
// This process opens it with a frozen clock ahead of the wall clock. Every process decides with the persisted authority
// high-water (docs/archive/ags30-broker-redesign.md 3.2), so all of them see exactly this instant and no 30 s window can lapse.
const FROZEN_NOW = Date.parse("2099-01-01T00:00:00.000Z");
const op = <T = unknown>(directory: string, operation: string, payload: Record<string, unknown>) =>
  runSessionMessageOperation<T>(operation, payload, directory, { clock: () => FROZEN_NOW });
async function stateDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), "ags-peer-wait-")); directories.push(directory); stateDirectories.push(directory);
  // The client reads the trust path when it opens; the test records hook wake observations into the same trust file.
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(directory, "trust.sqlite3"));
  vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", directory);
  expect(op(directory, "pending", { target: sender })).toEqual({ count: 0 });
  return directory;
}
function packagedHostWake(directory: string, nonces: string[]): HostWake {
  const observation = wakeObservation(nonces);
  return op<HostWake>(directory, "claim-host-wake", { target: sender, observation, sourceReceiptId: recordWakeHookObservation(observation, FROZEN_NOW) });
}
function packaged(directory: string, entry: string, input: unknown) {
  const result = spawnSync(process.execPath, [path.join(root, "mcp-server/dist", entry)], {
    input: JSON.stringify(input), encoding: "utf8", timeout: 5000, windowsHide: true,
    env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: directory, AGENT_GOVERNANCE_CODEX_QUEUE_WAKE: "1" },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout ? JSON.parse(result.stdout) : {};
}
function sendSynthetic(directory: string, payload: Record<string, unknown>): string {
  const { messageId } = op<{ messageId: string }>(directory, "prepare", payload);
  op(directory, "send", { sender: payload.sender, messageId });
  return messageId;
}
function preparePackaged(directory: string) {
  const requestId = sendSynthetic(directory, { sender, target, body: "Synthetic request" });
  const started = op<{ relayId: string | null }>(directory, "presence-start", { target: sender, instanceId: "packaged-instance", transport: "codex-queue",
    wakeVisibility: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message", hostPid: HOST_PID });
  expect(started.relayId).toMatch(RELAY_ID);
  const packagedBinding = { instanceId: "packaged-instance", relayId: started.relayId!, transport: "codex-queue" };
  expect(op(directory, "relay-tick", { target: sender, ...packagedBinding, includePending: false, hostStart: "start-1" })).toMatchObject({ alive: true, hostBound: true });
  const replyId = sendSynthetic(directory, { sender: target, target: sender, body: "Synthetic reply" });
  expect(op(directory, "reserve-wake", { target: sender, nonce: "nonce-packaged-peer-wait", ...packagedBinding })).toMatchObject({ dispatch: true });
  // The synthetic root adapter supplies the verified wake observation; no native hook actor is fabricated.
  const claimed = packagedHostWake(directory, ["nonce-packaged-peer-wait"]);
  expect(claimed).toMatchObject({recognized: true});
  return { requestId, replyId, binding: packagedBinding,
    replyClaims: claimed.messages.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt })) };
}
const hookInput = (timeoutMs: number, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: sender.sessionId, syntheticActor: syntheticRoot, tool_name: "mcp__codex_app__wait_threads", tool_input: { targets: [{ threadId: target.sessionId }], timeoutMs }, ...extra });

async function syntheticHook(input: Record<string, unknown>) {
  return await handleSessionMessageHook(input, syntheticHost) as {hookSpecificOutput?: {permissionDecision?: string}};
}
async function cli(directory: string, payload: Record<string, unknown>) {
  return (await runSessionMessageCli(JSON.stringify({ operation: "wait", payload }), directory)).data as Record<string, unknown>;
}

it("enforces core wait policy through a synthetic root hook and through native Codex inferred root", async () => {
  const directory = await stateDirectory(); preparePackaged(directory);
  expect((await syntheticHook(hookInput(60_000)))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect((await syntheticHook(hookInput(0))).hookSpecificOutput?.permissionDecision).toBeUndefined();
  expect((await syntheticHook(hookInput(0)))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  for (const extra of [{ tool_name: "clock.sleep" }, { tool_name: "exec_command" }, { syntheticActor: {role: "child", basis: "observed", reasonCode: "SYNTHETIC_CHILD"} }, { syntheticActor: {role: "indeterminate", basis: "unavailable", reasonCode: "SYNTHETIC_UNAVAILABLE"} },
    { tool_input: { targets: [{ threadId: target.sessionId }, { threadId: "other-chat" }], timeoutMs: 60_000 } }]) {
    expect((await syntheticHook(hookInput(60_000, extra))).hookSpecificOutput?.permissionDecision).not.toBe("deny");
  }
  // A native wait tool is not an AGS tool. Child/invalid actors must not become root or query a parent peer relation.
  for (const [actor, expected] of [
    [{}, {role: "root", basis: "inferred", reasonCode: "CODEX_ROOT_INFERRED_CHILD_GATE_DEFERRED"}],
    [{agent_id: ""}, {role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_AGENT_ID_INVALID"}],
    [{agent_id: "synthetic-child"}, {role: "child", basis: "observed", reasonCode: "CODEX_NATIVE_CHILD_AGENT_ID"}],
  ] as const) {
    const nativeInput = {...hookInput(60_000), ...actor};
    expect(adaptHostInput(nativeInput, "codex").observation.actor).toEqual(expected);
    expect(packaged(directory, "session-message-hook.mjs", nativeInput).hookSpecificOutput?.permissionDecision).not.toBe("deny");
  }
  const config = JSON.parse(await readFile(path.join(root, "hooks/hooks.json"), "utf8"));
  expect(config.hooks.PreToolUse.some((entry: { matcher: string }) => new RegExp(entry.matcher).test("mcp__codex_app__wait_threads"))).toBe(true);
}, 20_000);

it("the public CLI consumes the decision before delay and sends no repeated poll when denied", async () => {
  const directory = await stateDirectory(); preparePackaged(directory);
  const payload = { sender, targets: [target], timeoutMs: 60_000 };
  const output = packaged(directory, "session-message-cli.mjs", { operation: "wait", payload });
  expect(output.data).toMatchObject({ decision: { action: "deny" }, waitedMs: 0, next: "peer-resume" });
  expect(output.data.snapshot).toEqual(output.data.decision);
  // The same CLI code in this process: exactly one decision request and no poll after a denial.
  requests.clear();
  expect(await cli(directory, payload)).toEqual(output.data);
  expect(requests.get("peer-wait")).toBe(1);
}, 15_000);

it("synthetic root hook suppresses equivalent payloads but permits actual cursor change", async () => {
  const directory = await stateDirectory(); preparePackaged(directory);
  sendSynthetic(directory, { sender, target: secondTarget, body: "Second synthetic request" });
  const rows = [{ threadId: target.sessionId, afterCursor: "a" }, { threadId: secondTarget.sessionId, afterCursor: "b" }];
  const input = (targets: unknown[]) => hookInput(0, { tool_input: { targets, timeoutMs: 0 } });
  expect((await syntheticHook(input(rows))).hookSpecificOutput?.permissionDecision).toBeUndefined();
  const equivalent = [...rows].reverse().map(({ threadId, afterCursor }) => ({ afterCursor, hostId: "local", threadId }));
  expect((await syntheticHook(input([...equivalent, equivalent[0]])))).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect((await syntheticHook(input([{ ...rows[0], afterCursor: "c" }, rows[1]]))).hookSpecificOutput?.permissionDecision).toBeUndefined();
  expect((await syntheticHook(input([{ threadId: target.sessionId, afterCursor: 1 }]))).hookSpecificOutput?.permissionDecision).toBeUndefined();
}, 15_000);

it("CLI equivalent retransmissions consume one decision each and state change restores a snapshot", async () => {
  const directory = await stateDirectory(); const { replyId, replyClaims } = preparePackaged(directory);
  sendSynthetic(directory, { sender, target: secondTarget, body: "Second synthetic request" });
  requests.clear();
  const wait = (targets: unknown[]) => cli(directory, { sender, targets, timeoutMs: 0 });
  expect(await wait([target, secondTarget])).toMatchObject({ decision: { action: "snapshot" }, waitedMs: 0 });
  const repeat = await wait([secondTarget, { sessionId: target.sessionId, host: target.host }, secondTarget]);
  expect(repeat).toMatchObject({ decision: { action: "deny", reason: "unchanged-peer-state" }, waitedMs: 0 });
  expect(await wait([target, secondTarget])).toEqual(repeat);
  expect(requests.get("peer-wait")).toBe(3);
  op(directory, "acknowledge", { target: sender, messageIds: [replyId], receipts: replyClaims });
  expect(await wait([target, secondTarget])).toMatchObject({ decision: { action: "snapshot" }, waitedMs: 0 });
  expect(requests.get("peer-wait")).toBe(4);
}, 15_000);

it("CLI unknown resume uses one bounded wait and does not force permanent stopping", async () => {
  const directory = await stateDirectory();
  sendSynthetic(directory, { sender, target, body: "Synthetic request" });
  requests.clear();
  const output = await cli(directory, { sender, targets: [target], timeoutMs: 60_000, resumeObserved: true });
  expect(output).toMatchObject({ decision: { action: "bounded", resume: "unknown" }, waitedMs: 1000, next: "bounded-query-or-next-user-turn" });
  expect(requests.get("peer-wait")).toBe(2);
}, 15_000);

it("short-lived processes share durable repeat suppression and resume evidence; the relay's end drops resume", async () => {
  const directory = await stateDirectory(); const { requestId, binding: packagedBinding } = preparePackaged(directory);
  const wait = { sender, targets: [target], timeoutMs: 0 };
  expect(op(directory, "peer-wait", wait)).toMatchObject({ action: "snapshot", resume: "observed" });
  // This process's connection ends, as a hook or CLI process does; the packaged CLI is a new process with only durable rows.
  closeSessionMessaging(directory);
  const packagedWait = (timeoutMs: number) => packaged(directory, "session-message-cli.mjs", { operation: "wait", payload: { ...wait, timeoutMs } }).data;
  expect(packagedWait(0)).toMatchObject({ decision: { action: "deny", reason: "unchanged-peer-state", resume: "observed" }, waitedMs: 0 });
  expect(packagedWait(60_000)).toMatchObject({ decision: { action: "deny", reason: "async-resume", resume: "observed" }, waitedMs: 0, next: "peer-resume" });
  expect(op(directory, "status", { sender, messageId: requestId })).toMatchObject({ status: { state: "queued" } });
  // New user input observed by one process restores a first snapshot for every process.
  op(directory, "observe-native-input", { target: sender });
  expect(packagedWait(0)).toMatchObject({ decision: { action: "snapshot", resume: "observed" } });
  // The relay's own end drops its lease and its birth: resume is unknown, and a replayed marker brings no body and restores nothing.
  expect(op(directory, "release-relay", { target: sender, ...packagedBinding, reason: "relay-ended" })).toEqual({ released: true });
  expect(op(directory, "peer-wait", wait)).toMatchObject({ action: "bounded", resume: "unknown" });
  expect(packagedHostWake(directory, ["nonce-packaged-peer-wait"])).toMatchObject({ recognized: false, messages: [] });
  expect(packagedWait(0)).toMatchObject({ decision: { action: "bounded", resume: "unknown" } });
}, 20_000);
