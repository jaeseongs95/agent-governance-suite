import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { dispatchSessionMessageOperation } from "../../mcp-server/src/session-message-operations.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchManagedWake } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore, type WakeAttempt } from "../../mcp-server/src/session-message-store.js";
import type { WakeDispatchOutcome } from "../../mcp-server/src/session-message-wake-port.js";

const target = { host: "portable", sessionId: "d0031-recipient" };
const sender = { host: "portable", sessionId: "d0031-sender" };
const binding = { ...target, instanceId: "d0031-instance", transport: "portable" };
const body = "잠금 대기 중 만료되어도 시작·전달로 거짓 승격하거나 본문을 소비하지 않는다";
const T0 = Date.parse("2026-11-01T00:00:00.000Z");
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
const iso = (at: number) => new Date(at).toISOString();

// The store's only clock is injected. Every operation uses the authority time (no explicit time argument).
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d0031-lock-clock-"));
  directories.push(directory);
  const clock = { now: T0, samples: [] as Array<{ at: number; inTransaction: boolean }> };
  // A new file is initialized (and samples the clock) inside the constructor, before its connection is known here.
  const opened: { database?: DatabaseSync } = {};
  const store = new SessionMessageStore(path.join(directory, "messages.sqlite3"), {
    clock: () => { clock.samples.push({ at: clock.now, inTransaction: opened.database?.isTransaction ?? true }); return clock.now; },
  });
  opened.database = store.database;
  stores.push(store);
  store.startPresence({ ...binding, wakeVisibility: "silent", canWakeSilently: true, hostPid: 4242,
    deliveryCapabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" } });
  const relayId = store.grantRelay({ ...binding, codeDigest: null, hostPid: 4242 }).relayId!;
  expect(store.relayTick({ ...binding, relayId, includePending: true, hostStart: "d0031-host-start" })).toEqual({ alive: true, count: 0, hostBound: true });
  store.send({ sender, target, messageId: "d0031-body", body, ttlSeconds: 600 });
  return { store, clock, relayId };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 원조건: 요청 시각 < 만료 시각 < 실제 writer 잠금 획득 시각.
// 잠금 대기는 BEGIN IMMEDIATE가 돌아오는 사이에 주입 시계를 만료 뒤로 옮겨 결정적으로 재현한다(벽시계 대기 없음).
// 잠금 전에 시각을 샘플하는 구현은 만료 전 시각으로 판정하므로 이 시험에서 실패한다.
// 전체 동시 만료 외에도 각 직접 소비자의 만료를 분리해야 앞선 guard가 결함을 가리지 않는다.
it.each(["all", "nonce", "message", "presence", "relay", "live"] as const)(
  "D0031: start writer 대기 중 %s 만료는 외부 전달·거짓 started를 막고 만료 전에는 한 번 전달한다", async mode => {
    const f = fixture();
    const dispatch = vi.fn(async (): Promise<WakeDispatchOutcome> => ({ result: "handed-off" }));
    let attempt: WakeAttempt | undefined;
    let startResult: unknown;
    let startSamples: Array<{ at: number; inTransaction: boolean }> = [];
    const expiresAt = T0 + 1000;
    const request = async (operation: string, payload: Record<string, unknown>) => {
      if (operation !== "start-wake") return dispatchSessionMessageOperation(f.store, operation, payload);
      attempt = payload.attempt as WakeAttempt;
      expect(f.store.database.prepare("SELECT state,dispatch_epoch,started_at FROM wake_nonces WHERE attempt_id=?").get(attempt.attemptId))
        .toMatchObject({ state: "reserved", dispatch_epoch: 0, started_at: null });
      if (mode === "all" || mode === "nonce") f.store.database.prepare("UPDATE wake_nonces SET expires_at=?").run(iso(expiresAt));
      if (mode === "all" || mode === "message") f.store.database.prepare("UPDATE messages SET expires_at=?").run(iso(expiresAt));
      if (mode === "all" || mode === "presence") f.store.database.prepare("UPDATE session_presence SET lease_until=?").run(iso(expiresAt));
      if (mode === "all" || mode === "relay") f.store.database.prepare("UPDATE relay_leases SET lease_until=?").run(iso(expiresAt));
      // The request is issued before the expiry; acquiring the writer lock completes after it (except "live").
      const execute = f.store.database.exec.bind(f.store.database);
      const spy = vi.spyOn(f.store.database, "exec").mockImplementation(sql => {
        if (sql !== "BEGIN IMMEDIATE") return execute(sql);
        const result = execute(sql);
        if (mode !== "live") f.clock.now = expiresAt + 25;
        return result;
      });
      f.clock.samples.length = 0;
      try {
        startResult = dispatchSessionMessageOperation(f.store, operation, payload);
        return startResult;
      } finally { spy.mockRestore(); startSamples = [...f.clock.samples]; }
    };
    const result = await dispatchManagedWake(binding, f.relayId, {
      capabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" }, resendBaseMs: 600_000, dispatch,
    }, request as typeof sessionMessageRequest);
    if (mode !== "live") {
      expect(startResult).toEqual({ dispatch: false, attempt: null });
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]).toEqual([target, `[agent-governance-suite:wake:${attempt!.nonce}]`]);
    }
    // start-wake read its time once, under the writer lock (D0031/D0060).
    expect(startSamples).toEqual([{ at: mode === "live" ? T0 : expiresAt + 25, inTransaction: true }]);
    const row = f.store.database.prepare("SELECT state,dispatch_epoch,started_at FROM wake_nonces WHERE attempt_id=?").get(attempt!.attemptId);
    // 3.0 (2.6): an expired reservation is released (expired); one without a claimable body ends as not-delivered.
    expect(row).toMatchObject(mode === "live" ? { state: "handed-off", dispatch_epoch: 1, started_at: iso(T0) }
      : { state: mode === "nonce" || mode === "all" ? "released" : mode === "message" ? "not-delivered" : "reserved", dispatch_epoch: 0, started_at: null });
    // The body is never consumed: an expired one is pruned unclaimed, a live one stays queued for the woken claim.
    const message = f.store.database.prepare("SELECT body,claimed_at,delivery_attempts,acknowledged_at FROM messages WHERE message_id='d0031-body'").get();
    if (mode === "all" || mode === "message") expect(message).toBeUndefined();
    else expect(message).toEqual(expect.objectContaining({ body, claimed_at: null, delivery_attempts: 0, acknowledged_at: null }));
  });
