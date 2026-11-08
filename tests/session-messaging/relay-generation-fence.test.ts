import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { RELAY_START_GRACE_MS, SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// Same host process, new presence generation (SessionStart compact/resume): the old relay R1 is fenced by its relay_id.
// It can neither renew the lease the new generation holds nor, on a late exit, remove it (docs/archive/ags30-broker-redesign.md 3.3).
const target = { host: "codex", sessionId: "relay-fence-session" };
const transport = "codex-queue";
const t0 = Date.UTC(2026, 9, 30);
const code = "sha256:" + "a".repeat(64);
const otherCode = "sha256:" + "b".repeat(64);
let clock = t0;
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  clock = t0;
});

function file(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-relay-fence-"));
  directories.push(directory);
  return path.join(directory, "session-messages.sqlite3");
}
function open(filename = file()): SessionMessageStore {
  const store = new SessionMessageStore(filename, { clock: () => clock });
  stores.push(store);
  return store;
}
const start = (store: SessionMessageStore, instanceId: string, at: number, extra: { hostPid?: number; hostStart?: string } = {}) => store.startPresence({
  ...target, instanceId, transport, wakeVisibility: "user-message", canWakeSilently: false,
  deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "user-message" }, ...extra,
}, at);
const grant = (store: SessionMessageStore, instanceId: string, at: number, codeDigest: string | null = code) =>
  store.grantRelay({ ...target, transport, instanceId, codeDigest }, at);
const tick = (store: SessionMessageStore, relayId: string, instanceId: string, at: number, hostStart?: string) =>
  store.relayTick({ ...target, transport, relayId, instanceId, includePending: false, ...(hostStart ? { hostStart } : {}) }, at);
const release = (store: SessionMessageStore, relayId: string, instanceId: string, at: number) =>
  store.releaseRelay({ ...target, transport, relayId, instanceId, reason: "host-process-ended" }, at);
const granted = (result: ReturnType<SessionMessageStore["grantRelay"]>): string => {
  expect(result).toEqual({ relayId: expect.stringMatching(/^[0-9a-f-]{36}$/u) });
  return result.relayId!;
};

it("FENCE-1: a superseded instance cannot renew its lease, and the new generation's grant fences it at once", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0));
  start(store, "I2", t0 + 1000);
  expect(tick(store, r1, "I1", t0 + 2000).alive).toBe(false);
  expect(grant(store, "I1", t0 + 2000)).toEqual({ relayId: null, reason: "GENERATION_CHANGED" });
  // The lease names another instance, so the current generation is granted without waiting for R1's lease to lapse.
  const r2 = granted(grant(store, "I2", t0 + 2001));
  expect(r2).not.toBe(r1);
  expect(store.liveRelay(target, transport, t0 + 2001)).toMatchObject({ relayId: r2, instanceId: "I2" });
  expect(tick(store, r1, "I1", t0 + 2002).alive).toBe(false);
  expect(tick(store, r2, "I2", t0 + 2002)).toEqual({ alive: true, count: 0, hostBound: false });
});

it("FENCE-2: a relay exit releases only its own lease; a late old exit leaves the replacement lease and presence untouched", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0));
  start(store, "I2", t0 + 1);
  const r2 = granted(grant(store, "I2", t0 + 2));
  expect(release(store, r1, "I1", t0 + 3)).toBe(false);
  expect(store.liveRelay(target, transport, t0 + 3)).toMatchObject({ relayId: r2, instanceId: "I2" });
  expect(store.presence(target, t0 + 3)).toMatchObject({ instanceId: "I2", endedAt: null, state: "online" });
  // The current relay's own exit frees its lease and ends its generation once.
  expect(release(store, r2, "I2", t0 + 4)).toBe(true);
  expect(store.liveRelay(target, transport, t0 + 4)).toBeNull();
  expect(store.presence(target, t0 + 4)).toMatchObject({ instanceId: "I2", state: "ended", endReason: "host-process-ended" });
  expect(release(store, r2, "I2", t0 + 5)).toBe(false);
});

it("FENCE-3: a foreign relay_id renews, releases and ends nothing", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0));
  const foreign = "00000000-0000-4000-8000-000000000000";
  expect(tick(store, foreign, "I1", t0 + 1).alive).toBe(false);
  expect(release(store, foreign, "I1", t0 + 1)).toBe(false);
  expect(store.liveRelay(target, transport, t0 + 1)).toMatchObject({ relayId: r1 });
  expect(store.presence(target, t0 + 1)).toMatchObject({ instanceId: "I1", state: "online" });
});

it("FENCE-4: the current generation is granted again after its own lease expires; the old relay_id stays fenced", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0));
  expect(tick(store, r1, "I1", t0 + 5000).alive).toBe(true);
  // Paused past both leases: the tick fails and nothing is renewed.
  expect(tick(store, r1, "I1", t0 + 60_000).alive).toBe(false);
  expect(store.presence(target, t0 + 60_000).state).toBe("unreachable");
  const r2 = granted(grant(store, "I1", t0 + 60_000));
  expect(r2).not.toBe(r1);
  expect(store.presence(target, t0 + 60_000).state).toBe("online");
  expect(tick(store, r1, "I1", t0 + 61_000).alive).toBe(false);
  expect(tick(store, r2, "I1", t0 + 61_000).alive).toBe(true);
  expect(store.presence(target, t0 + 61_000)).toMatchObject({ instanceId: "I1", state: "online" });
});

it("FENCE-5: a live lease of the same generation and code refuses a second grant (RELAY_ALIVE) and keeps its holder", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0));
  expect(tick(store, r1, "I1", t0 + RELAY_START_GRACE_MS - 1).alive).toBe(true);
  expect(grant(store, "I1", t0 + RELAY_START_GRACE_MS + 1)).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
  expect(store.liveRelay(target, transport, t0 + RELAY_START_GRACE_MS + 1)).toMatchObject({ relayId: r1 });
});

it("FENCE-6: a new generation started in the same millisecond is current, so only its relay is granted", () => {
  const store = open();
  start(store, "I1", t0);
  start(store, "I2", t0);
  expect(store.presence(target, t0).instanceId).toBe("I2");
  expect(grant(store, "I1", t0)).toEqual({ relayId: null, reason: "GENERATION_CHANGED" });
  granted(grant(store, "I2", t0));
});

it("FENCE-7: the first watcher birth binds the generation; a different birth later fences the relay", () => {
  const store = open();
  start(store, "I1", t0, { hostPid: 4101 });
  const r1 = granted(grant(store, "I1", t0));
  expect(tick(store, r1, "I1", t0 + 1, "birth-1")).toEqual({ alive: true, count: 0, hostBound: true });
  expect(store.presenceHost(target, "I1")).toEqual({ pid: 4101, start: "birth-1" });
  expect(tick(store, r1, "I1", t0 + 2, "birth-2").alive).toBe(false);
  expect(store.presenceHost(target, "I1")).toEqual({ pid: 4101, start: "birth-1" });
  // A grant for another host process of the same generation is refused.
  expect(store.grantRelay({ ...target, transport, instanceId: "I1", codeDigest: code, hostPid: 4102 }, t0 + 3))
    .toEqual({ relayId: null, reason: "HOST_MISMATCH" });
});

it("D0348: a relay running other installed code is replaced once after the start grace, fencing the old relay", () => {
  const store = open();
  start(store, "I1", t0);
  const r1 = granted(grant(store, "I1", t0, code));
  // Inside the start grace even other code is refused, so a replacement cannot be replaced again at once.
  expect(grant(store, "I1", t0 + 1, otherCode)).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
  expect(tick(store, r1, "I1", t0 + RELAY_START_GRACE_MS - 1).alive).toBe(true);
  const r2 = granted(grant(store, "I1", t0 + RELAY_START_GRACE_MS + 1, otherCode));
  expect(store.liveRelay(target, transport, t0 + RELAY_START_GRACE_MS + 1)).toMatchObject({ relayId: r2, codeDigest: otherCode });
  expect(tick(store, r1, "I1", t0 + RELAY_START_GRACE_MS + 2).alive).toBe(false);
  expect(grant(store, "I1", t0 + RELAY_START_GRACE_MS + 3, otherCode)).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
});

const claimDeferred = (store: SessionMessageStore, extra: Record<string, unknown> = {}) =>
  dispatchSessionMessageOperation(store, "claim-deferred", { target, ...extra }) as { messages: unknown[]; relayRecovery?: { instanceId: string; hostPid?: number } };

it("RECOVER-1: a boundary claim reports the current generation that has no relay, and only that case", () => {
  const store = open();
  clock = t0;
  start(store, "I1", t0 - 90_000);
  start(store, "I2", t0 - 60_000); // never granted: presence lapsed to unreachable
  expect(claimDeferred(store).relayRecovery).toEqual({ instanceId: "I2" });
  // An instance-bound (verified) hook gets no hint.
  expect(claimDeferred(store, { instanceId: "I2" }).relayRecovery).toBeUndefined();
  granted(grant(store, "I2", t0));
  expect(claimDeferred(store).relayRecovery).toBeUndefined(); // live relay: nothing to recover
});

it("RECOVER-2: a killed relay's unexpired lease suppresses recovery until it expires, then the generation is granted again", () => {
  const store = open();
  start(store, "I1", t0 - 60_000);
  start(store, "I2", t0 - 30_000);
  granted(grant(store, "I2", t0)); // the relay is killed before its first tick: no release, no renewal
  expect(store.relayRecoveryInstance(target, t0 + 10_000)).toBeNull();
  expect(store.relayRecoveryInstance(target, t0 + RELAY_START_GRACE_MS + 1)).toBe("I2");
  granted(grant(store, "I2", t0 + RELAY_START_GRACE_MS + 1));
  expect(store.relayRecoveryInstance(target, t0 + RELAY_START_GRACE_MS + 2)).toBeNull();
});

it("RECOVER-3: ended, online or verified generations are never offered for unverified recovery", () => {
  const store = open();
  clock = t0;
  start(store, "I1", t0);
  expect(claimDeferred(store).relayRecovery).toBeUndefined(); // online (fresh presence lease)
  expect(store.endPresence(target, "host-process-ended", "I1", t0)).toBe(true);
  expect(store.relayRecoveryInstance(target, t0 + 60_000)).toBeNull();
  start(store, "host-process-v1:" + "c".repeat(64), t0 + 1);
  expect(store.relayRecoveryInstance(target, t0 + 60_000)).toBeNull();
});

it("RECOVER-4: the recovery hint carries only the host process the generation itself reported, and a legacy row none", () => {
  const store = open();
  clock = t0;
  start(store, "I1", t0 - 90_000, { hostPid: 5101 });
  const started = dispatchSessionMessageOperation(store, "presence-start", { target, instanceId: "I2", transport,
    wakeVisibility: "user-message", canWakeSilently: false, hostPid: 5102, codeDigest: code }) as { relayId: string | null };
  expect(started.relayId).toMatch(/^[0-9a-f-]{36}$/u);
  clock = t0 + 60_000; // the granted relay never ticked
  expect(claimDeferred(store).relayRecovery).toEqual({ instanceId: "I2", hostPid: 5102 });
  expect(store.presenceHost(target, "I1")).toEqual({ pid: 5101, start: null });
  // An invalid or half report is rejected rather than stored as a partial binding.
  expect(() => dispatchSessionMessageOperation(store, "presence-start", { target, instanceId: "I3", transport,
    wakeVisibility: "user-message", canWakeSilently: false, hostPid: 0 })).toThrow("hostPid is invalid.");
  expect(() => store.startPresence({ ...target, instanceId: "I4", transport, wakeVisibility: "user-message",
    canWakeSilently: false, hostStart: "birth-without-pid" })).toThrow("Invalid reported host process.");
  expect(store.presenceHost(target, "I3")).toBeNull();
  expect(store.presenceHost(target, "I4")).toBeNull();
  // A generation without a reported host gets no relay and its recovery hint names no host.
  const legacy = dispatchSessionMessageOperation(store, "presence-start", { target, instanceId: "I5", transport,
    wakeVisibility: "user-message", canWakeSilently: false }) as { relayId: string | null; reason?: string };
  expect(legacy).toMatchObject({ relayId: null, reason: "HOST_UNREPORTED" });
  clock = t0 + 120_000;
  expect(claimDeferred(store).relayRecovery).toEqual({ instanceId: "I5" });
});

it("RECOVER-5: two connections to one file agree on the reported host and the recovery hint", () => {
  const filename = file();
  const first = open(filename), second = open(filename);
  start(first, "fresh", t0, { hostPid: 5201 });
  expect(second.presenceHost(target, "fresh")).toEqual({ pid: 5201, start: null });
  clock = t0 + 60_000;
  expect((dispatchSessionMessageOperation(second, "claim-deferred", { target }) as { relayRecovery?: unknown }).relayRecovery)
    .toEqual({ instanceId: "fresh", hostPid: 5201 });
  expect(first.relayRecoveryInstance(target, t0 + 60_000)).toBe("fresh");
});

// D0354 (auditor 4048e5e4): a start event in the same host process (compact) replaced the generation and its working
// relay every time; a failed new relay then left the session without one. The served generation is kept instead.
describe("KEEP: a start event of the same host process keeps the generation its live relay serves", () => {
  const hostPid = 4100;
  const startEvent = (store: SessionMessageStore, instanceId: string, extra: Record<string, unknown> = {}) =>
    dispatchSessionMessageOperation(store, "presence-start", { target, instanceId, transport, wakeVisibility: "user-message",
      canWakeSilently: false, hostPid, codeDigest: code, ...extra }) as { presence: { instanceId: string }; kept?: boolean; relayId: string | null };
  /** I1 started at t0 by host 4100 and served by its relay: granted, bound to birth-1 by its first tick at t0 + 5. */
  const served = (relayCode = code, bind = true) => {
    const store = open();
    clock = t0;
    const first = startEvent(store, "I1", { codeDigest: relayCode });
    expect(first.kept).toBeUndefined(); // nothing serves the session yet: a new generation
    if (bind) expect(tick(store, first.relayId!, "I1", t0 + 5, "birth-1").alive).toBe(true);
    clock = t0 + 10;
    return store;
  };

  it.each([[{}], [{ hostStart: "birth-1" }]])("keeps it for the same host process and relay code %j: no new generation, the lease is untouched", (extra) => {
    const store = served();
    const lease = store.liveRelay(target, transport, t0 + 10);
    expect(startEvent(store, "I2", extra)).toMatchObject({ kept: true, presence: { instanceId: "I1" }, relayId: null });
    expect(store.presence(target, t0 + 10).instanceId).toBe("I1");
    expect(store.presenceHost(target, "I2")).toBeNull();
    expect(store.liveRelay(target, transport, t0 + 10)).toEqual(lease);
  });

  it.each([
    ["another host birth", { hostStart: "birth-2" }, code],
    ["an old hook that sends no relay code", { codeDigest: undefined }, code],
    ["a relay running other entry code (D0348)", {}, otherCode],
    ["another host process", { hostPid: hostPid + 1 }, code],
  ])("starts a new generation for %s", (_name, extra, relayCode) => {
    const store = served(relayCode);
    expect(startEvent(store, "I2", extra).kept).toBeUndefined();
    expect(store.presence(target, t0 + 10).instanceId).toBe("I2");
  });

  it("starts a new generation when the relay has not yet served (bound) the current one", () => {
    const store = served(code, false);
    expect(startEvent(store, "I2").kept).toBeUndefined();
    expect(store.presence(target, t0 + 10).instanceId).toBe("I2");
  });
});
