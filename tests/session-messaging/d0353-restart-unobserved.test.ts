import assert from "node:assert/strict";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {afterEach, test, vi} from "vitest";
import {
  SessionMessageStore, WAKE_RETIRE_GRACE_MS, WAKE_TTL_MS,
  type WakeAttempt, type WakeReservation,
} from "../../mcp-server/src/session-message-store.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {adaptHostInput, registerHookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {recordWakeHookObservation, wakeHookObservationReader} from "../../mcp-server/src/session-message-wake-port.js";

// AC08: 세대 교체는 외부 큐의 소멸 증거가 아니다. 실제 호스트 실행·큐 소멸을 측정하지 않는 합성 시험이다.
// 공개 저장소와 실제 임시 SQLite 연결을 사용한다. 시계는 인자로 고정하며 네트워크·하위 프로세스는 사용하지 않는다.
// 결함 판별: birth-only 회수 코드는 재시작/재탄생/장기 보관 사례에서 새 dispatch 또는 기존 행 소실로 실패해야 한다.
// 실행과 원본/수정 비교는 별도 시험 담당 소유이며, 이 파일 작성 단계의 결과는 NOT_RUN이다.
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

const target = {host, sessionId: "d0353-restart-target"};
const sender = {host, sessionId: "d0353-restart-sender"};
const capabilities: NonNullable<Parameters<SessionMessageStore["startPresence"]>[0]["deliveryCapabilities"]> = {
  supportedInjection: ["peer-wake", "tool-boundary"], idleWake: "silent",
};
const iso = (at: number) => new Date(at).toISOString();
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
  const f = {directory, database, store, stores, now, transport, retireAt: now + WAKE_TTL_MS + WAKE_RETIRE_GRACE_MS};
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
function live(f: Fixture, instanceId: string, relayId: string, at: number) {
  f.store.startPresence({...target, instanceId, transport: f.transport, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: capabilities}, at);
  assert.equal(f.store.acquireRelay({...target, instanceId, transport: f.transport, relayId,
    pid: process.pid, parentPid: process.pid}, at), true);
}
function request(f: Fixture, instanceId = "instance-1", relayId = "relay-1", nonce = "d0353-next-nonce-abcdefghijklmnop") {
  return {...target, instanceId, relayId, nonce, transport: f.transport, resume: true};
}
function dispatched(reservation: WakeReservation): WakeAttempt {
  assert.equal(reservation.dispatch, true);
  assert.ok(reservation.attempt);
  return reservation.attempt;
}
function submit(f: Fixture, body: string, at: number) {
  const prepared = f.store.prepare({sender, target, body, ttlSeconds: 86400}, at);
  return f.store.submitPrepared(sender, prepared.messageId, at);
}
type UncertainOutcome = "submitted" | "accepted-or-unknown" | "started";
function latch(f: Fixture, outcome: UncertainOutcome = "submitted") {
  const message = submit(f, "old-generation-body", f.now);
  const reserved = dispatched(f.store.reserveManagedWake(request(f, "instance-1", "relay-1", "d0353-first-nonce-abcdefghijklmnop"), f.now));
  const attempt = dispatched(f.store.startManagedWake(reserved, f.now + 1));
  if (outcome !== "started") assert.equal(f.store.recordManagedWakeOutcome(attempt, outcome, f.now + 2), true);
  return {attempt, message};
}
function row(f: Fixture, attempt: WakeAttempt) {
  const result = f.store.database.prepare("SELECT * FROM wake_nonces WHERE attempt_id = ?").get(attempt.attemptId);
  assert.ok(result);
  return result;
}
function activity(f: Fixture) {
  return f.store.database.prepare("SELECT active_at FROM session_activity WHERE host = ? AND session_id = ?").get(target.host, target.sessionId);
}
function observe(f: Fixture, attempt: WakeAttempt, at: number) {
  vi.stubEnv("AGENT_GOVERNANCE_TRUST_DB_PATH", join(f.directory, "trust.sqlite3"));
  const observation = adaptHostInput({hook_event_name: "UserPromptSubmit", session_id: target.sessionId,
    agent_id: "", prompt: `[agent-governance-suite:wake:${attempt.nonce}]`}, host).observation;
  const receipt = recordWakeHookObservation(observation, at);
  return f.store.claimHostWake(target, observation, receipt, wakeHookObservationReader, at + 1);
}

const transports = ["codex-queue", "claude-inbox", "gemini-queue", "d0353-unregistered-queue"];
const restartCases = transports.flatMap(transport => (["submitted", "accepted-or-unknown", "started"] as const)
  .map(outcome => ({transport, outcome})));
test.each(restartCases)("AC08: $transport/$outcome 제출 후 연결 재시작과 새 세대만으로 미관측 잠금을 풀지 않는다", ({transport, outcome}) => {
  const f = fixture(transport);
  const {attempt} = latch(f, outcome);
  const original = row(f, attempt);
  reopen(f);
  assert.deepEqual(row(f, attempt), original);
  live(f, "instance-2", "relay-2", f.retireAt - 1);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.retireAt - 1).dispatch, false);
  // 시작 직후 충돌은 기존 CAS 규약에 따라 unknown이 되며, 원래 결합·시각·시도는 보존한다.
  const retained = {...original, state: outcome === "started" ? "unknown" : original.state};
  assert.deepEqual(row(f, attempt), retained);
  f.store.prune(f.retireAt);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.retireAt).dispatch, false);
  assert.deepEqual(row(f, attempt), retained);
  assert.equal(activity(f), undefined);
  assert.equal(f.store.pendingCount(target, f.retireAt), 1);
});

test("AC08: 같은 인스턴스의 임대 만료와 재탄생도 기존 외부 효과를 취소하지 않는다", () => {
  const f = fixture();
  const {attempt} = latch(f);
  const original = row(f, attempt);
  reopen(f);
  assert.equal(f.store.presence(target, f.retireAt - 1).state, "unreachable");
  live(f, "instance-1", "relay-1", f.retireAt - 1);
  assert.notEqual(f.store.presence(target, f.retireAt - 1).startedAt, attempt.generation);
  assert.equal(f.store.reserveManagedWake(request(f), f.retireAt).dispatch, false);
  assert.deepEqual(row(f, attempt), original);
  assert.equal(activity(f), undefined);
});

test("AC08: 세션 시작·중계 임대·생존 신호는 실제 활동이나 미관측 해제 증거가 아니다", () => {
  const f = fixture();
  const {attempt} = latch(f);
  const original = row(f, attempt);
  const at = f.retireAt - 1;
  f.store.startPresence({...target, instanceId: "instance-2", transport: f.transport, wakeVisibility: "silent",
    canWakeSilently: true, deliveryCapabilities: capabilities}, at);
  assert.equal(activity(f), undefined);
  assert.deepEqual(row(f, attempt), original);
  assert.equal(f.store.acquireRelay({...target, instanceId: "instance-2", relayId: "relay-2", transport: f.transport,
    pid: process.pid, parentPid: process.pid}, at), true);
  assert.equal(activity(f), undefined);
  assert.deepEqual(row(f, attempt), original);
  assert.equal(f.store.heartbeatPresence(target, "instance-2", at + 1), true);
  assert.equal(activity(f), undefined);
  assert.deepEqual(f.store.relayTick({...target, instanceId: "instance-2", relayId: "relay-2", transport: f.transport,
    includePending: true}, at + 2), {alive: true, count: 1});
  assert.equal(activity(f), undefined);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), at + 3).dispatch, false);
  assert.deepEqual(row(f, attempt), original);
});

test("AC08: 25시간과 종료 행 보관 상한 정리 후 새 본문·두 연결에도 미관측 시도 하나를 보존한다", () => {
  const f = fixture();
  const {attempt, message} = latch(f);
  const original = row(f, attempt);
  reopen(f);
  const at = f.now + 25 * 3600_000;
  f.store.prune(at);
  assert.equal(f.store.database.prepare("SELECT 1 FROM messages WHERE message_id = ?").get(message.messageId), undefined);
  assert.deepEqual(row(f, attempt), original);
  // 종료 행만의 1000개 상한을 실제로 넘긴다. 합성 이력은 이 시험 전용 임시 DB에만 쓴다.
  f.store.database.prepare(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM history WHERE n < 1005)
    INSERT INTO wake_nonces (nonce_digest, host, session_id, expires_at, state, outcome_at)
    SELECT 'd0353-terminal-' || n, ?, 'd0353-terminal-history', ?, 'not-submitted', ? FROM history`)
    .run(host, iso(at + WAKE_TTL_MS), iso(at - 1));
  f.store.prune(at);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state = 'not-submitted'").get()?.n, 1000);
  assert.deepEqual(row(f, attempt), original);
  live(f, "instance-2", "relay-2", at + 1);
  const fresh = submit(f, "fresh-body-after-old-ttl", at + 2);
  assert.equal(fresh.autoWake.state, "latched");
  assert.equal(fresh.autoWake.reason, "wake-unobserved");
  assert.equal(f.store.pendingCount(target, at + 2), 1);
  const peer = new SessionMessageStore(f.database);
  f.stores.add(peer);
  assert.equal(peer.reserveManagedWake(request(f, "instance-2", "relay-2"), at + 3).dispatch, false);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2", "d0353-other-nonce-abcdefghijklmnop"), at + 3).dispatch, false);
  assert.equal(f.store.database.prepare("SELECT count(*) AS n FROM wake_nonces WHERE state IN ('reserved', 'started', 'submitted', 'unknown')").get()?.n, 1);
  assert.deepEqual(row(f, attempt), original);
});

test.each(["claim-and-ack", "native-input"] as const)("D0305: 재시작 후 실제 활동 %s는 기존 만료 조건에서 다음 깨우기를 허용한다", kind => {
  const f = fixture();
  const {attempt, message} = latch(f);
  reopen(f);
  live(f, "instance-2", "relay-2", f.retireAt - 1);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.retireAt).dispatch, false);
  if (kind === "claim-and-ack") {
    const claimed = f.store.claim(target, f.retireAt + 1);
    assert.deepEqual(claimed.map(value => value.messageId), [message.messageId]);
    assert.equal(f.store.acknowledge(target, [message.messageId], f.retireAt + 2,
      claimed.map(value => {
        assert.ok(value.claimReceipt);
        return {messageId: value.messageId, claimReceipt: value.claimReceipt};
      })), 1);
    submit(f, "next-body-after-ack", f.retireAt + 3);
  } else f.store.observeNativeInput(target, f.retireAt + 1);
  assert.ok(activity(f));
  const next = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.retireAt + 4));
  assert.notEqual(next.attemptId, attempt.attemptId);
  assert.notEqual(next.nonce, attempt.nonce);
  assert.equal(row(f, attempt).state, "expired-unobserved");
  assert.equal(row(f, attempt).observed_at, null);
  assert.equal(row(f, attempt).consumed_at, null);
});

test("AC08: 검증된 구 표식 도착은 새 세대 본문 없이 구 잠금만 풀고 중복 도착은 현재 시도를 보존한다", () => {
  const f = fixture();
  const {attempt} = latch(f);
  reopen(f);
  live(f, "instance-2", "relay-2", f.retireAt - 1);
  const fresh = submit(f, "current-generation-body", f.retireAt);
  assert.equal(fresh.autoWake.state, "latched");
  const messages = f.store.database.prepare("SELECT * FROM messages ORDER BY message_id").all();
  assert.deepEqual(observe(f, attempt, f.retireAt + 1), {recognized: false, messages: [], binding: null});
  const observed = row(f, attempt);
  assert.equal(observed.state, "observed");
  assert.equal(observed.late_observed_at, iso(f.retireAt + 2));
  assert.equal(observed.observed_at, iso(f.retireAt + 2));
  assert.equal(observed.consumed_at, iso(f.retireAt + 2));
  assert.deepEqual(f.store.database.prepare("SELECT * FROM messages ORDER BY message_id").all(), messages);
  const next = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-2"), f.retireAt + 3));
  const started = dispatched(f.store.startManagedWake(next, f.retireAt + 4));
  assert.equal(f.store.recordManagedWakeOutcome(started, "submitted", f.retireAt + 5), true);
  const current = row(f, started);
  const activityBeforeDuplicate = activity(f);
  assert.deepEqual(observe(f, attempt, f.retireAt + 6), {recognized: false, messages: [], binding: null});
  assert.deepEqual(row(f, attempt), observed);
  assert.deepEqual(row(f, started), current);
  assert.deepEqual(activity(f), activityBeforeDuplicate);
  assert.deepEqual(f.store.database.prepare("SELECT * FROM messages ORDER BY message_id").all(), messages);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-2", "d0353-third-nonce-abcdefghijklmnop"), f.retireAt + 8).dispatch, false);
  const delivered = observe(f, started, f.retireAt + 9);
  assert.equal(delivered.recognized, true);
  assert.ok(delivered.messages.some(value => value.messageId === fresh.messageId));
});

test("확정 실패는 같은 nonce로 지연 후 재시도하고 새 세대도 기존 대기 기한을 지킨다", () => {
  const f = fixture();
  const {attempt} = latch(f, "started");
  assert.equal(f.store.recordManagedWakeOutcome(attempt, "definite-failure", f.now + 2), true);
  const failed = row(f, attempt);
  assert.equal(failed.state, "reserved");
  const retryAt = Date.parse(String(failed.retry_not_before));
  assert.ok(retryAt > f.now + 2);
  reopen(f);
  // 첫 재시도 대기는 임대보다 길다. 실제 활동 없이 같은 출생 세대의 임대만 유지한다.
  for (const at of [f.now + 10_000, f.now + 20_000]) {
    assert.equal(f.store.relayTick({...target, instanceId: "instance-1", relayId: "relay-1", transport: f.transport,
      includePending: true}, at).alive, true);
  }
  assert.equal(f.store.reserveManagedWake(request(f), retryAt - 1).dispatch, false);
  const retry = dispatched(f.store.reserveManagedWake(request(f), retryAt));
  assert.equal(retry.nonce, attempt.nonce);
  assert.equal(retry.attemptId, attempt.attemptId);
  const restarted = dispatched(f.store.startManagedWake(retry, retryAt));
  assert.equal(restarted.dispatchEpoch, attempt.dispatchEpoch + 1);
  assert.equal(f.store.recordManagedWakeOutcome(restarted, "definite-failure", retryAt + 1), true);
  const secondFailure = row(f, restarted);
  const nextRetryAt = Date.parse(String(secondFailure.retry_not_before));
  assert.equal(f.store.endPresence(target, "synthetic-restart", "instance-1", retryAt + 2), true);
  live(f, "instance-2", "relay-1", retryAt + 3);
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), retryAt + 3).dispatch, false);
  assert.equal(row(f, restarted).state, "not-submitted");
  assert.equal(row(f, restarted).retry_not_before, secondFailure.retry_not_before);
  live(f, "instance-2", "relay-1", nextRetryAt - 1);
  assert.equal(f.store.autoWakeOutlook(target, nextRetryAt - 1).reason, "retry-backoff");
  assert.equal(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), nextRetryAt - 1).dispatch, false);
  live(f, "instance-2", "relay-1", nextRetryAt);
  const replacement = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), nextRetryAt));
  assert.notEqual(replacement.attemptId, attempt.attemptId);
  assert.notEqual(replacement.nonce, attempt.nonce);
});

test("시작 전 예약은 새 세대로 교체할 수 있고 미관측 제출 보류는 공개 전송 응답에 남는다", () => {
  const f = fixture();
  submit(f, "reserved-before-restart", f.now);
  const reserved = dispatched(f.store.reserveManagedWake(request(f, "instance-1", "relay-1", "d0353-prestart-nonce-abcdefghijklmnop"), f.now));
  assert.equal(f.store.endPresence(target, "synthetic-restart", "instance-1", f.now + 1), true);
  live(f, "instance-2", "relay-1", f.now + 2);
  const replacement = dispatched(f.store.reserveManagedWake(request(f, "instance-2", "relay-1"), f.now + 2));
  assert.equal(row(f, reserved).state, "not-submitted");
  assert.notEqual(replacement.attemptId, reserved.attemptId);
  const started = dispatched(f.store.startManagedWake(replacement, f.now + 3));
  assert.equal(f.store.recordManagedWakeOutcome(started, "submitted", f.now + 4), true);
  reopen(f);
  live(f, "instance-3", "relay-3", f.retireAt + 5);
  const outlook = f.store.autoWakeOutlook(target, f.retireAt + 6);
  assert.equal(outlook.state, "latched");
  assert.equal(outlook.reason, "wake-unobserved");
  const draft = f.store.prepare({sender, target, body: "prepared-while-latched"}, f.retireAt + 6);
  const receipt = f.store.submitPrepared(sender, draft.messageId, f.retireAt + 7);
  assert.equal(receipt.duplicate, false);
  assert.equal(receipt.autoWake.state, "latched");
  assert.equal(receipt.autoWake.reason, "wake-unobserved");
  const duplicate = f.store.submitPrepared(sender, draft.messageId, f.retireAt + 8);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.autoWake.state, "latched");
  assert.equal(duplicate.autoWake.reason, "wake-unobserved");
  assert.equal(f.store.reserveManagedWake(request(f, "instance-3", "relay-3", "d0353-third-nonce-abcdefghijklmnop"), f.retireAt + 8).dispatch, false);
});
