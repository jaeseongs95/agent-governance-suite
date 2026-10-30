import { afterEach, describe, expect, it } from "vitest";
import { producerFailureReason } from "../../mcp-server/src/failure-diagnostics.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

// 설계: CONC-FENCE-002 / DIST-ACK-001의 store 공개 경계와 실제 SQLite 상태를 검사한다.
// 원 결함판에서는 구세대/누락 호출이 거부되지 않아 실패해야 한다. red/green 실행은 NOT_RUN.
// 공식 호스트 busy/idle, 외부 제출, 모델 소비와 정상 ACK의 전체 수용은 이 시험 범위가 아니다.
const target = { host: "codex", sessionId: "hook-claim-generation-recipient" };
const sender = { host: "claude-code", sessionId: "hook-claim-generation-sender" };
const generationA = "host-process-v1:" + "a".repeat(64);
const generationB = "host-process-v1:" + "b".repeat(64);
const now = Date.UTC(2026, 9, 30, 0, 0, 0);
const transport = "codex-queue";
const stores: SessionMessageStore[] = [];
const operations = ["claimDeferred", "claimTurnEnd", "observeNativeInput", "clearDeferred"] as const;
type HookOperation = typeof operations[number];

function fixture() {
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const presence = {
    ...target, transport, wakeVisibility: "user-message" as const, canWakeSilently: false,
    deliveryCapabilities: {
      supportedInjection: ["peer-wake" as const, "tool-boundary" as const, "turn-end" as const],
      idleWake: "user-message" as const,
    },
  };
  const start = (instanceId: string, at: number) => {
    const input = { ...presence, instanceId, parentPid: 100 };
    const grant = store.prepareVerifiedRelay({ ...input, expectedOwner: store.relayOwner(target, transport) }, at);
    expect(grant.spawn).toBe(true);
    expect(grant.relayId).not.toBeNull();
    expect(store.activateVerifiedRelay({ ...input, relayId: grant.relayId!, pid: 200,
      relayStartToken: "hook-claim-child-start" }, at + 1)).toBe(true);
    return grant.relayId!;
  };
  const enqueue = (body: string, at: number) => {
    const prepared = store.prepare({ sender, target, body }, at);
    expect(store.submitPrepared(sender, prepared.messageId, at + 1).duplicate).toBe(false);
    return prepared.messageId;
  };
  const snapshot = () => Object.fromEntries([
    "messages", "prepared_messages", "input_observations", "session_activity",
    "wake_nonces", "session_presence", "relay_leases",
  ].map(table => [table, store.database.prepare(`SELECT * FROM ${table}`).all()]));
  return { store, presence, start, enqueue, snapshot };
}

function invoke(store: SessionMessageStore, operation: HookOperation, at: number, instanceId?: string) {
  const limits = instanceId === undefined ? {} : { instanceId };
  switch (operation) {
    case "claimDeferred": return store.claimDeferred(target, at, limits);
    case "claimTurnEnd": return store.claimTurnEnd(target, at, limits);
    case "observeNativeInput": return store.observeNativeInput(target, at, instanceId);
    case "clearDeferred": return store.clearDeferred(target, at, instanceId);
  }
}

function expectMismatch(action: () => unknown) {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect(producerFailureReason(failure)).toBe("SESSION_MESSAGE_HOOK_INSTANCE_MISMATCH");
}

afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe("D0354 훅 본문 claim의 현재 프로세스 세대 결속", () => {
  it.each(operations)("B 교체 뒤 A의 %s를 거부하고 본문·claim·지연·활동·wake를 보존한다", (operation) => {
    const { store, start, enqueue, snapshot } = fixture();
    start(generationA, now);
    const relayId = start(generationB, now + 2);
    const messageId = enqueue("replacement body remains intact", now + 4);
    store.observeNativeInput(target, now + 6, generationB);
    expect(store.reserveManagedWake({ ...target, transport, instanceId: generationB, relayId,
      nonce: "hook-generation-replacement-wake-abcdefghijklmnop" }, now + 7).dispatch).toBe(true);
    const before = snapshot();

    expectMismatch(() => invoke(store, operation, now + 8, generationA));
    expect(snapshot()).toEqual(before);
    expect(store.status(sender, messageId, now + 8)).toMatchObject({ deliveryAttempts: 0, acknowledgedAt: null });

    expect(store.claimDeferred(target, now + 9, { instanceId: generationB })).toEqual([]);
    expect(store.claimDeferred(target, now + 10, { instanceId: generationB })).toMatchObject([
      { messageId, body: "replacement body remains intact", deliveryAttempt: 1 },
    ]);
    expect(store.acknowledge(target, [messageId], now + 11)).toBe(1);
  });

  for (const instanceId of [undefined, "unobserved-generation"]) {
    it.each(operations)(`검증된 현재 세대에서 ${instanceId === undefined ? "누락" : "불명"} instance의 %s는 상태 변경 없이 거부한다`, (operation) => {
      const { store, start, enqueue, snapshot } = fixture();
      start(generationB, now);
      enqueue("unclaimed body", now + 2);
      store.observeNativeInput(target, now + 4, generationB);
      const before = snapshot();
      expectMismatch(() => invoke(store, operation, now + 5, instanceId));
      expect(snapshot()).toEqual(before);
    });
  }

  it.each(operations)("종료된 현재 instance의 %s도 상태 변경 없이 거부한다", (operation) => {
    const { store, start, enqueue, snapshot } = fixture();
    start(generationA, now);
    enqueue("body survives ended generation", now + 2);
    store.observeNativeInput(target, now + 4, generationA);
    expect(store.endPresence(target, "host-process-ended", generationA, now + 5)).toBe(true);
    const before = snapshot();
    expectMismatch(() => invoke(store, operation, now + 6, generationA));
    expect(snapshot()).toEqual(before);
  });

  it("정확한 현재 세대는 첫 경계 지연·clearDeferred·turn-end와 수신 ACK를 유지한다", () => {
    const { store, start, enqueue } = fixture();
    start(generationB, now);
    const first = enqueue("current body", now + 2);
    store.observeNativeInput(target, now + 4, generationB);
    expect(store.claimDeferred(target, now + 5, { instanceId: generationB })).toEqual([]);
    store.clearDeferred(target, now + 6, generationB);
    expect(store.database.prepare("SELECT * FROM input_observations").all()).toEqual([]);
    expect(store.claimDeferred(target, now + 7, { instanceId: generationB })).toMatchObject([
      { messageId: first, body: "current body", deliveryAttempt: 1 },
    ]);
    expect(store.acknowledge(target, [first], now + 8)).toBe(1);

    const second = enqueue("turn-end body", now + 9);
    store.observeNativeInput(target, now + 11, generationB);
    expect(store.claimTurnEnd(target, now + 12, { instanceId: generationB })).toMatchObject([
      { messageId: second, body: "turn-end body", deliveryAttempt: 1 },
    ]);
    expect(store.database.prepare("SELECT * FROM input_observations").all()).toEqual([]);
    expect(store.acknowledge(target, [second], now + 13)).toBe(1);
  });

  it.each(["claimDeferred", "claimTurnEnd"] as const)("종료되지 않은 동일 세대는 relay/presence lease 만료 뒤에도 %s를 유지한다", (operation) => {
    const { store, start, enqueue } = fixture();
    start(generationB, now);
    const messageId = enqueue("body after lease lapse", now + 2);
    const later = now + 25_000;
    expect(store.liveRelay(target, transport, later)).toBeNull();
    expect(store.presence(target, later)).toMatchObject({ state: "unreachable", instanceId: generationB, endedAt: null });
    store.observeNativeInput(target, later, generationB);
    if (operation === "claimDeferred") expect(store.claimDeferred(target, later + 1, { instanceId: generationB })).toEqual([]);
    expect(invoke(store, operation, later + 2, generationB)).toMatchObject([
      { messageId, body: "body after lease lapse", deliveryAttempt: 1 },
    ]);
    expect(store.acknowledge(target, [messageId], later + 3)).toBe(1);
  });

  it.each(["no-presence", "legacy-instance"] as const)("%s의 instance 없는 기존 훅 호출을 보존한다", (mode) => {
    const { store, presence, enqueue } = fixture();
    if (mode === "legacy-instance") store.startPresence({ ...presence, instanceId: "legacy-session-instance" }, now);
    const first = enqueue("legacy deferred body", now + 2);
    store.observeNativeInput(target, now + 4);
    expect(store.claimDeferred(target, now + 5)).toEqual([]);
    store.clearDeferred(target, now + 6);
    expect(store.claimDeferred(target, now + 7)).toMatchObject([
      { messageId: first, body: "legacy deferred body", deliveryAttempt: 1 },
    ]);
    expect(store.acknowledge(target, [first], now + 8)).toBe(1);

    const second = enqueue("legacy turn-end body", now + 9);
    store.observeNativeInput(target, now + 11);
    expect(store.claimTurnEnd(target, now + 12)).toMatchObject([
      { messageId: second, body: "legacy turn-end body", deliveryAttempt: 1 },
    ]);
    expect(store.database.prepare("SELECT * FROM input_observations").all()).toEqual([]);
  });
});
