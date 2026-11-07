import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ContinuityMemoryBodyV1, ContinuitySnapshotV1, LegacyContinuitySnapshotV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { SqliteContinuityStore, type ContinuityMemoryMigration } from "../../mcp-server/src/continuity-store.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

const NOW = "2026-11-07T00:00:00.000Z";
const PURGE_HOST = "d53-purge-migration-fixture";
// An owned adapter supplies only normalized fixture events; it reads no real host or transcript.
registerHookHostAdapter(PURGE_HOST, {
  processPid: () => undefined,
  deliveryProfile: () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  ownsTool: () => false,
  adaptInput: input => ({
    lifecycle: input.fixtureEvent === "compact" ? "start" : "none", outputEventName: "OwnedPurgeNotice", restoreCurrentAtTurnStart: true,
    ...(input.fixtureEvent === "pre-compact" ? {continuityAction: {kind: "pre-compact" as const}}
      : input.fixtureEvent === "compact" ? {continuityAction: {kind: "compact" as const}} : {}),
    observation: {host: PURGE_HOST, sessionId: String(input.fixtureSession), kind: input.fixtureEvent === "prompt" ? "user-input" : "unknown",
      actor: {role: "root", basis: "observed", reasonCode: "OWNED_PURGE_MIGRATION_ROOT"}},
  }),
});
const LEGACY_SCHEMA = `
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
CREATE TABLE continuity_delta_state(task_correlation TEXT NOT NULL,epoch INTEGER NOT NULL,receiver_host TEXT NOT NULL,
  receiver_session TEXT NOT NULL,receiver_instance TEXT NOT NULL,context_generation INTEGER NOT NULL CHECK(context_generation>=0),
  sequence INTEGER NOT NULL CHECK(sequence>=0),origin_digest TEXT NOT NULL,checkpoint_digest TEXT NOT NULL,
  checkpoint_json TEXT NOT NULL,last_delta_digest TEXT,state_ack_json TEXT,PRIMARY KEY(task_correlation,epoch));
PRAGMA user_version=3;
`;

const directories: string[] = [];
const stores: SqliteContinuityStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("ags-d53-receiver-")) {
      throw new Error("Refusing cleanup outside the owned receiver migration fixture.");
    }
    rmSync(resolved, { recursive: true, force: true });
  }
});

function body(objective: string): ContinuityMemoryBodyV1 {
  return {status: "active", core: {objective, completionCriteria: [], constraints: [], decisions: [], progress: [], blockers: [], nextActions: []}, evidenceRefs: []};
}

function fixture(receiverEpoch = 2) {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d53-receiver-"));
  directories.push(directory);
  const databasePath = path.join(directory, "continuity.sqlite3");
  const database = new DatabaseSync(databasePath);
  const images = new Map<string, LegacyContinuitySnapshotV1>();
  try {
    database.exec(LEGACY_SCHEMA);
    for (const taskCorrelation of ["receiver-task", "supported-task"]) {
      const base = {schemaVersion: "1.0.0" as const, source: "direct" as const, taskCorrelation, epoch: 2, revision: 1,
        ...body(`${taskCorrelation} origin ${"x".repeat(2400)}`), createdAt: NOW, updatedAt: NOW};
      const image = {...base, snapshotDigest: convergenceDigest(base)};
      images.set(taskCorrelation, image);
      database.prepare("INSERT INTO continuity_tasks(task_correlation,current_epoch,updated_at) VALUES(?,2,?)").run(taskCorrelation, NOW);
      database.prepare("INSERT INTO continuity_snapshots VALUES(?,2,1,?,?,?)")
        .run(taskCorrelation, image.snapshotDigest, JSON.stringify(image), NOW);
    }
    database.prepare(`INSERT INTO continuity_delta_state VALUES('receiver-task',?,'fixture-host','fixture-session','fixture-instance',
      2,1,'fixture-origin','fixture-current','{"receiverCurrent":"fixture-owned-private"}',NULL,NULL)`).run(receiverEpoch);
  } finally { database.close(); }
  const mapping = (taskCorrelation: string): ContinuityMemoryMigration => ({taskCorrelation,
    expectedSnapshotDigest: images.get(taskCorrelation)!.snapshotDigest, memory: body(`${taskCorrelation} optimized current`)});
  return {databasePath, images, mapping};
}

describe("D53 pre-existing schema 3 receiver migration boundary", () => {
  // Before the fix these valid prepared mappings fell through as MIGRATION_INCOMPLETE.
  // Both epochs exercise the existing task-wide receiver fence, not a new epoch policy.
  it.each([1, 2])("rejects a receiver-owned origin mapping with its precise reason and preserves schema 3 bytes (receiver epoch %i)", receiverEpoch => {
    const value = fixture(receiverEpoch);
    const before = readFileSync(value.databasePath);
    expect(() => new SqliteContinuityStore(value.databasePath, [value.mapping("receiver-task"), value.mapping("supported-task")]))
      .toThrowError(expect.objectContaining({reason: "RECEIVER_STATE_UNSUPPORTED"}));
    expect(readFileSync(value.databasePath)).toEqual(before);
  });

  it("migrates an unrelated prepared current while retaining the receiver record and refusing its stale origin", () => {
    const value = fixture();
    const before = new DatabaseSync(value.databasePath, {readOnly: true});
    const receiver = before.prepare("SELECT * FROM continuity_delta_state").get();
    before.close();
    const store = new SqliteContinuityStore(value.databasePath, [value.mapping("supported-task")]);
    stores.push(store);
    expect(store.getSchemaVersion()).toBe(4);
    expect(store.getCurrent("supported-task", 2)?.memory).toEqual(value.mapping("supported-task").memory);
    expect(() => store.getCurrent("receiver-task", 2)).toThrowError(expect.objectContaining({reason: "RECEIVER_STATE_UNSUPPORTED"}));
    const raw = new DatabaseSync(value.databasePath, {readOnly: true});
    try {
      expect(raw.prepare("SELECT * FROM continuity_delta_state").get()).toEqual(receiver);
      expect(raw.prepare("SELECT memory_json FROM continuity_current_memory WHERE task_correlation='receiver-task'").get())
        .toEqual({memory_json: null});
      // This is test-owned raw SQLite inspection, never an agent-facing history reader.
      expect(raw.prepare("SELECT memory_json FROM continuity_memory_history WHERE task_correlation='receiver-task'").get())
        .toEqual({memory_json: JSON.stringify(value.images.get("receiver-task"))});
    } finally { raw.close(); }
  });

  it.each(["missing", "changed"])("keeps supported current %s preparation failures distinct and preserves schema 3 bytes", kind => {
    const value = fixture();
    const before = readFileSync(value.databasePath);
    const mappings = kind === "missing" ? [] : [{...value.mapping("supported-task"), expectedSnapshotDigest: `sha256:${"0".repeat(64)}`}];
    expect(() => new SqliteContinuityStore(value.databasePath, mappings))
      .toThrowError(expect.objectContaining({reason: "MIGRATION_INCOMPLETE"}));
    expect(readFileSync(value.databasePath)).toEqual(before);
  });
});

function erasedFixture(version: number, erasedEpoch = 2) {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-d53-receiver-"));
  directories.push(directory);
  const databasePath = path.join(directory, "continuity.sqlite3");
  const session = "owned-legacy-erasure-session";
  const secret = "synthetic-erasure-migration-signing-key";
  const correlation = `hmac-sha256:${createHmac("sha256", secret).update(`session\0${session}`, "utf8").digest("hex")}`;
  const erasedBody = "ERASED-CURRENT-BODY-MUST-NOT-RETURN";
  const tombstoneDigest = convergenceDigest({erasedBody, erasedEpoch});
  const original = {task_correlation: correlation, epoch: erasedEpoch, revision: 4, payload_digest: tombstoneDigest, purged_at: NOW};
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(LEGACY_SCHEMA);
    if (version === 2) database.exec("DROP TABLE continuity_delta_state; PRAGMA user_version=2;");
    database.prepare("INSERT INTO continuity_metadata VALUES('signing-secret',?)").run(secret);
    database.prepare("INSERT INTO continuity_tasks(task_correlation,current_epoch,updated_at) VALUES(?,2,?)").run(correlation, NOW);
    database.prepare("INSERT INTO continuity_tombstones VALUES(?,?,?,?,?)")
      .run(correlation, erasedEpoch, original.revision, tombstoneDigest, NOW);
    const receipt = JSON.stringify({schemaVersion: "1.0.0", purged: true, epoch: erasedEpoch, revision: 4, tombstoneDigest, purgedAt: NOW});
    database.prepare("INSERT INTO continuity_requests VALUES(?,?,?,?,?,?)").run(correlation, erasedEpoch, "old-purge-request", "old-purge-command", receipt, NOW);
  } finally { database.close(); }
  const parentMemory = body("valid synthetic fork parent current");
  const parent: ContinuitySnapshotV1 = {schemaVersion: "1.0.0", source: "direct", taskCorrelation: "owned-parent", epoch: 1,
    stateToken: "a".repeat(48), memory: parentMemory, memoryDigest: convergenceDigest(parentMemory), createdAt: NOW, updatedAt: NOW};
  return {databasePath, session, correlation, erasedBody, tombstoneDigest, original, parent};
}

describe("D53 legacy explicit erasure survives migration and reopen", () => {
  it.each([2, 3])("keeps schema %i current-epoch erasure through service and new-turn hooks without resave cues or fork adoption", version => {
    const value = erasedFixture(version);
    let initialEmptyToken: string | undefined;
    for (let pass = 0; pass < 2; pass += 1) {
      const store = new SqliteContinuityStore(value.databasePath);
      stores.push(store);
      const service = new ContinuityService(store, null, null, () => new Date(NOW));
      expect(service.correlateSession(value.session)).toBe(value.correlation);
      const current = store.getCurrent(value.correlation, 2)!;
      expect(current).toMatchObject({memory: null, memoryDigest: null});
      expect(current.stateToken).toMatch(/^[a-f0-9]{48}$/u);
      if (initialEmptyToken !== undefined) expect(current.stateToken).toBe(initialEmptyToken);
      initialEmptyToken = current.stateToken;
      expect(store.getTombstone(value.correlation, 2)).toMatchObject({emptyStateToken: current.stateToken, payloadDigest: value.tombstoneDigest, purgedAt: NOW});
      expect(store.adoptCurrent(value.correlation, 2, value.parent, NOW)).toBeNull();
      expect(service.checkpointCueForSession(value.session)).toBeNull();
      expect(service.checkpointCueForSession(value.session, true)).toBeNull();
      service.markPreCompact(value.session);
      expect(service.compactContext(value.session)).toBeNull();
      expect(service.checkpointCueAfterProgressForSession(value.session, `owned-progress-${pass}`)).toBeNull();
      const outputs = ["pre-compact", "compact", "prompt"].map(fixtureEvent => handleContinuityHook(
        {fixtureEvent, fixtureSession: value.session}, service, PURGE_HOST, {}, "en"));
      expect(outputs).toEqual([{}, {}, {}]);
      expect(JSON.stringify([current, outputs, service.restoreCurrentForSession(value.session)])).not.toContain(value.erasedBody);
      const raw = new DatabaseSync(value.databasePath, {readOnly: true});
      try {
        expect(raw.prepare("SELECT value FROM continuity_metadata WHERE key=?").get(`legacy-tombstone:${value.correlation}:2`))
          .toEqual({value: JSON.stringify(value.original)});
        expect(raw.prepare("SELECT COUNT(*) AS count FROM continuity_memory_history WHERE task_correlation=?").get(value.correlation)).toEqual({count: 0});
      } finally { raw.close(); }
      if (pass === 0) { store.close(); stores.pop(); }
    }
  });

  it.each([2, 3])("keeps schema %i old-epoch erasure out of the new current's cue and adoption decisions", version => {
    const value = erasedFixture(version, 1);
    for (let pass = 0; pass < 2; pass += 1) {
      const store = new SqliteContinuityStore(value.databasePath);
      stores.push(store);
      const service = new ContinuityService(store, null, null, () => new Date(NOW));
      expect(store.getTombstone(value.correlation, 1)).toMatchObject({payloadDigest: value.tombstoneDigest});
      expect(store.getTombstone(value.correlation, 2)).toBeNull();
      expect(service.checkpointCueForSession(value.session)?.map(message => message.key)).toContain("hooks.checkpointCue.save");
      const output = handleContinuityHook({fixtureEvent: "prompt", fixtureSession: value.session}, service, PURGE_HOST, {}, "en");
      expect(JSON.stringify(output)).toContain("checkpoint_context");
      expect(JSON.stringify(output)).not.toContain(value.erasedBody);
      if (pass === 0) { store.close(); stores.pop(); }
      else expect(store.adoptCurrent(value.correlation, 2, value.parent, NOW)?.memory).toEqual(value.parent.memory);
    }
  });
});
