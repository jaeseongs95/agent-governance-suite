import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import { closeSessionMessaging, runSessionMessageOperation, sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const codeDigest = "sha256:" + hash("synthetic relay code");
const sender = { host: "portable", sessionId: "al01-sender" };
const recipient = { host: "portable", sessionId: "al01-recipient" };
let directory: string;
const second: DatabaseSync[] = [];

beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "ags-al01-")); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const connection of second.splice(0)) { try { connection.exec("ROLLBACK"); } catch { /* not in a transaction */ } connection.close(); }
  closeSessionMessaging(directory);
  fs.rmSync(directory, { recursive: true, force: true });
});

function rows(table: string): number {
  const connection = new DatabaseSync(path.join(directory, "session-messages.sqlite3"));
  try { return (connection.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count; }
  finally { connection.close(); }
}

// D-0006 in-process: the single operation attempt either commits or leaves nothing behind, and it is never replayed.
describe("AGS-D-0006: a contended or expired attempt writes nothing and is not replayed", () => {
  it("reports MESSAGING_BUSY while another connection holds the writer lock, then succeeds once", () => {
    const prepare = { sender, target: recipient, body: "synthetic body" };
    runSessionMessageOperation("pending", { target: recipient }, directory); // opens and creates the database
    const holder = new DatabaseSync(path.join(directory, "session-messages.sqlite3"));
    second.push(holder);
    holder.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    let failure: unknown;
    try { runSessionMessageOperation("prepare", prepare, directory, { busyTimeoutMs: 0 }); } catch (error) { failure = error; }
    expect(producerFailureReason(failure)).toBe("MESSAGING_BUSY");
    holder.exec("ROLLBACK");
    expect(rows("prepared_messages")).toBe(0);
    const prepared = runSessionMessageOperation<{ messageId: string }>("prepare", prepare, directory, { busyTimeoutMs: 0 });
    expect(prepared.messageId).toEqual(expect.any(String));
    expect(rows("prepared_messages")).toBe(1);
  });

  it("runs nothing once the request deadline has expired", async () => {
    const observed = vi.fn();
    const failure = await sessionMessageRequest("prepare", { sender, target: recipient, body: "synthetic body" }, directory,
      { deadlineMonotonicMs: performance.now() - 1, onOperationWrite: observed }).catch((error: unknown) => error);
    expect(producerFailureReason(failure)).toBe("BROKER_DEADLINE_EXPIRED");
    expect(observed).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(directory, "session-messages.sqlite3"))).toBe(false);
  });

  it("turns a domain rejection into a rejected request without writing", () => {
    runSessionMessageOperation("pending", { target: recipient }, directory);
    let failure: unknown;
    try { runSessionMessageOperation("prepare", { sender, target: recipient, body: 7 }, directory); } catch (error) { failure = error; }
    expect(producerFailureReason(failure)).toBe("BROKER_REQUEST_REJECTED");
    expect(rows("prepared_messages")).toBe(0);
  });
});

describe("AL02 operations/store integration: AGS-D-0007 and AGS-D-0031", () => {
  const target = { host: "portable", sessionId: "synthetic-relay" };
  const parentPid = 424242;
  const hostStart = "synthetic-host-birth";
  const instanceId = "host-process-v1:" + hash(JSON.stringify([target.host, target.sessionId, parentPid, hostStart]));
  type Store = Parameters<typeof dispatchSessionMessageOperation>[0];

  it("ensure-relay forwards the adapter's observation to the store without any OS query", () => {
    const ensureVerifiedGeneration = vi.fn<(input: unknown) => unknown>(() => ({ spawn: false, relayId: null, instanceId, reason: "RELAY_ALIVE" }));
    const store = { ensureVerifiedGeneration } as unknown as Store;
    const killed = vi.spyOn(process, "kill");
    dispatchSessionMessageOperation(store, "ensure-relay", { target, parentPid, parentStartToken: hostStart, expectedPresenceInstanceId: null, codeDigest,
      transport: "portable", wakeVisibility: "none", idleWake: "none", canWakeSilently: false, supportedInjection: [] });
    expect(killed).not.toHaveBeenCalled();
    expect(ensureVerifiedGeneration).toHaveBeenCalledTimes(1);
    expect(ensureVerifiedGeneration.mock.calls[0]![0]).toMatchObject({ ...target, instanceId, hostPid: parentPid, hostStart, codeDigest,
      transport: "portable", expectedPresenceInstanceId: null });
  });

  it("ensure-relay refuses a host observation without a start token", () => {
    const ensureVerifiedGeneration = vi.fn();
    const store = { ensureVerifiedGeneration } as unknown as Store;
    expect(() => dispatchSessionMessageOperation(store, "ensure-relay", { target, parentPid, parentStartToken: "  ", codeDigest,
      transport: "portable", wakeVisibility: "none", idleWake: "none", canWakeSilently: false, supportedInjection: [] })).toThrow("Invalid relay host observation.");
    expect(ensureVerifiedGeneration).not.toHaveBeenCalled();
  });

  const issued = randomUUID();
  it.each([["granted", { relayId: issued }, { relayId: issued }],
    ["refused", { relayId: null, reason: "RELAY_ALIVE" }, { relayId: null, reason: "RELAY_ALIVE" }]] as const)(
    "grant-relay returns the store's %s result and forwards the reported host PID", (_name, grant, expected) => {
      const grantRelay = vi.fn(() => grant);
      const store = { grantRelay } as unknown as Store;
      expect(dispatchSessionMessageOperation(store, "grant-relay", { target, transport: "portable", instanceId, hostPid: parentPid, codeDigest })).toEqual(expected);
      expect(grantRelay).toHaveBeenCalledWith(expect.objectContaining({ ...target, transport: "portable", instanceId, hostPid: parentPid }));
    });

  it("presence-start grants nothing for a generation that reports no host process", () => {
    const grantRelay = vi.fn();
    const presence = { instanceId: "generation" };
    const store = { grantRelay, startPresence: vi.fn(() => presence), liveRelayGeneration: vi.fn(() => null) } as unknown as Store;
    expect(dispatchSessionMessageOperation(store, "presence-start", { target, instanceId: "generation", transport: "portable",
      wakeVisibility: "none", canWakeSilently: false })).toEqual({ presence, relayId: null, reason: "HOST_UNREPORTED" });
    expect(grantRelay).not.toHaveBeenCalled();
  });

  it("lets the store sample reserve/start time after acquiring its transaction lock", () => {
    const reserveManagedWake = vi.fn(), startManagedWake = vi.fn();
    const store = { reserveManagedWake, startManagedWake } as unknown as Store;
    const binding = { ...target, instanceId, relayId: "relay", transport: "portable", nonce: "synthetic-nonce" };
    dispatchSessionMessageOperation(store, "reserve-wake", { target, ...binding });
    const attempt = { ...binding, generation: "generation", attemptId: "attempt", dispatchEpoch: 0 };
    dispatchSessionMessageOperation(store, "start-wake", { attempt, resendBaseMs: 600_000 });
    expect(reserveManagedWake.mock.calls[0]).toHaveLength(1);
    // The operation passes the validated resend base and no clock; the store samples time under its lock.
    expect(startManagedWake.mock.calls[0]).toHaveLength(2);
    expect(startManagedWake.mock.calls[0]![1]).toBe(600_000);
  });
});
