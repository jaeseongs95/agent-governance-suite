import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// Same Codex process, new presence generation (SessionStart compact/resume): the old relay R1
// must neither renew the lease R2 is waiting for nor, on a late exit, remove R2's lease.
const target = { host: "codex", sessionId: "relay-fence-session" };
const transport = "codex-queue";
const parentPid = process.pid;
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function open(): SessionMessageStore {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-relay-fence-"));
  directories.push(directory);
  const store = new SessionMessageStore(path.join(directory, "session-messages.sqlite3"));
  stores.push(store);
  return store;
}
const start = (store: SessionMessageStore, instanceId: string, at: number) => store.startPresence({
  ...target, instanceId, transport, wakeVisibility: "user-message", canWakeSilently: false,
  deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" },
}, at);
const acquire = (store: SessionMessageStore, relayId: string, pid: number, instanceId: string, at: number) =>
  store.acquireRelay({ ...target, transport, relayId, pid, parentPid, instanceId }, at);
const owner = (store: SessionMessageStore) => store.relayOwner(target, transport);
const end = (store: SessionMessageStore, instanceId: string, relayId: string, pid: number) =>
  (dispatchSessionMessageBrokerOperation(store, "presence-end", { target, instanceId, reason: "host-process-ended", relayId, pid }) as { ended: boolean }).ended;

it("FENCE-1: a superseded instance cannot renew the lease, so the new generation's relay acquires at once", () => {
  const store = open(), t0 = Date.now();
  start(store, "I1", t0);
  expect(acquire(store, "R1", 4101, "I1", t0)).toBe(true);
  start(store, "I2", t0 + 1000);
  expect(store.relayTick({ ...target, transport, relayId: "R1", instanceId: "I1", includePending: false }, t0 + 2000).alive).toBe(false);
  expect(acquire(store, "R1", 4101, "I1", t0 + 2000)).toBe(false);
  expect(owner(store)?.relayId).toBe("R1");
  // R1's original lease (t0 + 15s) was not extended: R2 succeeds right after it, not 15s after R1's retry.
  expect(acquire(store, "R2", 4102, "I2", t0 + 15_001)).toBe(true);
  expect(owner(store)).toMatchObject({ relayId: "R2", pid: 4102 });
});

it("FENCE-2: a relay exit releases only its own lease; a late old exit leaves the replacement lease untouched", () => {
  const store = open(), now = Date.now();
  start(store, "I1", now);
  expect(acquire(store, "R1", 4201, "I1", now)).toBe(true);
  start(store, "I2", now);
  expect(end(store, "I1", "R1", 4201)).toBe(true);
  expect(owner(store)).toBeNull();
  expect(acquire(store, "R2", 4202, "I2", Date.now())).toBe(true);
  // Duplicate/late R1 exit: zero lease rows and no presence change.
  expect(end(store, "I1", "R1", 4201)).toBe(false);
  expect(owner(store)).toMatchObject({ relayId: "R2", pid: 4202 });
  expect(store.presence(target).instanceId).toBe("I2");
  expect(store.presence(target).endedAt).toBeNull();
});

it("FENCE-3: same pid with a different relayId, or same relayId with a different pid, removes nothing", () => {
  const store = open(), now = Date.now();
  start(store, "I1", now);
  expect(acquire(store, "R1", 4301, "I1", now)).toBe(true);
  expect(end(store, "I1", "R-other", 4301)).toBe(true); // presence ends, foreign token releases nothing
  expect(owner(store)).toMatchObject({ relayId: "R1", pid: 4301 });
  start(store, "I2", Date.now());
  expect(end(store, "I2", "R1", 4399)).toBe(true);
  expect(owner(store)).toMatchObject({ relayId: "R1", pid: 4301 });
});

it("FENCE-4: the current generation still reconnects after its own lease expires and keeps heartbeating", () => {
  const store = open(), t0 = Date.now();
  start(store, "I1", t0);
  expect(acquire(store, "R1", 4401, "I1", t0)).toBe(true);
  expect(store.relayTick({ ...target, transport, relayId: "R1", instanceId: "I1", includePending: false }, t0 + 5000).alive).toBe(true);
  // Paused past both leases: tick fails, the same-generation reacquire succeeds and revives presence.
  expect(store.relayTick({ ...target, transport, relayId: "R1", instanceId: "I1", includePending: false }, t0 + 60_000).alive).toBe(false);
  expect(acquire(store, "R1", 4401, "I1", t0 + 60_000)).toBe(true);
  expect(store.relayTick({ ...target, transport, relayId: "R1", instanceId: "I1", includePending: false }, t0 + 61_000).alive).toBe(true);
  expect(store.presence(target, t0 + 61_000).state).toBe("online");
});

it("FENCE-5: a reused OS pid with a new relayId keeps its lease when the old relay's late exit arrives", () => {
  const store = open(), t0 = Date.now();
  start(store, "I1", t0);
  expect(acquire(store, "R1", 4501, "I1", t0)).toBe(true);
  start(store, "I2", t0 + 1000);
  expect(acquire(store, "R1", 4501, "I1", t0 + 2000)).toBe(false);
  expect(acquire(store, "R2", 4501, "I2", t0 + 15_001)).toBe(true);
  expect(end(store, "I1", "R1", 4501)).toBe(true); // ends I1 only
  expect(owner(store)).toMatchObject({ relayId: "R2", pid: 4501 });
  expect(store.presence(target).instanceId).toBe("I2");
  // The current relay re-acquiring its own expired lease is still one token; its own exit then frees it once.
  expect(acquire(store, "R2", 4501, "I2", t0 + 40_000)).toBe(true);
  expect(end(store, "I2", "R2", 4501)).toBe(true);
  expect(owner(store)).toBeNull();
  expect(end(store, "I2", "R2", 4501)).toBe(false);
});

it("FENCE-6: a new generation started in the same millisecond is current, so only its relay acquires", () => {
  const store = open(), t0 = Date.now();
  start(store, "I1", t0);
  start(store, "I2", t0);
  expect(store.presence(target, t0).instanceId).toBe("I2");
  expect(acquire(store, "R1", 4601, "I1", t0)).toBe(false);
  expect(acquire(store, "R2", 4602, "I2", t0)).toBe(true);
});

const claimDeferred = (store: SessionMessageStore, extra: Record<string, unknown> = {}) =>
  dispatchSessionMessageBrokerOperation(store, "claim-deferred", { target, ...extra }) as { messages: unknown[]; relayRecovery?: { instanceId: string } };

it("RECOVER-1: a boundary claim reports the current generation that has no relay, and only that case", () => {
  const store = open(), now = Date.now();
  start(store, "I1", now - 90_000);
  start(store, "I2", now - 60_000); // never acquired: presence lapsed to unreachable
  expect(claimDeferred(store).relayRecovery).toEqual({ instanceId: "I2" });
  expect(acquire(store, "R3", 4703, "I2", Date.now())).toBe(true);
  expect(claimDeferred(store).relayRecovery).toBeUndefined(); // live relay: nothing to recover
});

it("RECOVER-2: a killed old relay's stale lease suppresses recovery until it expires, then the new relay acquires", () => {
  const store = open(), now = Date.now();
  start(store, "I1", now - 60_000);
  start(store, "I2", now - 30_000);
  // Killed relay: its lease row stays (no exit cleanup). Legacy instance-less acquire stands in for the old row.
  expect(store.acquireRelay({ ...target, transport, relayId: "R1", pid: 4801, parentPid }, now - 5000)).toBe(true);
  expect(claimDeferred(store).relayRecovery).toBeUndefined();
  expect(store.relayRecoveryInstance(target, now + 10_001)).toBe("I2");
  expect(acquire(store, "R2", 4802, "I2", now + 10_001)).toBe(true);
  expect(store.relayRecoveryInstance(target, now + 10_002)).toBeNull();
});

it("RECOVER-3: ended, online or verified generations are never offered for unverified recovery", () => {
  const store = open(), now = Date.now();
  start(store, "I1", now);
  expect(claimDeferred(store).relayRecovery).toBeUndefined(); // online (fresh presence lease)
  expect(store.endPresence(target, "host-process-ended", "I1", now)).toBe(true);
  expect(store.relayRecoveryInstance(target, now + 60_000)).toBeNull();
  start(store, "host-process-v1:" + "c".repeat(64), now + 1);
  expect(store.relayRecoveryInstance(target, now + 60_000)).toBeNull();
});
