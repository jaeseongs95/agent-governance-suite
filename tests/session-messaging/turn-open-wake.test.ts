import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, test, vi} from "vitest";
import {SessionMessageStore, WAKE_QUIET_MAX_MS, WAKE_QUIET_MS, type WakeAttempt, type WakeReservation} from "../../mcp-server/src/session-message-store.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {adaptHostInput, registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {recordWakeHookObservation, wakeHookObservationReader, type WakeDispatchOutcome} from "../../mcp-server/src/session-message-wake-port.js";

// 3.5.2: a session whose turn is open (a prompt or a wake started it and its turn end has not run) is not rung.
// Without this a body that arrived during a long command was rung into the host queue, a later boundary of the
// same turn took the body, and the queued marker reached the host after the turn as an empty wake.
// Synthetic store cases with real temporary SQLite connections; every clock is an explicit argument.
const host = "turn-open-wake-synthetic";
registerHookHostAdapter(host, {
  adaptInput(input, selectedHost) {
    const adapted = adaptHostInput(input, "codex");
    return {...adapted, observation: {...adapted.observation, host: selectedHost,
      actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_TURN_OPEN_ROOT"}}};
  },
  deliveryProfile: () => ({transport: "turn-open-synthetic", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined,
});

const BASE = 10 * 60_000;
const HANDED: WakeDispatchOutcome = {result: "handed-off"};
const transport = "turn-open-synthetic";
const target = {host, sessionId: "turn-open-target"};
const sender = {host, sessionId: "turn-open-sender"};
const capabilities = {supportedInjection: ["peer-wake"], idleWake: "silent"} as const;
const resources: {directory: string; store: SessionMessageStore}[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const {directory, store} of resources.splice(0)) {
    store.close();
    rmSync(directory, {recursive: true, force: true});
  }
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "ags-turn-open-wake-"));
  const store = new SessionMessageStore(join(directory, "messages.sqlite3"));
  resources.push({directory, store});
  const f = {directory, store, now: Date.now(), relays: new Map<string, string>()};
  live(f, "instance-1", "relay-1", f.now);
  return f;
}
type Fixture = ReturnType<typeof fixture>;
function live(f: Fixture, instanceId: string, relay: string, at: number) {
  f.store.startPresence({...target, instanceId, transport, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: {supportedInjection: [...capabilities.supportedInjection], idleWake: capabilities.idleWake}, hostPid: process.pid}, at);
  const granted = f.store.grantRelay({...target, instanceId, transport, codeDigest: null, hostPid: process.pid}, at);
  assert.ok(granted.relayId, `grant refused: ${granted.reason}`);
  assert.equal(f.store.relayTick({...target, instanceId, relayId: granted.relayId, transport, includePending: false,
    hostStart: "synthetic-host-start"}, at).alive, true);
  f.relays.set(relay, granted.relayId);
}
function request(f: Fixture, instanceId = "instance-1", relay = "relay-1") {
  return {...target, instanceId, relayId: f.relays.get(relay)!, nonce: `turn-${Math.random().toString(36).slice(2, 10)}-nonce-abcdefghijklmnop`,
    transport, resume: true};
}
// A live relay renews its lease and presence every few seconds; model that up to `to` without any claim boundary.
function keep(f: Fixture, from: number, to: number, instanceId = "instance-1", relay = "relay-1") {
  for (let at = from; ; at = Math.min(at + 10_000, to)) {
    assert.equal(f.store.relayTick({...target, instanceId, relayId: f.relays.get(relay)!, transport, includePending: false}, at).alive, true);
    if (at === to) return;
  }
}
function submit(f: Fixture, body: string, at: number) {
  return f.store.submitPrepared(sender, f.store.prepare({sender, target, body, ttlSeconds: 86400}, at).messageId, at);
}
function dispatched(reservation: WakeReservation): WakeAttempt {
  assert.equal(reservation.dispatch, true);
  assert.ok(reservation.attempt);
  return reservation.attempt;
}

test("a prompt opens the turn: no wake while it runs, even past the quiet window, and one after the turn ends", () => {
  const f = fixture();
  f.store.observeNativeInput(target, f.now + 1);
  submit(f, "during-the-turn", f.now + 2);
  assert.equal(f.store.reserveManagedWake(request(f), f.now + 3).dispatch, false);
  const later = f.now + WAKE_QUIET_MS + 10_000;
  keep(f, f.now + 3, later);
  assert.equal(f.store.reserveManagedWake(request(f), later).dispatch, false, "a long command keeps the turn open");
  f.store.clearDeferred(target, later + 1);
  dispatched(f.store.reserveManagedWake(request(f), later + 2));
});

test("a turn whose end never ran yields once the oldest body has waited the quiet maximum", () => {
  const f = fixture();
  f.store.observeNativeInput(target, f.now + 1);
  submit(f, "turn-end-missed", f.now + 2);
  const waited = f.now + 2 + WAKE_QUIET_MAX_MS;
  keep(f, f.now + 3, waited - 1);
  assert.equal(f.store.reserveManagedWake(request(f), waited - 1).dispatch, false);
  keep(f, waited - 1, waited);
  dispatched(f.store.reserveManagedWake(request(f), waited));
});

test("an open turn of an earlier birth does not hold the next birth's wake", () => {
  const f = fixture();
  f.store.observeNativeInput(target, f.now + 1);
  live(f, "instance-2", "relay-2", f.now + 2);
  submit(f, "after-restart", f.now + 3);
  dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.now + 4));
});

test("a wake opens the turn too: a body that arrives during it waits for the turn end", () => {
  const f = fixture();
  submit(f, "first", f.now + 1);
  const attempt = dispatched(f.store.startManagedWake(dispatched(f.store.reserveManagedWake(request(f), f.now + 2)), BASE, f.now + 3));
  assert.equal(f.store.recordManagedWakeOutcome(attempt, HANDED, BASE, f.now + 4), true);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", join(f.directory, "trust.sqlite3"));
  const observation = adaptHostInput({hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "",
    prompt: `[agent-governance-suite:wake:${attempt.nonce}]`}, host).observation;
  const claimed = f.store.claimHostWake(target, observation, recordWakeHookObservation(observation, f.now + 5), wakeHookObservationReader, f.now + 6);
  assert.deepEqual(claimed.messages.map(message => message.body), ["first"]);
  assert.equal(f.store.acknowledge(target, claimed.messages.map(message => message.messageId), f.now + 6,
    claimed.messages.map(message => ({messageId: message.messageId, claimReceipt: message.claimReceipt!}))), 1);
  submit(f, "second", f.now + 7);
  const later = f.now + WAKE_QUIET_MS + 10_000;
  keep(f, f.now + 7, later);
  assert.equal(f.store.reserveManagedWake(request(f), later).dispatch, false, "the wake's turn is still open");
  f.store.clearDeferred(target, later + 1);
  dispatched(f.store.reserveManagedWake(request(f), later + 2));
});
