import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { bytes, fixture, histories, legacyFixture, legacyRows, memory, NEW_B, OLD_A, sql } from "./fixtures/ags38-d53-fixture.js";

// TEST/CI only. The existing official build must produce this executable first.
// No source CLI import, subprocess mock, operational database, or native model call.
const BUNDLE = fileURLToPath(new URL("../../mcp-server/dist/continuity-memory-migration.mjs", import.meta.url));
const CURRENT_CANARY = "CURRENT_OVERSIZE_D53_f123", SECRET_CANARY = "FAKE_TEST_SECRET_D53_739a";
const REQUEST_CANARY = "PRIVATE_TEST_RECEIPT_D53_3ac9";
const RECEIVER_CANARY = "RECEIVER_OWNED_ORIGIN_D53_752e";
const resources: Array<{ close(): void }> = [];
afterEach(() => { for (const resource of resources.splice(0).reverse()) resource.close(); });
function own<T extends { close(): void }>(value: T): T { resources.push(value); return value; }
type Legacy = ReturnType<typeof legacyFixture>;
interface CliReport { ok: boolean; code: string; count?: number; reason?: string; excludedReceiverTasks?: number; exclusionReason?: string | null }

function largeMemory() {
  const body = memory(CURRENT_CANARY);
  body.core.objective += "x".repeat(2400 - bytes(body));
  expect(bytes(body)).toBe(2400);
  return body;
}

function legacy(version: 2 | 3 = 2) {
  const f = own(legacyFixture(version, largeMemory()));
  // Synthetic TEST canaries, never credentials or another session's data.
  sql(f.databasePath, db => {
    db.prepare("INSERT INTO continuity_metadata(key,value) VALUES('signing-secret',?)").run(SECRET_CANARY);
    db.prepare("UPDATE continuity_requests SET result_json=?").run(JSON.stringify({ privateReceipt: REQUEST_CANARY }));
  });
  return f;
}

function fileState(file: string) {
  return { bytes: readFileSync(file), mtimeNs: statSync(file, { bigint: true }).mtimeNs };
}

function runCli(args: string[], databasePath: string) {
  expect(existsSync(BUNDLE), "Official build must create the migration CLI bundle").toBe(true);
  const result = spawnSync(process.execPath, [BUNDLE, ...args], { encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  expect(result.error, "CLI spawn/timeout is not an assertion result").toBeUndefined();
  expect(result.signal).toBeNull();
  const report = JSON.parse(result.stdout.trim()) as CliReport;
  expect(Object.keys(report).sort()).toEqual(report.ok
    ? report.code === "EXPORTED_CURRENT" ? ["code", "count", "excludedReceiverTasks", "exclusionReason", "ok"] : ["code", "count", "ok"]
    : ["code", "ok", "reason"]);
  if (report.ok) expect(result.status).toBe(0);
  else {
    expect(result.status).toBe(1);
    expect(report.code).toBe("MIGRATION_CLI_FAILED");
    expect(report.reason).toMatch(/^[A-Z][A-Z0-9_]+$/u);
  }
  const consoleText = result.stdout + result.stderr;
  for (const canary of [OLD_A, CURRENT_CANARY, NEW_B, SECRET_CANARY, REQUEST_CANARY, RECEIVER_CANARY, databasePath])
    expect(consoleText).not.toContain(canary);
  return { ...result, report };
}

function mapping(f: Legacy) {
  return { taskCorrelation: f.task, expectedSnapshotDigest: f.current.snapshotDigest, memory: memory(NEW_B) };
}

function exportCurrent(f: Legacy, output = join(f.directory, "admin-current.json")) {
  const result = runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath);
  expect(result.report).toEqual({ ok: true, code: "EXPORTED_CURRENT", count: 1, excludedReceiverTasks: 0, exclusionReason: null });
  return output;
}

function assertMigrated(f: Legacy) {
  sql(f.databasePath, db => {
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 4 });
    const rows = db.prepare("SELECT *,length(CAST(memory_json AS BLOB)) AS body_bytes FROM continuity_current_memory").all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ task_correlation: f.task, epoch: 2, state_token: expect.any(String) });
    expect(JSON.parse(String(rows[0]!.memory_json))).toEqual(memory(NEW_B));
    expect(rows[0]!.body_bytes).toBe(bytes(memory(NEW_B)));
    expect(Number(rows[0]!.body_bytes)).toBeLessThanOrEqual(2000);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='continuity_snapshots'").all()).toEqual([]);
  });
  expect(histories(f.databasePath).map(row => row.memory_json)).toEqual(f.originals);
}

describe("D53 관리자 migration CLI 실제 bundle subprocess", () => {
  // engineering-test-plan: task-wide receiver ownership excludes stale origins before body export.
  // Preconditions/input: owned schema3 with receiver delta in epoch1 or epoch2; no operational data.
  // Procedure/oracle: official CLI export -> optimize supported mappings -> apply; inspect owned SQL only.
  // Pass: supported/excluded counts differ, stale body absent, source bytes unchanged on export, delta/history preserved.
  // Actual/red-green: NOT_RUN here; TEST/CI runner and official build are owned by root.
  it.each([1, 2])("CLI-EXPORT-RECEIVER epoch%i: receiver-only는 stale origin 없이 제외수를 알리고 빈 mapping 이관 가능", epoch => {
    const f = own(legacyFixture(3, memory(RECEIVER_CANARY), true)), output = join(f.directory, "receiver-excluded.json");
    sql(f.databasePath, db => db.prepare("UPDATE continuity_delta_state SET epoch=?").run(epoch));
    const before = fileState(f.databasePath), rows = legacyRows(f.databasePath);
    const delta = sql(f.databasePath, db => db.prepare("SELECT * FROM continuity_delta_state").all());
    const result = runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath);
    expect(result.report).toEqual({ ok: true, code: "EXPORTED_CURRENT", count: 0,
      excludedReceiverTasks: 1, exclusionReason: "RECEIVER_STATE_UNSUPPORTED" });
    expect(readFileSync(output, "utf8")).toBe("[]\n");
    expect(fileState(f.databasePath)).toEqual(before);
    expect(legacyRows(f.databasePath)).toEqual(rows);
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", output], f.databasePath).report)
      .toEqual({ ok: true, code: "MIGRATED", count: 0 });
    expect(histories(f.databasePath).map(row => row.memory_json)).toEqual(f.originals);
    sql(f.databasePath, db => {
      expect(db.prepare("SELECT * FROM continuity_delta_state").all()).toEqual(delta);
      expect(db.prepare("SELECT memory_json FROM continuity_current_memory WHERE task_correlation=?").get(f.task))
        .toEqual({ memory_json: null });
    });
  });

  it("CLI-EXPORT-EMPTY: current가 없으면 지원0·receiver제외0을 구별하고 과거epoch를 export하지 않는다", () => {
    const f = legacy(3), output = join(f.directory, "empty-current.json");
    sql(f.databasePath, db => db.exec("DELETE FROM continuity_snapshots WHERE epoch=2"));
    const before = fileState(f.databasePath), rows = legacyRows(f.databasePath);
    expect(runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath).report)
      .toEqual({ ok: true, code: "EXPORTED_CURRENT", count: 0, excludedReceiverTasks: 0, exclusionReason: null });
    expect(readFileSync(output, "utf8")).toBe("[]\n");
    expect(fileState(f.databasePath)).toEqual(before);
    expect(legacyRows(f.databasePath)).toEqual(rows);
  });

  it("CLI-EXPORT-MIXED: receiver의 과거delta는 제외하고 지원task만 export·최적화·apply한다", () => {
    const f = legacy(3), receiverTask = "d53-receiver-owned", output = join(f.directory, "mixed-current.json");
    const { schemaVersion, source, epoch, revision, status, evidenceRefs, createdAt, updatedAt } = f.current;
    const base = { schemaVersion, source, taskCorrelation: receiverTask, epoch, revision, status,
      core: memory(RECEIVER_CANARY).core, evidenceRefs, createdAt, updatedAt };
    const receiver = { ...base, snapshotDigest: convergenceDigest(base) }, rawReceiver = JSON.stringify(receiver);
    sql(f.databasePath, db => {
      db.prepare("INSERT INTO continuity_tasks(task_correlation,current_epoch,updated_at) VALUES(?,2,?)").run(receiverTask, updatedAt);
      db.prepare("INSERT INTO continuity_snapshots VALUES(?,?,?,?,?,?)")
        .run(receiverTask, epoch, revision, receiver.snapshotDigest, rawReceiver, updatedAt);
      db.prepare("INSERT INTO continuity_delta_state VALUES(?,1,'test-host','test-session','test-instance',1,1,'origin','checkpoint',?,NULL,NULL)")
        .run(receiverTask, JSON.stringify({ privateDelta: RECEIVER_CANARY }));
    });
    const before = fileState(f.databasePath), delta = sql(f.databasePath, db => db.prepare("SELECT * FROM continuity_delta_state").all());
    expect(runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath).report)
      .toEqual({ ok: true, code: "EXPORTED_CURRENT", count: 1, excludedReceiverTasks: 1, exclusionReason: "RECEIVER_STATE_UNSUPPORTED" });
    const exported = readFileSync(output, "utf8");
    expect(JSON.parse(exported)).toEqual([{ taskCorrelation: f.task, expectedSnapshotDigest: f.current.snapshotDigest, memory: largeMemory() }]);
    expect(exported).not.toContain(RECEIVER_CANARY);
    expect(exported).not.toContain(receiverTask);
    expect(fileState(f.databasePath)).toEqual(before);
    const prepared = join(f.directory, "mixed-prepared.json");
    writeFileSync(prepared, JSON.stringify(JSON.parse(exported).map((item: ReturnType<typeof mapping>) => ({ ...item, memory: memory(NEW_B) }))), "utf8");
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", prepared], f.databasePath).report)
      .toEqual({ ok: true, code: "MIGRATED", count: 1 });
    expect(histories(f.databasePath).map(row => row.memory_json)).toEqual([...f.originals, rawReceiver]);
    sql(f.databasePath, db => {
      expect(db.prepare("SELECT * FROM continuity_delta_state").all()).toEqual(delta);
      expect(JSON.parse(String(db.prepare("SELECT memory_json FROM continuity_current_memory WHERE task_correlation=?").get(f.task)!.memory_json)))
        .toEqual(memory(NEW_B));
      expect(db.prepare("SELECT memory_json FROM continuity_current_memory WHERE task_correlation=?").get(receiverTask))
        .toEqual({ memory_json: null });
    });
  });

  it.each([2, 3] as const)("CLI-EXPORT schema%i: 현재 oversized 원문만 export하며 DB byte/mtime와 비공개 canary를 보존", version => {
    const f = legacy(version), beforeFile = fileState(f.databasePath), beforeRows = legacyRows(f.databasePath);
    const output = exportCurrent(f), raw = readFileSync(output, "utf8");
    expect(JSON.parse(raw)).toEqual([{ taskCorrelation: f.task, expectedSnapshotDigest: f.current.snapshotDigest,
      memory: largeMemory() }]);
    expect(bytes(JSON.parse(raw)[0].memory)).toBe(2400);
    for (const canary of [OLD_A, SECRET_CANARY, REQUEST_CANARY]) expect(raw).not.toContain(canary);
    expect(raw).toContain(CURRENT_CANARY);
    expect(fileState(f.databasePath)).toEqual(beforeFile);
    expect(legacyRows(f.databasePath)).toEqual(beforeRows);
  });

  it("CLI-EXPORT-FAIL wx: 기존 관리 파일의 byte/mtime를 덮어쓰지 않는다", () => {
    const f = legacy(), output = join(f.directory, "already-exists.json");
    writeFileSync(output, "owned existing recovery must survive", "utf8");
    const beforeOutput = fileState(output), beforeDatabase = fileState(f.databasePath);
    expect(runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath).report.reason).toBe("EEXIST");
    expect(fileState(output)).toEqual(beforeOutput);
    expect(fileState(f.databasePath)).toEqual(beforeDatabase);
  });

  it("CLI-EXPORT-FAIL: 손상된 current는 output 생성 없이 거부하고 raw 오류·본문을 출력하지 않는다", () => {
    const f = legacy(), output = join(f.directory, "must-not-exist.json");
    sql(f.databasePath, db => db.prepare("UPDATE continuity_snapshots SET snapshot_json=? WHERE epoch=2")
      .run(JSON.stringify({ bad: OLD_A, privateReceipt: REQUEST_CANARY })));
    const before = fileState(f.databasePath), rows = legacyRows(f.databasePath);
    const result = runCli(["export-current", "--database", f.databasePath, "--output", output], f.databasePath);
    expect(result.report.reason).toBe("INVALID_LEGACY_CURRENT");
    expect(existsSync(output)).toBe(false);
    expect(fileState(f.databasePath)).toEqual(before);
    expect(legacyRows(f.databasePath)).toEqual(rows);
  });

  it("CLI-EXPORT-FAIL: 존재하지 않는 DB와 관리 mapping을 만들지 않는다", () => {
    const f = legacy(), missingDatabase = join(f.directory, "absent.sqlite3"), output = join(f.directory, "absent-export.json");
    const prepared = join(f.directory, "prepared.json");
    writeFileSync(prepared, JSON.stringify([mapping(f)]), "utf8");
    const entries = readdirSync(f.directory).sort();
    expect(runCli(["export-current", "--database", missingDatabase, "--output", output], missingDatabase).report.ok).toBe(false);
    expect(runCli(["apply", "--database", missingDatabase, "--mapping", prepared], missingDatabase).report.ok).toBe(false);
    expect(existsSync(missingDatabase)).toBe(false);
    expect(existsSync(output)).toBe(false);
    const missingMapping = join(f.directory, "missing-mapping.json"), before = fileState(f.databasePath);
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", missingMapping], f.databasePath).report.reason).toBe("ENOENT");
    expect(existsSync(missingMapping)).toBe(false);
    expect(fileState(f.databasePath)).toEqual(before);
    expect(readdirSync(f.directory).sort()).toEqual(entries);
  });

  it("CLI-EXPORT-FAIL schema4: current/history를 다시 관리 export하거나 apply하지 않는다", () => {
    const f = own(fixture()), output = join(f.directory, "forbidden-export.json"), prepared = join(f.directory, "prepared.json");
    expect(f.save(memory(OLD_A), "a").ok).toBe(true);
    expect(f.save(memory(NEW_B), "b").ok).toBe(true);
    writeFileSync(prepared, "[]", "utf8");
    const before = fileState(f.databasePath), history = histories(f.databasePath);
    for (const args of [["export-current", "--database", f.databasePath, "--output", output],
      ["apply", "--database", f.databasePath, "--mapping", prepared]]) {
      expect(runCli(args, f.databasePath).report.reason).toBe("ALREADY_MIGRATED");
      expect(fileState(f.databasePath)).toEqual(before);
      expect(histories(f.databasePath)).toEqual(history);
    }
    expect(existsSync(output)).toBe(false);
  });

  it.each([2, 3] as const)("CLI-APPLY-INPUT schema%i: invalid/duplicate/oversized/stale/missing 최적화를 원형 보존하며 거부", version => {
    const f = legacy(version), exported = exportCurrent(f), exportBefore = fileState(exported);
    const recovery = fileState(f.recoveryPath), before = fileState(f.databasePath), beforeRows = legacyRows(f.databasePath);
    const valid = mapping(f), oversized = memory(NEW_B);
    oversized.core.objective += "x".repeat(2001 - bytes(oversized));
    const cases: Array<{ name: string; input: unknown; reason: string; raw?: string }> = [
      { name: "json", input: null, raw: "{", reason: "INVALID_MAPPING_JSON" },
      { name: "non-array", input: valid, reason: "INVALID_MAPPING" },
      { name: "unknown-key", input: [{ ...valid, history: true }], reason: "INVALID_MAPPING" },
      { name: "duplicate", input: [valid, valid], reason: "DUPLICATE_MAPPING" },
      { name: "oversized", input: [{ ...valid, memory: oversized }], reason: "MEMORY_TOO_LARGE" },
      { name: "invalid-memory", input: [{ ...valid, memory: { status: "paused" } }], reason: "INVALID_MEMORY" },
      { name: "stale", input: [{ ...valid, expectedSnapshotDigest: `sha256:${"0".repeat(64)}` }], reason: "MIGRATION_INCOMPLETE" },
      { name: "missing-optimization", input: [], reason: "MIGRATION_INCOMPLETE" },
    ];
    for (const item of cases) {
      const prepared = join(f.directory, `${item.name}.json`);
      writeFileSync(prepared, item.raw ?? JSON.stringify(item.input), "utf8");
      const mappingBefore = fileState(prepared), entries = readdirSync(f.directory).sort();
      expect(runCli(["apply", "--database", f.databasePath, "--mapping", prepared], f.databasePath).report.reason, item.name).toBe(item.reason);
      expect(fileState(f.databasePath), item.name).toEqual(before);
      expect(legacyRows(f.databasePath), item.name).toEqual(beforeRows);
      expect(fileState(exported), item.name).toEqual(exportBefore);
      expect(fileState(prepared), item.name).toEqual(mappingBefore);
      expect(fileState(f.recoveryPath), item.name).toEqual(recovery);
      expect(readdirSync(f.directory).sort(), item.name).toEqual(entries);
    }
  });

  it("CLI-APPLY-ROLLBACK: archive/DDL 뒤 오류도 DB 원 byte/mtime·schema·관리자료를 보존하고 재시도 가능", () => {
    const f = legacy(), exported = exportCurrent(f), prepared = join(f.directory, "prepared.json");
    writeFileSync(prepared, JSON.stringify([mapping(f)]), "utf8");
    sql(f.databasePath, db => db.exec(`CREATE TRIGGER d53_cli_failure BEFORE UPDATE ON continuity_requests BEGIN SELECT RAISE(ABORT,'${OLD_A}'); END`));
    const before = fileState(f.databasePath), rows = legacyRows(f.databasePath), exportBefore = fileState(exported);
    const recovery = fileState(f.recoveryPath), preparedBefore = fileState(prepared), entries = readdirSync(f.directory).sort();
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", prepared], f.databasePath).report.ok).toBe(false);
    expect(fileState(f.databasePath)).toEqual(before);
    expect(legacyRows(f.databasePath)).toEqual(rows);
    expect(fileState(exported)).toEqual(exportBefore);
    expect(fileState(prepared)).toEqual(preparedBefore);
    expect(fileState(f.recoveryPath)).toEqual(recovery);
    expect(readdirSync(f.directory).sort()).toEqual(entries);
    sql(f.databasePath, db => db.exec("DROP TRIGGER d53_cli_failure"));
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", prepared], f.databasePath).report)
      .toEqual({ ok: true, code: "MIGRATED", count: 1 });
    assertMigrated(f);
  });

  it.each([2, 3] as const)("CLI-APPLY-VALID schema%i: 검증된 최적화 current와 모든 legacy 원문 history를 독립 SQL 확인", version => {
    const f = legacy(version), exported = exportCurrent(f), prepared = join(f.directory, "prepared.json");
    writeFileSync(prepared, JSON.stringify([mapping(f)]), "utf8");
    const exportBefore = fileState(exported), recovery = fileState(f.recoveryPath), preparedBefore = fileState(prepared);
    expect(runCli(["apply", "--database", f.databasePath, "--mapping", prepared], f.databasePath).report)
      .toEqual({ ok: true, code: "MIGRATED", count: 1 });
    assertMigrated(f);
    expect(fileState(exported)).toEqual(exportBefore);
    expect(fileState(f.recoveryPath)).toEqual(recovery);
    expect(fileState(prepared)).toEqual(preparedBefore);
  });
});
