import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";

import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchManagedWake } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import type { WakeDispatchOutcome } from "../../mcp-server/src/session-message-wake-port.js";

const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const workers: Worker[] = [];
const target = { host: "portable-host", sessionId: "al02-recipient" };
const sender = { host: "portable-sender", sessionId: "al02-sender" };
const relay = { ...target, transport: "portable-transport", relayId: "relay-first", instanceId: "instance-first" };

function fixture(databasePath = ":memory:", now = Date.now()) {
  const store = new SessionMessageStore(databasePath);
  stores.push(store);
  store.startPresence({ ...relay, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" } }, now);
  store.acquireRelay({ ...relay, pid: 200, parentPid: 100 }, now);
  store.send({ sender, target, messageId: "al02-pending-message", body: "pending", ttlSeconds: 600 }, now);
  return store;
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const worker of workers.splice(0)) await worker.terminate();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it("AGS-D-0002: the same parent PID cannot replace another live relay owner", () => {
  const now = Date.UTC(2026, 0, 1);
  const store = fixture(":memory:", now);
  expect(store.acquireRelay({ ...relay, relayId: "relay-other-generation", pid: 201, parentPid: 100 }, now + 1)).toBe(false);
  expect(store.liveRelay(target, relay.transport, now + 2)?.relayId).toBe(relay.relayId);
  expect(store.acquireRelay({ ...relay, pid: 200, parentPid: 100 }, now + 3)).toBe(true);
  expect(store.acquireRelay({ ...relay, relayId: "relay-after-expiry", pid: 201, parentPid: 100 }, now + 20_000)).toBe(true);
});

it("AGS-D-0003: a slow wake keeps relay/presence leases without recording work activity", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 0, 1));
  const store = fixture();
  let finish!: (outcome: WakeDispatchOutcome) => void;
  const dispatch = vi.fn(() => new Promise<WakeDispatchOutcome>((resolve) => { finish = resolve; }));
  const request = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    if (operation === "reserve-wake") return store.reserveManagedWake({ ...relay, nonce: String(payload.nonce), resume: true });
    if (operation === "start-wake") return store.startManagedWake(payload.attempt as Parameters<SessionMessageStore["startManagedWake"]>[0]);
    if (operation === "relay-tick") return store.relayTick({ ...relay, includePending: false });
    if (operation === "record-wake-outcome") return { recorded: store.recordManagedWakeOutcome(
      payload.attempt as Parameters<SessionMessageStore["recordManagedWakeOutcome"]>[0], payload.outcome as WakeDispatchOutcome) };
    throw new Error(`Unexpected operation: ${operation}`);
  });
  const pending = dispatchManagedWake(relay, relay.relayId, {
    capabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" }, dispatch,
  }, request as typeof sessionMessageRequest);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(store.liveRelay(target, relay.transport)?.relayId).toBe(relay.relayId);
  expect(store.presence(target).state).toBe("online");
  expect(request.mock.calls.filter(([operation]) => operation === "relay-tick")).toHaveLength(4);
  expect(store.database.prepare("SELECT count(*) AS count FROM session_activity").get()).toMatchObject({ count: 0 });
  finish("accepted-or-unknown");
  await expect(pending).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(store.managedWakeStatus(target)?.state).toBe("unknown");
});

it("AGS-D-0007: a reused PID cannot reactivate an old token and a stale owner snapshot cannot replace its successor", () => {
  const now = Date.UTC(2026, 0, 1);
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const input = { ...target, transport: "portable-verified", parentPid: 100,
    instanceId: "host-process-v1:" + "a".repeat(64), wakeVisibility: "silent" as const, canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ["peer-wake" as const], idleWake: "silent" as const } };
  const first = store.prepareVerifiedRelay({ ...input, expectedOwner: null }, now);
  expect(store.activateVerifiedRelay({ ...input, relayId: first.relayId!, pid: 200, relayStartToken: "old-process-token" }, now + 1)).toBe(true);
  const snapshot = store.relayOwner(target, input.transport)!;
  expect(snapshot.relayStartToken).toBe("old-process-token");
  expect(store.activateVerifiedRelay({ ...input, relayId: first.relayId!, pid: 200, relayStartToken: "reused-pid-token" }, now + 2)).toBe(false);
  expect(store.prepareVerifiedRelay({ ...input, expectedOwner: { ...snapshot, relayStartToken: "wrong-snapshot-token" },
    confirmedDead: { relayId: first.relayId!, pid: 200 } }, now + 3).spawn).toBe(false);
  // The broker alone supplies this proof after ESRCH or a successful PID probe plus a known token mismatch.
  const replacement = store.prepareVerifiedRelay({ ...input, expectedOwner: snapshot,
    confirmedDead: { relayId: first.relayId!, pid: 200 } }, now + 4);
  expect(replacement.spawn).toBe(true);
  expect(replacement.relayId).not.toBe(first.relayId);
  expect(store.prepareVerifiedRelay({ ...input, expectedOwner: snapshot,
    confirmedDead: { relayId: first.relayId!, pid: 200 } }, now + 5).spawn).toBe(false);
  expect(store.releaseVerifiedRelay({ ...input, relayId: first.relayId!, pid: 200 }, now + 6)).toBe(false);
  const later = now + 48 * 3600_000;
  store.prune(later);
  expect(store.prepareVerifiedRelay({ ...input, expectedOwner: store.relayOwner(target, input.transport) }, later).spawn).toBe(false);
  expect(store.relayOwner(target, input.transport)).toMatchObject({ relayId: replacement.relayId, pid: 0, relayStartToken: null });
});

it("AGS-D-0007: additive token migration keeps historical relay rows with unknown tokens", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-al02-migrate-"));
  directories.push(directory);
  const databasePath = path.join(directory, "messages.sqlite3");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE relay_leases (host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL,
    relay_id TEXT NOT NULL, pid INTEGER NOT NULL, parent_pid INTEGER NOT NULL, lease_until TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(host, session_id, transport)) STRICT;`);
  database.prepare("INSERT INTO relay_leases VALUES(?,?,?,?,?,?,?,?)").run(target.host, target.sessionId,
    relay.transport, "historical-owner", 200, 100, "9999-12-31T23:59:59.999Z", "2026-01-01T00:00:00.000Z");
  database.close();
  const store = new SessionMessageStore(databasePath);
  stores.push(store);
  expect(store.relayOwner(target, relay.transport)).toEqual({ relayId: "historical-owner", pid: 200,
    parentPid: 100, instanceId: null, relayStartToken: null });
});

it.each(["reserve", "start"])("AGS-D-0031: %s reads expiry after an independent writer releases its lock", async (operation) => {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-al02-clock-"));
  directories.push(directory);
  const databasePath = path.join(directory, "messages.sqlite3");
  const store = fixture(databasePath);
  const input = { ...relay, nonce: "al02-writer-wait-nonce-abcdefghijklmnop", resume: true };
  const reserved = operation === "start" ? store.reserveManagedWake(input).attempt! : null;
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(workerData.databasePath);
    db.exec('BEGIN IMMEDIATE');
    const expires = Date.now() + 700;
    if (workerData.operation === 'start') db.prepare('UPDATE wake_nonces SET expires_at = ?').run(new Date(expires).toISOString());
    else {
      db.prepare('UPDATE relay_leases SET lease_until = ?').run(new Date(expires).toISOString());
      db.prepare('UPDATE session_presence SET lease_until = ?').run(new Date(expires).toISOString());
    }
    parentPort.postMessage(expires);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    db.exec('COMMIT');
    db.close();
  `, { eval: true, workerData: { databasePath, operation } });
  workers.push(worker);
  const [expires] = await once(worker, "message") as [number];
  expect(Date.now()).toBeLessThan(expires);
  const result = operation === "start" ? store.startManagedWake(reserved!) : store.reserveManagedWake(input);
  expect(result.dispatch).toBe(false);
  await once(worker, "exit");
});

it("AGS-D-0065: a rollback failure preserves the original commit failure", () => {
  const store = fixture();
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
