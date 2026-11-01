import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";

import { dispatchSessionMessageBrokerOperation } from "../../mcp-server/src/session-message-broker.js";
import type { sessionMessageRequest } from "../../mcp-server/src/session-message-client.js";
import { dispatchManagedWake } from "../../mcp-server/src/session-message-relay.js";
import { SessionMessageStore, type WakeAttempt } from "../../mcp-server/src/session-message-store.js";

const target = { host: "portable", sessionId: "d0031-recipient" };
const sender = { host: "portable", sessionId: "d0031-sender" };
const relay = { ...target, instanceId: "d0031-instance", transport: "portable", relayId: "d0031-relay" };
const body = "잠금 대기 중 만료되어도 시작·전달로 거짓 승격하거나 본문을 소비하지 않는다";
const directories: string[] = [];
const stores: SessionMessageStore[] = [];
const children: ChildProcess[] = [];
const iso = (at: number) => new Date(at).toISOString();

// DB-ISOLATION-002: 별도 프로세스의 실 SQLite 연결이 잠금을 가진다.
// 같은 이벤트 루프의 타이머로 동기 BEGIN IMMEDIATE 대기를 풀지 않는다.
const writerCode = String.raw`
  import { DatabaseSync } from "node:sqlite";
  import { existsSync } from "node:fs";
  const db = new DatabaseSync(process.argv[1]);
  const barrier = process.argv[2];
  process.send({ phase: "ready", pid: process.pid });
  process.once("message", ({ expiresAt, crossExpiry }) => {
    db.exec("BEGIN IMMEDIATE");
    process.send({ phase: "locked", at: Date.now(), pid: process.pid });
    const deadline = Date.now() + 5000;
    const release = () => {
      if (Date.now() >= deadline) throw new Error("D0031 writer 장벽 대기 시간 초과");
      if (!existsSync(barrier) || (crossExpiry && Date.now() < expiresAt + 25)) {
        setTimeout(release, 5);
        return;
      }
      db.exec("COMMIT");
      const at = Date.now();
      db.close();
      process.send({ phase: "released", at, pid: process.pid }, () => process.disconnect());
    };
    release();
  });
`;

async function writer(filename: string, barrier: string) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", writerCode, filename, barrier], {
    stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true, shell: false, env: {},
  });
  children.push(child);
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  const message = async (phase: string) => {
    const [value] = await once(child, "message", { signal: AbortSignal.timeout(7000) }) as [{ phase: string; at: number; pid: number }];
    expect(value.phase, stderr).toBe(phase);
    return value;
  };
  const ready = await message("ready");
  expect(ready.pid).not.toBe(process.pid);
  return { child, message, exited, stderr: () => stderr };
}

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d0031-lock-clock-"));
  directories.push(directory);
  const filename = path.join(directory, "messages.sqlite3");
  const store = new SessionMessageStore(filename);
  stores.push(store);
  const now = Date.now();
  store.startPresence({ ...relay, wakeVisibility: "silent", canWakeSilently: true,
    deliveryCapabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" } }, now);
  expect(store.acquireRelay({ ...relay, pid: 200, parentPid: 100 }, now)).toBe(true);
  store.send({ sender, target, messageId: "d0031-body", body, ttlSeconds: 600 }, now);
  return { store, filename, barrier: path.join(directory, "entered-writer-lock") };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close", { signal: AbortSignal.timeout(7000) });
      child.kill();
      await closed;
    }
  }
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 원조건: 요청 시각 < 만료 시각 < 실제 writer 잠금 획득 시각.
// 명시 atMs나 가짜 시계를 전달하지 않고 broker→store→relay의 외부 효과를 본다.
// 전체 동시 만료 외에도 각 직접 소비자의 만료를 분리해야 앞선 guard가 결함을 가리지 않는다.
it.each(["all", "nonce", "message", "presence", "relay", "live"] as const)(
  "D0031: start writer 대기 중 %s 만료는 외부 전달·거짓 started를 막고 만료 전에는 한 번 전달한다", async mode => {
    const f = fixture();
    const lock = await writer(f.filename, f.barrier);
    const dispatch = vi.fn(async () => "submitted" as const);
    let attempt: WakeAttempt | undefined;
    let expiresAt = 0;
    let enteredAt = 0;
    let acquiredAt = 0;
    let lockedAt = 0;
    let startResult: unknown;
    let released!: ReturnType<typeof lock.message>;
    const request = async (operation: string, payload: Record<string, unknown>) => {
      if (operation === "start-wake") {
        attempt = payload.attempt as WakeAttempt;
        expect(f.store.database.prepare("SELECT state,dispatch_epoch,started_at FROM wake_nonces WHERE attempt_id=?").get(attempt.attemptId))
          .toMatchObject({ state: "reserved", dispatch_epoch: 0, started_at: null });
        expiresAt = Date.now() + 1000;
        if (mode === "all" || mode === "nonce") f.store.database.prepare("UPDATE wake_nonces SET expires_at=?").run(iso(expiresAt));
        if (mode === "all" || mode === "message") f.store.database.prepare("UPDATE messages SET expires_at=?").run(iso(expiresAt));
        if (mode === "all" || mode === "presence") f.store.database.prepare("UPDATE session_presence SET lease_until=?").run(iso(expiresAt));
        if (mode === "all" || mode === "relay") f.store.database.prepare("UPDATE relay_leases SET lease_until=?").run(iso(expiresAt));
        const locked = lock.message("locked");
        lock.child.send({ expiresAt, crossExpiry: mode !== "live" });
        lockedAt = (await locked).at;
        released = lock.message("released");
        const execute = f.store.database.exec.bind(f.store.database);
        const spy = vi.spyOn(f.store.database, "exec").mockImplementation(sql => {
          if (sql !== "BEGIN IMMEDIATE") return execute(sql);
          enteredAt = Date.now();
          writeFileSync(f.barrier, "entered", { encoding: "utf8" });
          const result = execute(sql);
          acquiredAt = Date.now();
          return result;
        });
        try {
          startResult = dispatchSessionMessageBrokerOperation(f.store, operation, payload);
          return startResult;
        } finally { spy.mockRestore(); }
      }
      return dispatchSessionMessageBrokerOperation(f.store, operation, payload);
    };
    const result = await dispatchManagedWake(relay, relay.relayId, {
      capabilities: { supportedInjection: ["peer-wake"], idleWake: "silent" }, dispatch,
    }, request as typeof sessionMessageRequest);
    const release = await released;
    console.log(JSON.stringify({ defect: "D0031", mode, brokerPid: process.pid, writerPid: lock.child.pid,
      lockedAt, enteredAt, expiresAt, acquiredAt, releasedAt: release.at, dispatchCount: dispatch.mock.calls.length }));
    expect(await lock.exited, lock.stderr()).toEqual({ code: 0, signal: null });
    expect(lockedAt).toBeLessThanOrEqual(enteredAt);
    expect(enteredAt).toBeLessThan(expiresAt);
    expect(acquiredAt).toBeGreaterThanOrEqual(lockedAt);
    if (mode !== "live") {
      expect(release.at).toBeGreaterThanOrEqual(expiresAt);
      expect(acquiredAt).toBeGreaterThanOrEqual(expiresAt);
      expect(startResult).toEqual({ dispatch: false, attempt: null });
      expect(result).toBe(false);
      expect(dispatch).not.toHaveBeenCalled();
    } else {
      expect(acquiredAt).toBeLessThan(expiresAt);
      expect(result).toBe(true);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch.mock.calls[0]).toEqual([target, `[agent-governance-suite:wake:${attempt!.nonce}]`, undefined]);
    }
    const row = f.store.database.prepare("SELECT state,dispatch_epoch,started_at FROM wake_nonces WHERE attempt_id=?").get(attempt!.attemptId);
    expect(row).toMatchObject(mode === "live" ? { state: "submitted", dispatch_epoch: 1, started_at: expect.any(String) }
      : { state: mode === "nonce" || mode === "message" ? "not-submitted" : "reserved", dispatch_epoch: 0, started_at: null });
    expect(f.store.database.prepare("SELECT body,claimed_at,delivery_attempts,acknowledged_at FROM messages WHERE message_id='d0031-body'").get())
      .toEqual(expect.objectContaining({ body, claimed_at: null, delivery_attempts: 0, acknowledged_at: null }));
  });
