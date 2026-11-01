import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { dispatchManagedWake } from "../../mcp-server/src/session-message-relay.js";
import { parseWakeMessages, type sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// A verified host birth (adapter-observed pid and start token) ensures its own generation and relay in one transaction
// (ensureVerifiedGeneration). The relay_id of each grant is the fence; no PID or child start token is stored.
const target = { host: "gemini", sessionId: "verified-relay-fixture" };
const transport = "antigravity-queue";
const now = Date.UTC(2026, 0, 1);
const code = "sha256:" + "a".repeat(64);
const birth = (pid: number, start: string) => "host-process-v1:" + createHash("sha256")
  .update(JSON.stringify([target.host, target.sessionId, pid, start])).digest("hex");
const generation = birth(100, "T1");
const replacement = birth(101, "T2");
const stores: SessionMessageStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

const fixture = () => {
  let clock = now;
  const store = new SessionMessageStore(":memory:", { clock: () => clock });
  stores.push(store);
  const input = { ...target, instanceId: generation, hostPid: 100, hostStart: "T1", codeDigest: code, transport,
    wakeVisibility: "user-message" as const, canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["peer-wake" as const], idleWake: "user-message" as const } };
  type Input = Parameters<SessionMessageStore["ensureVerifiedGeneration"]>[0];
  const ensure = (overrides: Partial<Input> = {}, at = now) => store.ensureVerifiedGeneration({ ...input, ...overrides }, at);
  const next = (pid: number, start: string, overrides: Partial<Input> = {}, at = now) =>
    ensure({ instanceId: birth(pid, start), hostPid: pid, hostStart: start, ...overrides }, at);
  const tick = (relayId: string, at: number, instanceId = generation, includePending = false, tickTransport = transport) =>
    store.relayTick({ ...target, transport: tickTransport, relayId, instanceId, includePending }, at);
  const release = (relayId: string, at: number, instanceId = generation, releaseTransport = transport) =>
    store.releaseRelay({ ...target, transport: releaseTransport, relayId, instanceId, reason: "host-process-ended" }, at);
  return { store, input, ensure, next, tick, release, setClock: (value: number) => { clock = value; } };
};

it("grants once and refuses a second ensure of the live birth without changing its presence or lease", () => {
  const { store, ensure } = fixture();
  const first = ensure();
  expect(first).toEqual({ spawn: true, relayId: expect.stringMatching(/^[0-9a-f-]{36}$/u), instanceId: generation });
  const before = store.presence(target, now + 100);
  const lease = store.liveRelay(target, transport, now + 100);
  expect(ensure({}, now + 100)).toEqual({ spawn: false, relayId: null, instanceId: generation, reason: "RELAY_ALIVE" });
  expect(store.presence(target, now + 100)).toEqual(before);
  expect(store.liveRelay(target, transport, now + 100)).toEqual(lease);
  // The adapter-observed birth is the generation's host; the relay's watcher must later bind exactly it.
  expect(store.presenceHost(target, generation)).toEqual({ pid: 100, start: "T1" });
});

it("allows only one grant from competing ensures of the same birth", () => {
  const { store, ensure } = fixture();
  const first = ensure({}, now);
  const second = ensure({}, now + 1);
  expect(first.spawn).toBe(true);
  expect(second).toMatchObject({ spawn: false, relayId: null, reason: "RELAY_ALIVE" });
  expect(store.liveRelay(target, transport, now + 1)?.relayId).toBe(first.relayId);
});

it("re-grants an expired birth with a new relay_id once and fences the old relay's tick and release", () => {
  const { store, ensure, tick, release } = fixture();
  const old = ensure().relayId!;
  expect(tick(old, now + 5000).alive).toBe(true);
  const expired = now + 60_000;
  expect(store.presence(target, expired).state).toBe("unreachable");
  expect(tick(old, expired).alive).toBe(false);
  const fresh = ensure({}, expired);
  expect(fresh).toMatchObject({ spawn: true, instanceId: generation });
  expect(fresh.relayId).not.toBe(old);
  expect(store.presence(target, expired)).toMatchObject({ state: "online", instanceId: generation });
  expect(ensure({}, expired + 1)).toMatchObject({ spawn: false, reason: "RELAY_ALIVE" });
  expect(tick(old, expired + 2).alive).toBe(false);
  expect(release(old, expired + 2)).toBe(false);
  expect(store.liveRelay(target, transport, expired + 2)?.relayId).toBe(fresh.relayId);
  expect(tick(fresh.relayId!, expired + 3).alive).toBe(true);
});

it("refuses a superseded birth and a stale expected observation without changing the newer generation", () => {
  const { store, ensure, next } = fixture();
  const first = ensure();
  const second = next(101, "T2", { expectedPresenceInstanceId: generation }, now + 1);
  expect(second).toMatchObject({ spawn: true, instanceId: replacement });
  const before = store.presence(target, now + 2);
  const lease = store.liveRelay(target, transport, now + 2);
  expect(ensure({}, now + 2)).toEqual({ spawn: false, relayId: null, instanceId: generation, reason: "GENERATION_SUPERSEDED" });
  expect(next(102, "T3", { expectedPresenceInstanceId: generation }, now + 2))
    .toEqual({ spawn: false, relayId: null, instanceId: birth(102, "T3"), reason: "GENERATION_CHANGED" });
  expect(store.presence(target, now + 2)).toEqual(before);
  expect(store.liveRelay(target, transport, now + 2)).toEqual(lease);
  expect(second.relayId).not.toBe(first.relayId);
});

it("protects an online verified current birth from an unexpected replacement, and allows the expected one", () => {
  const { store, ensure, next } = fixture();
  ensure();
  expect(next(101, "T2", {}, now + 1)).toEqual({ spawn: false, relayId: null, instanceId: replacement, reason: "CURRENT_GENERATION_PROTECTED" });
  expect(store.presence(target, now + 1).instanceId).toBe(generation);
  // Once the current birth is not online its protection ends.
  expect(next(101, "T2", {}, now + 60_000)).toMatchObject({ spawn: true, instanceId: replacement });
  expect(store.presence(target, now + 60_000).instanceId).toBe(replacement);
});

it("refuses a grant whose reported host pid differs from the generation's host (HOST_MISMATCH)", () => {
  const { store, ensure } = fixture();
  ensure();
  expect(store.grantRelay({ ...target, transport, instanceId: generation, codeDigest: code, hostPid: 999 }, now + 1))
    .toEqual({ relayId: null, reason: "HOST_MISMATCH" });
});

it("rejects a birth whose instance id does not hash its pid and start token", () => {
  const { ensure } = fixture();
  expect(() => ensure({ instanceId: "host-process-v1:" + "b".repeat(64) })).toThrow("Invalid verified host process birth.");
  expect(() => ensure({ hostStart: "  " })).toThrow("Invalid verified host process birth.");
});

it("a release naming another instance never ends the current presence", () => {
  const { store, ensure, release } = fixture();
  const id = ensure().relayId!;
  const presence = store.presence(target, now + 1);
  release(id, now + 2, replacement);
  expect(store.presence(target, now + 2)).toMatchObject({ instanceId: presence.instanceId, startedAt: presence.startedAt,
    state: "online", endedAt: null, endReason: null });
});

it("keeps exact relay termination and reused-session wake/claim working with a retained input observation", () => {
  const { store, ensure, next, tick, release } = fixture();
  const old = ensure().relayId!;
  expect(tick(old, now + 1).alive).toBe(true);
  store.observeNativeInput(target, now + 2, generation);
  expect(release(old, now + 3)).toBe(true);
  expect(store.presence(target, now + 3)).toMatchObject({ state: "ended", instanceId: generation, endReason: "host-process-ended" });
  expect(store.liveRelay(target, transport, now + 3)).toBeNull();
  expect(store.database.prepare("SELECT deferred_tool_claim FROM input_observations").get()).toMatchObject({ deferred_tool_claim: 1 });

  const fresh = next(101, "T2", {}, now + 4);
  expect(fresh.spawn).toBe(true);
  expect(tick(fresh.relayId!, now + 5, replacement).alive).toBe(true);
  expect(release(old, now + 6)).toBe(false);
  expect(store.presence(target, now + 6)).toMatchObject({ state: "online", instanceId: replacement });
  store.send({ messageId: "reused-input-message", sender: { host: "synthetic-peer", sessionId: "sender" }, target, body: "pending" }, now + 7);
  expect(store.reserveManagedWake({ ...target, instanceId: replacement, transport,
    relayId: fresh.relayId!, nonce: "reused-input-wake-abcdefghijklmnop" }, now + 8).dispatch).toBe(true);
  store.observeNativeInput(target, now + 9, replacement);
  expect(store.database.prepare("SELECT * FROM input_observations").all()).toMatchObject([
    { deferred_tool_claim: 1, observed_at: new Date(now + 9).toISOString() },
  ]);
  expect(store.claimDeferred(target, now + 10, { instanceId: replacement })).toEqual([]);
  const claimed = store.claimDeferred(target, now + 11, { instanceId: replacement });
  expect(claimed).toMatchObject([{ messageId: "reused-input-message", deliveryAttempt: 1 }]);
  expect(store.acknowledge(target, ["reused-input-message"], now + 12, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  expect(release(fresh.relayId!, now + 13, replacement)).toBe(true);
});

it("releases an old transport's lease without ending the current transport presence", () => {
  const { store, ensure, release } = fixture();
  const old = ensure().relayId!;
  const fresh = ensure({ transport: "codex-queue" }, now + 2);
  expect(fresh.spawn).toBe(true);
  const presence = store.presence(target, now + 2);
  expect(presence.transport).toBe("codex-queue");
  expect(release(old, now + 3)).toBe(true);
  expect(store.presence(target, now + 3)).toEqual(presence);
  expect(store.liveRelay(target, "codex-queue", now + 3)?.relayId).toBe(fresh.relayId);
});

it("fences an old relay whose generation a newer presence of the same transport replaced", () => {
  const { store, input, ensure, tick } = fixture();
  const old = ensure().relayId!;
  store.startPresence({ ...input, instanceId: replacement, hostPid: 101, hostStart: "T2" }, now + 1);
  expect(tick(old, now + 2, replacement).alive).toBe(false);
  expect(tick(old, now + 2).alive).toBe(false);
  expect(store.presence(target, now + 2).instanceId).toBe(replacement);
});

it("AGS-D-0009: a re-granted expired birth dispatches its queued wake, then the recipient claims and acknowledges", async () => {
  const { store, ensure, tick, setClock } = fixture();
  const old = ensure().relayId!;
  store.send({ messageId: "e2e-expired-wake-msg", sender: { host: "codex", sessionId: "sender-session" }, target,
    body: "payload-after-lease-recovery" }, now + 2);
  // Past the relay (15s) and presence (20s) leases: the old relay is dead and the birth is unreachable.
  let clock = now + 60_000;
  setClock(clock);
  expect(tick(old, clock, generation, true)).toEqual({ alive: false, count: 0, hostBound: false });
  const fresh = ensure({}, clock);
  expect(fresh.spawn).toBe(true);
  expect(tick(fresh.relayId!, clock + 1, generation, true)).toEqual({ alive: true, count: 1, hostBound: true });
  clock += 2;
  setClock(clock);

  const dispatchedPrompts: string[] = [];
  const request = (async <T>(op: string, payload: Record<string, unknown>): Promise<T> => {
    clock += 1;
    setClock(clock);
    return dispatchSessionMessageOperation(store, op, payload) as T;
  }) as typeof sessionMessageRequest;
  const woke = await dispatchManagedWake({ ...target, instanceId: generation, transport }, fresh.relayId!, {
    capabilities: { supportedInjection: ["peer-wake"], idleWake: "user-message" }, resendBaseMs: 600_000,
    dispatch: async (_target, prompt) => { dispatchedPrompts.push(prompt); return { result: "handed-off" }; },
  }, request);
  expect(woke).toBe(true);
  expect(dispatchedPrompts).toHaveLength(1);
  const parsedWake = parseWakeMessages(dispatchedPrompts[0]!);
  expect(parsedWake).toMatchObject({ wakeOnly: true, nonces: [expect.any(String)] });
  expect(store.consumeWake(target, parsedWake.nonces[0]!)).toBe(true);
  // The old relay_id cannot reserve a second wake for the same birth.
  expect(store.reserveManagedWake({ ...target, instanceId: generation, transport, relayId: old,
    nonce: "fenced-old-relay-wake-abcdefghijklmnop" }, clock + 1).dispatch).toBe(false);

  store.observeNativeInput(target, clock + 2, generation);
  expect(store.claimDeferred(target, clock + 3, { instanceId: generation })).toEqual([]);
  const claimed = store.claimDeferred(target, clock + 4, { instanceId: generation });
  expect(claimed).toMatchObject([{ messageId: "e2e-expired-wake-msg", body: "payload-after-lease-recovery", deliveryAttempt: 1 }]);
  expect(store.acknowledge(target, ["e2e-expired-wake-msg"], clock + 5, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
});
