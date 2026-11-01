import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { PRESENCE_RETENTION_MS, SessionMessageStore, type SessionIdentity } from "../../mcp-server/src/session-message-store.js";

// CONC-FENCE-002 / DIST-ORDER-004: real SQLite and the verified generation fence of ensure-relay. Time is the injected
// store clock or an explicit fixture time. No OS identity query exists any more: the adapter-observed birth is the input.
const target = { host: "portable", sessionId: "pruned-generation-fence" };
const transport = "portable-queue";
const now = Date.UTC(2026, 9, 30);
const code = "sha256:" + "a".repeat(64);
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const birth = (pid: number, token: string, recipient = target) => "host-process-v1:" + createHash("sha256")
  .update(JSON.stringify([recipient.host, recipient.sessionId, pid, token])).digest("hex");
const tables = ["messages", "prepared_messages", "input_observations", "wake_paths", "wake_nonces", "session_presence", "relay_leases"];
type Grant = { spawn: boolean; relayId: string | null; instanceId: string; reason?: string };

afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function databaseFile() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-pruned-generation-"));
  directories.push(directory);
  return path.join(directory, "messages.sqlite3");
}

function fixture(filename = ":memory:") {
  const clock = { value: now };
  const store = new SessionMessageStore(filename, { clock: () => clock.value });
  stores.push(store);
  const tokens = new Map<number, string>([[100, "parent-A"], [101, "parent-B"], [102, "parent-C"], [103, "parent-D"]]);
  const payload = (pid: number, expected?: string | null, recipient: SessionIdentity = target) => ({
    target: recipient, transport, parentPid: pid, parentStartToken: tokens.get(pid)!, codeDigest: code,
    ...(expected === undefined ? {} : { expectedPresenceInstanceId: expected }), wakeVisibility: "user-message", idleWake: "user-message",
    canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary", "turn-end"],
  });
  const ensure = (pid: number, expected?: string | null, on: SessionMessageStore = store) =>
    dispatchSessionMessageOperation(on, "ensure-relay", payload(pid, expected)) as Grant;
  /** A verified birth registered against the current presence and served by its relay (first tick binds the birth). */
  const start = (pid: number) => {
    const grant = ensure(pid, store.presence(target).instanceId);
    expect(grant).toMatchObject({ spawn: true, instanceId: birth(pid, tokens.get(pid)!) });
    expect(store.relayTick({ ...target, transport, relayId: grant.relayId!, instanceId: grant.instanceId, includePending: false,
      hostStart: tokens.get(pid)! })).toMatchObject({ alive: true, hostBound: true });
    return grant;
  };
  const snapshot = () => Object.fromEntries(tables.map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const row = (instanceId: string) => store.database.prepare("SELECT * FROM session_presence WHERE instance_id=?").get(instanceId);
  return { store, clock, tokens, ensure, start, snapshot, row };
}

describe("D0354 verified generation fence across retention", () => {
  it("refuses a superseded A while its row is retained and keeps B's 7 tables, claim receipt and ACK", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    const sender = { host: "peer", sessionId: "sender" };
    const prepared = f.store.prepare({ sender, target, body: "replacement body" }, now);
    f.store.submitPrepared(sender, prepared.messageId, now);
    f.store.observeNativeInput(target, now, b.instanceId);
    expect(f.store.reserveManagedWake({ ...target, transport, instanceId: b.instanceId, relayId: b.relayId!,
      nonce: "protected-birth-wake-abcdefghijklmnop" }, now).dispatch).toBe(true);
    const before = f.snapshot();
    expect(f.ensure(100, b.instanceId)).toEqual({ spawn: false, relayId: null, instanceId: a.instanceId, reason: "GENERATION_SUPERSEDED" });
    expect(f.ensure(100)).toEqual({ spawn: false, relayId: null, instanceId: a.instanceId, reason: "GENERATION_SUPERSEDED" });
    expect(f.row(a.instanceId)).toMatchObject({ superseded_at: expect.any(String), host_pid: 100, host_start: "parent-A" });
    expect(f.snapshot()).toEqual(before);
    // A plain start of the superseded instance does not revive it either.
    expect(f.store.startPresence({ ...target, transport, instanceId: a.instanceId, wakeVisibility: "none", canWakeSilently: false }, now).instanceId)
      .toBe(b.instanceId);
    expect(f.snapshot()).toEqual(before);
    const claimed = f.store.claimTurnEnd(target, now + 1, { instanceId: b.instanceId });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, deliveryAttempt: 1, body: "replacement body" }]);
    expect(f.store.acknowledge(target, [prepared.messageId], now + 2, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    expect(f.store.database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 4 });
  });

  it("prunes verified rows like any other after retention; only an online current birth stays protected", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    const later = now + PRESENCE_RETENTION_MS + 60_000;
    f.clock.value = later;
    // B's host is still served: its birth is ensured again (revived and re-granted) before the retention prune.
    expect(f.ensure(101, b.instanceId)).toMatchObject({ spawn: true, instanceId: b.instanceId });
    f.store.prune(later);
    expect(f.row(a.instanceId)).toBeUndefined(); // no verified-row exemption
    expect(f.row(b.instanceId)).toMatchObject({ superseded_at: null, ended_at: null });
    const before = f.snapshot();
    expect(f.ensure(100)).toEqual({ spawn: false, relayId: null, instanceId: a.instanceId, reason: "CURRENT_GENERATION_PROTECTED" });
    expect(f.snapshot()).toEqual(before);
    // An explicit observation of the current B is a deliberate replacement once A's superseded row is gone.
    expect(f.ensure(100, b.instanceId)).toMatchObject({ spawn: true, instanceId: a.instanceId });
    expect(f.store.presence(target).instanceId).toBe(a.instanceId);
  });

  it("prunes every row of a session with no live birth, after which a birth registers as new", () => {
    const f = fixture();
    const a = f.start(100);
    f.start(101);
    const later = now + PRESENCE_RETENTION_MS + 60_000;
    f.clock.value = later;
    f.store.prune(later);
    expect(f.store.database.prepare("SELECT count(*) AS n FROM session_presence").get()).toEqual({ n: 0 });
    expect(f.store.database.prepare("SELECT count(*) AS n FROM relay_leases").get()).toEqual({ n: 0 });
    expect(f.store.presence(target).state).toBe("unknown");
    expect(f.ensure(100, null)).toMatchObject({ spawn: true, instanceId: a.instanceId });
  });

  it("allows an unregistered C when the expected B is current and refuses the C observation after D replaced it", () => {
    const f = fixture();
    f.start(100);
    const b = f.start(101);
    expect(f.ensure(102, b.instanceId)).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C") });
    const c = f.store.presence(target).instanceId!;
    expect(f.ensure(103, c).spawn).toBe(true);
    const before = f.snapshot();
    expect(f.ensure(102, b.instanceId)).toEqual({ spawn: false, relayId: null, instanceId: birth(102, "parent-C"), reason: "GENERATION_CHANGED" });
    expect(f.ensure(102, f.store.presence(target).instanceId)).toEqual({ spawn: false, relayId: null, instanceId: birth(102, "parent-C"), reason: "GENERATION_SUPERSEDED" });
    expect(f.snapshot()).toEqual(before);
    expect(f.store.presence(target).instanceId).toBe(birth(103, "parent-D"));
  });

  it.each([0, -10_000])("reserves a new C once after B's same-ms re-registration even when the clock moves %ims", clockOffset => {
    const f = fixture();
    const b = f.start(101);
    // B's relay ends normally: its own release drops its lease and ends B.
    expect(f.store.releaseRelay({ ...target, transport, relayId: b.relayId!, instanceId: b.instanceId, reason: "normal-stop" }, now)).toBe(true);
    const restarted = f.ensure(101, b.instanceId);
    expect(restarted).toMatchObject({ spawn: true, instanceId: b.instanceId });
    expect(f.row(b.instanceId)).toMatchObject({ started_at: new Date(now + 1).toISOString(), superseded_at: null });

    f.clock.value = now + clockOffset;
    const c = f.ensure(102, b.instanceId);
    expect(c).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C"), relayId: expect.any(String) });
    expect(f.store.presence(target)).toMatchObject({ instanceId: c.instanceId, state: "online" });
    // Authority time never moves back: a backward clock still stamps the high-water time, not the earlier sample.
    expect(f.row(b.instanceId)).toMatchObject({ superseded_at: new Date(now).toISOString() });
    expect(f.store.liveRelay(target, transport)).toMatchObject({ instanceId: c.instanceId, relayId: c.relayId });
    expect(f.store.database.prepare("SELECT instance_id FROM session_presence ORDER BY rowid").all())
      .toEqual([{ instance_id: b.instanceId }, { instance_id: c.instanceId }]);
    const reserved = f.snapshot();
    expect(f.ensure(102, c.instanceId)).toEqual({ spawn: false, relayId: null, instanceId: c.instanceId, reason: "RELAY_ALIVE" });
    expect(f.snapshot()).toEqual(reserved);
  });

  it("rolls back the superseded mark and the grant when inserting C fails", () => {
    const f = fixture();
    const b = f.start(101);
    // B's relay ends normally: its own release drops its lease and ends B.
    expect(f.store.releaseRelay({ ...target, transport, relayId: b.relayId!, instanceId: b.instanceId, reason: "normal-stop" }, now)).toBe(true);
    expect(f.ensure(101, b.instanceId).spawn).toBe(true);
    const before = f.snapshot();
    f.store.database.exec("CREATE TEMP TRIGGER reject_new_verified_birth BEFORE INSERT ON session_presence "
      + "WHEN NEW.instance_id <> '" + b.instanceId + "' "
      + "BEGIN SELECT RAISE(ABORT, 'controlled C insert failure'); END");
    expect(() => f.ensure(102, b.instanceId)).toThrow("controlled C insert failure");
    expect(f.snapshot()).toEqual(before);
    expect(f.row(b.instanceId)).toMatchObject({ superseded_at: null });
    f.store.database.exec("DROP TRIGGER reject_new_verified_birth");
    expect(f.ensure(102, b.instanceId)).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C") });
  });

  it("lets only C win when two connections observed B; D's late ensure changes no table or receipt", () => {
    const filename = databaseFile(), f = fixture(filename);
    const second = new SessionMessageStore(filename, { clock: () => f.clock.value });
    stores.push(second);
    f.start(100);
    const b = f.start(101);
    const observedB = second.presence(target).instanceId;
    expect(observedB).toBe(b.instanceId);
    const sender = { host: "peer", sessionId: "two-connections" };
    const prepared = f.store.prepare({ sender, target, body: "receipt survives the losing reservation" });
    f.store.submitPrepared(sender, prepared.messageId);
    expect(f.ensure(102, observedB).spawn).toBe(true);
    const c = birth(102, "parent-C");
    const claimed = f.store.claimTurnEnd(target, now, { instanceId: c });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, claimReceipt: expect.any(String) }]);
    const before = f.snapshot();
    expect(f.ensure(103, observedB, second)).toEqual({ spawn: false, relayId: null, instanceId: birth(103, "parent-D"), reason: "GENERATION_CHANGED" });
    expect(f.snapshot()).toEqual(before);
    expect(second.acknowledge(target, [prepared.messageId], now + 1,
      claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  });

  it("treats the same PID with another birth token as a distinct birth and keeps the superseded original row", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    f.tokens.set(100, "reused-parent-C");
    const c = f.ensure(100, b.instanceId);
    expect(c).toMatchObject({ spawn: true, instanceId: birth(100, "reused-parent-C") });
    expect(c.instanceId).not.toBe(a.instanceId);
    expect(f.row(a.instanceId)).toMatchObject({ host_start: "parent-A", superseded_at: expect.any(String) });
    expect(f.row(c.instanceId)).toMatchObject({ host_pid: 100, host_start: "reused-parent-C", superseded_at: null });
  });
});
