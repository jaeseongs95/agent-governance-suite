import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { ContinuityMemoryBodyV1, LegacyContinuitySnapshotV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { bytes, histories, legacyFixture, memory, NEW_B, OLD, OLD_A, sizedMemory, sql } from "./fixtures/ags38-d53-fixture.js";

// D55 / case218: actual documented commands, TEST-owned fixtures, no model calls.
// The immutable technical draft has prose edits later; protected fence bytes stay fixed.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUIDE = join(ROOT, "docs", "migrate-to-v3.8.0.md");
const HELPERS = ["backup-sqlite.mjs", "check-continuity-schema.mjs", "memory-sizes.mjs"];
const JS_HASHES = [
  "5f7fe1c0388cb0de5c53e430d1a9c62d7631137d19f1ea1a47284224e451b5ed",
  "b1b0df4444a4ae9ec2fed48c6b8543fbb03e9ee5ef1e6a415ad1131f90dd7c10",
  "b13218a1c0ccfa3b87cf87208a62643581632a7938665b3ea0af7eb8086cd9e5",
];
const TEXT_HASHES = [
  "df60f858ea64ef948bff7d5f52b9662b0a32401168b4db55480aa9ead692ce2b",
  "eb4f1bacd2c27be52ad1bdafe7d9b53622be65643cd3c9f82c24567aeaad678a",
  "1a0d45a856d70c492e372533fb6acee347d888b949d18168729d68cbbf8508f2",
  "461f46dad90e2c12fda8cf7ee4a118dd66b34c652e5d5b7df23a920965457f7d",
  "5587b5918f4a0586c5ab94f1a76449c3fe777f0209239f7f615898601038edf5",
  "d2ad5b0d45408f2b9e075d09a536b0f689cb7733e183d75fefd32efc9246bf2a",
  "253e94de45b3319ffbe62ec3df8858a6b911149818dac2f807e9afc97388013f",
  "d9838faed616664ed87b4de6a1e02eab85fb08b8f21f59005b87d7ebedd1ab78",
];
const WAL_KEY = "d55-committed-wal", WAL_BEFORE = "OWNED_WAL_PRE_UPGRADE_712b", WAL_AFTER = "OWNED_WAL_POST_UPGRADE_c812";
const LARGE = "OWNED_CURRENT_2400_D55_f18a", SECRET = "FAKE_TEST_SECRET_D55_91cf";
const resources: Array<{ close(): void }> = [];
afterEach(() => { for (const resource of resources.splice(0).reverse()) resource.close(); });
function own<T extends { close(): void }>(value: T): T { resources.push(value); return value; }
function digest(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function state(file: string) { return { bytes: readFileSync(file), mtime: statSync(file, { bigint: true }).mtimeNs }; }

function protectedBlocks() {
  const source = readFileSync(GUIDE, "utf8");
  const blocks = [...source.matchAll(/^([ \t]*)```([^\r\n]*)\r?\n([\s\S]*?)^\1```[ \t]*\r?$/gm)]
    .map(match => ({ language: match[2], body: match[3]! }));
  const scripts = blocks.filter(block => block.language === "js").map(block => block.body);
  const commands = blocks.filter(block => block.language === "text").map(block => block.body);
  expect(scripts.map(digest)).toEqual(JS_HASHES);
  expect(commands.map(digest)).toEqual(TEXT_HASHES);
  return { scripts, commands };
}

function tools(directory: string) {
  const { scripts, commands } = protectedBlocks(), folder = join(directory, "관리 tools");
  mkdirSync(folder);
  const values: Record<string, string> = {};
  HELPERS.forEach((name, index) => {
    const path = join(folder, name);
    writeFileSync(path, scripts[index]!, { flag: "wx" });
    expect(readFileSync(path)).toEqual(Buffer.from(scripts[index]!, "utf8"));
    values[`<${name}>`] = path;
  });
  return { values, lines: (index: number) => commands[index]!.split(/\r?\n/u).map(line => line.trim()).filter(Boolean) };
}

type Values = Record<string, string>;
function command(line: string, values: Values) {
  // Tokenize the actual fence literal before substituting paths: spaces/non-ASCII remain one argv item.
  const tokens = [...line.matchAll(/"([^"]*)"|(\S+)/gu)].map(match => match[1] ?? match[2]!);
  expect(tokens.shift()).toBe("node");
  const argv = tokens.map(token => values[token] ?? token);
  expect(argv.some(token => /^<.*>$/u.test(token))).toBe(false);
  const result = spawnSync(process.execPath, argv, { cwd: ROOT, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 });
  expect(result.error, `spawn/timeout is not a product assertion: ${JSON.stringify(argv)}`).toBeUndefined();
  expect(result.signal).toBeNull();
  return { ...result, argv };
}

function noBody(output: { stdout: string; stderr: string }) {
  for (const marker of [OLD_A, NEW_B, LARGE, SECRET, WAL_BEFORE, WAL_AFTER])
    expect(output.stdout + output.stderr).not.toContain(marker);
}

function successful(output: ReturnType<typeof command>) {
  expect(output.status, output.stderr).toBe(0);
  noBody(output);
  return JSON.parse(output.stdout.trim()) as Record<string, unknown>;
}

function readonly<T>(path: string, inspect: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return inspect(db); } finally { db.close(); }
}

// Closed TEST process leaves committed WAL and SHM just as a crashed writer can.
// Hashes prove the committed marker is absent from the unchanged main-file image.
const CRASH_WRITER = [
  "import {DatabaseSync} from 'node:sqlite';",
  "import {readFileSync} from 'node:fs';",
  "import {createHash} from 'node:crypto';",
  "const [file,key,value]=process.argv.slice(1);",
  "const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL;PRAGMA wal_autocheckpoint=0;PRAGMA synchronous=FULL');",
  "const hash=()=>createHash('sha256').update(readFileSync(file)).digest('hex');const before=hash();",
  "db.prepare('INSERT OR REPLACE INTO continuity_metadata(key,value) VALUES(?,?)').run(key,value);",
  "process.stdout.write(JSON.stringify({committed:true,before,after:hash()}));process.exit(0);",
].join("\n");

function committedWal(databasePath: string, value = WAL_BEFORE) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", CRASH_WRITER, databasePath, WAL_KEY, value],
    { encoding: "utf8", timeout: 10_000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status, result.stderr).toBe(0);
  const proof = JSON.parse(result.stdout);
  expect(proof.committed).toBe(true);
  expect(proof.before).toBe(proof.after);
  for (const suffix of ["-wal", "-shm"]) expect(statSync(databasePath + suffix).size).toBeGreaterThan(0);
}

function largeMemory() {
  const body = memory(LARGE);
  body.core.objective += "x".repeat(2400 - bytes(body));
  return body;
}

function legacy(version: 2 | 3) {
  const f = own(legacyFixture(version, largeMemory()));
  sql(f.databasePath, db => db.prepare("INSERT INTO continuity_metadata(key,value) VALUES('signing-secret',?)").run(SECRET));
  return f;
}

function snapshots(databasePath: string) {
  return readonly(databasePath, db => db.prepare("SELECT snapshot_json FROM continuity_snapshots ORDER BY task_correlation,epoch").all());
}

function legacyState(databasePath: string) {
  return readonly(databasePath, db => ({ version: db.prepare("PRAGMA user_version").get(),
    metadata: db.prepare("SELECT * FROM continuity_metadata ORDER BY key").all(),
    tasks: db.prepare("SELECT * FROM continuity_tasks ORDER BY task_correlation").all(),
    snapshots: db.prepare("SELECT * FROM continuity_snapshots ORDER BY task_correlation,epoch").all(),
    requests: db.prepare("SELECT * FROM continuity_requests ORDER BY task_correlation,epoch,request_hash").all(),
  }));
}

function addCurrent(databasePath: string, task: string, body: ContinuityMemoryBodyV1) {
  const base = { schemaVersion: "1.0.0" as const, source: "direct" as const, taskCorrelation: task, epoch: 1,
    revision: 1, ...body, createdAt: OLD, updatedAt: OLD };
  const snapshot: LegacyContinuitySnapshotV1 = { ...base, snapshotDigest: convergenceDigest(base) };
  sql(databasePath, db => {
    db.prepare("INSERT INTO continuity_tasks(task_correlation,current_epoch,updated_at) VALUES(?,1,?)").run(task, OLD);
    db.prepare("INSERT INTO continuity_snapshots VALUES(?,1,1,?,?,?)")
      .run(task, snapshot.snapshotDigest, JSON.stringify(snapshot), OLD);
  });
}

describe("D55 기존 사용자 migration 가이드 실제 명령", () => {
  it("D55-LITERAL: 실행한 JS·명령 fence는 immutable 기술 원문의 byte/digest와 같다", () => {
    const blocks = protectedBlocks();
    expect(blocks.scripts).toHaveLength(3);
    expect(blocks.commands).toHaveLength(8);
    const output = command(blocks.commands[0]!.trim(), {});
    expect(output.status).toBe(0);
    expect(Number(output.stdout.match(/^v(\d+)\./u)?.[1])).toBeGreaterThanOrEqual(24);
  });

  it.each([2, 3] as const)("D55-WAL-BACKUP schema%i: committed WAL 포함·원본 불변·기존 backup wx 거부", version => {
    const f = legacy(version), t = tools(f.directory), backup = join(f.directory, "pre upgrade.sqlite3");
    committedWal(f.databasePath);
    const original = state(f.databasePath);
    const values = { ...t.values, "<existing-continuity.sqlite3>": f.databasePath, "<new-pre-3.8-backup.sqlite3>": backup };
    expect(successful(command(t.lines(2)[0]!, values))).toEqual({ ok: true, schema: version });
    expect(state(f.databasePath)).toEqual(original);
    readonly(backup, db => {
      expect(db.prepare("SELECT value FROM continuity_metadata WHERE key=?").get(WAL_KEY)).toEqual({ value: WAL_BEFORE });
      expect(db.prepare("PRAGMA quick_check").all()).toEqual([{ quick_check: "ok" }]);
    });
    const backupState = state(backup), refused = command(t.lines(2)[0]!, values);
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain("EEXIST");
    expect(state(backup)).toEqual(backupState);
    expect(state(f.databasePath)).toEqual(original);
  });

  it("D55-PATH-SCHEMA: 경로·손상·지원밖 schema의 원인을 숨기거나 빈 DB로 바꾸지 않는다", () => {
    const f = legacy(2), t = tools(f.directory), missing = join(f.directory, "missing.sqlite3");
    const corrupt = join(f.directory, "not-sqlite.db");
    writeFileSync(corrupt, "owned invalid SQLite fixture", "utf8");
    const corruptState = state(corrupt);
    for (const [input, cause] of [[missing, /ENOENT/u], [basename(f.databasePath), /Use an absolute existing database path/u],
      [f.directory, /Database must be an existing file/u], [corrupt, /file is not a database|ERR_SQLITE_ERROR|SQLITE_NOTADB/u]] as const) {
      const result = command(t.lines(3)[0]!, { ...t.values, "<existing-continuity.sqlite3>": input });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(cause);
      expect(result.stdout).not.toContain('"ok":true');
    }
    expect(existsSync(missing)).toBe(false);
    expect(state(corrupt)).toEqual(corruptState);
    const destination = join(f.directory, "must-not-create.sqlite3");
    const missingBackup = command(t.lines(2)[0]!, { ...t.values, "<existing-continuity.sqlite3>": missing,
      "<new-pre-3.8-backup.sqlite3>": destination });
    expect(missingBackup.status).not.toBe(0);
    expect(missingBackup.stderr).toContain("ENOENT");
    expect(existsSync(destination)).toBe(false);
    const unknown = join(f.directory, "unknown-schema.sqlite3");
    sql(unknown, db => db.exec("PRAGMA user_version=99"));
    const before = state(unknown), values = { ...t.values, "<existing-continuity.sqlite3>": unknown,
      "<new-current-mapping.json>": join(f.directory, "unsupported-export.json") };
    expect(successful(command(t.lines(3)[0]!, values))).toEqual({ ok: true, schema: 99 });
    const rejected = command(t.lines(4)[0]!, values);
    expect(rejected.status).toBe(1);
    expect(JSON.parse(rejected.stdout)).toMatchObject({ ok: false, reason: "UNSUPPORTED_SCHEMA" });
    expect(state(unknown)).toEqual(before);
    expect(existsSync(values["<new-current-mapping.json>"])).toBe(false);
  });

  it.each([2, 3] as const)("D55-SIZES/MIGRATE/ROLLBACK schema%i: 실제 안내 순서로 각 current 크기·최적화·실패보존·구버전 복구", version => {
    const f = legacy(version), t = tools(f.directory);
    const small = sizedMemory(1999, "objective"), exact = sizedMemory(2000, "evidence");
    addCurrent(f.databasePath, "d55-current-1999", small);
    addCurrent(f.databasePath, "d55-current-2000", exact);
    committedWal(f.databasePath);
    const originalSnapshots = snapshots(f.databasePath), backup = join(f.directory, "pre-3.8.sqlite3");
    const exported = join(f.directory, "current mapping.json"), preparedFile = join(f.directory, "prepared mapping.json");
    const values = { ...t.values, "<existing-continuity.sqlite3>": f.databasePath, "<new-pre-3.8-backup.sqlite3>": backup,
      "<new-current-mapping.json>": exported, "<prepared-mapping.json>": preparedFile,
      "<pre-3.8-backup.sqlite3>": backup, "<original-continuity.sqlite3>": f.databasePath };
    expect(successful(command(t.lines(2)[0]!, values))).toEqual({ ok: true, schema: version });
    const backupState = state(backup);
    expect(successful(command(t.lines(3)[0]!, values))).toEqual({ ok: true, schema: version });
    expect(successful(command(t.lines(4)[0]!, values))).toEqual({ ok: true, code: "EXPORTED_CURRENT", count: 3 });
    const exportedState = state(exported);
    const mappings = JSON.parse(exportedState.bytes.toString("utf8")) as Array<{
      taskCorrelation: string; expectedSnapshotDigest: string; memory: ContinuityMemoryBodyV1;
    }>;
    const sizeResult = command(t.lines(5)[0]!, values);
    expect(sizeResult.status).toBe(0);
    noBody(sizeResult);
    expect(sizeResult.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual([
      { index: 0, bytes: 2400, withinLimit: false }, { index: 1, bytes: 1999, withinLimit: true },
      { index: 2, bytes: 2000, withinLimit: true },
    ]);
    expect(exportedState.bytes.length).toBeGreaterThan(6000);
    expect(mappings[1]!.memory).toEqual(small);
    expect(mappings[2]!.memory).toEqual(exact);
    const prepared = mappings.map(item => ({ ...item, memory: item.taskCorrelation === f.task ? memory(NEW_B) : item.memory }));
    const badFile = join(f.directory, "stale mapping.json");
    writeFileSync(badFile, "{", "utf8");
    const beforeParseFailure = state(f.databasePath);
    const invalid = command(t.lines(6)[0]!, { ...values, "<prepared-mapping.json>": badFile });
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, reason: "INVALID_MAPPING_JSON" });
    expect(state(f.databasePath)).toEqual(beforeParseFailure);
    writeFileSync(badFile, JSON.stringify(prepared.map((item, index) => index === 0
      ? { ...item, expectedSnapshotDigest: `sha256:${"0".repeat(64)}` } : item)));
    const beforeFailure = legacyState(f.databasePath);
    const failed = command(t.lines(6)[0]!, { ...values, "<prepared-mapping.json>": badFile });
    expect(failed.status).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, reason: "MIGRATION_INCOMPLETE" });
    noBody(failed);
    // Closing a writable connection may checkpoint pre-existing WAL even after rollback.
    // Preserve the complete logical legacy state; archive/export files remain byte/mtime identical.
    expect(legacyState(f.databasePath)).toEqual(beforeFailure);
    expect(snapshots(f.databasePath)).toEqual(originalSnapshots);
    expect(state(backup)).toEqual(backupState);
    expect(state(exported)).toEqual(exportedState);
    writeFileSync(preparedFile, JSON.stringify(prepared, null, 2), "utf8");
    const preparedSizes = command(t.lines(5)[0]!, { ...values, "<new-current-mapping.json>": preparedFile });
    expect(preparedSizes.status).toBe(0);
    expect(preparedSizes.stdout.trim().split("\n").map(line => JSON.parse(line))).toEqual(prepared.map((item, index) => ({
      index, bytes: bytes(item.memory), withinLimit: true,
    })));
    expect(successful(command(t.lines(6)[0]!, values))).toEqual({ ok: true, code: "MIGRATED", count: 3 });
    expect(successful(command(t.lines(6)[1]!, values))).toEqual({ ok: true, schema: 4 });
    const current = readonly(f.databasePath, db => db.prepare("SELECT task_correlation,memory_json FROM continuity_current_memory ORDER BY task_correlation").all());
    expect(current.map(row => ({ taskCorrelation: row.task_correlation, memory: JSON.parse(String(row.memory_json)) })))
      .toEqual(prepared.map(item => ({ taskCorrelation: item.taskCorrelation, memory: item.memory })));
    expect(histories(f.databasePath).map(row => row.memory_json).sort()).toEqual(originalSnapshots.map(row => row.snapshot_json).sort());
    committedWal(f.databasePath, WAL_AFTER);
    const quarantine = join(f.directory, "isolated schema4");
    mkdirSync(quarantine);
    const moved = [f.databasePath, f.databasePath + "-wal", f.databasePath + "-shm"].map(source => ({
      source, destination: join(quarantine, basename(source)), before: state(source),
    }));
    for (const item of moved) {
      expect(dirname(resolve(item.source))).toBe(resolve(f.directory));
      expect(dirname(resolve(item.destination))).toBe(resolve(quarantine));
      renameSync(item.source, item.destination);
      expect(existsSync(item.source)).toBe(false);
      expect(state(item.destination)).toEqual(item.before);
    }
    expect(successful(command(t.lines(7)[0]!, values))).toEqual({ ok: true, schema: version });
    expect(successful(command(t.lines(7)[1]!, values))).toEqual({ ok: true, schema: version });
    expect(snapshots(f.databasePath)).toEqual(originalSnapshots);
    readonly(f.databasePath, db => expect(db.prepare("SELECT value FROM continuity_metadata WHERE key=?").get(WAL_KEY))
      .toEqual({ value: WAL_BEFORE }));
    expect(state(backup)).toEqual(backupState);
    for (const item of moved) expect(state(item.destination)).toEqual(item.before);
    const restored = state(f.databasePath), duplicateRestore = command(t.lines(7)[0]!, values);
    expect(duplicateRestore.status).not.toBe(0);
    expect(duplicateRestore.stderr).toContain("EEXIST");
    expect(state(f.databasePath)).toEqual(restored);
    expect(state(backup)).toEqual(backupState);
  });
});
