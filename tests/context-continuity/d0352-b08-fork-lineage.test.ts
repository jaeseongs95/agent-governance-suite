import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// D0352 B08 r04: a real Claude fork child (host SessionStart source=fork) has its parent pinned at its first prompt
// from its own transcript lineage, and may then take that parent's exact direct checkpoint through inspect/load.
// Unrelated sessions, copies, later edits of the child's file and other hosts never do.
const TOOL = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const BODY_MARKER = "BODY-MARKER-9c41";
const stores: SqliteContinuityStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function createService(databasePath = ":memory:"): ContinuityService {
  const store = new SqliteContinuityStore(databasePath);
  stores.push(store);
  return new ContinuityService(store, new ContractValidator(), new InMemoryWorkflowStore(), () => new Date("2026-11-01T01:00:00.000Z"));
}

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "ags-b08-"));
  directories.push(created);
  return created;
}

function line(sessionId: string, uuid: string): string {
  return JSON.stringify({ type: "user", sessionId, uuid, message: { role: "user", content: BODY_MARKER } });
}

async function transcript(rows: Array<[sessionId: string, uuid: string]>, extra = ""): Promise<string> {
  const file = join(await directory(), "session.jsonl");
  await writeFile(file, rows.map(([sessionId, uuid]) => line(sessionId, uuid)).join("\n") + "\n" + extra, "utf8");
  return file;
}

function hook(service: ContinuityService, payload: Record<string, unknown>, host = "claude-code") {
  return handleContinuityHook(payload, service, host);
}

function start(service: ContinuityService, session: string, source: string, transcriptPath?: string, host = "claude-code") {
  return hook(service, { hook_event_name: "SessionStart", source, session_id: session, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }, host);
}

/** The child's first user prompt: the only point where its parent is read and pinned. */
function prompt(service: ContinuityService, session: string, transcriptPath?: string) {
  expect(hook(service, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "continue",
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}) })).toEqual({});
}

function hookBound<T extends Record<string, unknown>>(service: ContinuityService, session: string, tool: string, input: T, transcriptPath?: string): T & { _continuityBinding: string } {
  const output = hook(service, {
    hook_event_name: "PreToolUse", session_id: session, tool_name: TOOL + tool, tool_input: input,
    tool_use_id: "toolu_" + randomUUID().replaceAll("-", ""), ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  }) as { hookSpecificOutput: { updatedInput: T & { _continuityBinding: string } } };
  return output.hookSpecificOutput.updatedInput;
}

function checkpointInput(overrides: Partial<CheckpointContextRequestV1> = {}): Omit<CheckpointContextRequestV1, "_continuityBinding"> {
  return {
    schemaVersion: "1.0.0", requestId: "checkpoint-1", expectedRevision: 0, status: "active",
    core: {
      objective: "Parent-only objective P-7f3a.", completionCriteria: ["done"], constraints: ["parent constraint"],
      decisions: ["parent decision"], progress: [], blockers: [], nextActions: ["continue"],
    },
    evidenceRefs: [{ artifactId: "t", locator: "tests", digest: convergenceDigest("t"), verified: true }],
    ...overrides,
  };
}

function checkpoint(service: ContinuityService, session: string, transcriptPath: string, overrides: Partial<CheckpointContextRequestV1> = {}): ContinuitySnapshotV1 {
  const result = service.checkpointContext(hookBound(service, session, "checkpoint_context", checkpointInput(overrides), transcriptPath));
  expect(result.error).toBeNull();
  return result.data!;
}

function inspect(service: ContinuityService, session: string, transcriptPath?: string) {
  const result = service.inspectContext(hookBound(service, session, "inspect_context", { schemaVersion: "1.0.0" }, transcriptPath));
  expect(result.error).toBeNull();
  return result.data!;
}

function loadInput(candidate: ReturnType<typeof inspect>) {
  return { schemaVersion: "1.0.0", candidateToken: candidate.restoreToken!, epoch: candidate.summary!.epoch,
    revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
}

function load(service: ContinuityService, session: string, candidate: ReturnType<typeof inspect>) {
  return service.loadContext(hookBound(service, session, "load_context", loadInput(candidate)));
}

/** Parent A checkpoints over its own transcript; returns A's snapshot and the rows a fork would copy. */
async function parent(service: ContinuityService, session = "parent-a") {
  const rows: Array<[string, string]> = [[session, randomUUID()], [session, randomUUID()], [session, randomUUID()]];
  const file = await transcript(rows);
  const snapshot = checkpoint(service, session, file);
  return { snapshot, uuids: rows.map(([, uuid]) => uuid), file };
}

/** A host fork: copied uuids rewritten to the child session id, the child's own entry, then its first prompt. */
async function fork(service: ContinuityService, child: string, copied: string[]) {
  const file = await transcript([...copied.map(uuid => [child, uuid] as [string, string]), [child, randomUUID()]]);
  expect(start(service, child, "fork", file)).toEqual({});
  prompt(service, child, file);
  return file;
}

const CANDIDATE = ["EXPLICIT_LOAD_REQUIRED", "FORK_PARENT_CANDIDATE"];

describe("D0352 B08 fork lineage", () => {
  it("P1: a fork child inspects and loads the parent's exact checkpoint, then continues without STALE_REVISION", async () => {
    const service = createService();
    const { snapshot: parentSnapshot, uuids } = await parent(service);
    const childFile = await fork(service, "fork-f", uuids);
    const candidate = inspect(service, "fork-f", childFile);
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: CANDIDATE });
    expect(candidate.summary).toMatchObject({ source: "direct", taskCorrelation: parentSnapshot.taskCorrelation,
      revision: parentSnapshot.revision, snapshotDigest: parentSnapshot.snapshotDigest });
    const loaded = load(service, "fork-f", candidate);
    expect(loaded.data).toEqual(parentSnapshot);
    expect((loaded.data as ContinuitySnapshotV1).core.objective).toBe("Parent-only objective P-7f3a.");
    const next = checkpoint(service, "fork-f", childFile, { requestId: "child-1", expectedRevision: parentSnapshot.revision });
    expect(next).toMatchObject({ revision: parentSnapshot.revision + 1, taskCorrelation: service.correlateSession("fork-f") });
    // The parent namespace is read-only for the child.
    expect(service.store.getSnapshot(parentSnapshot.taskCorrelation, parentSnapshot.epoch)).toEqual(parentSnapshot);
    // After adoption the child sees its own state, not the parent again.
    expect(inspect(service, "fork-f", childFile).summary).toMatchObject({ taskCorrelation: next.taskCorrelation, revision: next.revision });
  });

  it("D1: the parent whose anchor appears last in the child's own file is chosen (grandchild fork)", async () => {
    const service = createService();
    const { uuids: aUuids } = await parent(service, "parent-a");
    const bRows: Array<[string, string]> = [...aUuids.map(uuid => ["fork-b", uuid] as [string, string]), ["fork-b", randomUUID()]];
    const bFile = await transcript(bRows);
    expect(start(service, "fork-b", "fork", bFile)).toEqual({});
    const bSnapshot = checkpoint(service, "fork-b", bFile, { requestId: "b-1" });
    const grandchild = await fork(service, "fork-g", bRows.map(([, uuid]) => uuid));
    expect(inspect(service, "fork-g", grandchild).summary).toMatchObject({ taskCorrelation: bSnapshot.taskCorrelation, revision: bSnapshot.revision });
  });

  it("N14: a grandchild forked before its parent fork adopted anything is a descendant of the original parent", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await fork(service, "fork-f", uuids);
    const grandchild = await fork(service, "fork-g", [...uuids, randomUUID()]);
    expect(inspect(service, "fork-g", grandchild).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
    expect(inspect(service, "fork-f", childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation });
  });

  it("N15: two forks of the same parent adopt and continue independently", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const files = [await fork(service, "fork-1", uuids), await fork(service, "fork-2", uuids)];
    const candidates = [inspect(service, "fork-1", files[0]), inspect(service, "fork-2", files[1])];
    expect(load(service, "fork-1", candidates[0]!).data).toEqual(snapshot);
    expect(load(service, "fork-2", candidates[1]!).data).toEqual(snapshot);
    const first = checkpoint(service, "fork-1", files[0]!, { requestId: "f1", expectedRevision: 1, status: "paused" });
    const second = checkpoint(service, "fork-2", files[1]!, { requestId: "f2", expectedRevision: 1 });
    expect([first.revision, second.revision]).toEqual([2, 2]);
    expect(first.taskCorrelation).not.toBe(second.taskCorrelation);
    expect([first.status, second.status]).toEqual(["paused", "active"]);
    expect(service.store.getSnapshot(snapshot.taskCorrelation, 1)).toEqual(snapshot);
  });

  it("A16: the parent is found when its newest entries were not copied into the fork", async () => {
    const service = createService();
    const rows: Array<[string, string]> = Array.from({ length: 20 }, () => ["parent-a", randomUUID()]);
    const snapshot = checkpoint(service, "parent-a", await transcript(rows));
    // The fork copied all but the parent's last three entries: anchors 17-19 of the newest 16 still match.
    const childFile = await fork(service, "fork-short", rows.slice(0, -3).map(([, uuid]) => uuid));
    expect(inspect(service, "fork-short", childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: 1 });
    // Entries older than the newest 16 at checkpoint time are not anchors.
    const oldOnly = await fork(service, "fork-old", rows.slice(0, 4).map(([, uuid]) => uuid));
    expect(inspect(service, "fork-old", oldOnly).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"]);
  });

  it("N10: a fork made after the parent compacted finds the parent through post-compaction anchors", async () => {
    const service = createService();
    for (const [session, event] of [["parent-post", "PostCompact"], ["parent-start", "SessionStart"]] as const) {
      const { snapshot, file } = await parent(service, session);
      // Compaction: the parent's file gains post-boundary entries; a later fork copies only those (tester r04).
      const after = [randomUUID(), randomUUID()];
      await appendFile(file, after.map(uuid => line(session, uuid)).join("\n") + "\n", "utf8");
      if (event === "PostCompact") expect(hook(service, { hook_event_name: "PostCompact", session_id: session, trigger: "manual", transcript_path: file })).toEqual({});
      else start(service, session, "compact", file);
      const child = `fork-of-${session}`;
      const childFile = await fork(service, child, after);
      expect(inspect(service, child, childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
    }
  });

  it("W1: a parent anchor older than the newest 4000 lines of the child's file is not lineage evidence", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const rows: Array<[string, string]> = [...uuids.map(uuid => ["fork-long", uuid] as [string, string]),
      ...Array.from({ length: 4000 }, () => ["fork-long", randomUUID()] as [string, string])];
    const file = await transcript(rows);
    expect(start(service, "fork-long", "fork", file)).toEqual({});
    prompt(service, "fork-long", file);
    expect(inspect(service, "fork-long", file).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"]);
  });

  it("N1: an unrelated startup session holding the parent's uuids in its own file or a copy gets nothing", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const copied = await transcript(uuids.map(uuid => ["unrelated-c", uuid] as [string, string]));
    expect(start(service, "unrelated-c", "startup", copied)).toEqual({});
    prompt(service, "unrelated-c", copied);
    expect(inspect(service, "unrelated-c", copied)).toMatchObject({ decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"], restoreToken: null });
    for (const source of ["resume", "clear"]) {
      expect(start(service, `unrelated-${source}`, source, copied)).toBeDefined();
      prompt(service, `unrelated-${source}`, copied);
      expect(inspect(service, `unrelated-${source}`, copied).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    }
  });

  it("N4: a real fork of an unrelated parent does not receive another session's state", async () => {
    const service = createService();
    await parent(service, "parent-a");
    const childFile = await fork(service, "fork-of-b", [randomUUID(), randomUUID()]);
    expect(inspect(service, "fork-of-b", childFile)).toMatchObject({ decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"] });
  });

  it("N4b: lines appended to a fork's own file after its first prompt never change the pinned parent", async () => {
    const service = createService();
    const { uuids } = await parent(service, "parent-a");
    const childFile = await fork(service, "fork-of-b", [randomUUID()]);
    // The model in the fork copies A's entries into its own transcript with a tool, then prompts again.
    await appendFile(childFile, uuids.map(uuid => line("fork-of-b", uuid)).join("\n") + "\n", "utf8");
    prompt(service, "fork-of-b", childFile);
    expect(inspect(service, "fork-of-b", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"]);
    // Without a prompt before inspect there is no pin, and inspect itself never reads the file.
    const unpinned = await transcript(uuids.map(uuid => ["fork-unpinned", uuid] as [string, string]));
    expect(start(service, "fork-unpinned", "fork", unpinned)).toEqual({});
    expect(inspect(service, "fork-unpinned", unpinned).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_PINNED"]);
  });

  it("N5/N8: a parent that saved again, was suppressed or purged after the fork yields no candidate", async () => {
    const service = createService();
    const advanced = await parent(service, "parent-adv");
    const advancedChild = await fork(service, "child-adv", advanced.uuids);
    checkpoint(service, "parent-adv", await transcript([["parent-adv", randomUUID()]]), { requestId: "again", expectedRevision: 1 });
    expect(inspect(service, "child-adv", advancedChild).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);

    const suppressed = await parent(service, "parent-sup");
    const suppressedChild = await fork(service, "child-sup", suppressed.uuids);
    const suppress = { schemaVersion: "1.0.0" as const, expectedEpoch: 1 };
    expect(service.suppressContextRestore(hookBound(service, "parent-sup", "suppress_context_restore", suppress)).data?.suppressed).toBe(true);
    expect(inspect(service, "child-sup", suppressedChild).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_SUPPRESSED"]);

    const purgedParent = await parent(service, "parent-pur");
    const purgedChild = await fork(service, "child-pur", purgedParent.uuids);
    const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-1", expectedEpoch: 1, expectedRevision: purgedParent.snapshot.revision };
    expect(service.purgeDirectContext(hookBound(service, "parent-pur", "purge_direct_context", purge)).data).toMatchObject({ purged: true });
    expect(inspect(service, "child-pur", purgedChild).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
  });

  it("N5/N13: a parent that saved, purged, cleared or suppressed between inspect and load rejects the load and adopts nothing", async () => {
    const service = createService();
    const cases: Array<[string, (session: string, snapshot: ContinuitySnapshotV1, file: string) => void, string]> = [
      ["saved", (session, snapshot) => { checkpoint(service, session, join(tmpdir(), "absent-b08.jsonl"), { requestId: "again", expectedRevision: snapshot.revision }); }, "STALE_REVISION"],
      ["purged", (session, snapshot) => {
        const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-1", expectedEpoch: 1, expectedRevision: snapshot.revision };
        expect(service.purgeDirectContext(hookBound(service, session, "purge_direct_context", purge)).data).toMatchObject({ purged: true });
      }, "STALE_REVISION"],
      ["cleared", (session, _snapshot, file) => { start(service, session, "clear", file); }, "BINDING_INVALID"],
      ["suppressed", session => {
        expect(service.suppressContextRestore(hookBound(service, session, "suppress_context_restore", { schemaVersion: "1.0.0" as const, expectedEpoch: 1 })).error).toBeNull();
      }, "SNAPSHOT_NOT_FOUND"],
    ];
    for (const [name, change, code] of cases) {
      const { snapshot, uuids, file } = await parent(service, `parent-${name}`);
      const child = `fork-late-${name}`;
      const childFile = await fork(service, child, uuids);
      const candidate = inspect(service, child, childFile);
      expect(candidate.reasonCodes).toEqual(CANDIDATE);
      change(`parent-${name}`, snapshot, file);
      expect(load(service, child, candidate).error?.code).toBe(code);
      expect(service.store.getSnapshot(service.correlateSession(child), 1)).toBeNull();
    }
  });

  it("N12: a fork child that already loaded or saved its own state cannot load the parent candidate again", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const loadedFile = await fork(service, "fork-loaded", uuids);
    const candidate = inspect(service, "fork-loaded", loadedFile);
    expect(load(service, "fork-loaded", candidate).error).toBeNull();
    expect(load(service, "fork-loaded", candidate).error?.code).toBe("STALE_REVISION");

    const savedFile = await fork(service, "fork-saved", uuids);
    const early = inspect(service, "fork-saved", savedFile);
    const own = checkpoint(service, "fork-saved", savedFile, { requestId: "own-1", core: { ...checkpointInput().core, objective: "Child's own objective." } });
    expect(load(service, "fork-saved", early).error?.code).toBe("STALE_REVISION");
    expect(service.store.getSnapshot(own.taskCorrelation, 1)).toEqual(own);
  });

  it("N6: missing, unreadable-format or foreign-session transcripts close with a stable reason", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const missing = join(await directory(), "absent.jsonl");
    const cases: Array<[string, string | undefined, string[]]> = [
      ["child-missing", missing, ["NO_RESTORE_CANDIDATE", "LINEAGE_TRANSCRIPT_ABSENT"]],
      // Parent rows whose sessionId was not rewritten are not the child's own entries.
      ["child-foreign", await transcript(uuids.map(uuid => ["parent-a", uuid] as [string, string])), ["NO_RESTORE_CANDIDATE", "LINEAGE_IDS_ABSENT"]],
      // A complete line that is not JSON is a host format change: no candidate even though valid rows remain (D2).
      ["child-garbled", await transcript(uuids.map(uuid => ["child-garbled", uuid] as [string, string]), "{not json\n"), ["NO_RESTORE_CANDIDATE", "LINEAGE_FORMAT_INVALID"]],
      // An unterminated last line is one the host is still writing; it is skipped, not a format error.
      ["child-writing", await transcript(uuids.map(uuid => ["child-writing", uuid] as [string, string]), "{\"type\":\"assistant\",\"sessionId\":\"child-wr"), CANDIDATE],
      // A fork whose host supplied no transcript path performs no lookup and pins nothing.
      ["child-no-path", undefined, ["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_PINNED"]],
    ];
    for (const [child, file, reasons] of cases) {
      expect(start(service, child, "fork", file)).toEqual({});
      prompt(service, child, file);
      expect(inspect(service, child, file).reasonCodes).toEqual(reasons);
    }
  });

  it("N7: without a host fork record the lookup never runs, and other hosts keep fork as startup", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const file = await transcript(uuids.map(uuid => ["never-forked", uuid] as [string, string]));
    prompt(service, "never-forked", file);
    expect(inspect(service, "never-forked", file).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    expect(service.store.hasObservation(service.correlateSession("never-forked"), 1, "fork-start")).toBe(false);
    for (const host of ["codex", "gemini", "antigravity"]) {
      const session = `${host}-fork`;
      expect(start(service, session, "fork", file, host)).toEqual({});
      expect(hook(service, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "continue", transcript_path: file }, host)).toBeDefined();
      expect(service.store.hasObservation(service.correlateSession(session), 1, "fork-start")).toBe(false);
      expect(service.store.firstObservationEvent(service.correlateSession(session), 1, "fork-parent:")).toBeNull();
    }
  });

  it("N9: a fork candidate cannot be loaded by another child or by the parent", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const childFile = await fork(service, "fork-owner", uuids);
    const candidate = inspect(service, "fork-owner", childFile);
    await fork(service, "fork-other", uuids);
    expect(load(service, "fork-other", candidate).error?.code).toBe("BINDING_INVALID");
    expect(load(service, "parent-a", candidate).error?.code).toBe("BINDING_INVALID");
    expect(service.store.getSnapshot(service.correlateSession("fork-other"), 1)).toBeNull();
  });

  it("PRIV: the store keeps only HMAC anchors, never transcript bodies or raw entry IDs", async () => {
    const databasePath = join(await directory(), "continuity.sqlite3");
    const service = createService(databasePath);
    const { uuids } = await parent(service);
    const childFile = await fork(service, "fork-f", uuids);
    expect(load(service, "fork-f", inspect(service, "fork-f", childFile)).error).toBeNull();
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
      const cells = tables.flatMap(({ name }) => (database.prepare(`SELECT * FROM "${name}"`).all() as Array<Record<string, unknown>>)
        .flatMap(row => Object.values(row).map(String)));
      for (const forbidden of [BODY_MARKER, ...uuids]) expect(cells.filter(cell => cell.includes(forbidden))).toEqual([]);
      const anchors = database.prepare("SELECT turn_hash FROM continuity_observations WHERE event LIKE 'lineage-anchor:%'").all() as Array<{ turn_hash: string }>;
      expect(anchors.length).toBeGreaterThan(0);
      for (const { turn_hash } of anchors) expect(turn_hash).toMatch(/^hmac-sha256:[0-9a-f]{64}$/u);
    } finally { database.close(); }
  });
});
