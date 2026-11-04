import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, test, vi} from "vitest";
import {
  SessionMessageStore, WAKE_QUIET_MS, WAKE_START_TIMEOUT_MS,
  type WakeAttempt, type WakeReservation,
} from "../../mcp-server/src/session-message-store.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {adaptHostInput, registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {recordWakeHookObservation, wakeHookObservationReader, type WakeDispatchOutcome} from "../../mcp-server/src/session-message-wake-port.js";

// D0353 under the AGS 3.0 doorbell (docs/ags30-wake-doorbell-design.md r3.2). The 2.x cases here asserted that a restart,
// a new birth or time never releases an unobserved hand-off (permanent latch). They are rewritten to the 2.6 rule: a hand-off
// ends by a later claim boundary, the end of its birth or its resend deadline, while I2 (an old birth claims nothing),
// I4/I5 (no second effect before that) and I11 (no revival) still hold.
// Synthetic store cases with real temporary SQLite connections; every clock is an explicit argument.
const host = "d0353-restart-synthetic";
registerHookHostAdapter(host, {
  adaptInput(input, selectedHost) {
    const adapted = adaptHostInput(input, "codex");
    return {...adapted, observation: {...adapted.observation, host: selectedHost,
      actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_D0353_ROOT"}}};
  },
  deliveryProfile: () => ({transport: "d0353-synthetic", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined,
});

const BASE = 10 * 60_000;
const HANDED: WakeDispatchOutcome = {result: "handed-off"};
const UNKNOWN: WakeDispatchOutcome = {result: "unknown", reasonCode: "SYNTHETIC_TIMEOUT"};
const TRANSIENT: WakeDispatchOutcome = {result: "not-delivered", kind: "transient", reasonCode: "SYNTHETIC_TRANSIENT"};
const target = {host, sessionId: "d0353-restart-target"};
const sender = {host, sessionId: "d0353-restart-sender"};
const capabilities: NonNullable<Parameters<SessionMessageStore["startPresence"]>[0]["deliveryCapabilities"]> = {
  supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent",
};
const iso = (at: number) => new Date(at).toISOString();
// The synthetic host process the hook reported and the birth its relay's watcher bound (docs/ags30-broker-redesign.md 3.3).
const HOST_PID = process.pid;
const HOST_START = "synthetic-host-start";
const resources: {directory: string; stores: Set<SessionMessageStore>}[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const {directory, stores} of resources.splice(0)) {
    for (const store of stores) store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

function fixture(transport = "d0353-synthetic") {
  const directory = mkdtempSync(join(tmpdir(), "ags-d0353-restart-"));
  const database = join(directory, "messages.sqlite3");
  const store = new SessionMessageStore(database);
  const stores = new Set([store]);
  resources.push({directory, stores});
  const now = Date.now();
  // Each relay grant gets a fresh random relay_id; the fixture names them so a case can address one (relay-1, relay-2).
  const f = {directory, database, store, stores, now, transport, relays: new Map<string, string>()};
  live(f, "instance-1", "relay-1", now);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function reopen(f: Fixture) {
  f.store.close();
  f.stores.delete(f.store);
  f.store = new SessionMessageStore(f.database);
  f.stores.add(f.store);
}
/** The hook grants the birth a lease under a new relay_id; the relay's first tick binds the host birth so it may ring. */
function grant(f: Fixture, instanceId: string, relay: string, at: number) {
  const granted = f.store.grantRelay({...target, instanceId, transport: f.transport, codeDigest: null, hostPid: HOST_PID}, at);
  assert.ok(granted.relayId, `grant refused: ${granted.reason}`);
  assert.deepEqual(f.store.relayTick({...target, instanceId, relayId: granted.relayId, transport: f.transport, includePending: false,
    hostStart: HOST_START}, at), {alive: true, count: 0, hostBound: true});
  f.relays.set(relay, granted.relayId);
}
function live(f: Fixture, instanceId: string, relay: string, at: number) {
  f.store.startPresence({...target, instanceId, transport: f.transport, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: capabilities, hostPid: HOST_PID}, at);
  grant(f, instanceId, relay, at);
}
function relayId(f: Fixture, relay: string) {
  const value = f.relays.get(relay);
  assert.ok(value, relay);
  return value;
}
function request(f: Fixture, instanceId = "instance-1", relay = "relay-1", nonce = `d0353-${Math.random().toString(36).slice(2, 10)}-nonce-abcdefghijklmnop`) {
  return {...target, instanceId, relayId: relayId(f, relay), nonce, transport: f.transport, resume: true};
}
// A live relay renews its lease and presence every few seconds; model that up to `to` without any claim boundary.
function keep(f: Fixture, from: number, to: number, instanceId = "instance-1", relay = "relay-1") {
  for (let at = from; ; at = Math.min(at + 10_000, to)) {
    assert.equal(f.store.relayTick({...target, instanceId, relayId: relayId(f, relay), transport: f.transport, includePending: false}, at).alive, true);
    if (at === to) return;
  }
}
function dispatched(reservation: WakeReservation): WakeAttempt {
  assert.equal(reservation.dispatch, true);
  assert.ok(reservation.attempt);
  return reservation.attempt;
}
function submit(f: Fixture, body: string, at: number, ttlSeconds = 86400) {
  const prepared = f.store.prepare({sender, target, body, ttlSeconds}, at);
  return f.store.submitPrepared(sender, prepared.messageId, at);
}
type Uncertain = "handed-off" | "unknown" | "started";
/** Hands one marker to the host for one pending body: started at now+1, outcome at now+2. */
function handOff(f: Fixture, outcome: Uncertain = "handed-off", at = f.now, instanceId = "instance-1", relay = "relay-1") {
  const attempt = dispatched(f.store.startManagedWake(dispatched(f.store.reserveManagedWake(request(f, instanceId, relay), at)), BASE, at + 1));
  if (outcome !== "started") assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome === "handed-off" ? HANDED : UNKNOWN, BASE, at + 2), true);
  return attempt;
}
function row(f: Fixture, attempt: WakeAttempt) {
  const result = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId);
  assert.ok(result);
  return {...result} as Record<string, unknown>;
}
function path(f: Fixture, instanceId = "instance-1") {
  return f.store.database.prepare("SELECT * FROM wake_paths WHERE host = ? AND session_id = ? AND instance_id = ? ORDER BY birth_generation DESC LIMIT 1")
    .get(target.host, target.sessionId, instanceId) as Record<string, unknown> | undefined;
}
function observe(f: Fixture, attempt: WakeAttempt, at: number) {
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", join(f.directory, "trust.sqlite3"));
  const observation = adaptHostInput({hook_event_name: "UserPromptSubmit", session_id: target.sessionId,
    agent_id: "", prompt: `[agent-governance-suite:wake:${attempt.nonce}]`}, host).observation;
  const receipt = recordWakeHookObservation(observation, at);
  return f.store.claimHostWake(target, observation, receipt, wakeHookObservationReader, at + 1);
}
const activeCount = (f: Fixture) => Number((f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces
  WHERE state IN ('reserved', 'started', 'handed-off', 'unknown')`).get() as {n: number}).n);

const transports = ["codex-queue", "claude-inbox", "antigravity-queue", "d0353-unregistered-queue"];
const restartCases = transports.flatMap(transport => (["handed-off", "unknown", "started"] as const).map(outcome => ({transport, outcome})));
test.each(restartCases)("2.6: $transport/$outcome after a restart and a new birth ends once, the old marker claims nothing and one new wake follows", ({transport, outcome}) => {
  const f = fixture(transport);
  submit(f, "old-generation-body", f.now);
  const attempt = handOff(f, outcome);
  const original = row(f, attempt);
  reopen(f);
  assert.deepEqual(row(f, attempt), original, "a restart alone changes nothing");
  live(f, "instance-2", "relay-2", f.now + 10);
  const at = outcome === "started" ? f.now + 1 + WAKE_START_TIMEOUT_MS : f.now + 11;
  if (outcome === "started") {
    // Before its start timeout a started attempt keeps the slot: its effect may still be in progress (I4).
    assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.now + 11).dispatch, false);
    assert.equal(row(f, attempt).state, "started");
    keep(f, f.now + 11, at, "instance-2", "relay-2");
  }
  const next = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), at));
  assert.notEqual(next.attemptId, attempt.attemptId);
  const ended = row(f, attempt);
  assert.deepEqual([ended.state, ended.release_reason, ended.released_at], ["released", "birth-ended", iso(at)]);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), at + 1).attempt?.attemptId, next.attemptId, "one active attempt (I5)");
  assert.equal(observe(f, attempt, at + 2).recognized, false, "an old birth marker claims no current body (I2)");
  assert.equal(f.store.pendingCount(target, at + 4), 1);
});

test("2.6: a lease expiry and rebirth of the same instance end the old hand-off as birth-ended", () => {
  const f = fixture();
  submit(f, "rebirth-body", f.now);
  const attempt = handOff(f);
  reopen(f);
  const at = f.now + 25_000;
  assert.equal(f.store.presence(target, at).state, "unreachable");
  live(f, "instance-1", "relay-1", at);
  assert.notEqual(f.store.presence(target, at).startedAt, attempt.generation);
  dispatched(f.store.reserveManagedWake(request(f), at + 1));
  assert.deepEqual([row(f, attempt).state, row(f, attempt).release_reason], ["released", "birth-ended"]);
  assert.equal(path(f)!.streak, 0, "the new birth starts from zero (r3 F2)");
});

test("2.3: presence renewal, a refused repeated grant and relay ticks of the same birth are no claim boundary and leave the hand-off", () => {
  const f = fixture();
  submit(f, "renewal-body", f.now);
  const attempt = handOff(f);
  const original = row(f, attempt);
  const at = f.now + 5_000;
  f.store.startPresence({...target, instanceId: "instance-1", transport: f.transport, wakeVisibility: "silent",
    canWakeSilently: true, deliveryCapabilities: capabilities}, at);
  assert.equal(f.store.presence(target, at).startedAt, attempt.generation, "a live renewal keeps its birth");
  // The live lease of this birth runs the same code: a second grant is refused and the holder keeps its relay_id.
  assert.deepEqual(f.store.grantRelay({...target, instanceId: "instance-1", transport: f.transport, codeDigest: null, hostPid: HOST_PID}, at),
    {relayId: null, reason: "RELAY_ALIVE"});
  assert.equal(f.store.liveRelay(target, f.transport, at)?.relayId, relayId(f, "relay-1"));
  assert.equal(f.store.heartbeatPresence(target, "instance-1", at + 1), true);
  assert.deepEqual(f.store.relayTick({...target, instanceId: "instance-1", relayId: relayId(f, "relay-1"), transport: f.transport,
    includePending: true}, at + 2), {alive: true, count: 1, hostBound: true});
  assert.equal(f.store.reserveManagedWake(request(f), at + 3).dispatch, false);
  assert.deepEqual(row(f, attempt), original);
  assert.equal(path(f)!.claim_boundary_at, null);
});

// The 2026-11-01 field case: an idle live Codex session latched for hours after one dropped marker.
test("I7: a quiet live session hours after an unobserved hand-off gets exactly one new wake across two connections", () => {
  const f = fixture();
  const {messageId} = submit(f, "old-body", f.now);
  const attempt = handOff(f);
  reopen(f);
  const at = f.now + 25 * 3600_000;
  // The birth stayed live the whole time (one long gap modelled by a lease extension, no boundary); its lapsed relay lease
  // is granted again to the same birth under a new relay_id.
  f.store.database.prepare("UPDATE session_presence SET lease_until = ? WHERE instance_id = 'instance-1'").run(iso(at + 20_000));
  grant(f, "instance-1", "relay-1", at - 2);
  const fresh = submit(f, "fresh-body-after-hours", at - 1);
  assert.equal(fresh.autoWake.state, "available");
  const peer = new SessionMessageStore(f.database);
  f.stores.add(peer);
  const next = dispatched(peer.reserveManagedWake(request(f), at));
  assert.equal(f.store.reserveManagedWake(request(f), at + 1).attempt?.attemptId, next.attemptId);
  assert.equal(activeCount(f), 1);
  assert.notEqual(next.nonce, attempt.nonce);
  assert.deepEqual([row(f, attempt).state, row(f, attempt).release_reason], ["released", "resend-due"]);
  assert.ok(messageId);
});

test("2.7: a released marker of the current birth arriving late claims the pending body once and leaves the current attempt", () => {
  const f = fixture();
  const {messageId} = submit(f, "late-body", f.now);
  const attempt = handOff(f);
  const due = f.now + 2 + BASE;
  keep(f, f.now + 3, due);
  const started = handOff(f, "handed-off", due);
  assert.deepEqual([row(f, attempt).state, row(f, attempt).release_reason], ["released", "resend-due"]);
  const current = row(f, started);
  const late = observe(f, attempt, due + 4);
  assert.equal(late.recognized, true);
  assert.deepEqual(late.messages.map(value => value.messageId), [messageId]);
  assert.equal(row(f, attempt).state, "released", "an ended row is never revived (I11)");
  assert.equal(row(f, attempt).late_observed_at, iso(due + 5));
  assert.deepEqual(row(f, started), current);
  assert.equal(f.store.reserveManagedWake(request(f), due + 6).dispatch, false);
});

test.each(["claim-and-ack", "empty-claim", "native-input"] as const)("2.3/2.6: after a restart, %s of the same birth decides the slot by the boundary rule only", kind => {
  const f = fixture();
  const {messageId} = submit(f, "restart-body", f.now);
  const attempt = handOff(f);
  const original = row(f, attempt);
  reopen(f);
  const at = f.now + 10_000;
  keep(f, f.now + 3, at);
  if (kind === "claim-and-ack") {
    const claimed = f.store.claim(target, at);
    assert.deepEqual(claimed.map(value => value.messageId), [messageId]);
    assert.equal(f.store.acknowledge(target, [messageId], at + 1, claimed.map(value => ({messageId: value.messageId, claimReceipt: value.claimReceipt!}))), 1);
  } else if (kind === "empty-claim") {
    // The body is expired so the claim takes nothing, but it is still a claim boundary of the live birth.
    f.store.database.prepare("UPDATE messages SET expires_at = ? WHERE message_id = ?").run(iso(at - 1), messageId);
    assert.deepEqual(f.store.claim(target, at), []);
  } else f.store.observeNativeInput(target, at);
  submit(f, "next-body", at + 2);
  f.store.prune(at + 3);
  if (kind === "native-input") {
    assert.deepEqual(row(f, attempt), original, "native input is activity, not a boundary");
    assert.equal(f.store.reserveManagedWake(request(f), at + 4).dispatch, false);
    return;
  }
  assert.deepEqual([row(f, attempt).state, row(f, attempt).release_reason], ["released", "claimed-after-handoff"]);
  assert.equal(row(f, attempt).observed_at, null, "a boundary is no evidence the marker was consumed");
  assert.equal(f.store.reserveManagedWake(request(f), at + 4).dispatch, false, "not quiet yet");
  keep(f, at, at + WAKE_QUIET_MS + 1);
  dispatched(f.store.reserveManagedWake(request(f), at + WAKE_QUIET_MS + 1));
});

test("2.2: a transient failure retries with a new row after backoff; a new birth does not inherit the backoff", () => {
  const f = fixture();
  submit(f, "transient-body", f.now);
  const attempt = handOff(f, "started");
  assert.equal(f.store.recordManagedWakeOutcome(attempt, TRANSIENT, BASE, f.now + 2), true);
  assert.equal(row(f, attempt).state, "not-delivered");
  const retryAt = Date.parse(String(path(f)!.retry_not_before));
  assert.ok(retryAt > f.now + 2);
  reopen(f);
  keep(f, f.now + 10_000, retryAt - 1);
  assert.equal(f.store.reserveManagedWake(request(f), retryAt - 1).dispatch, false);
  keep(f, retryAt - 1, retryAt);
  const retry = dispatched(f.store.reserveManagedWake(request(f), retryAt));
  assert.notEqual(retry.nonce, attempt.nonce);
  assert.notEqual(retry.attemptId, attempt.attemptId);
  const restarted = dispatched(f.store.startManagedWake(retry, BASE, retryAt));
  assert.equal(restarted.dispatchEpoch, 1);
  assert.equal(f.store.recordManagedWakeOutcome(restarted, TRANSIENT, BASE, retryAt + 1), true);
  assert.equal(f.store.endPresence(target, "synthetic-restart", "instance-1", retryAt + 2), true);
  live(f, "instance-2", "relay-1", retryAt + 3);
  const replacement = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), retryAt + 3));
  assert.notEqual(replacement.attemptId, restarted.attemptId);
  assert.equal(path(f, "instance-2")!.failures, 0);
});

test("2.8: a reservation replaced by a new birth ends as not-delivered and the public send reports facts, never latched", () => {
  const f = fixture();
  submit(f, "reserved-before-restart", f.now);
  const reserved = dispatched(f.store.reserveManagedWake(request(f), f.now));
  assert.equal(f.store.endPresence(target, "synthetic-restart", "instance-1", f.now + 1), true);
  live(f, "instance-2", "relay-1", f.now + 2);
  const replacement = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), f.now + 2));
  assert.equal(row(f, reserved).state, "not-delivered");
  assert.notEqual(replacement.attemptId, reserved.attemptId);
  const started = dispatched(f.store.startManagedWake(replacement, BASE, f.now + 3));
  assert.equal(f.store.recordManagedWakeOutcome(started, HANDED, BASE, f.now + 4), true);
  reopen(f);
  const at = f.now + 4 + WAKE_QUIET_MS + 1;
  keep(f, f.now + 10_000, at, "instance-2", "relay-1");
  const draft = f.store.prepare({sender, target, body: "prepared-after-hand-off"}, at);
  const receipt = f.store.submitPrepared(sender, draft.messageId, at + 1);
  assert.equal(receipt.duplicate, false);
  assert.deepEqual([receipt.autoWake.state, receipt.autoWake.reason, receipt.autoWake.basisAt], ["available", "wake-unanswered", row(f, started).resend_due_at]);
  const duplicate = f.store.submitPrepared(sender, draft.messageId, at + 2);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.autoWake.reason, "wake-unanswered");
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), at + 2).dispatch, false);
});

// V4: under the 2.x expiry+grace rule the message that caused a lost wake expired before the release.
test("I7: a default-TTL message is delivered after the first unobserved marker is released at its resend deadline", () => {
  const f = fixture();
  const prepared = f.store.prepare({sender, target, body: "default-ttl-body"}, f.now);
  const message = f.store.submitPrepared(sender, prepared.messageId, f.now);
  const lost = handOff(f);
  const releaseAt = f.now + 2 + BASE;
  keep(f, f.now + 3, releaseAt - 1);
  assert.equal(f.store.reserveManagedWake(request(f), releaseAt - 1).dispatch, false);
  assert.equal(row(f, lost).state, "handed-off");
  keep(f, releaseAt - 1, releaseAt);
  const next = handOff(f, "handed-off", releaseAt);
  assert.deepEqual([row(f, lost).state, row(f, lost).release_reason, row(f, lost).released_at], ["released", "resend-due", iso(releaseAt)]);
  const delivered = observe(f, next, releaseAt + 3);
  assert.equal(delivered.recognized, true);
  assert.deepEqual(delivered.messages.map(value => value.messageId), [message.messageId]);
});

// Bounds markers parked in a host queue (Codex keeps queued items while a thread is interrupted or running).
test("I8: consecutive unanswered hand-offs of one birth double the resend interval; an observation resets it", () => {
  const f = fixture();
  const parked = submit(f, "parked-body", f.now);
  const first = handOff(f);
  assert.equal(row(f, first).resend_due_at, iso(f.now + 2 + BASE));
  const secondAt = f.now + 2 + BASE;
  keep(f, f.now + 3, secondAt);
  const second = handOff(f, "handed-off", secondAt);
  assert.equal(row(f, first).release_reason, "resend-due");
  assert.equal(path(f)!.streak, 1);
  assert.equal(row(f, second).resend_due_at, iso(secondAt + 2 + 2 * BASE));
  keep(f, secondAt, secondAt + 2 + 2 * BASE - 1);
  assert.equal(f.store.reserveManagedWake(request(f), secondAt + 2 + 2 * BASE - 1).dispatch, false);
  const thirdAt = secondAt + 2 + 2 * BASE;
  keep(f, thirdAt - 1, thirdAt);
  const third = handOff(f, "handed-off", thirdAt);
  assert.equal(path(f)!.streak, 2);
  assert.equal(row(f, third).resend_due_at, iso(thirdAt + 2 + 4 * BASE));
  const observed = observe(f, third, thirdAt + 3);
  assert.equal(observed.recognized, true);
  assert.deepEqual(observed.messages.map(value => value.messageId), [parked.messageId]);
  assert.equal(path(f)!.streak, 0);
  // The woken session acknowledges the parked body, so no live claim lease keeps a body in delivery (2.5 gate 2).
  assert.equal(f.store.acknowledge(target, [parked.messageId], thirdAt + 4, observed.messages.map(value => ({messageId: value.messageId, claimReceipt: value.claimReceipt!}))), 1);
  f.store.clearDeferred(target, thirdAt + 4); // The woken turn ends (3.5.2: a wake opens a turn and its turn-end hook closes it).
  const fourthAt = thirdAt + 4 + WAKE_QUIET_MS + 1;
  keep(f, thirdAt + 3, fourthAt);
  submit(f, "after-observed-body", fourthAt);
  const fourth = handOff(f, "handed-off", fourthAt);
  assert.equal(row(f, fourth).resend_due_at, iso(fourthAt + 2 + BASE));
});

test("I8/r3 F2: the first hand-off of a new birth does not inherit the previous birth's streak", () => {
  const f = fixture();
  submit(f, "rebirth-body", f.now);
  const first = handOff(f);
  const at = f.now + 2 + BASE;
  keep(f, f.now + 3, at);
  handOff(f, "handed-off", at);
  assert.equal(row(f, first).release_reason, "resend-due");
  assert.equal(path(f)!.streak, 1);
  assert.equal(f.store.endPresence(target, "synthetic-restart", "instance-1", at + 3), true);
  live(f, "instance-2", "relay-2", at + 4);
  const next = handOff(f, "handed-off", at + 4, "instance-2", "relay-2");
  assert.equal(row(f, next).resend_due_at, iso(at + 6 + BASE));
  assert.equal(path(f, "instance-2")!.streak, 0);
});
