import { spawn } from "node:child_process";
import { once } from "node:events";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { waitForSessionMessageBrokerReady } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageService } from "../../mcp-server/src/session-message-service.js";
import * as protocol from "../../mcp-server/src/session-message-protocol.js";
import * as storeModule from "../../mcp-server/src/session-message-store.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { recordWakeHookObservation, wakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";

const { SessionMessageStore, WAKE_TTL_MS, WAKE_RETIRE_GRACE_MS } = storeModule;
type Store = InstanceType<typeof SessionMessageStore>;
// Read through the namespace so this file still loads (and fails on behavior) against 2.7.3, which lacks them.
const RETENTION = (storeModule as Record<string, unknown>).PRESENCE_RETENTION_MS as number;
const MAX_TARGETS = (protocol as Record<string, unknown>).SESSION_PRESENCE_LIST_MAX_TARGETS as number;
const HOUR = 3600_000;
const sourceBroker = fileURLToPath(new URL("../../mcp-server/src/session-message-broker.ts", import.meta.url));
const capabilities = { supportedInjection: ["peer-wake", "tool-boundary"] as Array<"peer-wake" | "tool-boundary">, idleWake: "silent" as const };
const cleanup: Array<() => void | Promise<void>> = [];
// Reverse order: a broker exits and stores close before their directory goes (Windows cannot remove open files).
afterEach(async () => { vi.unstubAllEnvs(); for (const task of cleanup.splice(0).reverse()) await task(); });

function directory(): string {
  const created = mkdtempSync(path.join(tmpdir(), "ags-presence-retention-"));
  cleanup.push(() => rmSync(created, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  return created;
}
function open(database: string): Store {
  const store = new SessionMessageStore(database);
  cleanup.push(() => store.close());
  return store;
}
function born(store: Store, sessionId: string, instanceId: string, at: number, host = "portable") {
  return store.startPresence({ host, sessionId, instanceId, transport: "portable", wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: capabilities, collaborationId: "collaboration-presence-retention",
    workspaceId: `/work/space/presence-retention/projects/agent-governance-suite-${sessionId}`, role: "implementation-writer" }, at);
}
function relay(store: Store, sessionId: string, at: number) {
  store.acquireRelay({ host: "portable", sessionId, transport: "portable", relayId: `relay-${sessionId}`, pid: process.pid, parentPid: process.pid }, at);
}
/** A real broker reads the wall clock, so rows meant to be live get a lease measured from now, after the slow seeding. */
function keepLive(store: Store, sessionIds: string[]) {
  const now = Date.now();
  for (const sessionId of sessionIds) {
    store.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ? WHERE session_id = ?")
      .run(new Date(now).toISOString(), new Date(now + 10 * 60_000).toISOString(), sessionId);
    store.database.prepare("UPDATE relay_leases SET updated_at = ?, lease_until = ? WHERE session_id = ?")
      .run(new Date(now).toISOString(), new Date(now + 10 * 60_000).toISOString(), sessionId);
  }
}
function rows(store: Store) {
  return store.database.prepare("SELECT rowid, * FROM session_presence ORDER BY rowid").all();
}
const withoutCheckedAt = (value: storeModule.SessionPresenceView) =>
  ({ ...value, autoWake: value.autoWake ? { ...value.autoWake, checkedAt: null } : value.autoWake });

/** 342 identities and 1302 rows, as on the reported PC: nearly all ended or lapsed days ago, 40 ended an hour ago, 2 live. */
function largeFixture(database: string, now: number) {
  const store = new SessionMessageStore(database);
  try {
    // One transaction: about 2000 separate commits each waited for a disk flush, which dominated slow Windows runners.
    store.database.exec("BEGIN");
    for (let index = 0; index < 300; index += 1) {
      for (let instance = 0; instance < (index < 60 ? 5 : 4); instance += 1) {
        const at = now - 10 * 24 * HOUR + index * 60_000 + instance * 1000;
        born(store, `old-${index}`, `old-${index}-${instance}`, at);
        if (instance % 2 === 0) store.endPresence({ host: "portable", sessionId: `old-${index}` }, "session-end", `old-${index}-${instance}`, at + 500);
      }
    }
    for (let index = 0; index < 40; index += 1) {
      born(store, `recent-${index}`, `recent-${index}`, now - HOUR);
      store.endPresence({ host: "portable", sessionId: `recent-${index}` }, "session-end", `recent-${index}`, now - HOUR + 1000);
    }
    // Relay leases go in directly: acquireRelay prunes, and the broker must first meet the full database.
    for (const sessionId of ["live-0", "live-1"]) {
      born(store, sessionId, sessionId, now - 1000);
      store.database.prepare(`INSERT INTO relay_leases (host, session_id, transport, relay_id, pid, parent_pid, lease_until, updated_at)
        VALUES ('portable', ?, 'portable', ?, ?, ?, ?, ?)`).run(sessionId, `relay-${sessionId}`, process.pid, process.pid,
        new Date(now + 60_000).toISOString(), new Date(now - 1000).toISOString());
    }
    keepLive(store, ["live-0", "live-1"]);
    store.database.exec("COMMIT");
    return (store.database.prepare("SELECT count(*) AS rows, count(DISTINCT session_id) AS identities FROM session_presence").get());
  } finally { store.close(); }
}

it("serves board presence from a 342-identity, 1302-row database through a real broker", async () => {
  const state = directory();
  const now = Date.now();
  expect(largeFixture(path.join(state, "session-messages.sqlite3"), now)).toEqual({ rows: 1302, identities: 342 });
  const child = spawn(process.execPath, ["--import", "tsx", sourceBroker, "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  });
  await waitForSessionMessageBrokerReady(state, child, 5000);
  // The board shows sessions updated in the last 24 hours: the recent and live ones, plus a few long-gone identities.
  const board = [...Array.from({ length: 40 }, (_, index) => `recent-${index}`), "live-0", "live-1", "old-0", "old-299"]
    .map((sessionId) => ({ host: "portable", sessionId }));
  const result = await new SessionMessageService(state).listPresence(board);
  expect(result.error).toBeNull();
  const bySession = new Map(result.data!.sessions.map((session) => [session.sessionId, session]));
  for (let index = 0; index < 40; index += 1) expect(bySession.get(`recent-${index}`)).toMatchObject({ state: "ended", endReason: "session-end" });
  for (const sessionId of ["live-0", "live-1"]) {
    expect(bySession.get(sessionId)).toMatchObject({ state: "online", autoWake: { state: "available", reason: "relay-live" } });
  }
  // Presence rows ended days ago were pruned; the identity reads as never registered.
  expect(bySession.get("old-0")).toMatchObject({ state: "unknown", autoWake: { state: "no-live-relay", reason: "presence-unknown" } });
  const database = new DatabaseSync(path.join(state, "session-messages.sqlite3"));
  try {
    expect(database.prepare("SELECT count(*) AS rows FROM session_presence").get()).toEqual({ rows: 42 });
  } finally { database.close(); }
}, 60_000);

it("B1: an identity outside the broker pattern stays unknown alone while the other board sessions resolve", async () => {
  const state = directory();
  const now = Date.now();
  const store = new SessionMessageStore(path.join(state, "session-messages.sqlite3"));
  try {
    for (let index = 0; index < 6; index += 1) born(store, `valid-${index}`, `valid-${index}`, now - 1000);
    keepLive(store, Array.from({ length: 6 }, (_, index) => `valid-${index}`));
  } finally { store.close(); }
  const child = spawn(process.execPath, ["--import", "tsx", sourceBroker, "--state-directory", state], { windowsHide: true, stdio: "ignore" });
  cleanup.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill(); await exit; }
  });
  await waitForSessionMessageBrokerReady(state, child, 5000);
  const board = [...Array.from({ length: 6 }, (_, index) => ({ host: "portable", sessionId: `valid-${index}` })),
    { host: "portable", sessionId: "has space" }];
  const result = await new SessionMessageService(state).listPresence(board);
  expect(result.ok).toBe(true);
  for (let index = 0; index < 6; index += 1) {
    expect(result.data!.sessions.find((session) => session.sessionId === `valid-${index}`)).toMatchObject({ state: "online" });
  }
  expect(result.data!.unanswered).toEqual([{ host: "portable", sessionId: "has space" }]);
}, 30_000);

it("keeps an ended or lapsed row until exactly the retention period after its lease end", () => {
  const store = open(":memory:");
  const now = Date.now();
  born(store, "ended", "ended", now); store.endPresence({ host: "portable", sessionId: "ended" }, "session-end", "ended", now + 10);
  born(store, "lapsed", "lapsed", now);
  const lapsedLease = Date.parse(store.presence({ host: "portable", sessionId: "lapsed" }).leaseUntil!);
  store.prune(now + 10 + RETENTION - 1);
  expect(store.presence({ host: "portable", sessionId: "ended" }, now + 10 + RETENTION - 1).state).toBe("ended");
  store.prune(now + 10 + RETENTION);
  expect(store.presence({ host: "portable", sessionId: "ended" }).state).toBe("unknown");
  store.prune(lapsedLease + RETENTION - 1);
  expect(store.presence({ host: "portable", sessionId: "lapsed" }, lapsedLease + RETENTION - 1).state).toBe("unreachable");
  store.prune(lapsedLease + RETENTION);
  expect(store.presence({ host: "portable", sessionId: "lapsed" }).state).toBe("unknown");
  expect(RETENTION).toBe(24 * HOUR);
});

it("never deletes a live row, however old its birth", () => {
  const store = open(":memory:");
  const start = Date.now() - 10 * 24 * HOUR;
  born(store, "long", "long", start);
  for (let at = start; at <= start + 10 * 24 * HOUR; at += 15_000 * 400) {
    store.database.prepare("UPDATE session_presence SET heartbeat_at = ?, lease_until = ?").run(new Date(at).toISOString(), new Date(at + 20_000).toISOString());
    store.prune(at + 1000);
  }
  const end = start + 10 * 24 * HOUR;
  store.database.prepare("UPDATE session_presence SET lease_until = ?").run(new Date(end + 20_000).toISOString());
  store.prune(end + 1000);
  expect(store.presence({ host: "portable", sessionId: "long" }, end + 1000)).toMatchObject({ state: "online", startedAt: new Date(start).toISOString() });
  // A live row that is not its identity's latest row is kept by its lease alone; the ended latest row stays while it lives.
  born(store, "long", "newer", start + 1000); store.endPresence({ host: "portable", sessionId: "long" }, "session-end", "newer", start + 2000);
  store.prune(end + 2000);
  expect(store.database.prepare("SELECT instance_id FROM session_presence WHERE session_id = 'long' ORDER BY instance_id").all())
    .toEqual([{ instance_id: "long" }, { instance_id: "newer" }]);
});

it("keeps retirement, presence and autoWake identical to a run that deletes no presence row", () => {
  const state = directory();
  const database = path.join(state, "a.sqlite3");
  const store = new SessionMessageStore(database);
  const t0 = Date.now() - 3 * 24 * HOUR;
  const target = (sessionId: string) => ({ host: "portable", sessionId });
  const wake = (sessionId: string, instanceId: string, at: number) => {
    store.send({ sender: { host: "portable", sessionId: "sender" }, target: target(sessionId), messageId: `body-${sessionId}`, body: "b", ttlSeconds: 86400 }, at);
    const reserved = store.reserveManagedWake({ ...target(sessionId), nonce: `${sessionId}-nonce-abcdefghijklmnopqrstu`, instanceId,
      transport: "portable", relayId: `relay-${sessionId}`, resume: true }, at);
    expect(reserved.dispatch).toBe(true);
    const started = store.startManagedWake(reserved.attempt!, at + 1);
    expect(store.recordManagedWakeOutcome(started.attempt!, "submitted", at + 2)).toBe(true);
  };
  // A: a latched wake of an old ended birth; a newer birth of the same instance is live now.
  born(store, "reborn", "same", t0); relay(store, "reborn", t0); wake("reborn", "same", t0);
  store.endPresence(target("reborn"), "session-end", "same", t0 + 5000);
  // B: an older birth still live while a newer instance of the same identity ended long ago (latest row is not live).
  born(store, "split", "live-old", t0); born(store, "split", "ended-new", t0 + 1000);
  store.endPresence(target("split"), "session-end", "ended-new", t0 + 2000);
  // C: a latched wake of an identity whose only birth ended long ago and never came back.
  born(store, "gone", "gone", t0); relay(store, "gone", t0); wake("gone", "gone", t0);
  store.endPresence(target("gone"), "session-end", "gone", t0 + 5000);
  // D: recently ended, E: live with relay.
  born(store, "recent", "recent", Date.now() - HOUR); store.endPresence(target("recent"), "session-end", "recent", Date.now() - HOUR + 1);
  store.close();
  const now = Date.now();
  const control = path.join(state, "b.sqlite3");
  copyFileSync(database, control);
  const a = open(database); const b = open(control);
  b.database.exec("CREATE TRIGGER keep_presence BEFORE DELETE ON session_presence BEGIN SELECT RAISE(IGNORE); END;");
  // Keep every presence row alive in the live identities across the gap without creating a new generation.
  for (const current of [a, b]) {
    current.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = 'live-old'").run(new Date(now + 60_000).toISOString());
    born(current, "reborn", "same", now - 10); relay(current, "reborn", now - 10); relay(current, "split", now - 10);
    born(current, "live", "live", now - 10); relay(current, "live", now - 10);
  }
  a.prune(now); b.prune(now);
  expect(a.database.prepare("SELECT count(*) AS n FROM session_presence").get()).not.toEqual(b.database.prepare("SELECT count(*) AS n FROM session_presence").get());
  expect(a.database.prepare("SELECT * FROM wake_nonces ORDER BY rowid").all()).toEqual(b.database.prepare("SELECT * FROM wake_nonces ORDER BY rowid").all());
  expect(a.database.prepare("SELECT * FROM messages ORDER BY rowid").all()).toEqual(b.database.prepare("SELECT * FROM messages ORDER BY rowid").all());
  expect(a.database.prepare("SELECT state FROM wake_nonces WHERE session_id = 'reborn'").get()).toEqual({ state: "expired-unobserved" });
  for (const sessionId of ["reborn", "split", "recent", "live"]) {
    expect(withoutCheckedAt(a.listPresence(now, [target(sessionId)])[0]!)).toEqual(withoutCheckedAt(b.listPresence(now, [target(sessionId)])[0]!));
  }
  expect(b.presence(target("split"), now).state).toBe("ended");
  // A fully purged identity differs only by reading as never registered; its autoWake state stays no-live-relay.
  expect(a.listPresence(now, [target("gone")])[0]).toMatchObject({ state: "unknown", autoWake: { state: "no-live-relay", reason: "presence-unknown" } });
  expect(b.listPresence(now, [target("gone")])[0]).toMatchObject({ state: "ended", autoWake: { state: "no-live-relay", reason: "presence-not-online" } });
});

it("gives a purged instance's rebirth a later generation, so an old-generation marker still claims nothing", () => {
  const state = directory();
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", path.join(state, "trust.sqlite3"));
  const store = open(path.join(state, "session-messages.sqlite3"));
  const target = { host: "portable", sessionId: "rebirth" };
  const t0 = Date.now() - 2 * 24 * HOUR;
  const old = born(store, "rebirth", "same", t0); relay(store, "rebirth", t0);
  store.send({ sender: { host: "portable", sessionId: "sender" }, target, messageId: "rebirth-old-body", body: "b", ttlSeconds: 86400 }, t0);
  const reserved = store.reserveManagedWake({ ...target, nonce: "rebirth-old-nonce-abcdefghijklmnopqr", instanceId: "same", transport: "portable",
    relayId: "relay-rebirth", resume: true }, t0);
  const attempt = store.startManagedWake(reserved.attempt!, t0 + 1).attempt!;
  store.recordManagedWakeOutcome(attempt, "submitted", t0 + 2);
  store.endPresence(target, "session-end", "same", t0 + 3);
  const now = Date.now();
  store.prune(now);
  expect(rows(store)).toEqual([]);
  const reborn = born(store, "rebirth", "same", now);
  store.send({ sender: { host: "portable", sessionId: "sender" }, target, messageId: "rebirth-body", body: "current", ttlSeconds: 86400 }, now);
  expect(Date.parse(reborn.startedAt!)).toBeGreaterThan(Date.parse(old.startedAt!));
  const wakeRow = store.database.prepare("SELECT birth_generation FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId) as { birth_generation: string };
  expect(wakeRow.birth_generation).toBe(old.startedAt);
  const observation = adaptHostInput({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "",
    prompt: `[agent-governance-suite:wake:${attempt.nonce}]` }, target.host).observation;
  const result = store.claimHostWake(target, observation, recordWakeHookObservation(observation, now + 1), wakeHookObservationReader, now + 2);
  expect(result).toMatchObject({ recognized: false, messages: [] });
  expect(store.pendingCount(target, now + 3)).toBe(1);
});

it("prunes presence idempotently when two processes race on one database", async () => {
  const state = directory();
  const database = path.join(state, "session-messages.sqlite3");
  const now = Date.now();
  largeFixture(database, now);
  const script = `import { SessionMessageStore } from ${JSON.stringify(new URL("../../mcp-server/src/session-message-store.ts", import.meta.url).href)};
    const store = new SessionMessageStore(${JSON.stringify(database)});
    for (let round = 0; round < 20; round += 1) { store.prune(${now} + round); store.startPresence({ host: "portable", sessionId: "racer-" + process.pid,
      instanceId: "racer", transport: "portable", wakeVisibility: "silent", canWakeSilently: true }, ${now} + round); }
    store.close();`;
  const children = [0, 1].map(() => spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }));
  const errors = children.map((child) => { let text = ""; child.stderr!.on("data", (chunk) => { text += String(chunk); }); return () => text; });
  const codes = await Promise.all(children.map(async (child) => (await once(child, "exit"))[0]));
  expect(codes, errors.map((read) => read()).join("\n")).toEqual([0, 0]);
  const store = open(database);
  const before = rows(store).filter((row) => !String((row as { session_id: string }).session_id).startsWith("racer-"));
  expect(before).toHaveLength(42);
  store.prune(now + 30);
  expect(rows(store).filter((row) => !String((row as { session_id: string }).session_id).startsWith("racer-"))).toEqual(before);
});

it("bounds list-presence: batches fit the response limit and oversized or overlong requests are refused", () => {
  const store = open(":memory:");
  const now = Date.now();
  // Worst case per identity: maximum identifier lengths and every free-text field made of characters JSON escapes to six bytes.
  const escaped = (length: number) => "\u0001".repeat(length);
  const worst = Array.from({ length: MAX_TARGETS }, (_, index) => ({ host: `h${index}`.padEnd(64, "h"), sessionId: `s${index}`.padEnd(200, "s") }));
  for (const target of worst) {
    store.startPresence({ ...target, instanceId: escaped(128), transport: escaped(64), wakeVisibility: "user-message", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: ["peer-wake", "tool-boundary", "turn-end", "user-input"], idleWake: "user-message" },
      collaborationId: escaped(200), workspaceId: escaped(500), role: escaped(100) }, now);
    store.endPresence(target, escaped(100), escaped(128), now + 1);
  }
  const data = dispatchSessionMessageBrokerOperation(store, "list-presence", { targets: worst });
  expect((data as { sessions: unknown[] }).sessions).toHaveLength(MAX_TARGETS);
  expect(Buffer.byteLength(`${JSON.stringify({ ok: true, data })}\n`)).toBeLessThanOrEqual(protocol.SESSION_MESSAGE_MAX_RESPONSE_BYTES);
  expect(() => dispatchSessionMessageBrokerOperation(store, "list-presence", { targets: [...worst, { host: "portable", sessionId: "extra" }] }))
    .toThrow(/targets must list/);
  expect(() => dispatchSessionMessageBrokerOperation(store, "list-presence", { targets: [] })).toThrow(/targets must list/);
  // The untargeted pre-2.7.4 request is refused explicitly once the stored identities no longer fit.
  for (let index = 0; index < 60; index += 1) born(store, `many-${index}`, `many-${index}`, now);
  expect(() => dispatchSessionMessageBrokerOperation(store, "list-presence", {})).toThrow(/exceeds the broker response limit/);
});

it("still lists every identity for an untargeted request that fits", () => {
  const store = open(":memory:");
  born(store, "one", "one", Date.now());
  expect(dispatchSessionMessageBrokerOperation(store, "list-presence", {})).toMatchObject({ sessions: [{ sessionId: "one", state: "online" }] });
  // A retained row outlives any wake injection plus grace that could still refer to its birth.
  expect(WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS).toBeLessThan(RETENTION);
});
