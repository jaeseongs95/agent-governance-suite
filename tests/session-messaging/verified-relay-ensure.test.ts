import { afterEach, expect, it } from "vitest";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

const target = { host: "gemini", sessionId: "verified-relay-fixture" };
const generation = "host-process-v1:" + "a".repeat(64);
const replacement = "host-process-v1:" + "b".repeat(64);
const now = Date.UTC(2026, 0, 1);
const stores: SessionMessageStore[] = [];
const fixture = () => {
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const input = { ...target, instanceId: generation, parentPid: 100, transport: "gemini-queue",
    wakeVisibility: "user-message" as const, canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["peer-wake" as const], idleWake: "user-message" as const } };
  const ensure = (overrides: Partial<typeof input> = {}, at = now) => {
    const next = { ...input, ...overrides };
    return store.prepareVerifiedRelay({ ...next, expectedOwner: store.relayOwner(target, next.transport) }, at);
  };
  const activate = (relayId: string, overrides = {}, at = now + 1) =>
    store.activateVerifiedRelay({ ...input, relayId, pid: 200, ...overrides }, at);
  return { store, input, ensure, activate };
};
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

it("caches a grant without changing its owner or presence birth/heartbeat/lease", () => {
  const { store, ensure } = fixture();
  const first = ensure();
  expect(first.spawn).toBe(true);
  const before = store.presence(target, now);
  const owner = store.relayOwner(target, "gemini-queue");
  expect(ensure({}, now + 100)).toEqual({ ...first, spawn: false });
  expect(store.presence(target, now + 100)).toEqual(before);
  expect(store.relayOwner(target, "gemini-queue")).toEqual(owner);
});

it("retains a pending unknown after presence retention without TTL respawn", () => {
  const { store, ensure } = fixture();
  const first = ensure();
  const later = now + 48 * 3600_000;
  store.prune(later);
  expect(store.presence(target, later).instanceId).toBeNull();
  expect(store.relayOwner(target, "gemini-queue")).toMatchObject({ relayId: first.relayId, pid: 0, instanceId: generation });
  expect(store.liveRelay(target, "gemini-queue", later)).toBeNull();
  expect(store.heartbeatRelay({ ...target, transport: "gemini-queue", relayId: first.relayId! }, later)).toBe(false);
  expect(ensure({}, later)).toEqual({ ...first, spawn: false });
  expect(store.presence(target, later).instanceId).toBeNull();
});

it("activates only the reserved parent and first child, allowing that exact child again", () => {
  const { ensure, activate } = fixture();
  const id = ensure().relayId!;
  expect(activate(id, { parentPid: 101 })).toBe(false);
  expect(activate(id)).toBe(true);
  expect(activate(id)).toBe(true);
  expect(activate(id, { pid: 201 })).toBe(false);
});

it("keeps a late first child fail closed instead of reviving an expired birth", () => {
  const { store, ensure, activate } = fixture();
  const first = ensure();
  expect(activate(first.relayId!, {}, now + 60_000)).toBe(false);
  expect(ensure({}, now + 60_001)).toEqual({ ...first, spawn: false });
  expect(store.relayOwner(target, "gemini-queue")?.pid).toBe(0);
  expect(store.presence(target, now + 60_001).state).toBe("unreachable");
});

it("does not let a legacy acquire replace pending or expired verified ownership", () => {
  const { store, ensure, activate } = fixture();
  const id = ensure().relayId!;
  const legacy = { ...target, transport: "gemini-queue", relayId: "legacy-child", pid: 300, parentPid: 100 };
  expect(store.acquireRelay(legacy, now + 1)).toBe(false);
  expect(activate(id)).toBe(true);
  expect(store.acquireRelay(legacy, now + 60_000)).toBe(false);
  expect(store.relayOwner(target, "gemini-queue")?.relayId).toBe(id);
});

it.each(["codex-deferred", "claude-inbox"])("rejects legacy same-parent live owner replacement for %s", (transport) => {
  const { store } = fixture();
  expect(store.acquireRelay({ ...target, transport, relayId: "legacy-first", pid: 200, parentPid: 100 }, now)).toBe(true);
  expect(store.acquireRelay({ ...target, transport, relayId: "legacy-next", pid: 201, parentPid: 100 }, now + 1)).toBe(false);
  expect(store.liveRelay(target, transport, now + 2)?.relayId).toBe("legacy-first");
  expect(store.acquireRelay({ ...target, transport, relayId: "legacy-next", pid: 201, parentPid: 100 }, now + 15_000)).toBe(true);
  expect(store.liveRelay(target, transport, now + 15_001)?.relayId).toBe("legacy-next");
});

it("replaces a positively dead exact child and fences stale activation/heartbeat/cleanup", () => {
  const { store, input, ensure, activate } = fixture();
  const old = ensure().relayId!;
  expect(activate(old)).toBe(true);
  const fresh = store.prepareVerifiedRelay({ ...input, expectedOwner: store.relayOwner(target, input.transport),
    confirmedDead: { relayId: old, pid: 200 } }, now + 2);
  expect(fresh.spawn).toBe(true);
  expect(fresh.relayId).not.toBe(old);
  expect(activate(old, {}, now + 3)).toBe(false);
  expect(store.heartbeatRelay({ ...target, transport: input.transport, relayId: old }, now + 3)).toBe(false);
  expect(store.releaseVerifiedRelay({ ...input, relayId: old, pid: 200 }, now + 3)).toBe(false);
  expect(store.relayOwner(target, input.transport)?.relayId).toBe(fresh.relayId);
});

it("rejects a stale pre-observation owner snapshot without changing a newer generation", () => {
  const { store, input, ensure } = fixture();
  const first = ensure();
  const snapshot = store.relayOwner(target, input.transport);
  const next = ensure({ instanceId: replacement }, now + 1);
  expect(next.spawn).toBe(true);
  const before = store.presence(target, now + 1);
  expect(store.prepareVerifiedRelay({ ...input, expectedOwner: snapshot }, now + 2))
    .toEqual({ spawn: false, relayId: null, instanceId: generation });
  expect(store.relayOwner(target, input.transport)?.relayId).toBe(next.relayId);
  expect(next.relayId).not.toBe(first.relayId);
  expect(store.presence(target, now + 2)).toEqual(before);
});

it("allows only one reservation from competing empty snapshots", () => {
  const { store, input } = fixture();
  const first = store.prepareVerifiedRelay({ ...input, expectedOwner: null }, now);
  const second = store.prepareVerifiedRelay({ ...input, expectedOwner: null }, now + 1);
  expect(first.spawn).toBe(true);
  expect(second.spawn).toBe(false);
  expect(store.relayOwner(target, input.transport)?.relayId).toBe(first.relayId);
});

it("rejects wrong-instance release even when relayId and child PID are current", () => {
  const { store, input, ensure, activate } = fixture();
  const id = ensure().relayId!;
  expect(activate(id)).toBe(true);
  const owner = store.relayOwner(target, input.transport);
  const presence = store.presence(target, now + 1);
  expect(store.releaseVerifiedRelay({ ...input, instanceId: replacement, relayId: id, pid: 200 }, now + 2)).toBe(false);
  expect(store.relayOwner(target, input.transport)).toEqual(owner);
  expect(store.presence(target, now + 2)).toEqual(presence);
});

it("keeps exact relay termination and reused-session wake/claim working with a retained input observation", () => {
  const { store, input, ensure, activate } = fixture();
  const old = ensure().relayId!;
  expect(activate(old)).toBe(true);
  store.observeNativeInput(target, now + 2);
  expect(store.releaseVerifiedRelay({ ...input, relayId: old, pid: 200 }, now + 3)).toBe(true);
  expect(store.presence(target, now + 3)).toMatchObject({ state: "ended", instanceId: generation, endReason: "host-process-ended" });
  expect(store.relayOwner(target, input.transport)).toBeNull();
  expect(store.database.prepare("SELECT deferred_tool_claim FROM input_observations").get()).toMatchObject({ deferred_tool_claim: 1 });

  const fresh = ensure({ instanceId: replacement }, now + 4);
  expect(fresh.spawn).toBe(true);
  expect(activate(fresh.relayId!, { instanceId: replacement }, now + 5)).toBe(true);
  expect(store.releaseVerifiedRelay({ ...input, relayId: old, pid: 200 }, now + 6)).toBe(false);
  expect(store.presence(target, now + 6)).toMatchObject({ state: "online", instanceId: replacement });
  store.send({ messageId: "reused-input-message", sender: { host: "synthetic-peer", sessionId: "sender" }, target, body: "pending" }, now + 7);
  expect(store.reserveManagedWake({ ...target, instanceId: replacement, transport: input.transport,
    relayId: fresh.relayId!, nonce: "reused-input-wake-abcdefghijklmnop" }, now + 8).dispatch).toBe(true);
  store.observeNativeInput(target, now + 9);
  expect(store.database.prepare("SELECT * FROM input_observations").all()).toMatchObject([
    { deferred_tool_claim: 1, observed_at: new Date(now + 9).toISOString() },
  ]);
  expect(store.claimDeferred(target, now + 10)).toEqual([]);
  expect(store.claimDeferred(target, now + 11)).toMatchObject([{ messageId: "reused-input-message", deliveryAttempt: 1 }]);
  expect(store.acknowledge(target, ["reused-input-message"], now + 12)).toBe(1);
  expect(store.releaseVerifiedRelay({ ...input, instanceId: replacement, relayId: fresh.relayId!, pid: 200 }, now + 13)).toBe(true);
});

it("releases an old transport without ending the current transport presence", () => {
  const { store, input, ensure, activate } = fixture();
  const old = ensure().relayId!;
  expect(activate(old)).toBe(true);
  const fresh = ensure({ transport: "codex-queue" }, now + 2);
  expect(fresh.spawn).toBe(true);
  const presence = store.presence(target, now + 2);
  expect(presence.transport).toBe("codex-queue");
  expect(store.releaseVerifiedRelay({ ...input, relayId: old, pid: 200 }, now + 3)).toBe(true);
  expect(store.presence(target, now + 3)).toEqual(presence);
  expect(store.relayOwner(target, "codex-queue")?.relayId).toBe(fresh.relayId);
});

it("rejects an old reservation even if a newer same-transport presence matches the caller", () => {
  const { store, input, ensure, activate } = fixture();
  const old = ensure().relayId!;
  store.startPresence({ ...input, instanceId: replacement }, now + 1);
  expect(activate(old, { instanceId: replacement }, now + 2)).toBe(false);
  expect(store.relayOwner(target, input.transport)?.pid).toBe(0);
  expect(store.presence(target, now + 2).instanceId).toBe(replacement);
});

it("does not replace an unbound historical verified-prefix row", () => {
  const { store, input, ensure } = fixture();
  const legacyId = "verified-relay-v1:11111111-1111-4111-8111-111111111111";
  expect(store.acquireRelay({ ...target, transport: input.transport, relayId: legacyId, pid: 200, parentPid: 100 }, now)).toBe(true);
  expect(ensure({}, now + 60_000)).toEqual({ spawn: false, relayId: null, instanceId: generation });
  expect(store.relayOwner(target, input.transport)?.relayId).toBe(legacyId);
});
