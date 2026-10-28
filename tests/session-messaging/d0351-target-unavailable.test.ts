import { afterEach, beforeEach, expect, it, vi } from "vitest";

const external = vi.hoisted(() => ({ request: vi.fn(), identity: vi.fn(), exists: vi.fn(), persistFailure: vi.fn() }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(),
  sessionMessageRequest: external.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(),
  processIdentityState: external.identity, processExists: external.exists,
}));
vi.mock("../../mcp-server/src/session-message-wake-port.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-wake-port.js")>(),
  persistRelayFailure: external.persistFailure,
}));

import { dispatchSessionMessageBrokerOperation as broker } from "../../mcp-server/src/session-message-broker.js";
import { dispatchManagedWake, runSessionMessageRelay } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore, type SessionIdentity, type WakeAttempt, type WakeReservation } from "../../mcp-server/src/session-message-store.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import type { InputObservation } from "../../mcp-server/src/input-observation.js";
import type { WakeDispatchOutcome, WakeDispatchPort, WakeHookObservationReader } from "../../mcp-server/src/session-message-wake-port.js";

/*
 * D0351 engineering-test-plan: synthetic core regression evidence only.
 * Public boundaries: real in-memory SQLite store + broker; relay dispatch and loop.
 * Oracles: an exact unobserved rejection retires only its birth/relay, preserves bodies,
 * grants no authority to another target, and stops renewal/retry/generic exit cleanup.
 * Wrong/stale/observed bindings must leave every persisted row unchanged. Ordinary
 * ambiguous/failure results retain their existing lifecycle. Fake time fixes ordering.
 * Replaced boundaries: host dispatch, native process identity, network client, diagnostic
 * sink and a receipt reader that accepts only fixture-issued observations. No production
 * adapter emits target-unavailable here; native producer/hook capture and E2E are excluded.
 * engineering-test-proof/result: NOT_RUN by author (including pre-fix red, green,
 * mutation, tsc/lint/build and skill consistency CLI); execute with the assigned tester.
 */
const now = Date.UTC(2026, 9, 28);
const target = { host: "synthetic-d0351", sessionId: "unavailable-target" };
const sender = { host: "synthetic-d0351", sessionId: "sender" };
const instanceId = "host-process-v1:" + "a".repeat(64);
const replacementId = "host-process-v1:" + "b".repeat(64);
const transport = "synthetic-queue";
const capabilities: WakeDispatchPort["capabilities"] = { supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent" };
const stores: SessionMessageStore[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.clearAllMocks();
  external.request.mockReset();
  external.identity.mockReturnValue("match");
  external.exists.mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
});

function owner(store: SessionMessageStore, identity = target, birth = instanceId, at = now) {
  const input = { ...identity, instanceId: birth, transport, parentPid: 100,
    wakeVisibility: "silent" as const, canWakeSilently: true, deliveryCapabilities: capabilities };
  const grant = store.prepareVerifiedRelay({ ...input, expectedOwner: store.relayOwner(identity, transport) }, at);
  expect(grant.spawn).toBe(true);
  expect(grant.relayId).not.toBeNull();
  const relayId = grant.relayId!;
  expect(store.activateVerifiedRelay({ ...input, relayId, pid: 200 }, at)).toBe(true);
  return { input, relayId };
}

function fixture() {
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const current = owner(store);
  // Receipt provenance is intentionally synthetic, scoped to exact fixture objects.
  const issued = new Map<string, InputObservation>();
  const reader: WakeHookObservationReader = {
    verifyObservation: (identity, observation, receiptId) => issued.get(receiptId) === observation
      && identity.host === observation.host && identity.sessionId === observation.sessionId,
  };
  const call = (operation: string, payload: Record<string, unknown>) => broker(store, operation, payload, reader);
  const request: typeof sessionMessageRequest = async <T>(operation: string, payload: Record<string, unknown>): Promise<T> => call(operation, payload) as T;
  const claimMarker = (identity: SessionIdentity, nonce: string) => {
    const observation: InputObservation = { ...identity, kind: "user-input", wakeOnly: true,
      wakeCandidates: [nonce], actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_D0351_ROOT" } };
    const sourceReceiptId = `synthetic-receipt-${issued.size}`;
    issued.set(sourceReceiptId, observation);
    return call("claim-host-wake", { target: identity, observation, sourceReceiptId });
  };
  return { store, ...current, call, request, claimMarker };
}
type Fixture = ReturnType<typeof fixture>;

function send(f: Fixture, identity = target, messageId = "old-body-0001") {
  f.store.send({ sender, target: identity, messageId, body: messageId }, Date.now());
}
function begin(f: Fixture, overrides: Partial<WakeAttempt> = {}): WakeAttempt {
  const reserved = f.call("reserve-wake", { target: { host: overrides.host ?? target.host, sessionId: overrides.sessionId ?? target.sessionId },
    instanceId: overrides.instanceId ?? instanceId, transport: overrides.transport ?? transport,
    relayId: overrides.relayId ?? f.relayId, nonce: overrides.nonce ?? "d0351-wake-nonce-abcdefghijklmnop" }) as WakeReservation;
  expect(reserved.dispatch).toBe(true);
  const started = f.call("start-wake", { attempt: reserved.attempt }) as WakeReservation;
  expect(started.dispatch).toBe(true);
  expect(started.attempt).not.toBeNull();
  return started.attempt!;
}
function wakeRow(f: Fixture, attempt: WakeAttempt) {
  return f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId);
}
function snapshot(f: Fixture) {
  return Object.fromEntries(["messages", "prepared_messages", "relay_leases", "wake_nonces", "session_presence", "session_activity", "input_observations"]
    .map(table => [table, f.store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
}
function terminal(f: Fixture, attempt: WakeAttempt) {
  return f.call("record-wake-outcome", { attempt, outcome: "target-unavailable" });
}
function port(outcome: WakeDispatchOutcome): WakeDispatchPort {
  return { capabilities, dispatch: vi.fn(async () => outcome) };
}

it("D0351 exact rejection retires only its birth/relay, preserves old bodies and leaves a new session independent", () => {
  const f = fixture();
  send(f);
  const attempt = begin(f);
  const bodies = f.store.database.prepare("SELECT * FROM messages").all();
  const fresh = { ...target, sessionId: "independent-new-target" };
  const freshOwner = owner(f.store, fresh, replacementId, now + 1);
  send(f, fresh, "fresh-body-0001");
  const freshPresence = f.store.presence(fresh, now + 1);
  vi.setSystemTime(now + 2);
  expect(terminal(f, attempt)).toEqual({ recorded: true });
  expect(wakeRow(f, attempt)).toMatchObject({ state: "not-submitted", retry_not_before: null, retry_count: 0,
    outcome_at: new Date(now + 2).toISOString(), observed_at: null, consumed_at: null });
  expect(f.store.presence(target)).toMatchObject({ state: "ended", instanceId, startedAt: attempt.generation,
    endedAt: new Date(now + 2).toISOString(), endReason: "target-unavailable" });
  expect(f.store.relayOwner(target, transport)).toBeNull();
  expect(f.store.database.prepare("SELECT * FROM messages WHERE message_id = 'old-body-0001'").all()).toEqual(bodies);
  expect(f.store.presence(fresh)).toEqual(freshPresence);
  expect(f.store.relayOwner(fresh, transport)?.relayId).toBe(freshOwner.relayId);
  const beforeStale = snapshot(f);
  expect(f.claimMarker(fresh, attempt.nonce)).toEqual({ recognized: false, messages: [], managed: false });
  expect(f.claimMarker(target, attempt.nonce)).toEqual({ recognized: false, messages: [], managed: false });
  expect(snapshot(f)).toEqual(beforeStale);
  expect(f.call("acknowledge", { target: fresh, messageIds: ["old-body-0001"] })).toEqual({ acknowledged: 0 });
  expect(f.store.pendingCount(target)).toBe(1);
  const freshAttempt = begin(f, { ...fresh, instanceId: replacementId, relayId: freshOwner.relayId,
    nonce: "d0351-fresh-nonce-abcdefghijklmnop" });
  expect(freshAttempt.attemptId).not.toBe(attempt.attemptId);
  expect(f.claimMarker(fresh, freshAttempt.nonce)).toMatchObject({ recognized: true, managed: true,
    messages: [{ messageId: "fresh-body-0001", recipient: fresh }] });
  expect(f.call("acknowledge", { target: fresh, messageIds: ["fresh-body-0001"] })).toEqual({ acknowledged: 1 });
  expect(f.store.pendingCount(fresh)).toBe(0);
  expect(f.store.pendingCount(target)).toBe(1);
  expect(wakeRow(f, attempt)).toMatchObject({ state: "not-submitted", observed_at: null, consumed_at: null });
  expect(f.store.reserveManagedWake({ ...attempt, nonce: "d0351-no-retry-abcdefghijklmnop", resume: true }, now + 3).dispatch).toBe(false);
});

it("D0351 a terminal tombstone blocks delayed same-instance start and ensure even with no retained owner", () => {
  const f = fixture(); send(f); const attempt = begin(f);
  const oldOwner = f.store.relayOwner(target, transport);
  vi.setSystemTime(now + 2);
  expect(terminal(f, attempt)).toEqual({ recorded: true });
  const before = snapshot(f);
  vi.setSystemTime(now + 3);
  expect(f.store.startPresence(f.input)).toMatchObject({ state: "ended", endReason: "target-unavailable",
    instanceId, startedAt: attempt.generation });
  expect(snapshot(f)).toEqual(before);
  for (const expectedOwner of [null, oldOwner]) {
    expect(f.store.prepareVerifiedRelay({ ...f.input, expectedOwner })).toEqual({ spawn: false, relayId: null, instanceId });
    expect(snapshot(f)).toEqual(before);
  }
  // A separately observed process generation can still acquire the same session.
  const fresh = owner(f.store, target, replacementId, now + 4);
  expect(f.store.presence(target, now + 4)).toMatchObject({ state: "online", instanceId: replacementId });
  expect(f.store.relayOwner(target, transport)?.relayId).toBe(fresh.relayId);
  expect(wakeRow(f, attempt)).toMatchObject({ state: "not-submitted", observed_at: null, consumed_at: null });
});

it("D0351 an exact unobserved unknown result can later become terminal without scheduling another retry", () => {
  const f = fixture(); send(f); const attempt = begin(f);
  expect(f.call("record-wake-outcome", { attempt, outcome: "accepted-or-unknown" })).toEqual({ recorded: true });
  expect(wakeRow(f, attempt)).toMatchObject({ state: "unknown" });
  vi.setSystemTime(now + 2);
  expect(terminal(f, attempt)).toEqual({ recorded: true });
  expect(wakeRow(f, attempt)).toMatchObject({ state: "not-submitted", retry_not_before: null, retry_count: 0 });
  expect(f.store.presence(target).state).toBe("ended");
  expect(f.store.relayOwner(target, transport)).toBeNull();
});

it.each(["host", "sessionId", "transport", "instanceId", "generation", "relayId", "attemptId", "nonce", "dispatchEpoch"] as const)(
  "D0351 mismatched %s cannot retire any persisted state", key => {
    const f = fixture(); send(f); const attempt = begin(f);
    const wrong: WakeAttempt = { ...attempt, [key]: key === "dispatchEpoch" ? attempt.dispatchEpoch + 1 : `different-${key}-abcdefghijklmnop` };
    const before = snapshot(f);
    expect(terminal(f, wrong)).toEqual({ recorded: false });
    expect(snapshot(f)).toEqual(before);
    expect(f.store.presence(target).state).toBe("online");
  });

it.each(["rebirth", "instance", "transport", "owner", "ended", "presence-expired", "relay-expired"] as const)(
  "D0351 a late rejection after %s cannot change the current owner or old attempt", kind => {
    const f = fixture(); send(f); const attempt = begin(f);
    let at = now + 2;
    if (kind === "rebirth") {
      expect(f.store.endPresence(target, "fixture-rebirth", instanceId, at)).toBe(true);
      f.store.startPresence(f.input, at + 1);
      expect(f.store.presence(target, at + 1).startedAt).not.toBe(attempt.generation);
    } else if (kind === "instance") {
      owner(f.store, target, replacementId, at);
    } else if (kind === "transport") {
      f.store.startPresence({ ...f.input, transport: "different-queue" }, at);
      expect(f.store.acquireRelay({ ...target, transport: "different-queue", relayId: "different-relay", pid: 201, parentPid: 100 }, at)).toBe(true);
    } else if (kind === "owner") {
      const grant = f.store.prepareVerifiedRelay({ ...f.input, expectedOwner: f.store.relayOwner(target, transport),
        confirmedDead: { relayId: f.relayId, pid: 200 } }, at);
      expect(grant.spawn).toBe(true);
      expect(grant.relayId).not.toBe(f.relayId);
      expect(f.store.activateVerifiedRelay({ ...f.input, relayId: grant.relayId!, pid: 201 }, at)).toBe(true);
      expect(f.store.presence(target, at).startedAt).toBe(attempt.generation);
    } else if (kind === "ended") {
      f.store.endPresence(target, "fixture-ended", instanceId, at);
    } else if (kind === "presence-expired") {
      at = Date.parse(f.store.presence(target, at).leaseUntil!);
      expect(f.store.heartbeatRelay({ ...target, transport, relayId: f.relayId }, at)).toBe(true);
    } else {
      at = now + 15_000;
      expect(f.store.heartbeatPresence(target, instanceId, at)).toBe(true);
    }
    vi.setSystemTime(at + 2);
    const before = snapshot(f);
    expect(terminal(f, attempt)).toEqual({ recorded: false });
    expect(snapshot(f)).toEqual(before);
  });

it.each(["late_observed_at", "observed_at", "consumed_at"] as const)(
  "D0351 a persisted %s observation fences terminal cleanup even if the state still says started", field => {
    const f = fixture(); send(f); const attempt = begin(f);
    f.store.database.prepare(`UPDATE wake_nonces SET ${field} = ? WHERE attempt_id = ?`)
      .run(new Date(now + 1).toISOString(), attempt.attemptId);
    const before = snapshot(f);
    vi.setSystemTime(now + 2);
    expect(terminal(f, attempt)).toEqual({ recorded: false });
    expect(snapshot(f)).toEqual(before);
  });

it.each(["before", "after"] as const)("D0351 rejection %s a relay heartbeat cannot be undone by renewal", order => {
  const f = fixture(); send(f); const attempt = begin(f);
  const tick = { target, instanceId, transport, relayId: f.relayId, includePending: false };
  vi.setSystemTime(now + 2);
  if (order === "after") expect(f.call("relay-tick", tick)).toEqual({ alive: true, count: 0 });
  expect(terminal(f, attempt)).toEqual({ recorded: true });
  const ended = snapshot(f);
  vi.setSystemTime(now + 3);
  expect(f.call("relay-tick", tick)).toEqual({ alive: false, count: 0 });
  expect(snapshot(f)).toEqual(ended);
  expect(f.store.presence(target).state).toBe("ended");
});

it("D0351 a previously observed hook rejects a later terminal result without changing claim or ACK", () => {
  const f = fixture(); send(f); const attempt = begin(f);
  expect(f.claimMarker(target, attempt.nonce)).toMatchObject({ recognized: true, managed: true,
    messages: [{ messageId: "old-body-0001" }] });
  expect(f.call("acknowledge", { target, messageIds: ["old-body-0001"] })).toEqual({ acknowledged: 1 });
  const before = snapshot(f);
  vi.setSystemTime(now + 2);
  expect(terminal(f, attempt)).toEqual({ recorded: false });
  expect(snapshot(f)).toEqual(before);
  expect(f.store.presence(target).state).toBe("online");
  expect(f.store.relayOwner(target, transport)?.relayId).toBe(f.relayId);
});

it.each(["accepted-or-unknown", "definite-failure", "submitted"] as const)(
  "D0351 ordinary %s preserves presence/relay and the existing wake lifecycle", outcome => {
    const f = fixture(); send(f); const attempt = begin(f);
    const presence = f.store.presence(target);
    const relay = f.store.relayOwner(target, transport);
    expect(f.call("record-wake-outcome", { attempt, outcome })).toEqual({ recorded: true });
    expect(f.store.presence(target)).toEqual(presence);
    expect(f.store.relayOwner(target, transport)).toEqual(relay);
    expect(wakeRow(f, attempt)).toMatchObject({ state: outcome === "submitted" ? "submitted" : outcome === "definite-failure" ? "reserved" : "unknown",
      retry_count: outcome === "definite-failure" ? 1 : 0,
      retry_not_before: outcome === "definite-failure" ? new Date(now + 30_000).toISOString() : null });
  });

it.each(["accepted-or-unknown", "definite-failure", "submitted"] as const)(
  "D0351 dispatch retains true for ordinary %s and false when no work remains", async outcome => {
    const f = fixture(); send(f); const dispatch = port(outcome);
    expect(await dispatchManagedWake(f.input, f.relayId, dispatch, f.request)).toBe(true);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(await dispatchManagedWake(f.input, f.relayId, dispatch, f.request)).toBe(false);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

it.each(["recorded", "stale", "error"] as const)(
  "D0351 dispatch returns terminal after a %s record result and drains in-flight renewal", async result => {
    const f = fixture(); send(f);
    let completeDispatch!: (outcome: WakeDispatchOutcome) => void;
    let completeHeartbeat!: () => void;
    let enteredDispatch!: () => void;
    const dispatchEntered = new Promise<void>(resolve => { enteredDispatch = resolve; });
    const pendingDispatch = new Promise<WakeDispatchOutcome>(resolve => { completeDispatch = resolve; });
    const pendingHeartbeat = new Promise<void>(resolve => { completeHeartbeat = resolve; });
    let renewals = 0;
    let records = 0;
    const request: typeof sessionMessageRequest = async <T>(operation: string, payload: Record<string, unknown>): Promise<T> => {
      if (operation === "relay-tick") {
        renewals++;
        await pendingHeartbeat;
      }
      if (operation === "record-wake-outcome") {
        records++;
        expect(payload.outcome).toBe("target-unavailable");
        if (result === "stale") return { recorded: false } as T;
        if (result === "error") throw new Error("synthetic terminal record failure");
      }
      return f.call(operation, payload) as T;
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatch: WakeDispatchPort = { capabilities, dispatch: async () => { enteredDispatch(); return pendingDispatch; } };
    const running = dispatchManagedWake(f.input, f.relayId, dispatch, request);
    await dispatchEntered;
    await vi.advanceTimersByTimeAsync(5000);
    expect(renewals).toBe(1);
    // A single unresolved renewal must not allow overlapping heartbeat requests.
    await vi.advanceTimersByTimeAsync(5000);
    expect(renewals).toBe(1);
    completeDispatch("target-unavailable");
    let settled = false;
    void running.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(records).toBe(1);
    expect(settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    if (result === "recorded") expect(f.store.presence(target).state).toBe("ended");
    const beforeRenewal = snapshot(f);
    completeHeartbeat();
    expect(await running).toBe("target-unavailable");
    if (result === "recorded") expect(snapshot(f)).toEqual(beforeRenewal);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(renewals).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(external.persistFailure).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
    expect(log).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
  });

it.each(["recorded", "stale", "error"] as const)(
  "D0351 terminal receipt stops new renewal while its %s record response is pending", async result => {
    const f = fixture(); send(f);
    let completeRecord!: () => void;
    let enteredRecord!: () => void;
    const pendingRecord = new Promise<void>(resolve => { completeRecord = resolve; });
    const recordEntered = new Promise<void>(resolve => { enteredRecord = resolve; });
    let renewals = 0;
    let records = 0;
    const request: typeof sessionMessageRequest = async <T>(operation: string, payload: Record<string, unknown>): Promise<T> => {
      if (operation === "relay-tick") renewals++;
      if (operation === "record-wake-outcome") {
        records++;
        expect(payload.outcome).toBe("target-unavailable");
        // Separate the terminal decision from a delayed/unknown persistence reply.
        const response = result === "recorded" ? f.call(operation, payload) : { recorded: false };
        enteredRecord();
        await pendingRecord;
        if (result === "error") throw new Error("synthetic pending terminal record failure");
        return response as T;
      }
      return f.call(operation, payload) as T;
    };
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dispatch = port("target-unavailable");
    let settled = false;
    const running = dispatchManagedWake(f.input, f.relayId, dispatch, request);
    void running.then(() => { settled = true; }, () => { settled = true; });
    await recordEntered;
    expect(records).toBe(1);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(renewals).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(settled).toBe(false);
    completeRecord();
    expect(await running).toBe("target-unavailable");
    expect(settled).toBe(true);
    expect(renewals).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(external.persistFailure).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
    expect(log).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
  });

it.each(["recorded", "stale", "error"] as const)(
  "D0351 actual relay loop stops after terminal %s without generic cleanup or another tick", async result => {
    const f = fixture(); send(f);
    const operations: string[] = [];
    let replacement: ReturnType<typeof owner> | undefined;
    let replacementBefore: ReturnType<typeof snapshot> | undefined;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    external.request.mockImplementation(async (operation: string, payload: Record<string, unknown>) => {
      operations.push(operation);
      // Process identity/start-token inspection belongs to the synthetic host seam.
      // Ownership was activated against the real store in the fixture already.
      if (operation === "acquire-relay") return { acquired: true };
      if (operation === "record-wake-outcome" && result !== "recorded") {
        replacement = owner(f.store, target, replacementId, Date.now() + 1);
        replacementBefore = snapshot(f);
        if (result === "error") throw new Error("synthetic terminal reply lost");
      }
      return f.call(operation, payload);
    });
    const dispatch = port("target-unavailable");
    let settled = false;
    let loopError: unknown;
    const running = runSessionMessageRelay({ ...f.input, parentStartToken: "synthetic-start", relayId: f.relayId }, dispatch)
      .then(() => { settled = true; }, error => { settled = true; loopError = error; });
    // A loop that schedules another sleep must fail here instead of hanging the test.
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(true);
    await running;
    expect(loopError).toBeUndefined();
    expect(operations).toEqual(["acquire-relay", "relay-tick", "reserve-wake", "start-wake", "record-wake-outcome"]);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(operations).not.toContain("presence-end");
    expect(operations).not.toContain("release-verified-relay");
    expect(vi.getTimerCount()).toBe(0);
    if (result === "recorded") {
      expect(f.store.presence(target)).toMatchObject({ state: "ended", endReason: "target-unavailable" });
      expect(f.store.relayOwner(target, transport)).toBeNull();
    } else {
      expect(replacement).toBeDefined();
      expect(snapshot(f)).toEqual(replacementBefore);
      expect(f.store.presence(target)).toMatchObject({ state: "online", instanceId: replacementId });
      expect(f.store.relayOwner(target, transport)?.relayId).toBe(replacement!.relayId);
    }
    await vi.advanceTimersByTimeAsync(30_000);
    expect(operations).toHaveLength(5);
    expect(dispatch.dispatch).toHaveBeenCalledTimes(1);
    expect(external.persistFailure).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
    expect(log).toHaveBeenCalledTimes(result === "error" ? 1 : 0);
  });
