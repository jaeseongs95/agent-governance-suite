import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ContinuityMemoryBodyV1, ContinuitySnapshotV1, LegacyContinuitySnapshotV1 } from "../../../contracts/types.js";
import { convergenceDigest } from "../../../mcp-server/src/convergence-logic.js";
import { ContinuityService } from "../../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../../mcp-server/src/schema-validator.js";
import { rootCaller } from "../../helpers/caller.js";

export const NOW = "2026-11-07T01:00:00.000Z", OLD = "2025-01-01T00:00:00.000Z";
export const OLD_A = "OLD_A_과거본문_인출금지_7f83", NEW_B = "NEW_B_현재교정_보존_9c41";

export function memory(objective = NEW_B): ContinuityMemoryBodyV1 {
  return { status: "paused", core: { objective, completionCriteria: ["검증 근거 보존"],
    constraints: ["운영 데이터 변경 금지"], decisions: [], progress: [], blockers: [], nextActions: [] }, evidenceRefs: [] };
}
/** Independent byte oracle: key order cannot change JSON's encoded byte length. */
export function bytes(body: ContinuityMemoryBodyV1): number { return Buffer.byteLength(JSON.stringify(body), "utf8"); }
export function sizedMemory(size: number, slot: "objective" | "evidence"): ContinuityMemoryBodyV1 {
  const body = memory('한글🙂 "인용" \\경로\n줄바꿈');
  body.evidenceRefs = [{ artifactId: "utf8-evidence", locator: '증거/🙂/"x"/\\/\n',
    digest: `sha256:${"a".repeat(64)}`, verified: true }];
  const padding = "x".repeat(size - bytes(body));
  if (slot === "objective") body.core.objective += padding;
  else body.evidenceRefs[0]!.locator += padding;
  if (bytes(body) !== size) throw new Error("Invalid owned UTF-8 fixture size");
  return body;
}
export function ownedDirectory(): string { return mkdtempSync(join(tmpdir(), "ags-d53-owned-")); }
export function removeOwnedDirectory(directory: string): void {
  const absolute = resolve(directory);
  if (dirname(absolute) !== resolve(tmpdir()) || !basename(absolute).startsWith("ags-d53-owned-"))
    throw new Error("Refusing cleanup outside TEST-owned D53 fixture directory");
  rmSync(absolute, { recursive: true, force: true });
}
export function fixture(session = "d53-owned-session") {
  const directory = ownedDirectory(), databasePath = join(directory, "continuity.sqlite3");
  const store = new SqliteContinuityStore(databasePath);
  let now = NOW;
  const service = new ContinuityService(store, new ContractValidator(), null, () => new Date(now));
  const caller = rootCaller("synthetic-d53-host", session), task = service.ensureSession(session);
  const current = () => store.getCurrent(task.taskCorrelation, store.getTask(task.taskCorrelation)!.currentEpoch)!;
  const save = (body = memory(), id = "save", token = current().stateToken) =>
    service.checkpointContext({ schemaVersion: "1.0.0", requestId: id, expectedStateToken: token, ...body }, caller);
  return { directory, databasePath, store, service, session, caller, task, current, save, setNow: (value: string) => { now = value; },
    close: () => { store.close(); removeOwnedDirectory(directory); } };
}
export type Fixture = ReturnType<typeof fixture>;
/** Only paths returned by this test's owned fixture may be passed here. */
export function sql<T>(databasePath: string, read: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(databasePath);
  try { database.exec("PRAGMA busy_timeout = 5000"); return read(database); } finally { database.close(); }
}
export function domainRows(databasePath: string) {
  return sql(databasePath, database => Object.fromEntries(["continuity_current_memory", "continuity_memory_history",
    "continuity_requests", "continuity_tombstones", "continuity_observations"]
    .map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()])));
}
export function histories(databasePath: string) {
  return sql(databasePath, db => db.prepare("SELECT * FROM continuity_memory_history ORDER BY rowid").all());
}
export function direct(data: unknown): ContinuitySnapshotV1 {
  if (!data || typeof data !== "object" || !("source" in data) || data.source !== "direct")
    throw new Error("Expected direct current memory response");
  return data as ContinuitySnapshotV1;
}

// Exact schema2 inventory, fixed independently of the D53 store under test.
const LEGACY_SQL = `
CREATE TABLE continuity_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE continuity_tasks(task_correlation TEXT PRIMARY KEY,current_epoch INTEGER NOT NULL CHECK(current_epoch>=1),
 root_id TEXT,suppressed INTEGER NOT NULL DEFAULT 0 CHECK(suppressed IN(0,1)),last_auto_injected_revision INTEGER,
 pending_source TEXT CHECK(pending_source IN('direct','workflow')),pending_revision INTEGER,pending_digest TEXT,
 pending_root_id TEXT,pending_consumed INTEGER NOT NULL DEFAULT 0 CHECK(pending_consumed IN(0,1)),updated_at TEXT NOT NULL);
CREATE TABLE continuity_snapshots(task_correlation TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL CHECK(revision>=1),
 snapshot_digest TEXT NOT NULL,snapshot_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(task_correlation,epoch));
CREATE TABLE continuity_requests(task_correlation TEXT NOT NULL,epoch INTEGER NOT NULL,request_hash TEXT NOT NULL,
 command_digest TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_correlation,epoch,request_hash));
CREATE TABLE continuity_tombstones(task_correlation TEXT NOT NULL,epoch INTEGER NOT NULL,revision INTEGER NOT NULL,
 payload_digest TEXT NOT NULL,purged_at TEXT NOT NULL,PRIMARY KEY(task_correlation,epoch));
CREATE TABLE continuity_observations(observation_id INTEGER PRIMARY KEY AUTOINCREMENT,task_correlation TEXT NOT NULL,
 epoch INTEGER NOT NULL,event TEXT NOT NULL,turn_hash TEXT,success INTEGER NOT NULL CHECK(success IN(0,1)),observed_at TEXT NOT NULL);
PRAGMA user_version=2;`;
const DELTA_SQL = `CREATE TABLE continuity_delta_state(task_correlation TEXT NOT NULL,epoch INTEGER NOT NULL,
 receiver_host TEXT NOT NULL,receiver_session TEXT NOT NULL,receiver_instance TEXT NOT NULL,
 context_generation INTEGER NOT NULL CHECK(context_generation>=0),sequence INTEGER NOT NULL CHECK(sequence>=0),
 origin_digest TEXT NOT NULL,checkpoint_digest TEXT NOT NULL,checkpoint_json TEXT NOT NULL,last_delta_digest TEXT,
 state_ack_json TEXT,PRIMARY KEY(task_correlation,epoch)); PRAGMA user_version=3;`;
export function legacyFixture(version: 2 | 3, body: ContinuityMemoryBodyV1, receiver = false) {
  const directory = ownedDirectory(), databasePath = join(directory, "legacy.sqlite3"), task = "d53-legacy-owned";
  const make = (epoch: number, content: ContinuityMemoryBodyV1): LegacyContinuitySnapshotV1 => {
    const base = { schemaVersion: "1.0.0" as const, source: "direct" as const, taskCorrelation: task,
      epoch, revision: 7, ...content, createdAt: OLD, updatedAt: OLD };
    return { ...base, snapshotDigest: convergenceDigest(base) };
  };
  const previous = make(1, memory(OLD_A)), current = make(2, body);
  const originals = [previous, current].map(snapshot => JSON.stringify(snapshot, null, 2));
  const recoveryPath = join(directory, "legacy-recovery.json");
  writeFileSync(recoveryPath, JSON.stringify(originals), "utf8");
  sql(databasePath, db => {
    db.exec(LEGACY_SQL);
    if (version === 3) db.exec(DELTA_SQL);
    db.prepare("INSERT INTO continuity_tasks(task_correlation,current_epoch,updated_at) VALUES(?,2,?)").run(task, OLD);
    [previous, current].forEach((snapshot, index) => db.prepare("INSERT INTO continuity_snapshots VALUES(?,?,?,?,?,?)")
      .run(task, snapshot.epoch, snapshot.revision, snapshot.snapshotDigest, originals[index]!, OLD));
    db.prepare("INSERT INTO continuity_requests VALUES(?,2,'old-request','old-command',?,?)")
      .run(task, JSON.stringify({ schemaVersion: "1.0.0", kind: "checkpoint", epoch: 2, revision: 7, snapshotDigest: current.snapshotDigest }), OLD);
    if (receiver) db.prepare("INSERT INTO continuity_delta_state VALUES(?,2,'test-host','test-session','test-instance',1,1,'origin','checkpoint',?,NULL,NULL)")
      .run(task, JSON.stringify({ secret: OLD_A }));
  });
  return { directory, databasePath, task, current, originals, recoveryPath, close: () => removeOwnedDirectory(directory) };
}
export function legacyRows(databasePath: string) {
  return sql(databasePath, db => ({ version: db.prepare("PRAGMA user_version").get(),
    schema: db.prepare("SELECT type,name,sql FROM sqlite_master ORDER BY type,name").all(),
    snapshots: db.prepare("SELECT * FROM continuity_snapshots ORDER BY epoch").all(),
    tasks: db.prepare("SELECT * FROM continuity_tasks").all(),
    requests: db.prepare("SELECT * FROM continuity_requests").all() }));
}
