import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({
  read: vi.fn(), rename: vi.fn(), delay: vi.fn(), connect: vi.fn(), createServer: vi.fn(), spawn: vi.fn(),
  startToken: vi.fn(), storeClose: vi.fn(),
}));
vi.mock("node:fs", async original => ({ ...(await original<typeof import("node:fs")>()), renameSync: f.rename }));
vi.mock("node:fs/promises", async original => ({ ...(await original<typeof import("node:fs/promises")>()), readFile: f.read }));
vi.mock("node:child_process", async original => ({ ...(await original<typeof import("node:child_process")>()), spawn: f.spawn }));
vi.mock("node:timers/promises", () => ({ setTimeout: f.delay }));
vi.mock("node:tls", () => ({ default: { connect: f.connect, createServer: f.createServer } }));
vi.mock("../../mcp-server/src/process-identity.js", () => ({ processStartToken: f.startToken }));
vi.mock("../../mcp-server/src/session-message-wake-port.js", () => ({
  createWakeHookObservationReader: () => () => null, verifyHistoricalWakeObservation: () => false,
}));
vi.mock("../../mcp-server/src/session-message-store.js", () => ({
  MessageCapacityError: class extends Error {},
  SessionMessageStore: class {
    close = f.storeClose;
    relayTick() { return { alive: false, count: 0 }; }
    prepare() { return { messageId: "synthetic-prepared-id" }; }
  },
}));

import { acquireBrokerProcessLock, acquireBrokerProcessLockWhenReady, releaseBrokerProcessLock } from "../../mcp-server/src/broker-process-lock.js";
import { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchSessionMessageBrokerOperation, startSessionMessageBroker } from "../../mcp-server/src/session-message-broker.js";

const nativeFs = await vi.importActual<typeof import("node:fs")>("node:fs");
const nativePromises = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const fingerprint = Array(32).fill("AA").join(":");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
let directory: string;
let cleanupBroker: (() => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  f.rename.mockImplementation(nativeFs.renameSync);
  f.read.mockImplementation(nativePromises.readFile);
  f.delay.mockResolvedValue(undefined);
  f.startToken.mockReturnValue("synthetic-current-birth");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ags-al01-"));
});
afterEach(() => {
  cleanupBroker?.(); cleanupBroker = undefined;
  vi.restoreAllMocks(); vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("AGS-D-0004 and AGS-D-0215: birth-bound lock generations", () => {
  it("reclaims a stale birth after the PID is reused, while preserving a live legacy owner", () => {
    const lock = path.join(directory, "broker.lock");
    const old = `owner-999999-${"a".repeat(32)}-${hash("previous-birth")}`;
    fs.mkdirSync(path.join(lock, old), { recursive: true });
    vi.spyOn(process, "kill").mockReturnValue(true);
    const acquired = acquireBrokerProcessLock(lock)!;
    expect(acquired).not.toBeNull(); expect(acquired.owner).not.toBe(old);
    expect(fs.readdirSync(lock)).toEqual([acquired.owner]);
    releaseBrokerProcessLock(acquired);
    const legacy = `owner-999999-${"b".repeat(32)}`;
    fs.mkdirSync(path.join(lock, legacy), { recursive: true });
    expect(acquireBrokerProcessLock(lock)).toBeNull();
    expect(fs.readdirSync(lock)).toEqual([legacy]);
  });

  it("preserves a lock when the existing birth cannot be observed", () => {
    const lock = path.join(directory, "broker.lock");
    const old = `owner-999999-${"a".repeat(32)}-${hash("previous-birth")}`;
    fs.mkdirSync(path.join(lock, old), { recursive: true });
    vi.spyOn(process, "kill").mockReturnValue(true);
    f.startToken.mockImplementation((pid: number) => pid === process.pid ? "synthetic-current-birth" : null);
    expect(() => acquireBrokerProcessLock(lock)).toThrow("OWNER_UNVERIFIED");
    expect(fs.readdirSync(lock)).toEqual([old]);
  });

  it.each([false, true])("reclaims a verified abandoned stage, including the pre-marker crash window (%s)", marker => {
    const lock = path.join(directory, "broker.lock");
    const old = `owner-999999-${"a".repeat(32)}-${hash("previous-birth")}`;
    const stage = `${lock}.stage-${old}-ABC123`;
    fs.mkdirSync(marker ? path.join(stage, old) : stage, { recursive: true });
    const live = `${lock}.stage-owner-${process.pid}-${"c".repeat(32)}-${hash("synthetic-current-birth")}-DEF456`;
    fs.mkdirSync(live);
    const unknown = `${lock}.stage-legacy`;
    fs.mkdirSync(unknown);
    vi.spyOn(process, "kill").mockReturnValue(true);
    const acquired = acquireBrokerProcessLock(lock)!;
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.existsSync(live)).toBe(true); expect(fs.existsSync(unknown)).toBe(true);
    releaseBrokerProcessLock(acquired);
  });
});

describe("AGS-D-0231: the same publication failures drive bounded reobservation", () => {
  it.each(["EEXIST", "ENOTEMPTY", "EPERM", "EACCES", "ENOENT"])("reobserves %s after both inner publication attempts fail", async code => {
    const failure = Object.assign(new Error("synthetic publication failure"), { code });
    f.rename.mockImplementationOnce(() => { throw failure; }).mockImplementationOnce(() => { throw failure; });
    const acquired = await acquireBrokerProcessLockWhenReady(path.join(directory, "broker.lock"));
    expect(acquired).not.toBeNull(); expect(f.rename).toHaveBeenCalledTimes(3);
    expect(f.delay.mock.calls).toEqual([[25]]);
    releaseBrokerProcessLock(acquired!);
  });
});

function clientEndpoint() {
  f.read.mockImplementation(async (name: string) => name.endsWith("endpoint.json")
    ? JSON.stringify({ protocolVersion: "1.0.0", claimReceiptVersion: 1, address: "127.0.0.1", port: 12345, certificateFingerprint256: fingerprint })
    : name.endsWith("broker.token") ? "a".repeat(43) : "synthetic certificate");
}
function socket() {
  return Object.assign(new EventEmitter(), {
    getPeerCertificate: () => ({ fingerprint256: fingerprint }), write: vi.fn(), destroy: vi.fn(), end: vi.fn(), setTimeout: vi.fn(),
  });
}

describe("AGS-D-0006: a wire attempt is never automatically replayed", () => {
  it.each(["prepare", "claim", "reserve-wake"])("keeps one %s attempt after a lost response", async operation => {
    clientEndpoint(); const connection = socket();
    const failure = Object.assign(new Error("synthetic lost response"), { code: "ECONNRESET" });
    connection.write.mockImplementation(() => { queueMicrotask(() => connection.emit("error", failure)); return true; });
    f.connect.mockImplementation(() => { queueMicrotask(() => connection.emit("secureConnect")); return connection; });
    const observed = vi.fn();
    await expect(sessionMessageRequest(operation, {}, directory, { onOperationWrite: observed })).rejects.toBe(failure);
    expect(connection.write).toHaveBeenCalledTimes(1); expect(observed).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(1); expect(f.spawn).not.toHaveBeenCalled();
    expect(connection.destroy).toHaveBeenCalledTimes(1);
  });

  it("still recovers a connection failure before any target write", async () => {
    clientEndpoint(); const frames: string[] = [];
    f.connect.mockImplementation(() => {
      const connection = socket(); const first = f.connect.mock.calls.length === 1;
      connection.write.mockImplementation((frame: string) => {
        frames.push(JSON.parse(frame).operation);
        queueMicrotask(() => connection.emit("data", Buffer.from('{"ok":true,"data":{"ready":true}}\n')));
        return true;
      });
      queueMicrotask(() => connection.emit(first ? "error" : "secureConnect", new Error("synthetic pre-write failure")));
      return connection;
    });
    const observed = vi.fn();
    await expect(sessionMessageRequest("prepare", {}, directory, { onOperationWrite: observed })).resolves.toEqual({ ready: true });
    expect(frames).toEqual(["ping", "prepare"]); expect(observed).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledTimes(3); expect(f.spawn).not.toHaveBeenCalled();
  });

  it("does not replay a response timeout or a synchronous write failure", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    clientEndpoint(); const connection = socket(); connection.write.mockReturnValue(true);
    f.connect.mockImplementation(() => { queueMicrotask(() => connection.emit("secureConnect")); return connection; });
    const timedOut = sessionMessageRequest("claim", {}, directory, { totalTimeoutMs: 100 }).catch(error => error);
    await vi.advanceTimersByTimeAsync(101);
    expect(await timedOut).toBeInstanceOf(Error);
    expect(connection.write).toHaveBeenCalledTimes(1); expect(f.connect).toHaveBeenCalledTimes(1);
    const failed = socket(); const failure = new Error("synthetic synchronous write failure");
    failed.write.mockImplementation(() => { throw failure; });
    f.connect.mockImplementation(() => { queueMicrotask(() => failed.emit("secureConnect")); return failed; });
    await expect(sessionMessageRequest("prepare", {}, directory)).rejects.toBe(failure);
    expect(failed.write).toHaveBeenCalledTimes(1); expect(f.connect).toHaveBeenCalledTimes(2);
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe("AGS-D-0008: relay maintenance cannot keep an idle broker alive", () => {
  it("ignores repeated relay ticks but extends the idle window for an actual preparation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] }); vi.setSystemTime(0);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const server = Object.assign(new EventEmitter(), {
      address: () => ({ port: 12345 }), close: vi.fn(), listen: vi.fn((_port: number, _host: string, ready: () => void) => ready()),
    });
    f.createServer.mockReturnValue(server);
    const previous = new Set(process.listeners("exit"));
    await expect(startSessionMessageBroker(directory)).resolves.toBe("started");
    cleanupBroker = process.listeners("exit").find(listener => !previous.has(listener)) as (() => void) | undefined;
    const accept = f.createServer.mock.calls[0]![1] as (connection: ReturnType<typeof socket>) => void;
    const token = fs.readFileSync(path.join(directory, "broker.token"), "utf8").trim();
    const request = (operation: string, payload: Record<string, unknown>) => {
      const connection = socket(); server.emit("connection", connection); accept(connection);
      connection.emit("data", Buffer.from(JSON.stringify({ protocolVersion: "1.0.0", token, operation, payload }) + "\n"));
    };
    const tick = { target: { host: "portable", sessionId: "synthetic" }, transport: "portable", relayId: "relay", instanceId: "instance", includePending: false };
    vi.setSystemTime(40_000); request("relay-tick", tick);
    request("prepare", { sender: tick.target, target: tick.target, body: "synthetic activity" });
    vi.setSystemTime(80_000); request("relay-tick", tick);
    await vi.advanceTimersByTimeAsync(0); expect(exit).not.toHaveBeenCalled();
    vi.setSystemTime(100_000); request("relay-tick", tick);
    await vi.advanceTimersByTimeAsync(5000);
    expect(exit).toHaveBeenCalledWith(0); expect(f.storeClose).toHaveBeenCalledTimes(1);
  });
});

describe("AL02 broker/store integration: AGS-D-0007 and AGS-D-0031", () => {
  const target = { host: "portable", sessionId: "synthetic-relay" };
  const parentPid = 424242;
  const parentStartToken = "synthetic-parent-birth";
  const instanceId = "host-process-v1:" + hash(JSON.stringify([target.host, target.sessionId, parentPid, parentStartToken]));
  type Store = Parameters<typeof dispatchSessionMessageBrokerOperation>[0];

  it.each(["different", "unknown", "EPERM"])("only confirms an old relay dead on positive birth evidence (%s)", mode => {
    const previous = { relayId: "old-relay", pid: 999999, relayStartToken: "old-birth" };
    const prepareVerifiedRelay = vi.fn<(input: unknown) => { spawn: boolean }>(() => ({ spawn: false }));
    const store = { relayOwner: () => previous, prepareVerifiedRelay } as unknown as Store;
    f.startToken.mockImplementation((pid: number) => pid === parentPid ? parentStartToken : mode === "unknown" ? null : "different-birth");
    vi.spyOn(process, "kill").mockImplementation(() => {
      if (mode === "EPERM") throw Object.assign(new Error("synthetic permission denial"), { code: "EPERM" });
      return true;
    });
    dispatchSessionMessageBrokerOperation(store, "ensure-relay", { target, parentPid, parentStartToken,
      identityTimeoutMs: 8000, transport: "portable", wakeVisibility: "none", idleWake: "none", canWakeSilently: false, supportedInjection: [] });
    if (mode === "different") expect(prepareVerifiedRelay.mock.calls[0]![0]).toMatchObject({ confirmedDead: { relayId: previous.relayId, pid: previous.pid } });
    else expect(prepareVerifiedRelay.mock.calls[0]![0]).not.toHaveProperty("confirmedDead");
  });

  it.each(["child-birth", null])("passes a verified child birth to activation and preserves an unknown child (%s)", token => {
    const activateVerifiedRelay = vi.fn(() => false);
    const store = { activateVerifiedRelay } as unknown as Store;
    f.startToken.mockImplementation((pid: number) => pid === parentPid ? parentStartToken : token);
    dispatchSessionMessageBrokerOperation(store, "acquire-relay", { target, parentPid, parentStartToken, instanceId,
      relayId: "verified-relay-v1:synthetic", pid: 999999, transport: "portable" });
    if (token === null) expect(activateVerifiedRelay).not.toHaveBeenCalled();
    else expect(activateVerifiedRelay).toHaveBeenCalledWith(expect.objectContaining({ pid: 999999, relayStartToken: token }));
  });

  it("lets the store sample reserve/start time after acquiring its transaction lock", () => {
    const reserveManagedWake = vi.fn(), startManagedWake = vi.fn();
    const store = { reserveManagedWake, startManagedWake } as unknown as Store;
    const binding = { ...target, instanceId, relayId: "relay", transport: "portable", nonce: "synthetic-nonce" };
    dispatchSessionMessageBrokerOperation(store, "reserve-wake", { target, ...binding });
    const attempt = { ...binding, generation: "generation", attemptId: "attempt", dispatchEpoch: 0 };
    dispatchSessionMessageBrokerOperation(store, "start-wake", { attempt });
    expect(reserveManagedWake.mock.calls[0]).toHaveLength(1);
    expect(startManagedWake.mock.calls[0]).toHaveLength(1);
  });
});
