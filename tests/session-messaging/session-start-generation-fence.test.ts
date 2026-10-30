import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const boundary = vi.hoisted(() => ({ now: 100, request: vi.fn(), token: vi.fn(), spawn: vi.fn() }));
vi.mock("node:perf_hooks", () => ({ performance: { now: () => boundary.now } }));
vi.mock("node:child_process", async original => ({
  ...await original<typeof import("node:child_process")>(), spawn: boundary.spawn,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: boundary.request,
}));
vi.mock("../../mcp-server/src/process-identity.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: boundary.token,
}));
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";
import type { ActorObservation } from "../../mcp-server/src/input-observation.js";

// 실제 훅·중개기·저장소를 연결한다. OS 출생 조회와 child spawn은 주입 경계이며 native 재개 증거가 아니다.
const host = "synthetic-session-start-generation-fence";
const actor: ActorObservation = { role: "root", basis: "observed", reasonCode: "SYNTHETIC_SESSION_START_ROOT" };
const input = { hook_event_name: "SessionStart", session_id: "session-start-generation-fence", syntheticActor: actor };
const target = { host, sessionId: input.session_id };
const transport = "gemini-queue";
const tables = ["messages", "prepared_messages", "input_observations", "session_activity", "wake_nonces", "session_presence", "relay_leases"];
const stores: SessionMessageStore[] = [];
const now = Date.UTC(2026, 9, 30);
type Grant = { spawn: boolean; relayId: string | null; instanceId: string };

registerHookHostAdapter(host, {
  adaptInput: (payload, observedHost) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host: observedHost, actor: payload.syntheticActor as ActorObservation } };
  },
  deliveryProfile: () => ({
    transport, capabilities: { supportedInjection: ["peer-wake", "turn-end"], idleWake: "user-message" }, blocksEmptyWakePrompt: false,
  }),
  processPid: (pid, observation) => observation ? pid : undefined,
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const store of stores.splice(0)) store.close();
});

function fixture() {
  const store = new SessionMessageStore(":memory:");
  stores.push(store);
  const tokens = new Map([[101, "parent-A"], [102, "parent-B"], [103, "parent-C"],
    [1101, "relay-A"], [1102, "relay-B"], [1103, "relay-C"]]);
  boundary.now = 100;
  boundary.request.mockReset(); boundary.token.mockReset(); boundary.spawn.mockReset();
  boundary.token.mockImplementation((pid: number) => tokens.get(pid) ?? null);
  boundary.spawn.mockImplementation(() => Object.assign(new EventEmitter(), { unref: vi.fn() }));
  vi.spyOn(process, "kill").mockImplementation(() => true);
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "1");
  const birth = (pid: number) => "host-process-v1:" + createHash("sha256")
    .update(JSON.stringify([target.host, target.sessionId, pid, tokens.get(pid)])).digest("hex");
  const payload = (pid: number) => ({ target, transport, parentPid: pid, parentStartToken: tokens.get(pid)!,
    identityTimeoutMs: 900, wakeVisibility: "user-message", idleWake: "user-message",
    canWakeSilently: false, supportedInjection: ["peer-wake", "turn-end"] });
  const dispatch = (pid: number, extra: Record<string, unknown> = {}) =>
    dispatchSessionMessageBrokerOperation(store, "ensure-relay", { ...payload(pid), ...extra }) as Grant;
  const grants: Grant[] = [];
  boundary.request.mockImplementation(async (operation: string, data: Record<string, unknown>) => {
    expect(operation).toBe("ensure-relay");
    const grant = dispatchSessionMessageBrokerOperation(store, operation, data) as Grant;
    grants.push(grant);
    return grant;
  });
  const hook = (pid: number) => handleSessionMessageHook(input, host, pid, {
    ensureRelay: true, hostProcess: { pid, startToken: tokens.get(pid)! },
    executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 },
  });
  const activate = (pid: number) => {
    const owner = store.relayOwner(target, transport)!;
    expect(owner).toMatchObject({ instanceId: birth(pid), parentPid: pid, pid: 0 });
    expect(store.activateVerifiedRelay({ ...target, transport, instanceId: birth(pid), relayId: owner.relayId,
      parentPid: pid, pid: pid + 1000, relayStartToken: tokens.get(pid + 1000)! })).toBe(true);
  };
  const release = (pid: number) => {
    const owner = store.relayOwner(target, transport)!;
    expect(store.releaseVerifiedRelay({ ...target, transport, instanceId: birth(pid),
      relayId: owner.relayId, pid: pid + 1000 })).toBe(true);
    expect(store.relayOwner(target, transport)).toBeNull();
    expect(store.presence(target)).toMatchObject({ instanceId: birth(pid), endedAt: expect.any(String) });
  };
  const protectReceipt = (pid: number) => {
    const sender = { host: "synthetic-peer", sessionId: "protected-session-start-receipt" };
    const prepared = store.prepare({ sender, target, body: "늦은 이전 세대 예약이 바꾸면 안 되는 본문" });
    store.submitPrepared(sender, prepared.messageId);
    const owner = store.relayOwner(target, transport)!;
    expect(store.reserveManagedWake({ ...target, transport, instanceId: birth(pid), relayId: owner.relayId,
      nonce: "protected-session-start-wake-abcdefghijklmnop" }).dispatch).toBe(true);
    const claimed = store.claimTurnEnd(target, now, { instanceId: birth(pid) });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, claimReceipt: expect.any(String) }]);
    store.observeNativeInput(target, now, birth(pid));
    return claimed[0]!;
  };
  const snapshot = () => Object.fromEntries(tables.map(table =>
    [table, store.database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]));
  return { store, tokens, birth, dispatch, hook, activate, release, protectReceipt, snapshot, grants };
}

// CONC-FENCE-002 / DIST-ORDER-004: 정상 종료와 새 출생을 구분하고 옛 출생을 되살리지 않는다.
it("실제 SessionStart가 정상 종료한 A 다음 B를 예약·spawn하고 선택된 B 뒤 A 재등록은 거부한다", async () => {
  const f = fixture();
  await f.hook(101);
  expect(f.grants[0]).toMatchObject({ spawn: true, instanceId: f.birth(101), relayId: expect.any(String) });
  f.activate(101);
  f.release(101);
  await f.hook(102);
  expect(f.grants[1]).toMatchObject({ spawn: true, instanceId: f.birth(102), relayId: expect.any(String) });
  expect(f.store.presence(target)).toMatchObject({ instanceId: f.birth(102), state: "online", endedAt: null });
  expect(f.store.relayOwner(target, transport)).toMatchObject({ instanceId: f.birth(102), parentPid: 102, pid: 0 });
  expect(boundary.spawn).toHaveBeenCalledTimes(2);
  for (const index of [0, 1]) {
    const request = boundary.request.mock.calls[index]!;
    expect(Object.hasOwn(request[1], "expectedPresenceInstanceId")).toBe(false);
    expect(request[3]).toMatchObject({ noOperationReplay: true, deadlineMonotonicMs: 1000 });
    const args = boundary.spawn.mock.calls[index]![1] as string[];
    const pid = 101 + index;
    expect(args[args.indexOf("--instance-id") + 1]).toBe(f.birth(pid));
    expect(args[args.indexOf("--parent-pid") + 1]).toBe(String(pid));
    expect(args[args.indexOf("--parent-start-token") + 1]).toBe(f.tokens.get(pid));
    expect(args[args.indexOf("--relay-id") + 1]).toBe(f.grants[index]!.relayId);
    expect(boundary.spawn.mock.calls[index]![2]).toMatchObject({ detached: true, windowsHide: true, stdio: "ignore" });
  }
  const before = f.snapshot();
  await f.hook(101);
  expect(f.grants[2]).toMatchObject({ spawn: false, instanceId: f.birth(101) });
  expect(boundary.spawn).toHaveBeenCalledTimes(2);
  expect(f.snapshot()).toEqual(before);
});

it("출생 검증 중 C가 등록·정상 종료해 소유자가 다시 비어도 늦은 B는 처음 관측한 A의 CAS로 거부한다", async () => {
  const f = fixture();
  await f.hook(101);
  f.activate(101);
  const receipt = f.protectReceipt(101);
  f.release(101);
  const prepare = vi.spyOn(f.store, "prepareVerifiedRelay");
  let bQueries = 0;
  let afterC: ReturnType<typeof f.snapshot> | undefined;
  boundary.token.mockImplementation((pid: number) => {
    // 첫 조회는 훅의 선검증, 둘째는 실제 broker generator의 OS 조회 경계이다.
    if (pid === 102 && ++bQueries === 2) {
      expect(f.store.presence(target).instanceId).toBe(f.birth(101));
      expect(f.store.relayOwner(target, transport)).toBeNull();
      expect(f.dispatch(103)).toMatchObject({ spawn: true, instanceId: f.birth(103) });
      f.activate(103); f.release(103);
      // owner CAS만으로 통과하는 시험이 되지 않도록 원 owner=null로 돌린다. C 출생은 보호된 채 남는다.
      expect(f.store.relayOwner(target, transport)).toBeNull();
      afterC = f.snapshot();
    }
    return f.tokens.get(pid) ?? null;
  });
  await f.hook(102);
  expect(bQueries).toBe(2);
  expect(afterC).toBeDefined();
  const bInput = prepare.mock.calls.find(([data]) => data.parentPid === 102)![0];
  expect(bInput.expectedPresenceInstanceId).toBe(f.birth(101));
  expect(f.grants[1]).toMatchObject({ spawn: false, instanceId: f.birth(102), relayId: null });
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
  expect(f.store.presence(target).instanceId).toBe(f.birth(103));
  expect(f.store.database.prepare("SELECT instance_id FROM session_presence WHERE instance_id=?").get(f.birth(102))).toBeUndefined();
  expect(f.snapshot()).toEqual(afterC);
  expect(f.store.database.prepare("SELECT claim_receipt FROM messages WHERE message_id=?").get(receipt.messageId))
    .toMatchObject({ claim_receipt: receipt.claimReceipt });
});

it.each([null, "different-parent-birth"])("훅 선검증 뒤 broker의 B 출생 조회가 %s이면 예약·spawn·영수증을 바꾸지 않는다", async observed => {
  const f = fixture();
  await f.hook(101);
  f.activate(101); f.protectReceipt(101); f.release(101);
  const before = f.snapshot();
  let bQueries = 0;
  boundary.token.mockImplementation((pid: number) => pid === 102 && ++bQueries === 2 ? observed : f.tokens.get(pid) ?? null);
  await f.hook(102);
  expect(bQueries).toBe(2);
  expect(boundary.request).toHaveBeenCalledTimes(2);
  expect(f.grants).toHaveLength(1);
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
  expect(f.snapshot()).toEqual(before);
});

it.each([null, "explicit-other-generation"])("명시 expectedPresence=%s는 현재 A로 대체하지 않고 원 불일치를 거부한다", async expected => {
  const f = fixture();
  await f.hook(101);
  f.activate(101); f.protectReceipt(101); f.release(101);
  const before = f.snapshot();
  const prepare = vi.spyOn(f.store, "prepareVerifiedRelay");
  expect(f.dispatch(102, { expectedPresenceInstanceId: expected })).toMatchObject({ spawn: false, relayId: null, instanceId: f.birth(102) });
  expect(prepare.mock.calls[0]![0].expectedPresenceInstanceId).toBe(expected);
  expect(f.snapshot()).toEqual(before);
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
});

it("불일치한 훅 PID와 broker의 무효 PID는 기존 출생을 바꾸지 않는다", async () => {
  const f = fixture();
  await f.hook(101);
  f.activate(101); f.release(101);
  const before = f.snapshot();
  await handleSessionMessageHook(input, host, 103, { ensureRelay: true,
    hostProcess: { pid: 102, startToken: "parent-B" }, executionBudget: { deadlineMonotonicMs: 1000, postClaimReserveMs: 200 } });
  expect(boundary.request).toHaveBeenCalledTimes(1);
  expect(() => f.dispatch(102, { parentPid: 0 })).toThrow("Invalid relay host observation or budget.");
  expect(boundary.spawn).toHaveBeenCalledTimes(1);
  expect(f.snapshot()).toEqual(before);
});
