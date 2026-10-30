import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock("../../mcp-server/src/process-identity.js", async original => ({
  ...(await original<typeof import("../../mcp-server/src/process-identity.js")>()), processStartToken: native.token,
}));
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { PRESENCE_RETENTION_MS, SessionMessageStore, type SessionIdentity } from "../../mcp-server/src/session-message-store.js";

// CONC-FENCE-002 / DIST-ORDER-004: 실제 SQLite와 broker 신원 경계. OS 조회만 fixture로 격리한다.
// 출생시간 전순서·구버전 writer 혼합 실행·설치/실제 호스트 수용은 이 시험의 보장이 아니다.
const target = { host: "portable", sessionId: "pruned-generation-fence" };
const transport = "portable-queue";
const now = Date.UTC(2026, 9, 30);
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const birth = (pid: number, token: string, recipient = target) => "host-process-v1:" + createHash("sha256")
  .update(JSON.stringify([recipient.host, recipient.sessionId, pid, token])).digest("hex");
const tables = ["messages", "prepared_messages", "input_observations", "session_activity", "wake_nonces", "session_presence", "relay_leases"];

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); native.token.mockReset(); });
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.useRealTimers();
});

function databaseFile() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-pruned-generation-"));
  directories.push(directory);
  return path.join(directory, "messages.sqlite3");
}

function fixture(filename = ":memory:") {
  const store = new SessionMessageStore(filename);
  stores.push(store);
  const tokens = new Map<number, string>([[100, "parent-A"], [101, "parent-B"], [102, "parent-C"], [103, "parent-D"]]);
  const failures = new Map<number, string>();
  native.token.mockImplementation((pid: number) => tokens.get(pid) ?? null);
  const probe = vi.spyOn(process, "kill").mockImplementation(pid => {
    const code = failures.get(pid);
    if (code) throw Object.assign(new Error("controlled process probe"), { code });
    return true;
  });
  const payload = (pid: number, expected = store.presence(target).instanceId, recipient: SessionIdentity = target) => ({
    target: recipient, transport, parentPid: pid, parentStartToken: tokens.get(pid)!, identityTimeoutMs: 8000,
    expectedPresenceInstanceId: expected, wakeVisibility: "user-message", idleWake: "user-message",
    canWakeSilently: false, supportedInjection: ["peer-wake", "tool-boundary", "turn-end"],
  });
  const ensure = (pid: number, expected = store.presence(target).instanceId, recipient: SessionIdentity = target) =>
    dispatchSessionMessageBrokerOperation(store, "ensure-relay", payload(pid, expected, recipient)) as ReturnType<SessionMessageStore["prepareVerifiedRelay"]>;
  const start = (pid: number) => {
    const grant = ensure(pid);
    expect(grant.spawn).toBe(true);
    tokens.set(pid + 1000, "child-" + pid);
    expect(store.activateVerifiedRelay({ ...target, transport, parentPid: pid, instanceId: grant.instanceId,
      relayId: grant.relayId!, pid: pid + 1000, relayStartToken: tokens.get(pid + 1000)! })).toBe(true);
    return grant;
  };
  const snapshot = () => Object.fromEntries(tables.map(table => [table, store.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const row = (instanceId: string) => store.database.prepare("SELECT * FROM session_presence WHERE instance_id=?").get(instanceId);
  return { store, tokens, failures, probe, payload, ensure, start, snapshot, row };
}

describe("D0354 정리 이후에도 유지되는 검증 부모 세대 울타리", () => {
  it("A/B 동시 생존 중 24시간 정리 뒤 A를 거부하고 B의 7개 표·claim 영수증·ACK를 보존한다", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    const later = now + PRESENCE_RETENTION_MS + 60_000;
    vi.setSystemTime(later);
    expect(f.ensure(101).spawn).toBe(false);
    f.store.prune(later);
    const prepared = f.store.prepare({ sender: { host: "peer", sessionId: "sender" }, target, body: "replacement body" }, later);
    f.store.submitPrepared({ host: "peer", sessionId: "sender" }, prepared.messageId, later);
    f.store.observeNativeInput(target, later, b.instanceId);
    expect(f.store.reserveManagedWake({ ...target, transport, instanceId: b.instanceId, relayId: b.relayId!,
      nonce: "protected-birth-wake-abcdefghijklmnop" }, later).dispatch).toBe(true);
    const before = f.snapshot();
    expect(f.ensure(100, b.instanceId)).toMatchObject({ spawn: false, relayId: null });
    expect(f.row(a.instanceId)).toMatchObject({ superseded_at: expect.any(String), verified_parent_pid: 100, verified_parent_token: "parent-A" });
    expect(f.snapshot()).toEqual(before);
    expect(f.store.startPresence({ ...target, transport, instanceId: a.instanceId, wakeVisibility: "none", canWakeSilently: false }, later).instanceId).toBe(b.instanceId);
    expect(f.snapshot()).toEqual(before);
    const claimed = f.store.claimTurnEnd(target, later + 1, { instanceId: b.instanceId });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, deliveryAttempt: 1, body: "replacement body" }]);
    expect(f.store.acknowledge(target, [prepared.messageId], later + 2, claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    expect(f.store.database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
  });

  it("미등록 C는 기대한 B가 현재일 때 허용하고 D 교체 뒤의 C 관측은 거부한다", () => {
    const f = fixture();
    f.start(100);
    const b = f.start(101);
    expect(f.ensure(102, b.instanceId)).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C") });
    const c = f.store.presence(target).instanceId!;
    expect(f.ensure(103, c).spawn).toBe(true);
    const before = f.snapshot();
    expect(f.ensure(102, b.instanceId)).toMatchObject({ spawn: false, relayId: null });
    expect(f.snapshot()).toEqual(before);
    expect(f.store.presence(target).instanceId).toBe(birth(103, "parent-D"));
  });

  it.each([0, -10_000])("B의 같은 ms 재등록 뒤 시계 이동 %ims에도 새 C를 한 번만 예약한다", clockOffset => {
    const f = fixture();
    const b = f.start(101);
    expect(f.store.endPresence(target, "normal-stop", b.instanceId, now)).toBe(true);
    f.failures.set(1101, "ESRCH");
    const restarted = f.ensure(101, b.instanceId);
    expect(restarted).toMatchObject({ spawn: true, instanceId: b.instanceId });
    expect(f.probe).toHaveBeenCalledWith(1101, 0);
    expect(f.row(b.instanceId)).toMatchObject({ started_at: new Date(now + 1).toISOString(), superseded_at: null });

    vi.setSystemTime(now + clockOffset);
    const c = f.ensure(102, b.instanceId);
    expect(c).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C"), relayId: expect.any(String) });
    expect(f.store.presence(target)).toMatchObject({ instanceId: c.instanceId, state: "online" });
    expect(f.row(b.instanceId)).toMatchObject({ superseded_at: new Date(now + clockOffset).toISOString() });
    expect(f.store.relayOwner(target, transport)).toMatchObject({ instanceId: c.instanceId, relayId: c.relayId, pid: 0 });
    expect(f.store.database.prepare("SELECT instance_id FROM session_presence ORDER BY rowid").all())
      .toEqual([{ instance_id: b.instanceId }, { instance_id: c.instanceId }]);
    const reserved = f.snapshot();
    expect(f.ensure(102, c.instanceId)).toMatchObject({ spawn: false, instanceId: c.instanceId, relayId: c.relayId });
    expect(f.snapshot()).toEqual(reserved);
  });

  it("재등록 B를 대체할 C 삽입이 실패하면 superseded 표시와 예약도 전부 되돌린다", () => {
    const f = fixture();
    const b = f.start(101);
    expect(f.store.endPresence(target, "normal-stop", b.instanceId, now)).toBe(true);
    f.failures.set(1101, "ESRCH");
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

  it("독립된 두 연결이 B를 관측하면 C만 예약하고 D의 늦은 예약은 7개 표·영수증을 바꾸지 않는다", () => {
    const filename = databaseFile(), f = fixture(filename);
    const second = new SessionMessageStore(filename);
    stores.push(second);
    f.start(100);
    const b = f.start(101);
    const observedB = second.presence(target).instanceId;
    const ownerB = second.relayOwner(target, transport);
    expect(observedB).toBe(b.instanceId);
    const sender = { host: "peer", sessionId: "two-connections" };
    const prepared = f.store.prepare({ sender, target, body: "receipt survives the losing reservation" });
    f.store.submitPrepared(sender, prepared.messageId);
    expect(f.ensure(102, observedB).spawn).toBe(true);
    const c = birth(102, "parent-C");
    const claimed = f.store.claimTurnEnd(target, now, { instanceId: c });
    expect(claimed).toMatchObject([{ messageId: prepared.messageId, claimReceipt: expect.any(String) }]);
    const before = f.snapshot();
    expect(second.prepareVerifiedRelay({ ...target, transport, parentPid: 103, instanceId: birth(103, "parent-D"),
      verifiedParentStartToken: "parent-D", expectedOwner: ownerB, expectedPresenceInstanceId: observedB,
      wakeVisibility: "user-message", canWakeSilently: false })).toMatchObject({ spawn: false, relayId: null });
    expect(f.snapshot()).toEqual(before);
    expect(second.acknowledge(target, [prepared.messageId], now + 1,
      claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
  });

  it("새 보호열이 없는 schema 2 파일을 additive 이전하며 원 행과 회차·ACK 영수증을 보존한다", () => {
    const filename = databaseFile(), f = fixture(filename);
    f.start(100);
    const sender = { host: "peer", sessionId: "schema-two" };
    const prepared = f.store.prepare({ sender, target, body: "original schema-two body" });
    f.store.submitPrepared(sender, prepared.messageId);
    const claimed = f.store.claimTurnEnd(target, now, { instanceId: birth(100, "parent-A") });
    expect(claimed).toHaveLength(1);
    expect(f.store.acknowledge(target, [prepared.messageId], now + 1,
      claimed.map(message => ({ messageId: message.messageId, claimReceipt: message.claimReceipt! })))).toBe(1);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();
    const legacy = new DatabaseSync(filename);
    let before: unknown;
    try {
      for (const column of ["verified_parent_pid", "verified_parent_token", "superseded_at"]) legacy.exec(`ALTER TABLE session_presence DROP COLUMN ${column};`);
      before = Object.fromEntries(tables.map(table => [table, legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      expect(legacy.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    } finally { legacy.close(); }
    const upgraded = new SessionMessageStore(filename);
    stores.push(upgraded);
    const second = new SessionMessageStore(filename);
    stores.push(second);
    const after = Object.fromEntries(tables.map(table => [table, upgraded.database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()
      .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !["verified_parent_pid", "verified_parent_token", "superseded_at"].includes(key))))]));
    expect(after).toEqual(before);
    expect(second.database.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 2 });
    expect(second.database.prepare("SELECT verified_parent_pid,verified_parent_token,superseded_at FROM session_presence").get())
      .toEqual({ verified_parent_pid: null, verified_parent_token: null, superseded_at: null });
  });

  it("최초 EPERM 행을 보존하면서 뒤의 사망행과 세션의 마지막 사망행까지 순환 수거한다", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    f.failures.set(100, "EPERM");
    f.failures.set(101, "ESRCH");
    const other = { host: "portable", sessionId: "cleanup-request" };
    for (let i = 0; i < 4; i += 1) f.ensure(102, f.store.presence(other).instanceId, other);
    expect(f.row(a.instanceId)).toBeDefined();
    expect(f.row(b.instanceId)).toBeUndefined();
    // 남은 A는 이미 교체 확정돼 있어 B 삭제로 다시 현재가 되지 않는다.
    expect(f.store.presence(target).instanceId).toBeNull();
  });

  it("이미 검증된 같은 PID의 다른 출생토큰으로만 원 신원 사망을 확인하고 새 세대를 보존한다", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    f.tokens.set(100, "reused-parent-C");
    const c = f.ensure(100, b.instanceId);
    expect(c).toMatchObject({ spawn: true, instanceId: birth(100, "reused-parent-C") });
    expect(f.row(a.instanceId)).toBeUndefined();
    expect(f.row(c.instanceId)).toMatchObject({ verified_parent_token: "reused-parent-C", superseded_at: null });
  });

  it("양성 PID 탐사만으로 다른 PID의 저장 출생 신원을 사망 또는 일치로 판정하지 않는다", () => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    f.tokens.set(100, "reused-but-not-queried");
    native.token.mockClear();
    expect(f.ensure(102, b.instanceId).spawn).toBe(true);
    expect(f.row(a.instanceId)).toMatchObject({ verified_parent_token: "parent-A" });
    expect(native.token.mock.calls.map(([pid]) => pid)).not.toContain(100);
  });

  it.each(["started_at", "superseded_at"] as const)("사망 관측 뒤 %s가 바뀌면 행·세대 CAS가 삭제하지 않는다", column => {
    const f = fixture();
    const a = f.start(100), b = f.start(101);
    f.tokens.set(100, "reused-parent-C");
    const prepare = f.store.prepareVerifiedRelay.bind(f.store);
    vi.spyOn(f.store, "prepareVerifiedRelay").mockImplementationOnce(input => {
      expect(input.confirmedDeadPresence?.instanceId).toBe(a.instanceId);
      f.store.database.prepare(`UPDATE session_presence SET ${column}=? WHERE instance_id=?`)
        .run(new Date(now + 1234).toISOString(), a.instanceId);
      return prepare(input);
    });
    expect(f.ensure(100, b.instanceId).spawn).toBe(true);
    expect(f.row(a.instanceId)).toBeDefined();
  });

  it.each(["null", "timeout", "cancelled"] as const)("부모 조회가 %s이면 보호기록과 나머지 상태를 보존한다", mode => {
    const f = fixture();
    f.start(100); f.start(101);
    const before = f.snapshot();
    const failure = Object.assign(new Error("controlled identity failure"), { code: mode === "cancelled" ? "ABORT_ERR" : "ETIMEDOUT" });
    native.token.mockImplementationOnce((_pid, _platform, _timeout, observer) => {
      if (mode !== "null") observer(failure, { stage: "proc-read", elapsedMs: 1, timeoutMs: 1, nativeCode: failure.code, status: null, signal: null, stderrIndication: null });
      return null;
    });
    expect(() => f.ensure(102)).toThrow("Relay host generation is unverified.");
    expect(f.snapshot()).toEqual(before);
  });

  it("수거 사망근거를 얻은 뒤 남은 요청 예산이 끝나면 삭제와 예약을 모두 하지 않는다", () => {
    const f = fixture();
    f.start(100); f.start(101);
    f.failures.set(100, "ESRCH");
    const before = f.snapshot();
    let elapsed = 0;
    vi.spyOn(performance, "now").mockImplementation(() => elapsed);
    native.token.mockImplementation((pid: number) => {
      if (pid === 1101) elapsed = 8001;
      return f.tokens.get(pid) ?? null;
    });
    expect(() => f.ensure(102)).toThrow();
    expect(f.probe).toHaveBeenCalledWith(100, 0);
    expect(f.snapshot()).toEqual(before);
  });

  it("추가되는 새 행이 있어도 고정된 수거 회차를 끝내고 앞선 행으로 돌아온다", () => {
    const f = fixture();
    const register = (pid: number) => {
      const token = "parent-" + pid;
      f.tokens.set(pid, token);
      return f.store.prepareVerifiedRelay({ ...target, transport, parentPid: pid, instanceId: birth(pid, token),
        verifiedParentStartToken: token, expectedOwner: f.store.relayOwner(target, transport),
        expectedPresenceInstanceId: f.store.presence(target).instanceId, wakeVisibility: "none", canWakeSilently: false });
    };
    const a = register(200), b = register(201);
    expect(f.store.verifiedPresenceForCleanup()?.instanceId).toBe(a.instanceId);
    register(202);
    expect(f.store.verifiedPresenceForCleanup()?.instanceId).toBe(b.instanceId);
    register(203);
    expect(f.store.verifiedPresenceForCleanup()?.instanceId).toBe(a.instanceId);
  });

  it("미검증 행도 한 요청의 한 행으로 소비하고 다음 요청에서 검증 행으로 전진한다", () => {
    const f = fixture();
    f.store.startPresence({ host: "legacy", sessionId: "unverified", instanceId: "legacy", transport,
      wakeVisibility: "none", canWakeSilently: false });
    const token = "parent-A";
    const a = f.store.prepareVerifiedRelay({ ...target, transport, parentPid: 100, instanceId: birth(100, token),
      verifiedParentStartToken: token, expectedOwner: null, wakeVisibility: "none", canWakeSilently: false });
    expect(f.store.verifiedPresenceForCleanup()).toBeNull();
    expect(f.store.verifiedPresenceForCleanup()?.instanceId).toBe(a.instanceId);
  });
});
