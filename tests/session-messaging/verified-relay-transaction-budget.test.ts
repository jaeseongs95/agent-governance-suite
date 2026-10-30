import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({ token: vi.fn() }));
vi.mock("../../mcp-server/src/process-identity.js", async original => ({
  ...(await original<typeof import("../../mcp-server/src/process-identity.js")>()), processStartToken: native.token,
}));
import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import { SessionMessageStore } from "../../mcp-server/src/session-message-store.js";

const target = { host: "portable", sessionId: "verified-relay-transaction-budget" };
const transport = "portable-queue";
const tables = ["messages", "prepared_messages", "input_observations", "session_activity", "wake_nonces", "session_presence", "relay_leases"];
const stores: SessionMessageStore[] = [];
const directories: string[] = [];
const birth = (pid: number, token: string) => "host-process-v1:" + createHash("sha256")
  .update(JSON.stringify([target.host, target.sessionId, pid, token])).digest("hex");

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// CONC-CANCEL-004 / DB-BOUNDARY-001 / DB-ISOLATION-002:
// 같은 이벤트 루프의 타이머로 동기 SQLite 잠금을 풀지 않는다. 독립 worker의 실제 두 번째 연결이다.
async function writerLock(filename: string, holdMs: number) {
  const cells = new Int32Array(new SharedArrayBuffer(4 * Int32Array.BYTES_PER_ELEMENT));
  const worker = new Worker(String.raw`
    const { workerData } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    const cells = new Int32Array(workerData.shared);
    const db = new DatabaseSync(workerData.filename);
    const phase = value => { Atomics.store(cells, 1, value); Atomics.notify(cells, 1); };
    try {
      db.exec("PRAGMA busy_timeout=5000");
      phase(1);
      Atomics.wait(cells, 0, 0);
      db.exec("BEGIN IMMEDIATE");
      phase(2);
      Atomics.wait(cells, 2, 0, workerData.holdMs);
      Atomics.store(cells, 3, 1);
      db.exec("COMMIT");
      phase(3);
    } catch (error) {
      phase(-1);
      throw error;
    } finally {
      db.close();
    }
  `, { eval: true, workerData: { filename, shared: cells.buffer, holdMs } });
  let failure: Error | undefined;
  worker.on("error", error => { failure = error; });
  const exited = new Promise<number>(resolve => worker.once("exit", resolve));
  const waitFor = (phase: number) => {
    const deadline = performance.now() + 5000;
    while (Atomics.load(cells, 1) !== phase) {
      const current = Atomics.load(cells, 1);
      if (current === -1 || current > phase || performance.now() >= deadline) {
        throw new Error("독립 SQLite writer의 단계 확인 실패: " + current + " / " + phase);
      }
      Atomics.wait(cells, 1, current, Math.max(1, deadline - performance.now()));
    }
  };
  const close = async () => {
    Atomics.store(cells, 0, 1); Atomics.notify(cells, 0);
    Atomics.store(cells, 2, 1); Atomics.notify(cells, 2);
    expect(await exited, failure?.message).toBe(0);
  };
  try {
    waitFor(1);
    return {
      acquire() { Atomics.store(cells, 0, 1); Atomics.notify(cells, 0); waitFor(2); },
      cancelled: () => Atomics.load(cells, 3) === 1,
      waitUntilReleased() { waitFor(3); },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-verified-relay-budget-"));
  directories.push(directory);
  const filename = path.join(directory, "messages.sqlite3");
  const store = new SessionMessageStore(filename);
  stores.push(store);
  const tokens = new Map([[100, "parent-A"], [101, "parent-B"], [102, "parent-C"], [1100, "relay-A"], [1101, "relay-B"]]);
  native.token.mockReset();
  native.token.mockImplementation((pid: number) => tokens.get(pid) ?? null);
  const probe = vi.spyOn(process, "kill").mockImplementation(pid => {
    if (pid === 100) throw Object.assign(new Error("관측된 이전 부모의 ESRCH"), { code: "ESRCH" });
    return true;
  });
  const at = Date.now();
  const start = (pid: number) => {
    const token = tokens.get(pid)!;
    const grant = store.prepareVerifiedRelay({ ...target, transport, parentPid: pid, instanceId: birth(pid, token),
      verifiedParentStartToken: token, expectedOwner: store.relayOwner(target, transport),
      expectedPresenceInstanceId: store.presence(target, at).instanceId, wakeVisibility: "user-message", canWakeSilently: false,
      deliveryCapabilities: { supportedInjection: ["peer-wake", "turn-end"], idleWake: "user-message" } }, at);
    expect(grant.spawn).toBe(true);
    expect(store.activateVerifiedRelay({ ...target, transport, parentPid: pid, instanceId: grant.instanceId,
      relayId: grant.relayId!, pid: pid + 1000, relayStartToken: tokens.get(pid + 1000)! }, at)).toBe(true);
    return grant;
  };
  const a = start(100), b = start(101);
  const sender = { host: "peer", sessionId: "protected-receipt" };
  const prepared = store.prepare({ sender, target, body: "만료·취소 뒤에도 본문과 claim 영수증을 보존한다" }, at);
  store.submitPrepared(sender, prepared.messageId, at);
  expect(store.reserveManagedWake({ ...target, transport, instanceId: b.instanceId, relayId: b.relayId!,
    nonce: "protected-budget-wake-abcdefghijklmnop" }, at).dispatch).toBe(true);
  const claimed = store.claimTurnEnd(target, at, { instanceId: b.instanceId });
  expect(claimed).toMatchObject([{ messageId: prepared.messageId, claimReceipt: expect.any(String) }]);
  store.observeNativeInput(target, at, b.instanceId);
  const snapshot = () => Object.fromEntries(tables.map(table => [table, store.database.prepare("SELECT * FROM " + table + " ORDER BY rowid").all()]));
  const ensure = () => dispatchSessionMessageBrokerOperation(store, "ensure-relay", { target, transport, parentPid: 102,
    parentStartToken: "parent-C", identityTimeoutMs: 100, expectedPresenceInstanceId: b.instanceId,
    wakeVisibility: "user-message", idleWake: "user-message", canWakeSilently: false, supportedInjection: ["peer-wake", "turn-end"] });
  return { filename, store, a, b, probe, snapshot, ensure, claimed, prepared, at };
}

it.each(["deadline", "cancelled"] as const)("부모·ESRCH 관측 뒤 실제 writer 대기 중 %s이면 7개 표·보호행·예약을 보존한다", async mode => {
  const f = fixture();
  const writer = await writerLock(f.filename, 300);
  const before = f.snapshot();
  const original = f.store.prepareVerifiedRelay.bind(f.store);
  const abort = new AbortController();
  const cancelled = new Error("The broker identity query was cancelled.");
  let entered = false;
  vi.spyOn(f.store, "prepareVerifiedRelay").mockImplementationOnce((input, nowMs) => {
    expect(native.token.mock.calls.map(([pid]) => pid)).toContain(102);
    expect(f.probe).toHaveBeenCalledWith(100, 0);
    expect(input.confirmedDeadPresence?.instanceId).toBe(f.a.instanceId);
    entered = true;
    writer.acquire();
    const check = input.checkRequestBudget;
    return original({ ...input, ...(mode === "cancelled" ? { checkRequestBudget: () => {
      if (writer.cancelled()) abort.abort();
      if (abort.signal.aborted) throw cancelled;
      check?.();
    } } : {}) }, nowMs);
  });
  try {
    const started = performance.now();
    let caught: unknown;
    try { f.ensure(); } catch (error) { caught = error; }
    expect(entered).toBe(true);
    writer.waitUntilReleased();
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    if (mode === "deadline") expect(caught).toMatchObject({ code: "BROKER_IDENTITY_BUDGET_EXPIRED" });
    else { expect(abort.signal.aborted).toBe(true); expect(caught).toBe(cancelled); }
    expect(f.snapshot()).toEqual(before);
    expect(f.store.database.prepare("SELECT verified_parent_token,superseded_at FROM session_presence WHERE instance_id=?").get(f.a.instanceId))
      .toMatchObject({ verified_parent_token: "parent-A", superseded_at: expect.any(String) });
    expect(f.store.relayOwner(target, transport)).toMatchObject({ instanceId: f.b.instanceId, relayId: f.b.relayId, pid: 1101 });
    expect(f.store.database.prepare("SELECT instance_id FROM session_presence WHERE instance_id=?").get(birth(102, "parent-C"))).toBeUndefined();
  } finally { await writer.close(); }
}, 15_000);

it("commit 직전 취소는 이미 수행한 새 세대·예약·사망 CAS 삭제를 모두 rollback하고 다음 정상 요청을 허용한다", () => {
  const f = fixture();
  const dead = f.store.verifiedPresenceForCleanup();
  expect(dead?.instanceId).toBe(f.a.instanceId);
  const before = f.snapshot();
  const abort = new AbortController();
  const cancelled = new Error("The broker identity query was cancelled.");
  let checks = 0;
  const input = { ...target, transport, parentPid: 102, instanceId: birth(102, "parent-C"), verifiedParentStartToken: "parent-C",
    expectedOwner: f.store.relayOwner(target, transport), expectedPresenceInstanceId: f.b.instanceId,
    confirmedDeadPresence: dead!, wakeVisibility: "user-message" as const, canWakeSilently: false,
    checkRequestBudget: () => {
      checks++;
      if (checks === 2) {
        expect(f.store.database.prepare("SELECT instance_id FROM session_presence WHERE instance_id=?").get(f.a.instanceId)).toBeUndefined();
        expect(f.store.relayOwner(target, transport)).toMatchObject({ instanceId: birth(102, "parent-C"), pid: 0 });
        abort.abort();
      }
      if (abort.signal.aborted) throw cancelled;
    } };
  let caught: unknown;
  try { f.store.prepareVerifiedRelay(input, f.at); } catch (error) { caught = error; }
  expect(checks).toBe(2);
  expect(caught).toBe(cancelled);
  expect(f.snapshot()).toEqual(before);
  expect(f.ensure()).toMatchObject({ spawn: true, instanceId: birth(102, "parent-C") });
});
