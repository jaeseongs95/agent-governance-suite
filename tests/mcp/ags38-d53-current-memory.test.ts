import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { bytes, direct, domainRows, fixture, histories, memory, NEW_B, NOW, OLD_A, sizedMemory, sql,
  type Fixture } from "./fixtures/ags38-d53-fixture.js";

// 실행 전 사례·oracle: d53-memory-test-plan.ko.md. TEST/CI only; no mocked database.
const owned: Fixture[] = [];
afterEach(() => { for (const item of owned.splice(0)) item.close(); });
function setup() { const value = fixture(); owned.push(value); return value; }

describe("D53 현재 메모리의 실제 SQLite 불변조건", () => {
  it.each(["objective", "evidence"] as const)("D53-BYTE %s: 한국어·escape·증거 포함 전체 UTF8 1999/2000/2001", slot => {
    const f = setup();
    for (const size of [1999, 2000]) {
      const body = sizedMemory(size, slot);
      expect(JSON.stringify(body).length).toBeLessThan(size);
      const saved = f.save(body, `bytes-${size}`);
      expect(saved.ok).toBe(true);
      expect(direct(saved.data).memory).toEqual(body);
      expect(sql(f.databasePath, db => db.prepare("SELECT length(CAST(memory_json AS BLOB)) AS bytes FROM continuity_current_memory").get()))
        .toEqual({ bytes: size });
    }
    const before = domainRows(f.databasePath);
    const rejected = f.save(sizedMemory(2001, slot), "bytes-2001");
    expect(rejected).toMatchObject({ ok: false, error: { code: "INVALID_INPUT", details: {
      reasonCode: "CONTINUITY_MEMORY_TOO_LARGE", actualBytes: 2001, maxBytes: 2000 } } });
    expect(domainRows(f.databasePath)).toEqual(before);
    // Independent database constraint, even if service validation is bypassed.
    expect(() => sql(f.databasePath, db => db.prepare("UPDATE continuity_current_memory SET memory_json=?")
      .run(JSON.stringify(sizedMemory(2001, slot))))).toThrow(/CHECK constraint failed/u);
    expect(domainRows(f.databasePath)).toEqual(before);
    const short = memory("짧은 목표");
    expect(f.save(short, "short").ok).toBe(true);
    expect(bytes(f.current().memory!)).toBe(bytes(short));
    expect(bytes(short)).toBeLessThan(1000);
  });

  it("D53-ARCHIVE: current 하나와 직전 원문·token·digest·시각을 SQL로 독립 확인", () => {
    const f = setup(), empty = f.current();
    expect(empty.memory).toBeNull();
    expect(histories(f.databasePath)).toHaveLength(0);
    const a = direct(f.save(memory(OLD_A), "a").data);
    expect(a.stateToken).not.toBe(empty.stateToken);
    expect(histories(f.databasePath)).toHaveLength(0);
    const rawA = sql(f.databasePath, db => db.prepare("SELECT * FROM continuity_current_memory").get())!;
    const b = direct(f.save(memory(NEW_B), "b").data);
    const rows = sql(f.databasePath, db => db.prepare("SELECT * FROM continuity_current_memory").all());
    expect(rows).toHaveLength(1);
    expect(b.stateToken).not.toBe(a.stateToken);
    expect(b.memory).toEqual(memory(NEW_B));
    expect(histories(f.databasePath)).toEqual([expect.objectContaining({
      task_correlation: a.taskCorrelation, epoch: a.epoch, state_token: a.stateToken,
      memory_json: rawA.memory_json, memory_digest: rawA.memory_digest,
      created_at: rawA.created_at, updated_at: rawA.updated_at,
    })]);
  });

  it("D53-IDEMPOTENCY: replay/no-op은 history·token·시각을 늘리지 않고 오래된 replay는 본문을 반환하지 않는다", () => {
    const f = setup(), body = memory(OLD_A), initial = f.current().stateToken;
    const a = direct(f.save(body, "a", initial).data), afterA = domainRows(f.databasePath);
    f.setNow("2026-11-07T01:01:00.000Z");
    expect(f.save(body, "a", initial).data).toEqual(a);
    expect(domainRows(f.databasePath)).toEqual(afterA);
    expect(f.save(body, "a-noop", a.stateToken).data).toEqual(a);
    expect(f.current()).toEqual(a);
    expect(histories(f.databasePath)).toHaveLength(0);
    const noOpRows = domainRows(f.databasePath);
    expect(f.save(memory("conflicting"), "a", initial)).toMatchObject({ ok: false, error: { code: "REQUEST_CONFLICT" } });
    expect(domainRows(f.databasePath)).toEqual(noOpRows);
    expect(f.save(memory(NEW_B), "b").ok).toBe(true);
    const beforeReplay = domainRows(f.databasePath), replay = f.save(body, "a", initial);
    expect(replay).toMatchObject({ ok: false, error: { code: "STALE_REVISION" } });
    expect(JSON.stringify(replay)).not.toContain(OLD_A);
    expect(domainRows(f.databasePath)).toEqual(beforeReplay);
    const receipts = sql(f.databasePath, db => db.prepare("SELECT result_json FROM continuity_requests").all());
    expect(JSON.stringify(receipts)).not.toContain(OLD_A);
    expect(JSON.stringify(receipts)).not.toContain(NEW_B);
    for (const { result_json: json } of receipts) {
      const receipt = JSON.parse(String(json));
      expect(receipt).not.toHaveProperty("memory");
      expect(receipt).not.toHaveProperty("core");
      expect(receipt).not.toHaveProperty("snapshot");
    }
  });

  it.each([
    ["history", "AFTER INSERT ON continuity_memory_history"],
    ["current", "AFTER UPDATE ON continuity_current_memory"],
    ["receipt", "AFTER INSERT ON continuity_requests"],
  ])("D53-ROLLBACK %s: 트랜잭션 중간 오류 뒤 current/history/receipt/anchor 모두 복원", (_point, trigger) => {
    const f = setup();
    expect(f.save(memory(OLD_A), "a").ok).toBe(true);
    const before = domainRows(f.databasePath), token = f.current().stateToken;
    sql(f.databasePath, db => db.exec(`CREATE TRIGGER d53_owned_failure ${trigger} BEGIN SELECT RAISE(ABORT,'${OLD_A}'); END`));
    const result = f.service.checkpointContext({ schemaVersion: "1.0.0", requestId: "faulted",
      expectedStateToken: token, ...memory(NEW_B) }, { ...f.caller, readLineage: () => ({ ids: ["owned-fault-anchor"], at: [0] }) });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(OLD_A);
    expect(domainRows(f.databasePath)).toEqual(before);
    sql(f.databasePath, db => db.exec("DROP TRIGGER d53_owned_failure"));
    expect(f.save(memory(NEW_B), "after-fault", token).ok).toBe(true);
    expect(histories(f.databasePath)).toHaveLength(1);
  });

  it("D53-ABA: A→B→A와 purge→A는 옛 token으로 쓰거나 삭제할 수 없다", () => {
    const f = setup(), body = memory(OLD_A);
    const a = direct(f.save(body, "a").data);
    expect(f.save(memory(NEW_B), "b").ok).toBe(true);
    const again = direct(f.save(body, "a-again").data);
    expect(again.memoryDigest).toBe(a.memoryDigest);
    expect(again.stateToken).not.toBe(a.stateToken);
    const before = domainRows(f.databasePath);
    expect(f.save(memory("stale-write"), "stale-write", a.stateToken).ok).toBe(false);
    expect(f.service.purgeDirectContext({ schemaVersion: "1.0.0", requestId: "stale-purge", expectedStateToken: a.stateToken }, f.caller).ok).toBe(false);
    expect(domainRows(f.databasePath)).toEqual(before);
    const purge = { schemaVersion: "1.0.0", requestId: "purge-a", expectedStateToken: again.stateToken };
    expect(f.service.purgeDirectContext(purge, f.caller).ok).toBe(true);
    const empty = f.current();
    expect(empty.memory).toBeNull();
    expect(empty.stateToken).not.toBe(again.stateToken);
    const afterPurge = domainRows(f.databasePath);
    expect(f.service.purgeDirectContext(purge, f.caller).ok).toBe(true);
    expect(domainRows(f.databasePath)).toEqual(afterPurge);
    expect(histories(f.databasePath)).toHaveLength(2); // purge must not archive its own target.
    const recreated = direct(f.save(body, "recreated").data), stable = domainRows(f.databasePath);
    expect(recreated.stateToken).not.toBe(a.stateToken);
    expect(f.service.purgeDirectContext(purge, f.caller).ok).toBe(false);
    expect(domainRows(f.databasePath)).toEqual(stable);
  });

  it("D53-ROLLBACK nested: 내부 checkpoint 성공 뒤 외부 transaction 실패는 history/current/receipt를 함께 취소", () => {
    const f = setup(), a = direct(f.save(memory(OLD_A), "a").data), before = domainRows(f.databasePath);
    let innerKind: string | undefined;
    expect(() => f.store.readCurrentState(a.taskCorrelation, a.epoch, "direct", () => {
      const result = f.store.checkpoint(a.taskCorrelation, a.epoch, a.stateToken, "nested-request", "nested-command", memory(NEW_B), NOW,
        ["owned-nested-anchor"]);
      innerKind = result.kind;
      throw new Error("owned outer rollback");
    })).toThrow();
    expect(innerKind).toBe("stored");
    expect(domainRows(f.databasePath)).toEqual(before);
  });

  it("D53-LIFECYCLE: clear와 terminal carry는 빈 상태에도 새 token을 발급하고 old writer를 fence한다", () => {
    const f = setup(), a = direct(f.save(memory(OLD_A), "a").data);
    f.service.clearSession(f.session);
    const empty = f.current();
    expect(empty).toMatchObject({ epoch: a.epoch + 1, memory: null });
    expect(empty.stateToken).not.toBe(a.stateToken);
    expect(histories(f.databasePath)).toHaveLength(1);
    expect(f.save(memory("old-writer"), "old-writer", a.stateToken).ok).toBe(false);
    expect(f.service.purgeDirectContext({ schemaVersion: "1.0.0", requestId: "old-purge", expectedStateToken: a.stateToken }, f.caller).ok).toBe(false);
    f.service.clearSession(f.session);
    expect(f.current().stateToken).not.toBe(empty.stateToken);
    const b = direct(f.save(memory(NEW_B), "b").data);
    expect(f.store.bindRoot(b.taskCorrelation, b.epoch, "owned-root", NOW)).toBe(true);
    const bound = f.current(), rows = domainRows(f.databasePath);
    const expected = { epoch: b.epoch, rootId: "owned-root", isTerminal: () => false,
      carry: (snapshot: typeof b, nextEpoch: number) => ({ ...snapshot, epoch: nextEpoch }) };
    f.store.rotateEpoch(b.taskCorrelation, NOW, expected);
    expect(f.current()).toEqual(bound);
    expect(domainRows(f.databasePath)).toEqual(rows);
    f.store.rotateEpoch(b.taskCorrelation, NOW, { ...expected, isTerminal: () => true });
    expect(f.current().memory).toEqual(b.memory);
    expect(f.current().epoch).toBe(b.epoch + 1);
    expect(f.current().stateToken).not.toBe(b.stateToken);
    expect(f.store.checkpoint(b.taskCorrelation, b.epoch, b.stateToken, "old-epoch", "old-command", memory(), NOW).kind).toBe("epoch-mismatch");
  });

  it("D53-RACE: 실제 두 프로세스가 같은 token을 읽은 뒤 정확히 한 writer만 commit", async () => {
    const f = setup(), a = direct(f.save(memory(OLD_A), "a").data);
    const workerPath = fileURLToPath(new URL("./fixtures/ags38-d53-race-worker.mjs", import.meta.url));
    const children = [0, 1].map(() => {
      const child = fork(workerPath, [f.databasePath, a.taskCorrelation, String(a.epoch)], {
        execArgv: ["--import", import.meta.resolve("tsx")], stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let stderr = "", result: { type: string; kind?: string; pid?: number } | undefined;
      child.stderr!.on("data", chunk => { stderr += String(chunk); });
      const ready = new Promise<{ pid: number; stateToken: string }>((resolve, reject) => {
        child.on("message", message => {
          const item = message as { type: string; pid: number; stateToken: string };
          if (item.type === "ready") resolve(item);
        });
        child.once("error", reject);
        child.once("exit", code => reject(new Error(`Worker exited before barrier: ${code}; ${stderr}`)));
      });
      const completed = new Promise<string>((resolve, reject) => {
        const deadline = setTimeout(() => { child.kill(); reject(new Error("D53 worker barrier deadline")); }, 20_000);
        child.on("message", message => {
          const item = message as typeof result;
          if (item?.type === "result" || item?.type === "worker-error") result = item;
        });
        child.once("error", error => { clearTimeout(deadline); reject(error); });
        child.once("exit", code => {
          clearTimeout(deadline);
          if (code === 0 && result?.type === "result" && result.kind) resolve(result.kind);
          else reject(new Error(`Worker failure: exit=${code}, result=${JSON.stringify(result)}; ${stderr}`));
        });
      });
      // Keep an early spawn failure observed while awaiting both ready messages.
      void completed.catch(() => undefined);
      return { child, ready, completed };
    });
    try {
      const ready = await Promise.all(children.map(child => child.ready));
      expect(new Set(ready.map(item => item.pid)).size).toBe(2);
      expect(ready.every(item => item.stateToken === a.stateToken)).toBe(true);
      children.forEach(({ child }, index) => child.send({ requestHash: `race-${index}`,
        commandDigest: convergenceDigest({ index }), memory: memory(`winner-${index}`), now: NOW }));
      expect((await Promise.all(children.map(child => child.completed))).sort()).toEqual(["stale", "stored"]);
      expect(histories(f.databasePath)).toHaveLength(1);
      expect(histories(f.databasePath)[0]).toMatchObject({ state_token: a.stateToken });
      expect(sql(f.databasePath, db => db.prepare("SELECT count(*) AS n FROM continuity_requests WHERE request_hash LIKE 'race-%'").get()))
        .toEqual({ n: 1 });
    } finally {
      for (const { child } of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.allSettled(children.map(child => child.completed));
    }
  });
});
