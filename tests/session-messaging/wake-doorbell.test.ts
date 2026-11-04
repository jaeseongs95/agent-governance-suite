import assert from "node:assert/strict";
import { fork, type ForkOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test, vi } from "vitest";
import {
  SessionMessageStore, WAKE_FAILURE_LIMIT, WAKE_QUIET_MAX_MS, WAKE_QUIET_MS, WAKE_RESEND_MAX_MS, WAKE_START_TIMEOUT_MS,
  type WakeAttempt, type WakeReservation,
} from "../../mcp-server/src/session-message-store.js";
import { dispatchSessionMessageOperation as dispatch } from "../../mcp-server/src/session-message-operations.js";
import { dispatchManagedWake } from "../../mcp-server/src/session-message-relay.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import {
  recordWakeHookObservation, wakeBackoffDelay, wakeHookObservationReader,
  type WakeDispatchOutcome, type WakeDispatchPort,
} from "../../mcp-server/src/session-message-wake-port.js";
import { transportWakePort } from "../../mcp-server/src/wake-transports.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";
import { TrustStore } from "../../mcp-server/src/trust-store.js";

// AGS 3.0 wake doorbell (docs/ags30-wake-doorbell-design.md r3.2, 7.1). Synthetic store-level cases with real temporary
// SQLite connections. Every time is an explicit argument; no case waits on wall time, raises a limit or retries.
// Long synchronous sweeps run each simulated step, or the whole sweep, as one writer transaction (store.atomically): the
// cases assert state transitions at explicit times, never durability between steps, so they need one commit, not one per
// call (on Windows every commit is a synchronous flush). The stores' own durability settings are unchanged.
// Expected values come from the design formulas (2.2, 2.4-2.8), never from the implementation under test.
const host = "doorbell-synthetic";
registerHookHostAdapter(host, {
  adaptInput(input, selectedHost) {
    const adapted = adaptHostInput(input, "codex");
    return { ...adapted, observation: { ...adapted.observation, host: selectedHost,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_DOORBELL_ROOT" } } };
  },
  deliveryProfile: () => ({ transport: "doorbell-synthetic", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  processPid: () => undefined,
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE = 10 * MINUTE;
const TRANSPORT = "doorbell-synthetic";
const target = { host, sessionId: "doorbell-target" };
const sender = { host, sessionId: "doorbell-sender" };
const capabilities: NonNullable<Parameters<SessionMessageStore["startPresence"]>[0]["deliveryCapabilities"]> = {
  supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent",
};
const HANDED: WakeDispatchOutcome = { result: "handed-off" };
const UNKNOWN: WakeDispatchOutcome = { result: "unknown", reasonCode: "SYNTHETIC_TIMEOUT" };
const TRANSIENT: WakeDispatchOutcome = { result: "not-delivered", kind: "transient", reasonCode: "CODEX_NO_ACTIVE_SESSION" };
const PREREQ: WakeDispatchOutcome = { result: "not-delivered", kind: "prerequisite-missing", reasonCode: "SYNTHETIC_EXECUTABLE_MISSING" };
// The synthetic host process the hook reported and the birth its relay's watcher bound (docs/ags30-broker-redesign.md 3.3).
const HOST_PID = process.pid;
const HOST_START = "synthetic-host-start";
const iso = (at: number) => new Date(at).toISOString();
type Row = Record<string, unknown>;

const resources: { directory: string; close: Array<() => void> }[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const { directory, close } of resources.splice(0)) {
    for (const item of close) item();
    rmSync(directory, { recursive: true, force: true });
  }
});

let nonceCounter = 0;
const nextNonce = () => `doorbell-${++nonceCounter}-nonce-abcdefghijklmnop`;

interface Fixture {
  directory: string; database: string; store: SessionMessageStore; t0: number;
  instanceId: string; relayId: string; transport: string;
}
function fixture(transport = TRANSPORT): Fixture {
  const directory = mkdtempSync(join(tmpdir(), "ags-wake-doorbell-"));
  const database = join(directory, "messages.sqlite3");
  const store = new SessionMessageStore(database);
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", join(directory, "trust.sqlite3"));
  // Held open for the fixture's life, as the running server holds its trust connection. Each hook observation still opens
  // and closes its own connection (recordWakeHookObservation and the reader are unchanged); with this one open, a close
  // no longer checkpoints and deletes the WAL that the next open creates again.
  const trust = new TrustStore(join(directory, "trust.sqlite3"));
  resources.push({ directory, close: [() => store.close(), () => trust.close()] });
  const f: Fixture = { directory, database, store, t0: Date.now(), instanceId: "instance-1", relayId: "", transport };
  live(f, "instance-1", f.t0);
  return f;
}
/** The hook grants a lease to the birth; the relay's first tick binds the host birth, so the relay may ring. */
function bindRelay(f: Fixture, instanceId: string, at: number) {
  const grant = f.store.grantRelay({ ...target, instanceId, transport: f.transport, codeDigest: null, hostPid: HOST_PID }, at);
  assert.ok(grant.relayId, `grant refused: ${grant.reason}`);
  assert.deepEqual(f.store.relayTick({ ...target, instanceId, transport: f.transport, relayId: grant.relayId, includePending: false, hostStart: HOST_START }, at),
    { alive: true, count: 0, hostBound: true });
  f.instanceId = instanceId; f.relayId = grant.relayId;
}
function live(f: Fixture, instanceId: string, at: number, caps = capabilities) {
  f.store.startPresence({ ...target, instanceId, transport: f.transport, wakeVisibility: caps.idleWake, canWakeSilently: caps.idleWake === "silent",
    deliveryCapabilities: caps, hostPid: HOST_PID }, at);
  bindRelay(f, instanceId, at);
}
/** Keeps the current birth and its relay live across a gap without a new birth and without any claim boundary. */
function jump(f: Fixture, at: number) {
  f.store.atomically(() => {
    f.store.database.prepare("UPDATE session_presence SET lease_until = ? WHERE host = ? AND session_id = ? AND instance_id = ? AND ended_at IS NULL")
      .run(iso(at + 20_000), target.host, target.sessionId, f.instanceId);
    // The relay kept renewing its lease over the gap (one extension models its ticks); a pruned lease is granted again.
    const renewed = f.store.database.prepare("UPDATE relay_leases SET lease_until = ?, updated_at = ? WHERE host = ? AND session_id = ? AND transport = ? AND relay_id = ?")
      .run(iso(at + 15_000), iso(at), target.host, target.sessionId, f.transport, f.relayId).changes;
    if (renewed === 0) bindRelay(f, f.instanceId, at);
  });
}
/** A live relay renews its lease every few seconds (relay-tick only; not a claim boundary). */
function keep(f: Fixture, from: number, to: number) {
  // Every tick still runs, at the same times; the ticks of one gap share one commit.
  f.store.atomically(() => {
    for (let at = from; ; at = Math.min(at + 10_000, to)) {
      assert.equal(f.store.relayTick({ ...target, instanceId: f.instanceId, relayId: f.relayId, transport: f.transport, includePending: false }, at).alive, true);
      if (at === to) return;
    }
  });
}
function send(f: Fixture, id: string, at: number, ttlSeconds = 86_400) {
  f.store.send({ sender, target, messageId: id, body: id, ttlSeconds }, at);
}
function request(f: Fixture, nonce = nextNonce()) {
  return { ...target, nonce, instanceId: f.instanceId, relayId: f.relayId, transport: f.transport, resume: true };
}
function reserve(f: Fixture, at: number): WakeReservation { return f.store.reserveManagedWake(request(f), at); }
function dispatched(reservation: WakeReservation): WakeAttempt {
  assert.equal(reservation.dispatch, true);
  assert.ok(reservation.attempt);
  return reservation.attempt;
}
function ring(f: Fixture, at: number, base = BASE): WakeAttempt {
  return dispatched(f.store.startManagedWake(dispatched(reserve(f, at)), base, at));
}
function handOff(f: Fixture, at: number, outcome: WakeDispatchOutcome = HANDED, base = BASE): WakeAttempt {
  const attempt = ring(f, at, base);
  assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome, base, at), true);
  return attempt;
}
function row(f: Fixture, attempt: WakeAttempt): Row {
  const value = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId) as Row | undefined;
  assert.ok(value, "attempt row exists");
  return { ...value };
}
/** The wake path state of the current birth (2.3); null before the birth was ever rung or crossed a boundary. */
function birthPath(f: Fixture): Row | null {
  const presence = f.store.presence(target, f.t0);
  const value = f.store.database.prepare(`SELECT * FROM wake_paths WHERE host = ? AND session_id = ? AND instance_id = ? AND birth_generation = ?`)
    .get(target.host, target.sessionId, presence.instanceId, presence.startedAt) as Row | undefined;
  return value ? { ...value } : null;
}
function activeCount(f: Fixture): number {
  return Number((f.store.database.prepare(`SELECT count(*) AS n FROM wake_nonces WHERE host = ? AND session_id = ?
    AND state IN ('reserved', 'started', 'handed-off', 'unknown')`).get(target.host, target.sessionId) as { n: number }).n);
}
function observe(f: Fixture, nonces: string[], at: number) {
  const observation = adaptHostInput({ hook_event_name: "UserPromptSubmit", session_id: target.sessionId, agent_id: "",
    prompt: nonces.map(nonce => `[agent-governance-suite:wake:${nonce}]`).join("\n") }, host).observation;
  const receipt = recordWakeHookObservation(observation, at);
  return f.store.claimHostWake(target, observation, receipt, wakeHookObservationReader, at + 1);
}
function outlook(f: Fixture, at: number) { return f.store.autoWakeOutlook(target, at); }
/** A boundary claim that takes one body and acknowledges it at once, so no live claim lease remains. */
function boundary(f: Fixture, at: number) {
  const claimed = f.store.claimTurnEnd(target, at, { maxMessages: 1 });
  if (claimed.length > 0) assert.equal(f.store.acknowledge(target, claimed.map(m => m.messageId), at,
    claimed.map(m => ({ messageId: m.messageId, claimReceipt: m.claimReceipt! }))), claimed.length);
  return claimed;
}
/** Design 2.4: retry_not_before = failure time + wakeBackoffDelay(failures); either count base is accepted. */
function assertBackoff(path: Row, failedAt: number) {
  const failures = Number(path.failures);
  const retryAt = Date.parse(String(path.retry_not_before));
  assert.ok([failedAt + wakeBackoffDelay(failures), failedAt + wakeBackoffDelay(failures - 1)].includes(retryAt),
    `retry_not_before ${path.retry_not_before} follows wakeBackoffDelay after ${failures} failures`);
  assert.ok(retryAt - failedAt <= 10 * MINUTE, "backoff stays under its 10 minute cap");
  return retryAt;
}

test("1: a stalled adapter call stays one external call across boundaries and time; its late not-delivered still reaches the birth state", async () => {
  const f = fixture();
  send(f, "stalled-body", f.t0);
  let clock = f.t0;
  let calls = 0;
  let release!: (outcome: WakeDispatchOutcome) => void;
  let entered!: () => void;
  const inCall = new Promise<void>(resolve => { entered = resolve; });
  const bases: unknown[] = [];
  const port: WakeDispatchPort = { capabilities, resendBaseMs: BASE, dispatch: async () => {
    calls++; entered(); return new Promise<WakeDispatchOutcome>(resolve => { release = resolve; });
  } };
  // The relay's dispatch requests run against the same store with the fixture clock (the cycle itself never renews the lease).
  const relayRequest = (async (operation: string, payload: Record<string, any>) => { // eslint-disable-line @typescript-eslint/no-explicit-any -- operation payload
    const attempt = payload.attempt ?? payload;
    if (operation === "reserve-wake") return f.store.reserveManagedWake({ ...payload.target, nonce: payload.nonce, instanceId: payload.instanceId,
      relayId: payload.relayId, transport: payload.transport, resume: payload.resume }, clock);
    if (operation === "start-wake") { bases.push(payload.resendBaseMs); return f.store.startManagedWake(attempt, payload.resendBaseMs, clock); }
    if (operation === "record-wake-outcome") {
      bases.push(payload.resendBaseMs);
      return { recorded: f.store.recordManagedWakeOutcome(attempt, payload.outcome, payload.resendBaseMs, clock) };
    }
    throw new Error(`unexpected relay operation ${operation}`);
  }) as unknown as Parameters<typeof dispatchManagedWake>[3];
  const running = dispatchManagedWake({ ...target, instanceId: f.instanceId, transport: f.transport }, f.relayId, port, relayRequest);
  await inCall;
  const attempt = (f.store.database.prepare("SELECT * FROM wake_nonces WHERE state = 'started'").get() as Row);
  assert.ok(attempt, "the effect started after a committed start CAS");
  // A boundary takes the body while the adapter call is stalled; the session gets busy.
  clock = f.t0 + 30_000; jump(f, clock);
  assert.deepEqual(boundary(f, clock).map(m => m.messageId), ["stalled-body"]);
  // Past WAKE_START_TIMEOUT_MS the stalled start becomes unknown with its resend deadline (2.2, r3 N1).
  clock = f.t0 + WAKE_START_TIMEOUT_MS + 1_000; jump(f, clock); f.store.prune(clock);
  const timedOut = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(String(attempt.attempt_id)) as Row;
  assert.equal(timedOut.state, "unknown");
  assert.equal(timedOut.outcome_at, iso(clock));
  assert.equal(timedOut.resend_due_at, iso(clock + BASE));
  // A later boundary releases the slot (claimed-after-handoff); the next body still finds the session not quiet.
  clock += 20_000; jump(f, clock); send(f, "next-body", clock - 1); boundary(f, clock);
  // The boundary is recorded after the claim's own prune, so the release is settled by the next prune (as in 2.6).
  f.store.prune(clock);
  const releasedRow = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(String(attempt.attempt_id)) as Row;
  assert.equal(releasedRow.state, "released");
  assert.equal(releasedRow.release_reason, "claimed-after-handoff");
  clock += 1_000; jump(f, clock); send(f, "third-body", clock);
  assert.equal(await dispatchManagedWake({ ...target, instanceId: f.instanceId, transport: f.transport }, f.relayId, port, relayRequest), false);
  assert.equal(calls, 1);
  // The adapter finally reports a definite transient failure: the ended row stays ended, the birth counts the failure.
  clock += 10_000; jump(f, clock);
  const before = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(String(attempt.attempt_id)) as Row;
  release(TRANSIENT);
  await running;
  assert.deepEqual(f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(String(attempt.attempt_id)), before);
  const path = birthPath(f)!;
  assert.equal(path.failures, 1);
  assert.equal(path.last_failure_at, iso(clock));
  assertBackoff(path, clock);
  assert.equal(calls, 1);
  // The relay passed the port's declared base on both requests (3.1), never a hook-supplied value.
  assert.deepEqual(bases, [BASE, BASE]);
});

test("2: an outcome or start for an ended row is refused and never revives it (I11)", () => {
  const f = fixture();
  send(f, "terminal-body", f.t0, 86_400);
  // observed
  const observedAttempt = handOff(f, f.t0);
  assert.equal(observe(f, [observedAttempt.nonce], f.t0 + 1).recognized, true);
  f.store.clearDeferred(target, f.t0 + 1); // The woken turn ends (3.5.2: a wake opens a turn and its turn-end hook closes it).
  // released by resend-due
  const t1 = f.t0 + 2 * MINUTE + WAKE_QUIET_MS;
  jump(f, t1); send(f, "terminal-body-2", t1);
  const releasedAttempt = handOff(f, t1);
  const t2 = t1 + BASE; jump(f, t2);
  const notDeliveredAttempt = ring(f, t2);
  assert.equal(row(f, releasedAttempt).state, "released");
  assert.equal(row(f, releasedAttempt).release_reason, "resend-due");
  assert.equal(f.store.recordManagedWakeOutcome(notDeliveredAttempt, TRANSIENT, BASE, t2), true);
  assert.equal(row(f, notDeliveredAttempt).state, "not-delivered");
  const refused: WakeDispatchOutcome[] = [HANDED, UNKNOWN, TRANSIENT, PREREQ];
  for (const ended of [observedAttempt, releasedAttempt, notDeliveredAttempt]) {
    const before: Record<string, unknown> = row(f, ended);
    for (const outcome of refused) {
      assert.equal(f.store.recordManagedWakeOutcome(ended, outcome, BASE, t2 + 1), false, `${before.state} refuses ${outcome.result}`);
      assert.deepEqual(row(f, ended), before);
    }
    assert.equal(f.store.startManagedWake(ended, BASE, t2 + 1).dispatch, false);
    assert.equal(f.store.startManagedWake({ ...ended, dispatchEpoch: ended.dispatchEpoch - 1 }, BASE, t2 + 1).dispatch, false);
    assert.deepEqual(row(f, ended), before);
  }
});

test("2a: a relay that dies mid hand-off times out to unknown and a quiet session is rung again at resend_due_at", () => {
  const f = fixture();
  send(f, "crash-body", f.t0);
  const crashed = ring(f, f.t0); // started; the relay never records an outcome
  keep(f, f.t0, f.t0 + WAKE_START_TIMEOUT_MS - 1);
  f.store.prune(f.t0 + WAKE_START_TIMEOUT_MS - 1);
  assert.equal(row(f, crashed).state, "started");
  const timeoutAt = f.t0 + WAKE_START_TIMEOUT_MS + 5_000;
  keep(f, f.t0 + WAKE_START_TIMEOUT_MS - 1, timeoutAt);
  f.store.prune(timeoutAt);
  const unknown = row(f, crashed);
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.resend_base_ms, BASE);
  assert.equal(unknown.outcome_at, iso(timeoutAt));
  assert.equal(unknown.resend_due_at, iso(timeoutAt + BASE));
  const due = timeoutAt + BASE;
  jump(f, due - 1);
  assert.equal(reserve(f, due - 1).dispatch, false, "no second effect before the resend deadline (I4)");
  jump(f, due);
  const next = dispatched(reserve(f, due));
  assert.notEqual(next.nonce, crashed.nonce);
  assert.notEqual(next.attemptId, crashed.attemptId);
  assert.equal(row(f, crashed).state, "released");
  assert.equal(row(f, crashed).release_reason, "resend-due");
  assert.equal(row(f, crashed).released_at, iso(due));
  assert.equal(birthPath(f)!.streak, 1);
});

test("2c and 11: repeated start-up transients never disable waking; a hand-off resets failures and lifts degraded", () => {
  const f = fixture("codex-queue");
  const base = 20 * MINUTE;
  send(f, "startup-body", f.t0);
  let at = f.t0;
  for (let failure = 1; failure <= WAKE_FAILURE_LIMIT + 1; failure++) {
    jump(f, at);
    const attempt = ring(f, at, base);
    assert.equal(f.store.recordManagedWakeOutcome(attempt, TRANSIENT, base, at), true);
    assert.equal(row(f, attempt).state, "not-delivered");
    const path = birthPath(f)!;
    assert.equal(path.failures, failure);
    assert.equal(path.prerequisite_missing, null, "a transient is never a prerequisite loss");
    const retryAt = assertBackoff(path, at);
    const view = outlook(f, at + 1);
    if (failure >= WAKE_FAILURE_LIMIT) assert.deepEqual([view.state, view.reason, view.basisAt], ["degraded", "wake-failing", iso(at)]);
    else assert.deepEqual([view.state, view.reason, view.basisAt], ["available", "retry-backoff", path.retry_not_before]);
    jump(f, retryAt - 1);
    assert.equal(reserve(f, retryAt - 1).dispatch, false, "backoff holds");
    at = retryAt;
  }
  jump(f, at);
  const accepted = handOff(f, at, HANDED, base);
  assert.equal(birthPath(f)!.failures, 0);
  const view = outlook(f, at + 1);
  assert.deepEqual([view.state, view.reason, view.basisAt], ["available", "wake-in-flight", iso(at)]);
  assert.equal(row(f, accepted).state, "handed-off");
  // unknown also resets the failure count (r3 F1).
  const g = fixture();
  send(g, "unknown-body", g.t0);
  assert.equal(g.store.recordManagedWakeOutcome(ring(g, g.t0), TRANSIENT, BASE, g.t0), true);
  const retry = Date.parse(String(birthPath(g)!.retry_not_before));
  jump(g, retry);
  handOff(g, retry, UNKNOWN);
  assert.equal(birthPath(g)!.failures, 0);
});

test("3 (I7, I8): alternating not-delivered and resend-due over 24 hours follows the doubling schedule, also after row deletion", () => {
  const f = fixture();
  send(f, "day-body", f.t0, 86_400);
  const step = 5 * MINUTE;
  const handed: number[] = [];
  let transientNext = false;
  // Contract (I7, I8): over 24 hours probed every 5 minutes, hand-offs follow the doubling resend schedule, also after
  // terminal rows are deleted. The sweep is one writer transaction; every probe still runs at its own explicit time.
  f.store.atomically(() => {
    for (let offset = 0; offset < 24 * HOUR - step; offset += step) {
      const at = f.t0 + offset;
      jump(f, at);
      const reservation = reserve(f, at);
      if (reservation.dispatch) {
        const attempt = dispatched(f.store.startManagedWake(reservation.attempt!, BASE, at));
        const outcome: WakeDispatchOutcome = transientNext ? TRANSIENT : HANDED;
        assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome, BASE, at), true);
        if (!transientNext) handed.push(offset);
        transientNext = !transientNext;
      }
      // Terminal rows may be deleted (retention cap); the birth state keeps the streak (2.6).
      if (offset % HOUR === 0) f.store.database.prepare(`DELETE FROM wake_nonces WHERE host = ? AND session_id = ?
        AND state IN ('released', 'not-delivered', 'observed')`).run(target.host, target.sessionId);
      if (handed.length > 0) {
        // Design bound: k hand-offs need at least (2^(k-1) - 1) * base elapsed since the first (resend_due = outcome + base*2^streak).
        const elapsed = offset - handed[0]!;
        assert.ok(2 ** (handed.length - 1) - 1 <= elapsed / BASE, `I8 at +${offset / MINUTE}m: ${handed.length} hand-offs`);
      }
    }
  });
  // Oracle: the n-th hand-off is released at its outcome + min(base * 2^n, 24h); the not-delivered ring takes that probe,
  // the hand-off follows at the next 5-minute probe (the transient backoff is at most 60 seconds).
  const expected = [0];
  while (true) {
    const n = expected.length - 1;
    const next = expected[n]! + Math.min(BASE * 2 ** n, WAKE_RESEND_MAX_MS) + step;
    if (next >= 24 * HOUR - step) break;
    expected.push(next);
  }
  assert.deepEqual(handed.map(value => value / MINUTE), expected.map(value => value / MINUTE));
});

test("4: codex-queue native input and deferred clears every 30 seconds for an hour are no boundary; the wake rings and reports the facts", () => {
  const f = fixture("codex-queue");
  const base = 20 * MINUTE;
  const bodyAt = f.t0 + 5 * MINUTE;
  let rungAt: number | null = null;
  // One writer transaction for the hour; every 30-second step and relay tick still runs at its own explicit time.
  f.store.atomically(() => {
    for (let at = f.t0; at <= f.t0 + HOUR; at += 30_000) {
      if (at > f.t0) keep(f, at - 30_000, at);
      f.store.observeNativeInput(target, at);
      f.store.clearDeferred(target, at);
      if (at === bodyAt) send(f, "busy-body", at);
      const view = outlook(f, at);
      if (rungAt === null) {
        if (at < bodyAt) assert.deepEqual([view.state, view.reason], ["available", "relay-live"]);
        const reservation = reserve(f, at);
        if (at < bodyAt) assert.equal(reservation.dispatch, false, "nothing to deliver yet");
        else if (reservation.dispatch) {
          const attempt = dispatched(f.store.startManagedWake(reservation.attempt!, base, at));
          assert.equal(f.store.recordManagedWakeOutcome(attempt, HANDED, base, at), true);
          rungAt = at;
        }
      } else if (at - rungAt < WAKE_QUIET_MS) {
        assert.deepEqual([view.state, view.reason, view.basisAt], ["available", "wake-in-flight", iso(rungAt)]);
      } else if (at - rungAt > WAKE_QUIET_MS && at < rungAt + base) {
        assert.deepEqual([view.state, view.reason, view.basisAt], ["available", "wake-unanswered", iso(rungAt + base)]);
      }
    }
  });
  assert.ok(rungAt !== null && rungAt - bodyAt <= WAKE_QUIET_MAX_MS, `rung ${rungAt === null ? "never" : (rungAt - bodyAt) / 1000 + "s"} after the body`);
  assert.equal(birthPath(f)!.claim_boundary_at, null, "observeNativeInput and clearDeferred record no claim boundary");
});

test("4b (I7): a busy session is still rung once its oldest claimable body waited longer than WAKE_QUIET_MAX_MS", () => {
  const f = fixture();
  send(f, "busy-body", f.t0);
  // Every 30 seconds the session crosses a claim boundary. It claims the body without ever acknowledging it, so the body
  // becomes claimable again whenever its claim lease lapses, while the boundaries keep the session from being quiet.
  let rungAt: number | null = null;
  assert.deepEqual(f.store.claimTurnEnd(target, f.t0 + 1).map(m => m.messageId), ["busy-body"]);
  for (let at = f.t0 + 30_000; at <= f.t0 + 3 * WAKE_QUIET_MAX_MS && rungAt === null; at += 30_000) {
    keep(f, at - 30_000, at);
    const lease = (f.store.database.prepare("SELECT claim_until FROM messages WHERE message_id = 'busy-body'").get() as Row).claim_until;
    const claimable = lease === null || String(lease) <= iso(at);
    const reservation = reserve(f, at);
    if (!claimable || at - f.t0 <= WAKE_QUIET_MAX_MS) assert.equal(reservation.dispatch, false, `+${(at - f.t0) / 1000}s`);
    else {
      // The first probe where the body is claimable and has waited past the maximum must ring.
      assert.equal(reservation.dispatch, true, `+${(at - f.t0) / 1000}s`);
      rungAt = at;
    }
    if (rungAt === null) f.store.claimTurnEnd(target, at);
  }
  assert.ok(rungAt !== null, "a busy session is rung");
});

test("5: the quiet condition also holds for the backoff retry and is rechecked inside the start CAS", () => {
  const f = fixture();
  send(f, "quiet-body-a", f.t0);
  send(f, "quiet-body-b", f.t0 + 1);
  send(f, "quiet-body-c", f.t0 + 2);
  assert.equal(f.store.recordManagedWakeOutcome(ring(f, f.t0 + 3), TRANSIENT, BASE, f.t0 + 3), true);
  const retryAt = Date.parse(String(birthPath(f)!.retry_not_before));
  // A boundary just before the backoff ends: the retry must wait for quiet.
  const boundaryAt = retryAt - 5_000;
  keep(f, f.t0 + 3, boundaryAt);
  assert.equal(boundary(f, boundaryAt).length, 1);
  keep(f, boundaryAt, retryAt);
  assert.equal(reserve(f, retryAt).dispatch, false, "not quiet at the end of the backoff");
  // Quiet again: reserve passes, then a boundary lands between reserve and start; the start CAS refuses the effect.
  const quietAt = boundaryAt + WAKE_QUIET_MS + 1_000;
  keep(f, retryAt, quietAt);
  const reserved = dispatched(reserve(f, quietAt));
  assert.equal(boundary(f, quietAt + 1).length, 1);
  assert.equal(f.store.startManagedWake(reserved, BASE, quietAt + 2).dispatch, false);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'started'").get()!.n, 0);
  // Once quiet again a ring is possible: the remaining body is still waiting.
  const laterAt = quietAt + 1 + WAKE_QUIET_MS + 1_000;
  keep(f, quietAt + 2, laterAt);
  // Either the untouched reservation resumes or a new one is made; both must reach a committed start.
  const attempt = dispatched(reserve(f, laterAt));
  assert.equal(f.store.startManagedWake(attempt, BASE, laterAt).dispatch, true);
});

test("6: an expired reservation is released unconditionally (no relay, expired body, quiet session)", () => {
  const f = fixture();
  send(f, "short-body", f.t0, 30);
  const reserved = dispatched(reserve(f, f.t0));
  const expiresAt = Date.parse(String(row(f, reserved).expires_at));
  assert.ok(expiresAt > f.t0);
  // No relay tick, no presence renewal, no boundary: everything just lapses.
  f.store.prune(expiresAt);
  const released = row(f, reserved);
  assert.equal(released.state, "released");
  assert.equal(released.release_reason, "expired");
  assert.equal(released.released_at, iso(expiresAt));
  assert.equal(activeCount(f), 0);
  // The slot is free for a new birth.
  live(f, "instance-2", expiresAt + 1);
  send(f, "after-expiry", expiresAt + 1);
  dispatched(reserve(f, expiresAt + 2));
});

test("8: a prompt carrying an ended and an active marker claims the body once", () => {
  const f = fixture();
  send(f, "mixed-body", f.t0);
  const old = handOff(f, f.t0);
  const due = f.t0 + BASE;
  jump(f, due);
  const current = handOff(f, due);
  assert.equal(row(f, old).state, "released");
  const first = observe(f, [old.nonce, current.nonce], due + 1);
  assert.equal(first.recognized, true);
  assert.deepEqual(first.messages.map(m => m.messageId), ["mixed-body"]);
  assert.equal(row(f, current).state, "observed");
  assert.equal(row(f, old).state, "released");
  assert.equal(row(f, old).late_observed_at, iso(due + 2));
  const replay = observe(f, [old.nonce, current.nonce], due + 3);
  assert.deepEqual(replay.messages, []);
  assert.equal((f.store.database.prepare("SELECT delivery_attempts FROM messages WHERE message_id = 'mixed-body'").get() as Row).delivery_attempts, 1);
  assert.equal(birthPath(f)!.streak, 0, "a marker arrival resets the unanswered streak");
});

test("9: a late marker after the claim lease expired re-claims, but only as often as the lease law allows (I6)", () => {
  const f = fixture();
  send(f, "lease-body", f.t0);
  const attempt = handOff(f, f.t0);
  let claims = 0;
  const window = 2 * HOUR;
  // Contract (I6): a late marker for the same handed-off attempt, observed every minute for two hours (121 observations,
  // each with its own hook receipt), re-claims the body only as often as the claim lease law allows, and the attempt ends
  // observed. Durability between observations is not part of it, so the sweep is one writer transaction of the message
  // store; each observation still records and verifies its receipt in the trust store.
  f.store.atomically(() => {
    for (let offset = 0; offset <= window; offset += MINUTE) {
      jump(f, f.t0 + offset + 1);
      claims += observe(f, [attempt.nonce], f.t0 + offset + 1).messages.length;
    }
  });
  // Oracle: CLAIM_LEASE_BASE 2 min doubling per attempt up to 30 min gives claims at 0, 2, 6, 14, 30, 60, 90, 120 minutes.
  assert.ok(claims >= 1 && claims <= 8, `re-claims bounded by the lease law: ${claims}`);
  assert.equal(row(f, attempt).state, "observed");
});

test("10 (standalone): a backward or forward clock jump neither releases early nor locks the slot", () => {
  const f = fixture();
  send(f, "clock-body", f.t0);
  const attempt = handOff(f, f.t0);
  const before = row(f, attempt);
  // Backward (the leases written at t0 are still in the future): no early release and no second effect.
  assert.equal(reserve(f, f.t0 - HOUR).dispatch, false);
  f.store.prune(f.t0 - HOUR);
  assert.deepEqual(row(f, attempt), before);
  // Forward by two days: the hand-off is released and the quiet live session is rung.
  const later = f.t0 + 48 * HOUR;
  jump(f, later);
  // A body lives at most MESSAGE_TTL_MAX_SECONDS (24 h), so clock-body has expired; a body sent at the new time waits.
  send(f, "clock-body-later", later);
  const next = handOff(f, later);
  assert.equal(row(f, attempt).state, "released");
  assert.equal(row(f, attempt).release_reason, "resend-due");
  assert.equal(row(f, next).resend_due_at, iso(later + 2 * BASE));
  assert.equal(reserve(f, later - 30 * MINUTE).dispatch, false, "the active slot holds when time steps back");
  f.store.prune(later - 30 * MINUTE);
  assert.equal(row(f, next).state, "handed-off");
});

test("10 (shared): authority time never runs backward, so a stale caller clock cannot shorten or skip the resend deadline", () => {
  const directory = mkdtempSync(join(tmpdir(), "ags-wake-doorbell-shared-"));
  let now = Date.now();
  const keys = { workflow: Buffer.alloc(32, 7).toString("base64url"), continuity: Buffer.alloc(32, 8).toString("base64url"), trust: Buffer.alloc(32, 9).toString("base64url") };
  const value = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => now, syntheticKeys: keys });
  resources.push({ directory, close: [() => value.owner.close()] });
  const store = value.messaging;
  const t0 = now;
  store.startPresence({ ...target, instanceId: "shared-1", transport: TRANSPORT, wakeVisibility: "silent", canWakeSilently: true, deliveryCapabilities: capabilities,
    hostPid: HOST_PID }, t0);
  const relayId = store.grantRelay({ ...target, instanceId: "shared-1", transport: TRANSPORT, codeDigest: null, hostPid: HOST_PID }, t0).relayId!;
  assert.ok(relayId);
  assert.equal(store.relayTick({ ...target, instanceId: "shared-1", relayId, transport: TRANSPORT, includePending: false, hostStart: HOST_START }, t0).hostBound, true);
  store.send({ sender, target, messageId: "shared-body", body: "shared-body", ttlSeconds: 86_400 }, t0);
  const binding = { ...target, instanceId: "shared-1", relayId, transport: TRANSPORT, resume: true };
  const attempt = dispatched(store.startManagedWake(dispatched(store.reserveManagedWake({ ...binding, nonce: nextNonce() }, t0)), BASE, t0));
  // The caller passes a clock one hour behind; the authority time (high water t0) is used.
  assert.equal(store.recordManagedWakeOutcome(attempt, HANDED, BASE, t0 - HOUR), true);
  const stored = store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId) as Row;
  assert.equal(stored.outcome_at, iso(t0));
  assert.equal(stored.resend_due_at, iso(t0 + BASE));
  assert.equal(store.reserveManagedWake({ ...binding, nonce: nextNonce() }, t0 - HOUR).dispatch, false);
  // The live relay renews its lease and the presence every 10 seconds of authority time.
  for (let at = t0 + 10_000; at <= t0 + BASE; at += 10_000) {
    now = at;
    assert.equal(store.relayTick({ ...target, instanceId: "shared-1", relayId, transport: TRANSPORT, includePending: false }, at).alive, true);
  }
  // A caller still behind the authority clock: the authority time reaches the deadline.
  dispatched(store.reserveManagedWake({ ...binding, nonce: nextNonce() }, t0));
  assert.equal((store.database.prepare("SELECT state, release_reason FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId) as Row).release_reason, "resend-due");
});

test("12 (I3): two real connections reserving and starting at the same time cause one external call", async () => {
  const f = fixture();
  send(f, "race-body", f.t0);
  const worker = fileURLToPath(new URL("./fixtures/managed-wake-process.mjs", import.meta.url));
  const spawnWorker = async (relayId: string) => {
    const child = fork(worker, ["ring-race", f.database, join(f.directory, "effects.txt"), relayId, String(process.pid)],
      { execArgv: ["--import", "tsx"], silent: true, windowsHide: true } as ForkOptions);
    let stderr = ""; child.stderr!.on("data", chunk => { stderr += chunk; });
    const exit = once(child, "exit");
    const [first] = await Promise.race([once(child, "message"), exit.then(([code]) => { throw new Error(`worker exited early: ${code}; ${stderr}`); })]) as [{ type: string }];
    assert.equal(first.type, "ready", stderr);
    return { child, exit, stderr: () => stderr };
  };
  const workers = await Promise.all(["race-a", "race-b"].map(() => spawnWorker(f.relayId)));
  type Reply = { result: { dispatch: boolean; attempt: WakeAttempt | null } | null; error?: string };
  const phase = async (inputs: Array<Record<string, unknown>>) => {
    const replies = workers.map(w => once(w.child, "message"));
    workers.forEach((w, index) => w.child.send(inputs[index]!));
    return (await Promise.all(replies)).map(([message]) => message as Reply);
  };
  const binding = { ...target, instanceId: f.instanceId, relayId: f.relayId, transport: f.transport };
  // Phase 1: both reserve at once (the same lease may resume the same reservation).
  const reserved = await phase(workers.map(() => ({ phase: "reserve", binding, now: f.t0 + 1 })));
  for (const reply of reserved) assert.equal(reply.error, undefined);
  assert.ok(reserved.some(reply => reply.result?.attempt));
  // Phase 2: both start at once with what they hold; each calls the external effect only after a committed start.
  const started = await phase(reserved.map(reply => ({ phase: "start", attempt: reply.result?.attempt ?? null, resendBaseMs: BASE, now: f.t0 + 2 })));
  for (const reply of started) assert.equal(reply.error, undefined);
  for (const w of workers) { const [code] = await w.exit; assert.equal(code, 0, w.stderr()); }
  assert.equal(started.filter(reply => reply.result?.dispatch).length, 1);
  const effects = join(f.directory, "effects.txt");
  assert.equal(existsSync(effects) ? readFileSync(effects, "utf8").trim().split("\n").length : 0, 1);
  assert.equal(activeCount(f), 1);
});

const ttlCases = [
  { transport: "claude-inbox", base: 10 * MINUTE, losses: 2 },
  { transport: "antigravity-queue", base: 10 * MINUTE, losses: 2 },
  { transport: "codex-queue", base: 20 * MINUTE, losses: 1 },
];
test.each(ttlCases)("13: a default-TTL message is delivered after resend-due on $transport (base from the port, $losses lost markers)", ({ transport, base, losses }) => {
  assert.equal(transportWakePort(transport).resendBaseMs, base);
  const f = fixture(transport);
  f.store.send({ sender, target, messageId: "default-ttl", body: "default-ttl" }, f.t0);
  let at = f.t0;
  for (let lost = 0; lost < losses; lost++) {
    handOff(f, at, HANDED, base);
    at += base * 2 ** lost; // resend_due = outcome + base * 2^streak
    keep(f, at - base * 2 ** lost, at);
  }
  const delivering = handOff(f, at, HANDED, base);
  const delivered = observe(f, [delivering.nonce], at + 1);
  assert.ok(at + 2 < f.t0 + HOUR, "inside the default TTL");
  assert.equal(delivered.recognized, true);
  assert.deepEqual(delivered.messages.map(m => m.messageId), ["default-ttl"]);
});

test("14: a marker arriving after the ended-row retention claims nothing; inside it the current birth still claims", () => {
  for (const late of [false, true]) {
    const f = fixture();
    send(f, "first-body", f.t0, 600);
    const attempt = handOff(f, f.t0);
    jump(f, f.t0 + BASE); f.store.prune(f.t0 + BASE);
    const releasedAt = Date.parse(String(row(f, attempt).released_at));
    assert.equal(releasedAt, f.t0 + BASE);
    const arrival = late ? releasedAt + WAKE_RESEND_MAX_MS + 1 : releasedAt + WAKE_RESEND_MAX_MS - MINUTE;
    jump(f, arrival);
    send(f, "retention-body", arrival);
    f.store.prune(arrival);
    const result = observe(f, [attempt.nonce], arrival);
    if (late) {
      assert.equal(result.recognized, false);
      assert.deepEqual(result.messages, []);
      assert.equal(f.store.pendingCount(target, arrival + 2), 1);
    } else {
      assert.deepEqual(result.messages.map(m => m.messageId), ["retention-body"]);
    }
  }
});

test("15 (I9): a prerequisite-missing birth is never rung again until a new birth; unsupported is a declaration only", () => {
  const f = fixture();
  send(f, "prereq-body", f.t0);
  const failed = ring(f, f.t0);
  assert.equal(f.store.recordManagedWakeOutcome(failed, PREREQ, BASE, f.t0), true);
  assert.equal(row(f, failed).state, "not-delivered");
  assert.equal(birthPath(f)!.prerequisite_missing, "SYNTHETIC_EXECUTABLE_MISSING");
  for (const at of [f.t0 + MINUTE, f.t0 + 11 * MINUTE, f.t0 + 5 * HOUR]) {
    jump(f, at);
    assert.equal(reserve(f, at).dispatch, false);
    const view = outlook(f, at);
    assert.deepEqual([view.state, view.reason], ["degraded", "wake-prerequisite-missing"]);
  }
  // A new birth starts from zero (r3 F2) and is rung.
  const rebirth = f.t0 + 5 * HOUR + 1;
  assert.equal(f.store.endPresence(target, "synthetic-restart", f.instanceId, rebirth), true);
  live(f, "instance-2", rebirth + 1);
  dispatched(reserve(f, rebirth + 1));
  const path = birthPath(f)!;
  assert.equal(path.prerequisite_missing, null);
  assert.equal(path.failures, 0);
  assert.equal(path.streak, 0);
  // Unsupported comes from the capability declaration, never an outcome, and is never rung.
  const deferred = { host, sessionId: "doorbell-deferred" };
  f.store.startPresence({ ...deferred, instanceId: "deferred-1", transport: "codex-deferred", wakeVisibility: "none", canWakeSilently: false,
    deliveryCapabilities: { supportedInjection: ["tool-boundary"], idleWake: "none" } }, rebirth + 2);
  f.store.send({ sender, target: deferred, messageId: "deferred-body", body: "b", ttlSeconds: 600 }, rebirth + 2);
  assert.deepEqual(f.store.autoWakeOutlook(deferred, rebirth + 3), { state: "unsupported", reason: "no-idle-wake", basisAt: iso(rebirth + 2),
    checkedAt: iso(rebirth + 3), authorityEffect: "none" });
});

test("16: the board hook consume-wake still recognizes this target's marker, whatever its state, with no state effect", () => {
  const f = fixture();
  send(f, "board-body", f.t0);
  const attempt = handOff(f, f.t0);
  const before = row(f, attempt);
  assert.equal(f.store.consumeWake(target, attempt.nonce), true);
  assert.deepEqual(dispatch(f.store, "consume-wake", { target, nonce: attempt.nonce }), { consumed: true });
  assert.equal(f.store.consumeWake({ ...target, sessionId: "other-target" }, attempt.nonce), false);
  assert.equal(f.store.consumeWake(target, "unregistered-board-nonce-abcdefghijk"), false);
  assert.deepEqual(row(f, attempt), before);
  // Released and past its injection expiry: still this target's marker.
  const later = f.t0 + 2 * HOUR;
  jump(f, later); f.store.prune(later);
  assert.equal(row(f, attempt).state, "released");
  assert.equal(f.store.consumeWake(target, attempt.nonce), true);
});

test("2.6: a claim boundary after the hand-off or the end of its birth releases the slot; reasons and streak follow the design", () => {
  // claimed-after-handoff (the agy path without marker observation) resets the streak.
  const f = fixture("antigravity-queue");
  send(f, "agy-body-1", f.t0);
  const first = handOff(f, f.t0);
  jump(f, f.t0 + BASE); const second = handOff(f, f.t0 + BASE);
  assert.equal(birthPath(f)!.streak, 1);
  const claimAt = f.t0 + BASE + 30_000;
  jump(f, claimAt);
  assert.deepEqual(boundary(f, claimAt).map(m => m.messageId), ["agy-body-1"]);
  f.store.prune(claimAt + 1);
  assert.deepEqual([row(f, second).state, row(f, second).release_reason], ["released", "claimed-after-handoff"]);
  assert.equal(row(f, first).release_reason, "resend-due");
  assert.equal(birthPath(f)!.streak, 0);
  assert.equal(birthPath(f)!.claim_boundary_at, iso(claimAt));
  const view = outlook(f, claimAt + 2);
  assert.deepEqual([view.state, view.reason, view.basisAt], ["available", "recipient-active", iso(claimAt)]);
  // A boundary before the hand-off does not release it.
  const g = fixture();
  send(g, "early-body-1", g.t0); send(g, "early-body-2", g.t0 + 1);
  boundary(g, g.t0 + 2);
  jump(g, g.t0 + 2 + WAKE_QUIET_MS + 1);
  const quiet = handOff(g, g.t0 + 2 + WAKE_QUIET_MS + 1);
  g.store.prune(g.t0 + 2 + WAKE_QUIET_MS + 2);
  assert.equal(row(g, quiet).state, "handed-off");
  // birth-ended keeps the streak of the old birth and the new birth starts at zero.
  assert.equal(g.store.endPresence(target, "synthetic-exit", g.instanceId, g.t0 + 3 * MINUTE), true);
  g.store.prune(g.t0 + 3 * MINUTE + 1);
  assert.deepEqual([row(g, quiet).state, row(g, quiet).release_reason], ["released", "birth-ended"]);
  live(g, "instance-2", g.t0 + 4 * MINUTE);
  const reborn = dispatched(reserve(g, g.t0 + 4 * MINUTE));
  assert.notEqual(reborn.attemptId, quiet.attemptId);
});

test("2.8: list-presence exports relayLive explicitly and autoWake never reports latched", () => {
  const f = fixture();
  const item = (at: number) => f.store.listPresence(at, [target])[0]!;
  assert.equal(item(f.t0).relayLive, true);
  // The relay lease (15 s) lapses before the presence lease (20 s): online, relay not live.
  assert.equal(f.store.heartbeatPresence(target, f.instanceId, f.t0 + 10_000), true);
  const lapsed = item(f.t0 + 16_000);
  assert.equal(lapsed.state, "online");
  assert.equal(lapsed.relayLive, false);
  assert.deepEqual([lapsed.autoWake?.state, lapsed.autoWake?.reason], ["no-live-relay", "relay-lease-missing"]);
  jump(f, f.t0 + 17_000);
  send(f, "latched-body", f.t0 + 17_000);
  handOff(f, f.t0 + 17_000);
  for (const at of [f.t0 + 17_001, f.t0 + 17_000 + 2 * MINUTE, f.t0 + 17_000 + BASE - 1]) {
    jump(f, at);
    assert.notEqual(outlook(f, at).state as string, "latched");
  }
});

test("3.1: the operation table refuses a resendBaseMs that is not a positive integer within WAKE_RESEND_MAX_MS", () => {
  const f = fixture();
  send(f, "base-body", f.t0);
  const reserved = dispatched(reserve(f, f.t0));
  for (const resendBaseMs of [0, -1, 1.5, WAKE_RESEND_MAX_MS + 1, "600000", undefined]) {
    assert.throws(() => dispatch(f.store, "start-wake", { attempt: reserved, resendBaseMs }), Error, String(resendBaseMs));
  }
  assert.equal(row(f, reserved).state, "reserved");
});

test("3.6.0: a message's status wake is only an attempt started while that message was pending, else null", () => {
  const f = fixture();
  const wakeOf = (id: string, at: number) => (f.store.status(sender, id, at) as { wake: Row | null }).wake;
  send(f, "first-body", f.t0 + 1_000);
  const first = handOff(f, f.t0 + 2_000);
  assert.equal(wakeOf("first-body", f.t0 + 2_500)?.attemptId, first.attemptId);
  // The first body is claimed and acknowledged; a later body did not cause the attempt that rang before it existed.
  assert.equal(boundary(f, f.t0 + 3_000).length, 1);
  send(f, "second-body", f.t0 + 4_000);
  assert.equal(wakeOf("second-body", f.t0 + 4_500), null);
  // A quiet gap later the second body rings its own attempt; the first body's status keeps its own attempt.
  const later = f.t0 + 3_000 + WAKE_QUIET_MS + 1_000;
  jump(f, later);
  const second = handOff(f, later);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.equal(wakeOf("second-body", later + 1)?.attemptId, second.attemptId);
  assert.equal(wakeOf("first-body", later + 1)?.attemptId, first.attemptId);
  // The target's own wake-status still reads its latest attempt.
  assert.equal((dispatch(f.store, "wake-status", { target }) as { wake: Row | null }).wake?.attemptId, second.attemptId);
});
