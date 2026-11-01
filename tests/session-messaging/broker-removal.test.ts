import { fork, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
import type { HostWatch } from "../../mcp-server/src/host-process-watch.js";
import { closeSessionMessaging, runSessionMessageOperation, type sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { RELAY_START_GRACE_MS, SessionMessageStore, type WakeAttempt, type WakeReservation } from "../../mcp-server/src/session-message-store.js";
import type { WakeDispatchOutcome, WakeDispatchPort } from "../../mcp-server/src/session-message-wake-port.js";

// Verification obligations CS-1..CS-6 of the broker removal (docs/ags30-broker-redesign.md 3.1-3.4, 5, 7).
// Time is injected (store clock) and contention is forced with a second connection; nothing waits on a wall clock.
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const SECOND = 1000;
const transport = "portable";
const target = { host: "portable", sessionId: "broker-removal-recipient" };
const sender = { host: "portable", sessionId: "broker-removal-sender" };
const capabilities = { supportedInjection: ["peer-wake" as const], idleWake: "silent" as const };
const HOST_PID = 4242;
const HOST_START = "broker-removal-host-start";
const iso = (at: number) => new Date(at).toISOString();
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
const connections: DatabaseSync[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const connection of connections.splice(0)) { if (connection.isOpen) { if (connection.isTransaction) connection.exec("ROLLBACK"); connection.close(); } }
  for (const store of stores.splice(0)) { if (store.database.isOpen) store.close(); }
  for (const directory of directories.splice(0)) { closeSessionMessaging(directory); rmSync(directory, { recursive: true, force: true }); }
});

function directory(): string {
  const value = mkdtempSync(path.join(tmpdir(), "ags-broker-removal-"));
  directories.push(value);
  return value;
}

function open(file: string, clock: () => number): SessionMessageStore {
  const store = new SessionMessageStore(file, { clock });
  stores.push(store);
  return store;
}

function connection(file: string): DatabaseSync {
  const value = new DatabaseSync(file);
  value.exec("PRAGMA busy_timeout = 0;");
  connections.push(value);
  return value;
}

/** One online birth with a reported host, a fresh grant and its first host-binding tick, all at the store's authority time. */
function servedBirth(store: SessionMessageStore, instanceId = "birth-1", codeDigest: string | null = null) {
  store.startPresence({ ...target, instanceId, transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities, hostPid: HOST_PID });
  const grant = store.grantRelay({ ...target, transport, instanceId, codeDigest, hostPid: HOST_PID });
  expect(grant.relayId).toEqual(expect.any(String));
  expect(store.relayTick({ ...target, transport, instanceId, relayId: grant.relayId!, includePending: false, hostStart: HOST_START }))
    .toEqual({ alive: true, count: 0, hostBound: true });
  return { instanceId, relayId: grant.relayId! };
}

const digestA = "sha256:" + "a".repeat(64);
const digestB = "sha256:" + "b".repeat(64);
const tick = (store: SessionMessageStore, instanceId: string, relayId: string) =>
  store.relayTick({ ...target, transport, instanceId, relayId, includePending: true, hostStart: HOST_START });
const reserve = (store: SessionMessageStore, instanceId: string, relayId: string, nonce: string) =>
  dispatchSessionMessageOperation(store, "reserve-wake", { target, nonce, instanceId, transport, relayId, resume: true }) as WakeReservation;
const start = (store: SessionMessageStore, attempt: WakeAttempt) =>
  dispatchSessionMessageOperation(store, "start-wake", { attempt, resendBaseMs: 600_000 }) as WakeReservation;

describe("CS-1 fencing: a later grant retires the previous relay", () => {
  it("a different code digest after the start grace replaces A; A can neither renew, reserve nor start, B renews and serves", () => {
    const clock = { now: T0 };
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => clock.now);
    const a = servedBirth(store, "birth-1", digestA);
    store.send({ sender, target, messageId: "cs1-body-1", body: "fencing body" });
    // A renews every 5 s; B's grant is refused while A is live with the same code or inside the start grace.
    for (const at of [5, 10, 15, 20]) { clock.now = T0 + at * SECOND; expect(tick(store, a.instanceId, a.relayId)).toMatchObject({ alive: true, count: 1, hostBound: true }); }
    expect(store.grantRelay({ ...target, transport, instanceId: a.instanceId, codeDigest: digestB, hostPid: HOST_PID })).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
    for (const at of [25, 30]) { clock.now = T0 + at * SECOND; expect(tick(store, a.instanceId, a.relayId).alive).toBe(true); }
    const reservedByA = reserve(store, a.instanceId, a.relayId, "cs1-nonce-reserved-by-a-0001");
    expect(reservedByA.dispatch).toBe(true);
    clock.now = T0 + RELAY_START_GRACE_MS + SECOND;
    expect(store.grantRelay({ ...target, transport, instanceId: a.instanceId, codeDigest: digestA, hostPid: HOST_PID })).toEqual({ relayId: null, reason: "RELAY_ALIVE" });
    const b = store.grantRelay({ ...target, transport, instanceId: a.instanceId, codeDigest: digestB, hostPid: HOST_PID });
    expect(b.relayId).toEqual(expect.any(String));
    expect(b.relayId).not.toBe(a.relayId);
    // A is fenced on every path.
    expect(tick(store, a.instanceId, a.relayId)).toEqual({ alive: false, count: 0, hostBound: false });
    expect(reserve(store, a.instanceId, a.relayId, "cs1-nonce-new-from-a-000001")).toEqual({ dispatch: false, attempt: null });
    expect(start(store, reservedByA.attempt!)).toEqual({ dispatch: false, attempt: null });
    expect(store.database.prepare("SELECT state, dispatch_epoch FROM wake_nonces WHERE attempt_id = ?").get(reservedByA.attempt!.attemptId))
      .toMatchObject({ state: "reserved", dispatch_epoch: 0 });
    // B binds the same host birth, renews, takes over the unstarted reservation and starts it exactly once.
    const bTick = tick(store, a.instanceId, b.relayId!);
    expect(bTick).toEqual({ alive: true, count: 1, hostBound: true });
    const leaseAfterFirst = store.database.prepare("SELECT relay_id, lease_until FROM relay_leases").get() as { relay_id: string; lease_until: string };
    clock.now += 5 * SECOND;
    expect(tick(store, a.instanceId, b.relayId!).alive).toBe(true);
    const leaseAfterSecond = store.database.prepare("SELECT relay_id, lease_until FROM relay_leases").get() as { relay_id: string; lease_until: string };
    expect([leaseAfterFirst.relay_id, leaseAfterSecond.relay_id]).toEqual([b.relayId, b.relayId]);
    expect(Date.parse(leaseAfterSecond.lease_until)).toBe(Date.parse(leaseAfterFirst.lease_until) + 5 * SECOND);
    const resumed = reserve(store, a.instanceId, b.relayId!, "cs1-nonce-new-from-b-000001");
    expect(resumed).toMatchObject({ dispatch: true, attempt: { attemptId: reservedByA.attempt!.attemptId, relayId: b.relayId } });
    expect(start(store, resumed.attempt!).dispatch).toBe(true);
    expect(start(store, reservedByA.attempt!).dispatch).toBe(false);
    expect(store.liveRelay(target, transport)).toMatchObject({ relayId: b.relayId, instanceId: a.instanceId, codeDigest: digestB });
  });

  it("after A's lease expiry a same-code grant replaces A; A's late tick is fenced", () => {
    const clock = { now: T0 };
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => clock.now);
    const a = servedBirth(store, "birth-1", digestA);
    clock.now = T0 + 16 * SECOND; // A last renewed at T0; RELAY_LEASE_MS is 15 s. The birth (20 s) is still online.
    expect(store.presence(target).state).toBe("online");
    const b = store.grantRelay({ ...target, transport, instanceId: a.instanceId, codeDigest: digestA, hostPid: HOST_PID });
    expect(b.relayId).toEqual(expect.any(String));
    expect(tick(store, a.instanceId, a.relayId).alive).toBe(false);
    expect(tick(store, a.instanceId, b.relayId!).alive).toBe(true);
  });

  it("an expired lease is dead without any newer grant: the late tick neither renews nor revives it", () => {
    const clock = { now: T0 };
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => clock.now);
    const a = servedBirth(store, "birth-1", digestA);
    clock.now = T0 + 16 * SECOND; // past RELAY_LEASE_MS (15 s) since the last renewal; the birth itself is still online.
    expect(store.presence(target).state).toBe("online");
    expect(tick(store, a.instanceId, a.relayId)).toEqual({ alive: false, count: 0, hostBound: false });
    expect(store.database.prepare("SELECT relay_id, lease_until FROM relay_leases").all().filter(row => Date.parse(String(row.lease_until)) > clock.now)).toEqual([]);
  });

  it("a lease whose birth reported no host process binds no host birth on its tick", () => {
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => T0);
    store.startPresence({ ...target, instanceId: "birth-unhosted", transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities });
    const grant = store.grantRelay({ ...target, transport, instanceId: "birth-unhosted", codeDigest: null });
    expect(grant.relayId).toEqual(expect.any(String));
    expect(tick(store, "birth-unhosted", grant.relayId!)).toEqual({ alive: true, count: 0, hostBound: false });
    expect(store.database.prepare("SELECT host_pid, host_start FROM session_presence WHERE instance_id = ?").get("birth-unhosted"))
      .toEqual({ host_pid: null, host_start: null });
  });
});

describe("CS-2 single dispatch: the start CAS admits one dispatch per attempt across connections", () => {
  it("two store connections on one file: exactly one start-wake dispatches", () => {
    const file = path.join(directory(), "session-messages.sqlite3");
    const clock = { now: T0 };
    const first = open(file, () => clock.now);
    const second = open(file, () => clock.now);
    const birth = servedBirth(first);
    first.send({ sender, target, messageId: "cs2-body-1", body: "single dispatch body" });
    const reserved = reserve(second, birth.instanceId, birth.relayId, "cs2-nonce-two-connections-01");
    expect(reserved.dispatch).toBe(true);
    // Both connections hold the same reserved attempt; each tries to start it.
    const results = [start(first, reserved.attempt!), start(second, reserved.attempt!), start(first, reserved.attempt!)];
    expect(results.map(result => result.dispatch)).toEqual([true, false, false]);
    expect(first.database.prepare("SELECT state, dispatch_epoch FROM wake_nonces").all().map(row => ({ ...row })))
      .toEqual([{ state: "started", dispatch_epoch: 1 }]);
  });

  it("N child processes race start-wake for one attempt: exactly one dispatch across all results", async () => {
    const state = directory();
    const file = path.join(state, "session-messages.sqlite3");
    const store = open(file, () => T0);
    const birth = servedBirth(store);
    store.send({ sender, target, messageId: "cs2-body-processes", body: "single dispatch across processes" });
    const reserved = reserve(store, birth.instanceId, birth.relayId, "cs2-nonce-child-processes-01");
    expect(reserved.dispatch).toBe(true);
    store.close();
    const script = path.join(state, "start-wake-child.mjs");
    const client = new URL("../../mcp-server/src/session-message-client.ts", import.meta.url).href;
    const diagnostics = new URL("../../mcp-server/src/failure-diagnostics.ts", import.meta.url).href;
    writeFileSync(script, [
      `const { runSessionMessageOperation } = await import(${JSON.stringify(client)});`,
      `const { producerFailureReason } = await import(${JSON.stringify(diagnostics)});`,
      "const [stateDirectory, now] = process.argv.slice(2);",
      "const options = { clock: () => Number(now) };",
      "runSessionMessageOperation('wake-status', { target: { host: 'portable', sessionId: 'broker-removal-recipient' } }, stateDirectory, options);",
      "process.send({ phase: 'ready' });",
      "process.once('message', ({ attempt }) => {",
      "  let result;",
      "  try { result = { reservation: runSessionMessageOperation('start-wake', { attempt, resendBaseMs: 600000 }, stateDirectory, options) }; }",
      "  catch (error) { result = { reason: producerFailureReason(error) ?? String(error?.message) }; }",
      "  process.send({ phase: 'result', result }, () => process.disconnect());",
      "});",
    ].join("\n"), "utf8");
    const children = Array.from({ length: 4 }, () => fork(script, [state, String(T0)], { execArgv: ["--import", "tsx"], silent: true }));
    const exits = children.map(child => once(child, "exit"));
    const stderr = children.map(() => "");
    children.forEach((child, index) => child.stderr!.on("data", (chunk: Buffer) => { stderr[index] += chunk.toString("utf8"); }));
    try {
      const ready = await Promise.all(children.map(child => once(child, "message") as Promise<[{ phase: string }]>));
      expect(ready.map(([message]) => message.phase), stderr.join("\n")).toEqual(["ready", "ready", "ready", "ready"]);
      const results = children.map(child => once(child, "message") as Promise<[{ phase: string; result: { reservation?: WakeReservation; reason?: string } }]>);
      for (const child of children) child.send({ attempt: reserved.attempt });
      const outcomes = (await Promise.all(results)).map(([message]) => message.result);
      // Outcome-set oracle: one dispatch; every other child either lost the CAS or found the writer lock busy (nothing written).
      expect(outcomes.filter(outcome => outcome.reservation?.dispatch === true), stderr.join("\n")).toHaveLength(1);
      for (const outcome of outcomes) {
        if (outcome.reservation?.dispatch === true) continue;
        expect([JSON.stringify(outcome.reservation ?? null), outcome.reason ?? null]).toSatisfy(([reservation, reason]) =>
          reservation === JSON.stringify({ dispatch: false, attempt: null }) || reason === "MESSAGING_BUSY");
      }
      // Read only after every child closed its connection (a closing WAL connection checkpoints under a brief lock).
      await Promise.all(exits);
      const check = connection(file);
      expect(check.prepare("SELECT state, dispatch_epoch FROM wake_nonces").all().map(row => ({ ...row }))).toEqual([{ state: "started", dispatch_epoch: 1 }]);
    } finally {
      await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? undefined
        : (child.kill(), once(child, "exit"))));
    }
  });
});

describe("CS-3 authority time is sampled after the writer lock", () => {
  it("every clock read happens inside a transaction, once per outermost transaction", () => {
    const samples: Array<{ inTransaction: boolean; transaction: number }> = [];
    let begins = 0;
    let now = T0;
    // A new file is initialized inside the constructor (before its connection is known here); those samples are discarded below.
    const opened: { database?: DatabaseSync } = {};
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => {
      samples.push({ inTransaction: opened.database?.isTransaction ?? true, transaction: begins });
      return now;
    });
    opened.database = store.database;
    const execute = store.database.exec.bind(store.database);
    vi.spyOn(store.database, "exec").mockImplementation(sql => { if (sql === "BEGIN IMMEDIATE") begins++; return execute(sql); });
    samples.length = 0;
    const birth = servedBirth(store);
    now += SECOND; store.send({ sender, target, messageId: "cs3-body-0001", body: "lock clock body" });
    now += SECOND; expect(tick(store, birth.instanceId, birth.relayId).count).toBe(1);
    now += SECOND; dispatchSessionMessageOperation(store, "pending", { target });
    now += SECOND; expect(store.claim(target)).toHaveLength(1);
    now += SECOND; store.presence(target);
    expect(begins).toBe(8);
    expect(samples).toEqual(Array.from({ length: begins }, (_, index) => ({ inTransaction: true, transaction: index + 1 })));
  });

  it("a multi-step operation (presence-start with its grant, peer-wait with its snapshot) is one writer transaction with one clock read", () => {
    let now = T0;
    let reads = 0;
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => { reads++; return now; });
    let begins = 0;
    const execute = store.database.exec.bind(store.database);
    vi.spyOn(store.database, "exec").mockImplementation(sql => { if (sql === "BEGIN IMMEDIATE") begins++; return execute(sql); });
    reads = 0;
    const started = dispatchSessionMessageOperation(store, "presence-start", { target, instanceId: "cs3-birth", transport,
      wakeVisibility: "silent", canWakeSilently: true, supportedInjection: ["peer-wake"], idleWake: "silent", hostPid: HOST_PID }) as { relayId: unknown };
    expect(started.relayId).toEqual(expect.any(String));
    expect([begins, reads]).toEqual([1, 1]);
    now += SECOND;
    dispatchSessionMessageOperation(store, "peer-wait", { sender, targets: [target], timeoutMs: 60_000 });
    expect([begins, reads]).toEqual([2, 2]);
  });

  it("a clock that goes backwards never lowers the authority time, also for a later store instance", () => {
    const file = path.join(directory(), "session-messages.sqlite3");
    const clock = { now: T0 + 10 * SECOND };
    const first = open(file, () => clock.now);
    const prepare = (store: SessionMessageStore) => store.prepare({ sender, target, body: "high-water body" }).preparedAt;
    expect(prepare(first)).toBe(iso(T0 + 10 * SECOND));
    clock.now = T0 + 5 * SECOND;
    expect(prepare(first)).toBe(iso(T0 + 10 * SECOND));
    first.close();
    const later = open(file, () => T0 + SECOND);
    expect(prepare(later)).toBe(iso(T0 + 10 * SECOND));
    expect(later.database.prepare("SELECT last_ms FROM authority_time").get()).toMatchObject({ last_ms: T0 + 10 * SECOND });
    const forward = open(file, () => T0 + 20 * SECOND);
    expect(prepare(forward)).toBe(iso(T0 + 20 * SECOND));
  });
});

describe("CS-4 contention: a held writer lock is reported, never waited out or half-written", () => {
  it("busyTimeoutMs 0 against BEGIN IMMEDIATE on another connection throws MESSAGING_BUSY and writes nothing; after COMMIT it succeeds", () => {
    const state = directory();
    runSessionMessageOperation("pending", { target }, state);
    const holder = connection(path.join(state, "session-messages.sqlite3"));
    const counts = () => holder.prepare(`SELECT (SELECT count(*) FROM prepared_messages) AS prepared, (SELECT last_ms FROM authority_time) AS time`).get();
    const before = counts();
    holder.exec("BEGIN IMMEDIATE");
    let failure: unknown;
    try { runSessionMessageOperation("prepare", { sender, target, body: "contended body" }, state, { busyTimeoutMs: 0 }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(producerFailureReason(failure)).toBe("MESSAGING_BUSY");
    expect(counts()).toEqual(before);
    holder.exec("COMMIT");
    const prepared = runSessionMessageOperation<{ messageId: string }>("prepare", { sender, target, body: "contended body" }, state, { busyTimeoutMs: 0 });
    expect(prepared.messageId).toEqual(expect.any(String));
    expect(holder.prepare("SELECT message_id FROM prepared_messages").all().map(row => ({ ...row }))).toEqual([{ message_id: prepared.messageId }]);
  });
});

// The previous standalone layout (user_version 3): PID-bound leases, parent-identity presence columns, no authority_time.
const V3_RELAY_LEASES = `CREATE TABLE relay_leases (host TEXT NOT NULL, session_id TEXT NOT NULL, transport TEXT NOT NULL, relay_id TEXT NOT NULL,
  pid INTEGER NOT NULL, parent_pid INTEGER NOT NULL, relay_start_token TEXT, relay_code_digest TEXT, relay_code_id TEXT,
  lease_until TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (host, session_id, transport)) STRICT;`;

function v3File(): string {
  const file = path.join(directory(), "session-messages.sqlite3");
  const store = open(file, () => T0);
  store.startPresence({ ...target, instanceId: "old-birth", transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities });
  store.send({ sender, target, messageId: "cs5-body-kept", body: "body kept across the migration" });
  store.close();
  const db = new DatabaseSync(file);
  try {
    db.exec(`DROP TABLE peer_wait_snapshots; DROP TABLE authority_time; DROP TABLE relay_leases; ${V3_RELAY_LEASES}
      ALTER TABLE session_presence DROP COLUMN host_pid; ALTER TABLE session_presence DROP COLUMN host_start;
      ALTER TABLE session_presence ADD COLUMN verified_parent_pid INTEGER; ALTER TABLE session_presence ADD COLUMN verified_parent_token TEXT;
      ALTER TABLE session_presence ADD COLUMN reported_parent_pid INTEGER; ALTER TABLE session_presence ADD COLUMN reported_parent_token TEXT;
      UPDATE session_presence SET verified_parent_pid = 77, verified_parent_token = 'old-token', reported_parent_pid = 77, reported_parent_token = 'old-token';
      PRAGMA user_version = 3;`);
    db.prepare(`INSERT INTO relay_leases (host, session_id, transport, relay_id, pid, parent_pid, relay_start_token, lease_until, updated_at)
      VALUES (?, ?, ?, 'old-relay', 88, 77, 'old-start-token', ?, ?)`).run(target.host, target.sessionId, transport, iso(T0 + 3_600_000), iso(T0));
  } finally { db.close(); }
  return file;
}

function schema(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const columns = (table: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name);
    return {
      version: (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
      sql: db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all().map(row => ({ ...row })),
      leaseColumns: columns("relay_leases"),
      presenceColumns: columns("session_presence"),
      rows: ["messages", "session_presence", "relay_leases"].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))),
    };
  } finally { db.close(); }
}

describe("CS-5 migration v3 -> v4", () => {
  it("a v3 file opens as v4: PID columns gone, leases empty, bodies and births kept", () => {
    const file = v3File();
    expect(schema(file).version).toBe(3);
    open(file, () => T0 + SECOND).close();
    const after = schema(file);
    expect(after.version).toBe(4);
    expect(after.leaseColumns).toEqual(["host", "session_id", "transport", "instance_id", "relay_id", "code_digest", "granted_at", "lease_until", "updated_at"]);
    for (const gone of ["verified_parent_pid", "verified_parent_token", "reported_parent_pid", "reported_parent_token"]) expect(after.presenceColumns).not.toContain(gone);
    expect(after.presenceColumns).toEqual(expect.arrayContaining(["host_pid", "host_start"]));
    expect(after.sql.map(row => row.name)).toEqual(expect.arrayContaining(["authority_time", "peer_wait_snapshots"]));
    const [messages, presence, leases] = after.rows;
    expect(messages!.map(row => row.message_id)).toEqual(["cs5-body-kept"]);
    expect(presence!.map(row => [row.instance_id, row.host_pid, row.host_start])).toEqual([["old-birth", null, null]]);
    expect(leases).toEqual([]);
  });

  it("opening a current file takes no write lock and changes nothing", () => {
    const file = v3File();
    open(file, () => T0 + SECOND).close();
    const before = schema(file);
    const holder = connection(file);
    holder.exec("BEGIN IMMEDIATE");
    const reopened = open(file, () => T0 + 2 * SECOND);
    reopened.close();
    holder.exec("ROLLBACK");
    expect(schema(file)).toEqual(before);
  });

  it("a newer user_version is refused, also when it appears between the unlocked read and the migration lock", () => {
    const newer = v3File();
    const db = new DatabaseSync(newer); db.exec("PRAGMA user_version = 5;"); db.close();
    const before = schema(newer);
    expect(() => new SessionMessageStore(newer)).toThrow(/newer/);
    expect(schema(newer)).toEqual(before);

    // D0059: the version is read again under BEGIN IMMEDIATE. Another runtime upgrades the file just before this one locks it.
    const raced = v3File();
    const execute = DatabaseSync.prototype.exec;
    let upgraded = false;
    vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (sql === "BEGIN IMMEDIATE" && !upgraded) {
        upgraded = true;
        const other = new DatabaseSync(raced);
        try { execute.call(other, "PRAGMA user_version = 5;"); } finally { other.close(); }
      }
      return execute.call(this, sql);
    });
    expect(() => new SessionMessageStore(raced)).toThrow(/newer/);
    vi.restoreAllMocks();
    expect(upgraded).toBe(true);
    expect(schema(raced).version).toBe(5);
    expect(schema(raced).leaseColumns).toContain("pid");
  });
});

describe("CS-6 lease renewal runs beside a pending dispatch", () => {
  it("relay-tick continues while the port's dispatch has not resolved", async () => {
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => T0);
    store.startPresence({ ...target, instanceId: "birth-1", transport, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities, hostPid: HOST_PID });
    const relayId = store.grantRelay({ ...target, transport, instanceId: "birth-1", codeDigest: null, hostPid: HOST_PID }).relayId!;
    store.send({ sender, target, messageId: "cs6-body-0001", body: "renewal beside dispatch" });
    const operations: string[] = [];
    const request = (async (operation: string, payload: Record<string, unknown>) => {
      operations.push(operation);
      return dispatchSessionMessageOperation(store, operation, payload);
    }) as typeof sessionMessageRequest;
    const delays: Array<() => void> = [];
    const delay = (_milliseconds: number, stop: Promise<void>) => Promise.race([new Promise<void>(resolve => { delays.push(resolve); }), stop]);
    const step = () => { expect(delays.length).toBeLessThanOrEqual(1); delays.shift()?.(); };
    let exit!: (reason: string) => void;
    const watch = (): HostWatch => ({ bound: Promise.resolve(HOST_START), exited: new Promise<string>(resolve => { exit = resolve; }), close: () => {} });
    let release!: (outcome: WakeDispatchOutcome) => void;
    const dispatch = vi.fn(() => new Promise<WakeDispatchOutcome>(resolve => { release = resolve; }));
    const port: WakeDispatchPort = { capabilities, resendBaseMs: 600_000, dispatch };
    const settle = () => new Promise<void>(resolve => setImmediate(resolve));
    const ticks = () => operations.filter(operation => operation === "relay-tick").length;
    const relay = runSessionMessageRelay({ ...target, instanceId: "birth-1", transport, parentPid: HOST_PID, relayId }, port, { request, watch, delay });
    try {
      await settle();
      expect(ticks()).toBe(1); // before the watcher bound the host: no dispatch yet
      step(); await settle();
      expect(ticks()).toBe(2);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(operations).toEqual(["relay-tick", "relay-tick", "reserve-wake", "start-wake"]);
      step(); await settle();
      step(); await settle();
      expect(ticks()).toBe(4);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(store.database.prepare("SELECT state FROM wake_nonces").get()).toMatchObject({ state: "started" });
    } finally {
      release?.({ result: "handed-off" });
      await settle();
      exit?.("HOST_PROCESS_ENDED");
      await relay;
    }
    expect(operations.slice(-2)).toEqual(["record-wake-outcome", "release-relay"]);
    expect(store.database.prepare("SELECT state FROM wake_nonces").get()).toMatchObject({ state: "handed-off" });
    expect(store.liveRelay(target, transport)).toBeNull();
    expect(store.presence(target)).toMatchObject({ state: "ended", endReason: "host-process-ended" });
  });
});

describe("a relay whose host PID names no process (synthetic hosts, R5)", () => {
  it("ends at the real watcher's first look, releases its lease and ends the birth", async () => {
    vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", directory());
    // A PID that certainly names no process: a child that has already exited and been reaped.
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await once(child, "exit");
    const gone = child.pid!;
    const store = open(path.join(directory(), "session-messages.sqlite3"), () => T0);
    store.startPresence({ ...target, instanceId: "birth-gone", transport, wakeVisibility: "none", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: [], idleWake: "none" }, hostPid: gone });
    const relayId = store.grantRelay({ ...target, transport, instanceId: "birth-gone", codeDigest: null, hostPid: gone }).relayId!;
    const operations: string[] = [];
    const request = (async (operation: string, payload: Record<string, unknown>) => {
      operations.push(operation);
      return dispatchSessionMessageOperation(store, operation, payload);
    }) as typeof sessionMessageRequest;
    const port: WakeDispatchPort = { capabilities: { supportedInjection: [], idleWake: "none" }, resendBaseMs: 600_000, dispatch: vi.fn() };
    // The production watcher and loop wait: the relay ends when the watcher reports the host gone, not on a timer.
    await runSessionMessageRelay({ ...target, instanceId: "birth-gone", transport, parentPid: gone, relayId }, port, { request });
    expect(operations.at(-1)).toBe("release-relay");
    expect(store.liveRelay(target, transport)).toBeNull();
    expect(store.presence(target)).toMatchObject({ state: "ended", endReason: "host-process-ended" });
  }, 30_000);
});

// Claude Code ends an async SessionStart hook by sending SIGTERM to the hook's process group, which holds the relay
// (measured on Claude Code 2.1.314, Linux). The relay must release its lease and end its birth before it exits.
describe.skipIf(process.platform === "win32")("a relay stopped with SIGTERM while its host still runs (R5)", () => {
  it("releases its lease and ends its birth, then exits with code 0", async () => {
    const state = directory();
    const file = path.join(state, "session-messages.sqlite3");
    const host = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    try {
      const store = open(file, Date.now);
      store.startPresence({ ...target, instanceId: "birth-term", transport, wakeVisibility: "none", canWakeSilently: false,
        deliveryCapabilities: { supportedInjection: [], idleWake: "none" }, hostPid: host.pid! });
      const relayId = store.grantRelay({ ...target, transport, instanceId: "birth-term", codeDigest: null, hostPid: host.pid! }).relayId!;
      store.close();
      const script = path.join(state, "relay-child.mjs");
      const relay = new URL("../../mcp-server/src/session-message-relay.ts", import.meta.url).href;
      const client = new URL("../../mcp-server/src/session-message-client.ts", import.meta.url).href;
      writeFileSync(script, [
        `const { runSessionMessageRelay } = await import(${JSON.stringify(relay)});`,
        `const { sessionMessageRequest } = await import(${JSON.stringify(client)});`,
        "const [hostPid, relayId] = process.argv.slice(2);",
        "let ticked = false;",
        "const request = async (operation, payload) => {",
        "  const result = await sessionMessageRequest(operation, payload);",
        "  if (operation === 'relay-tick' && !ticked) { ticked = true; process.send({ alive: result.alive }); }",
        "  return result;",
        "};",
        "const port = { capabilities: { supportedInjection: [], idleWake: 'none' }, resendBaseMs: 600000, dispatch: async () => ({ result: 'unknown' }) };",
        `await runSessionMessageRelay({ ...${JSON.stringify(target)}, instanceId: 'birth-term', transport: ${JSON.stringify(transport)},`,
        "  parentPid: Number(hostPid), relayId }, port, { request });",
        "process.disconnect();",
      ].join("\n"), "utf8");
      const child = fork(script, [String(host.pid), relayId], { execArgv: ["--import", "tsx"], silent: true,
        env: { ...process.env, AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR: state } });
      let stderr = "";
      child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      const exited = once(child, "exit");
      const [first] = await once(child, "message") as [{ alive: boolean }];
      expect(first, stderr).toEqual({ alive: true });
      child.kill("SIGTERM");
      expect(await exited, stderr).toEqual([0, null]);
      const after = open(file, Date.now);
      expect(after.liveRelay(target, transport)).toBeNull();
      expect(after.presence(target)).toMatchObject({ state: "ended", endReason: "relay-stop-requested" });
    } finally {
      host.kill();
    }
  }, 30_000);
});

// SessionEnd ends the birth it belongs to (R5 on Windows: the async hook tree is terminated with no signal, so the relay
// never releases; R10: `/clear` keeps the host process, so the old session's relay keeps serving it). The hook runs in
// this process: its host is process.ppid and its start bound is this process's own start.
describe("the host's SessionEnd ends exactly its own birth (R5 Windows, R10 /clear)", () => {
  const EARLIER = process.platform === "linux" ? "1" : "2000-01-01T00:00:00.000Z";
  const LATER = process.platform === "linux" ? "99999999999999" : "2999-01-01T00:00:00.000Z";
  const none = { supportedInjection: [], idleWake: "none" as const };
  const hookStart = Math.floor(performance.timeOrigin);
  function setup() {
    const state = directory();
    vi.stubEnv("AGENT_GOVERNANCE_SESSION_MESSAGE_STATE_DIR", state);
    return open(path.join(state, "session-messages.sqlite3"), Date.now);
  }
  /** A served birth of `sessionId`: started at `startedAt`, granted and (when `hostStart` is given) bound by its relay's tick. */
  function birth(store: SessionMessageStore, sessionId: string, instanceId: string, options: { hostPid?: number; hostStart?: string | null; startedAt?: number } = {}) {
    const session = { host: "claude-code", sessionId };
    store.startPresence({ ...session, instanceId, transport, wakeVisibility: "none", canWakeSilently: false, deliveryCapabilities: none,
      hostPid: options.hostPid ?? process.ppid }, options.startedAt ?? hookStart - SECOND);
    const relayId = store.grantRelay({ ...session, transport, instanceId, codeDigest: null, hostPid: options.hostPid ?? process.ppid }).relayId!;
    const hostStart = options.hostStart === undefined ? EARLIER : options.hostStart;
    expect(store.relayTick({ ...session, transport, instanceId, relayId, includePending: false, ...(hostStart === null ? {} : { hostStart }) }))
      .toMatchObject({ alive: true });
    return { session, relayId };
  }
  const sessionEnd = (sessionId: string, reason: string) =>
    handleSessionMessageHook({ hook_event_name: "SessionEnd", session_id: sessionId, reason }, "claude-code");

  it("a relay that vanished without a release (Windows tree termination): SessionEnd ends the birth and drops its lease", async () => {
    const store = setup();
    const { session } = birth(store, "session-end-killed", "birth-killed");
    await expect(sessionEnd(session.sessionId, "prompt_input_exit")).resolves.toEqual({});
    expect(store.presence(session)).toMatchObject({ state: "ended", endReason: "host-session-ended" });
    expect(store.liveRelay(session, transport)).toBeNull();
    expect(store.database.prepare("SELECT count(*) AS count FROM relay_leases").get()).toEqual({ count: 0 });
  });

  it("/clear in the same host process: the old session ends and its still-running relay ends normally on its next tick", async () => {
    const store = setup();
    const { session, relayId } = birth(store, "session-end-cleared", "birth-cleared");
    const failures = vi.spyOn(console, "error");
    const operations: string[] = [];
    const request = (async (operation: string, payload: Record<string, unknown>) => {
      operations.push(operation);
      return dispatchSessionMessageOperation(store, operation, payload);
    }) as typeof sessionMessageRequest;
    const delays: Array<() => void> = [];
    const delay = (_milliseconds: number, stop: Promise<void>) => Promise.race([new Promise<void>(resolve => { delays.push(resolve); }), stop]);
    let exit!: (reason: string) => void;
    const watch = (): HostWatch => ({ bound: Promise.resolve(EARLIER), exited: new Promise<string>(resolve => { exit = resolve; }), close: () => {} });
    const port: WakeDispatchPort = { capabilities: none, resendBaseMs: 600_000, dispatch: vi.fn() };
    const relay = runSessionMessageRelay({ ...session, instanceId: "birth-cleared", transport, parentPid: process.ppid, relayId }, port, { request, watch, delay });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(operations).toEqual(["relay-tick"]);
      await expect(sessionEnd(session.sessionId, "clear")).resolves.toEqual({});
      expect(store.presence(session)).toMatchObject({ state: "ended", endReason: "host-session-ended" });
      delays.shift()?.();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(operations).toEqual(["relay-tick", "relay-tick", "release-relay"]);
    } finally {
      exit?.("HOST_PROCESS_ENDED");
      await relay;
    }
    // The first end stays; the relay records no failure for a birth its host ended.
    expect(store.presence(session)).toMatchObject({ state: "ended", endReason: "host-session-ended" });
    expect(failures.mock.calls.flat().join(" ")).not.toContain("relay-failure");
  });

  it("a late SessionEnd ends no birth that is not this hook's host's: another process, a later birth, a later generation, an unbound birth", async () => {
    const store = setup();
    const cases = [
      birth(store, "late-other-process", "birth-other", { hostPid: process.ppid + 1 }), // resumed in another process
      birth(store, "late-reused-pid", "birth-reused", { hostStart: LATER }), // the PID now names a process born after the hook
      birth(store, "late-newer-generation", "birth-newer", { startedAt: hookStart + 60 * SECOND }), // started after the hook
      birth(store, "late-unbound", "birth-unbound", { hostStart: null }), // the relay never bound the host birth
    ];
    for (const { session } of cases) {
      await expect(sessionEnd(session.sessionId, "other")).resolves.toEqual({});
      expect(store.presence(session), session.sessionId).toMatchObject({ state: "online", endedAt: null });
      expect(store.liveRelay(session, transport), session.sessionId).not.toBeNull();
    }
  });

  it("after the relay's own release, SessionEnd changes nothing", async () => {
    const store = setup();
    const { session, relayId } = birth(store, "session-end-released", "birth-released");
    expect(store.releaseRelay({ ...session, transport, relayId, instanceId: "birth-released", reason: "relay-stop-requested" })).toBe(true);
    await expect(sessionEnd(session.sessionId, "other")).resolves.toEqual({});
    expect(store.presence(session)).toMatchObject({ state: "ended", endReason: "relay-stop-requested" });
  });
});
