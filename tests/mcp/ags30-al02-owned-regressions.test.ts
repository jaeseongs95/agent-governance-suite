import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import type { WakeDispatchOutcome, WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";

const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const holders: DatabaseSync[] = [];
const target = { host: "portable-host", sessionId: "al02-recipient" };
const sender = { host: "portable-sender", sessionId: "al02-sender" };
const relayBase = { ...target, transport: "portable-transport", instanceId: "instance-first" };
const base = Date.UTC(2026, 0, 1);
const silent = { supportedInjection: ["peer-wake" as const], idleWake: "silent" as const };

/** A served generation: presence reported with its host PID, a granted relay, the relay's first tick bound the host birth. */
function fixture(databasePath = ":memory:", clock?: () => number) {
  const store = new SessionMessageStore(databasePath, clock ? { clock } : {});
  stores.push(store);
  store.startPresence({ ...relayBase, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: silent, hostPid: 100 }, base);
  const grant = store.grantRelay({ ...relayBase, codeDigest: null, hostPid: 100 }, base);
  expect(grant.relayId).toEqual(expect.any(String));
  const relay = { ...relayBase, relayId: grant.relayId! };
  expect(store.relayTick({ ...relay, includePending: false, hostStart: "host-birth" }, base + 1)).toEqual({ alive: true, count: 0, hostBound: true });
  store.send({ sender, target, messageId: "al02-pending-message", body: "pending", ttlSeconds: 600 }, base);
  return { store, relay };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const holder of holders.splice(0)) { try { holder.exec("ROLLBACK"); } catch { /* not in a transaction */ } holder.close(); }
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("AGS-D-0002: the lease holder is a random relay id, so a second grant cannot replace a live relay and a replaced relay is fenced", () => {
  const { store, relay } = fixture();
  const request = { ...relayBase, codeDigest: null, hostPid: 100 };
  expect(store.grantRelay(request, base + 2)).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
  expect(store.liveRelay(target, relay.transport, base + 3)?.relayId).toBe(relay.relayId);
  // A grant for another host process than the one the generation reported is refused, never taken over.
  expect(store.grantRelay({ ...request, hostPid: 101 }, base + 4)).toEqual({ relayId: null, reason: "HOST_MISMATCH" });
  // Another entry code inside the start grace is still refused; once the grace has passed the new code replaces the holder.
  const code = "sha256:" + "b".repeat(64);
  expect(store.grantRelay({ ...request, codeDigest: code }, base + 10_000).reason).toBe("RELAY_ALIVE");
  expect(store.relayTick({ ...relay, includePending: false }, base + 20_000)).toMatchObject({ alive: true });
  const replacement = store.grantRelay({ ...request, codeDigest: code }, base + 31_000);
  expect(replacement.relayId).toEqual(expect.any(String));
  expect(replacement.relayId).not.toBe(relay.relayId);
  // The replaced relay's tick and release no longer match the lease.
  expect(store.relayTick({ ...relay, includePending: false }, base + 31_001)).toMatchObject({ alive: false });
  expect(store.releaseRelay({ ...relay, reason: "stale-release" }, base + 31_002)).toBe(false);
  expect(store.liveRelay(target, relay.transport, base + 31_003)?.relayId).toBe(replacement.relayId);
  // After the lease lapsed without renewal the next grant is a new holder again.
  const later = store.grantRelay({ ...request, codeDigest: code }, base + 31_000 + 61_000);
  expect(later.relayId).toEqual(expect.any(String));
  expect(later.relayId).not.toBe(replacement.relayId);
});

it("AGS-D-0003: a slow wake does not queue lease renewal behind it and records no work activity", async () => {
  let now = base + 2;
  const { store, relay } = fixture(":memory:", () => now);
  let finish!: (outcome: WakeDispatchOutcome) => void;
  const dispatch = vi.fn(() => new Promise<WakeDispatchOutcome>((resolve) => { finish = resolve; }));
  const port: WakeDispatchPort = { capabilities: silent, resendBaseMs: 600_000, dispatch };
  const ticks: number[] = [];
  const request = (async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "relay-tick") ticks.push(now);
    return dispatchSessionMessageOperation(store, operation, payload);
  }) as unknown as typeof sessionMessageRequest;
  let exit!: (reason: string) => void;
  const watch = (): HostWatch => ({ bound: Promise.resolve("host-birth"), exited: new Promise<string>((resolve) => { exit = resolve; }), close: vi.fn() });
  const observed: Array<{ lease: string | undefined; presence: string; wakeStarts: number; boundaries: number }> = [];
  let turn = 0;
  const delay = async (milliseconds: number, stopped: Promise<void>) => {
    turn += 1;
    now += milliseconds;
    // The wake is still in flight while renewal continues beside it (D0003).
    if (turn === 5) {
      await new Promise<void>((resolve) => setImmediate(resolve)); // drains the dispatch chain; no timer is waited on
      observed.push({ lease: store.liveRelay(target, relay.transport)?.relayId, presence: store.presence(target).state, wakeStarts: dispatch.mock.calls.length,
        boundaries: (store.database.prepare("SELECT count(*) AS count FROM wake_paths WHERE claim_boundary_at IS NOT NULL").get() as { count: number }).count });
      finish({ result: "unknown", reasonCode: "SYNTHETIC_UNKNOWN" });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(store.managedWakeStatus(target)?.state).toBe("unknown");
      exit("HOST_PROCESS_ENDED");
      await stopped;
    }
  };
  await runSessionMessageRelay({ ...relay, parentPid: 100 }, port, { request, watch, delay });
  // Five ticks at the injected 5 s steps renewed the lease while the first one's dispatch stayed pending.
  expect(ticks).toHaveLength(5);
  expect(observed).toEqual([{ lease: relay.relayId, presence: "online", wakeStarts: 1, boundaries: 0 }]);
  // The relay's own end released its lease and ended its birth.
  expect(store.liveRelay(target, relay.transport)).toBeNull();
  expect(store.presence(target)).toMatchObject({ state: "ended", endReason: "host-process-ended" });
});

it("AGS-D-0007: a reused PID cannot continue an old birth and a stale snapshot cannot replace its successor", () => {
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const birth = (pid: number, start: string) => ({ ...target, transport: "portable-verified", hostPid: pid, hostStart: start, codeDigest: null,
    instanceId: "host-process-v1:" + createHash("sha256").update(JSON.stringify([target.host, target.sessionId, pid, start])).digest("hex"),
    wakeVisibility: "silent" as const, canWakeSilently: true, deliveryCapabilities: silent });
  const first = birth(100, "old-process-token");
  const started = store.ensureVerifiedGeneration({ ...first, expectedPresenceInstanceId: null }, base);
  expect(started).toMatchObject({ spawn: true, instanceId: first.instanceId });
  const lease = { ...target, transport: first.transport, relayId: started.relayId!, instanceId: first.instanceId, includePending: false };
  expect(store.relayTick({ ...lease, hostStart: "old-process-token" }, base + 1)).toMatchObject({ alive: true, hostBound: true });
  // A process that took the PID later reports another birth: the relay is told it is not alive and renews nothing.
  expect(store.relayTick({ ...lease, hostStart: "reused-pid-token" }, base + 2)).toMatchObject({ alive: false });
  expect(store.presenceHost(target, first.instanceId)).toEqual({ pid: 100, start: "old-process-token" });
  // A stale snapshot of the current generation cannot start or replace anything.
  expect(store.ensureVerifiedGeneration({ ...first, expectedPresenceInstanceId: "stale-instance" }, base + 3))
    .toMatchObject({ spawn: false, reason: "GENERATION_CHANGED" });
  expect(store.ensureVerifiedGeneration({ ...first, expectedPresenceInstanceId: first.instanceId }, base + 4))
    .toMatchObject({ spawn: false, reason: "RELAY_ALIVE" });
  // A different birth is refused while the current verified birth is online and was not the expected one.
  const second = birth(101, "new-process-token");
  expect(store.ensureVerifiedGeneration({ ...second }, base + 5)).toMatchObject({ spawn: false, reason: "CURRENT_GENERATION_PROTECTED" });
  const replacement = store.ensureVerifiedGeneration({ ...second, expectedPresenceInstanceId: first.instanceId }, base + 6);
  expect(replacement).toMatchObject({ spawn: true, instanceId: second.instanceId });
  expect(replacement.relayId).not.toBe(started.relayId);
  // The replaced birth is superseded and its relay holds nothing.
  expect(store.ensureVerifiedGeneration({ ...first, expectedPresenceInstanceId: second.instanceId }, base + 7))
    .toMatchObject({ spawn: false, reason: "GENERATION_SUPERSEDED" });
  expect(store.releaseRelay({ ...lease, reason: "stale-release" }, base + 8)).toBe(false);
  expect(store.liveRelay(target, first.transport, base + 9)?.relayId).toBe(replacement.relayId);
  const later = base + 48 * 3600_000;
  store.prune(later);
  expect(store.liveRelay(target, first.transport, later)).toBeNull();
  expect(store.database.prepare("SELECT count(*) AS count FROM relay_leases").get()).toMatchObject({ count: 0 });
});

it("AGS-D-0007: opening a schema-3 file rebuilds the PID-bound relay lease table empty", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-al02-migrate-"));
  directories.push(directory);
  const databasePath = path.join(directory, "messages.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE relay_leases (host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL,
    relay_id TEXT NOT NULL, pid INTEGER NOT NULL, parent_pid INTEGER NOT NULL, lease_until TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(host, session_id, transport)) STRICT;
    PRAGMA user_version = 3;`);
  database.prepare("INSERT INTO relay_leases VALUES(?,?,?,?,?,?,?,?)").run(target.host, target.sessionId,
    relayBase.transport, "historical-owner", 200, 100, "9999-12-31T23:59:59.999Z", "2026-01-01T00:00:00.000Z");
  database.close();
  const store = new SessionMessageStore(databasePath);
  stores.push(store);
  const columns = (store.database.prepare("PRAGMA table_info(relay_leases)").all() as Array<{ name: string }>).map((column) => column.name);
  expect(columns).toEqual(expect.arrayContaining(["instance_id", "relay_id", "code_digest", "granted_at", "lease_until"]));
  expect(columns).not.toContain("pid");
  expect(columns).not.toContain("parent_pid");
  expect(store.database.prepare("SELECT count(*) AS count FROM relay_leases").get()).toMatchObject({ count: 0 });
  expect(store.database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
  expect(store.liveRelay(target, relayBase.transport, base)).toBeNull();
});

it.each(["reserve", "start"])("AGS-D-0031: %s samples its clock only after it holds the writer lock", (operation) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-al02-clock-"));
  directories.push(directory);
  const databasePath = path.join(directory, "messages.sqlite3");
  let now = base + 2;
  const inTransaction: boolean[] = [];
  const observer: { store?: SessionMessageStore } = {};
  const { store, relay } = fixture(databasePath, () => { inTransaction.push(observer.store?.database.isTransaction ?? false); return now; });
  observer.store = store;
  const input = { ...relay, nonce: "al02-writer-wait-nonce-abcdefghijklmnop", resume: true };
  const reserved = operation === "start" ? store.reserveManagedWake(input, base + 2).attempt! : null;
  const run = () => operation === "start" ? store.startManagedWake(reserved!, 600_000) : store.reserveManagedWake(input);
  // An independent writer holds the lock and, in the same transaction, ends the state this operation depends on.
  const holder = new DatabaseSync(databasePath);
  holders.push(holder);
  const expires = new Date(base + 10).toISOString();
  holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  if (operation === "start") holder.prepare("UPDATE wake_nonces SET expires_at = ?").run(expires);
  else {
    holder.prepare("UPDATE relay_leases SET lease_until = ?").run(expires);
    holder.prepare("UPDATE session_presence SET lease_until = ?").run(expires);
  }
  store.database.exec("PRAGMA busy_timeout = 0");
  const sampled = inTransaction.length;
  expect(run).toThrow(/locked|busy/iu);
  // Nothing sampled the clock before the lock was held; a time taken earlier could not see the writer's expiry.
  expect(inTransaction).toHaveLength(sampled);
  holder.exec("COMMIT");
  now = base + 20;
  const result = run();
  expect(result.dispatch).toBe(false);
  expect(inTransaction.length).toBeGreaterThan(sampled);
  expect(inTransaction.slice(sampled).every(Boolean)).toBe(true);
});

it("AGS-D-0065: a rollback failure preserves the original commit failure", () => {
  const { store } = fixture();
  const primary = new Error("original commit failure");
  const execute = store.database.exec.bind(store.database);
  const spy = vi.spyOn(store.database, "exec").mockImplementation((sql) => {
    if (sql === "COMMIT") throw primary;
    if (sql === "ROLLBACK") throw new Error("secondary rollback failure");
    return execute(sql);
  });
  try {
    expect(() => store.prepare({ sender, target, body: "draft" })).toThrow(primary);
  } finally {
    spy.mockRestore();
    execute("ROLLBACK");
  }
});
