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

// Host write times: entries a fork copies keep the parent's earlier time; a fork's own entries are written at or after
// its fork record, which this service's fixed clock stamps at OWN.
const EARLIER = "2026-11-01T00:30:00.000Z";
const OWN = "2026-11-01T01:00:00.000Z";

function line(sessionId: string, uuid: string, timestamp = EARLIER): string {
  return JSON.stringify({ type: "user", sessionId, uuid, timestamp, message: { role: "user", content: BODY_MARKER } });
}

async function transcript(rows: Array<[sessionId: string, uuid: string, timestamp?: string]>, extra = ""): Promise<string> {
  const file = join(await directory(), "session.jsonl");
  await writeFile(file, rows.map(([sessionId, uuid, timestamp]) => line(sessionId, uuid, timestamp)).join("\n") + "\n" + extra, "utf8");
  return file;
}

function hook(service: ContinuityService, payload: Record<string, unknown>, host = "claude-code") {
  return handleContinuityHook(payload, service, host);
}

function start(service: ContinuityService, session: string, source: string, transcriptPath?: string, host = "claude-code") {
  return hook(service, { hook_event_name: "SessionStart", source, session_id: session, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }, host);
}

/** The child's first user prompt: its parent is pinned here only when already found. */
function prompt(service: ContinuityService, session: string, transcriptPath?: string) {
  expect(hook(service, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "continue",
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}) })).toEqual({});
}

/** A write-capable host tool or non-AGS MCP tool boundary (before the tool runs): the final point a fork's parent is pinned. */
function tool(service: ContinuityService, session: string, transcriptPath: string, toolName = "Bash") {
  expect(hook(service, { hook_event_name: "PreToolUse", session_id: session, tool_name: toolName, tool_input: { command: "true" },
    tool_use_id: "toolu_" + randomUUID().replaceAll("-", ""), transcript_path: transcriptPath })).toEqual({});
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
  const file = await transcript([...copied.map(uuid => [child, uuid] as [string, string]), [child, randomUUID(), OWN]]);
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
    const bRows: Array<[string, string, string?]> = [...aUuids.map(uuid => ["fork-b", uuid] as [string, string]), ["fork-b", randomUUID(), OWN]];
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
      // A save after the re-anchor advances the parent: the fork's pinned revision is no longer current.
      checkpoint(service, session, file, { requestId: "after-compact", expectedRevision: snapshot.revision });
      expect(inspect(service, child, childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
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

  it("N4b: lines a fork writes into its own file after its parent is pinned never change that parent", async () => {
    const service = createService();
    const { uuids } = await parent(service, "parent-a");
    const childFile = await fork(service, "fork-of-b", [randomUUID()]);
    // The model in the fork copies A's entries into its own transcript with a write-capable tool. That tool's
    // boundary runs before the tool does and pins the parent from the host-written file.
    tool(service, "fork-of-b", childFile);
    await appendFile(childFile, uuids.map(uuid => line("fork-of-b", uuid)).join("\n") + "\n", "utf8");
    prompt(service, "fork-of-b", childFile);
    expect(inspect(service, "fork-of-b", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"]);
  });

  it("N4c: a non-AGS MCP tool that writes the fork's file is a pin boundary too (review 902e b9531242)", async () => {
    const service = createService();
    const { uuids } = await parent(service, "parent-a");
    const childFile = await fork(service, "fork-mcp", [randomUUID()]);
    tool(service, "fork-mcp", childFile, "mcp__filesystem__write_file");
    await appendFile(childFile, uuids.map(uuid => line("fork-mcp", uuid)).join("\n") + "\n", "utf8");
    expect(inspect(service, "fork-mcp", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"]);
  });

  it("M1: a fork whose transcript is not written yet at its first prompt is pinned later, at inspect", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = join(await directory(), "fork.jsonl");
    expect(start(service, "fork-late-file", "fork", childFile)).toEqual({});
    prompt(service, "fork-late-file", childFile);
    expect(service.store.firstObservationEvent(service.correlateSession("fork-late-file"), 1, "fork-parent:")).toBeNull();
    await writeFile(childFile, [...uuids, randomUUID()].map(uuid => line("fork-late-file", uuid)).join("\n") + "\n", "utf8");
    const candidate = inspect(service, "fork-late-file", childFile);
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: CANDIDATE, summary: { revision: snapshot.revision } });
    expect(load(service, "fork-late-file", candidate).data).toEqual(snapshot);
  });

  it("F1: a parent save after the fork is never chosen, even when its anchors include entries the fork copied", async () => {
    const service = createService();
    const { snapshot, uuids, file } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID()]]);
    expect(start(service, "fork-f", "fork", childFile)).toEqual({});
    // The parent continues (or resumes) in the same file and saves again: its newest anchors still hold pre-fork entries.
    await appendFile(file, [randomUUID(), randomUUID()].map(uuid => line("parent-a", uuid)).join("\n") + "\n", "utf8");
    checkpoint(service, "parent-a", file, { requestId: "after-fork", expectedRevision: snapshot.revision });
    expect(inspect(service, "fork-f", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
  });

  it("F2: a sibling fork that adopted and saved never becomes the parent of a later fork of the same parent", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const firstFile = await fork(service, "fork-1", uuids);
    expect(load(service, "fork-1", inspect(service, "fork-1", firstFile)).error).toBeNull();
    checkpoint(service, "fork-1", firstFile, { requestId: "sibling-own", expectedRevision: snapshot.revision });
    const secondFile = await transcript([...uuids.map(uuid => ["fork-2", uuid] as [string, string]), ["fork-2", randomUUID()]]);
    expect(start(service, "fork-2", "fork", secondFile)).toEqual({});
    expect(inspect(service, "fork-2", secondFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  it("F3: a sibling's save repeating copied entries never outscores the parent for a later fork (review 902e)", async () => {
    const service = createService();
    const rows: Array<[string, string]> = Array.from({ length: 20 }, () => ["parent-a", randomUUID()]);
    const snapshot = checkpoint(service, "parent-a", await transcript(rows));
    // Forks miss the parent's newest two entries: 14 of the parent's 16 anchors are in each fork.
    const copied = rows.slice(0, -2).map(([, uuid]) => uuid);
    const siblingFile = await fork(service, "fork-s", copied);
    expect(load(service, "fork-s", inspect(service, "fork-s", siblingFile)).error).toBeNull();
    // The sibling saves with one own entry: 15 of its 16 anchors are copies of the parent's entries.
    checkpoint(service, "fork-s", siblingFile, { requestId: "sibling-15", expectedRevision: snapshot.revision });
    const laterFile = await fork(service, "fork-late", copied);
    expect(inspect(service, "fork-late", laterFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  it("T1: a sibling that copied the parent's entries written after its save never becomes the parent (review 902e)", async () => {
    const service = createService();
    const rows: Array<[string, string]> = Array.from({ length: 20 }, () => ["parent-a", randomUUID()]);
    const file = await transcript(rows);
    const snapshot = checkpoint(service, "parent-a", file);
    // The parent's file grows after its save (at least that tool's result): these two entries are no parent anchors.
    const tail = [randomUUID(), randomUUID()];
    await appendFile(file, tail.map(uuid => line("parent-a", uuid)).join("\n") + "\n", "utf8");
    const copied = [...rows.map(([, uuid]) => uuid), ...tail];
    const siblingFile = await fork(service, "fork-s", copied);
    expect(load(service, "fork-s", inspect(service, "fork-s", siblingFile)).error).toBeNull();
    // The sibling saves: the tail it copied existed before its fork, so it owns only its own entry.
    checkpoint(service, "fork-s", siblingFile, { requestId: "sibling-tail", expectedRevision: snapshot.revision });
    const laterFile = await fork(service, "fork-late", copied);
    expect(inspect(service, "fork-late", laterFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  it("N1x: an unrelated session that wrote the parent's unanchored entries into its own file and saved never becomes the parent (review 902e)", async () => {
    const service = createService();
    const rows: Array<[string, string]> = Array.from({ length: 20 }, () => ["parent-a", randomUUID()]);
    const file = await transcript(rows);
    const snapshot = checkpoint(service, "parent-a", file);
    const tail = [randomUUID(), randomUUID()];
    await appendFile(file, tail.map(uuid => line("parent-a", uuid)).join("\n") + "\n", "utf8");
    // C is no fork: its model read A's file and appended A's tail uuids as its own entries, then saved.
    const forged = await transcript([["unrelated-c", randomUUID(), OWN], ...tail.map(uuid => ["unrelated-c", uuid, OWN] as [string, string, string])]);
    expect(start(service, "unrelated-c", "startup", forged)).toEqual({});
    checkpoint(service, "unrelated-c", forged, { requestId: "forged-tail" });
    const laterFile = await fork(service, "fork-late", [...rows.map(([, uuid]) => uuid), ...tail]);
    expect(inspect(service, "fork-late", laterFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  // OPEN DEFECT REPRODUCTION, not the accepted outcome (review 902e N1z; chief 700fa72c judgement: risk not accepted,
  // "file or token possession alone never grants a relation" holds). Inside a recorded lineage a non-fork parent's model
  // can copy a descendant's own entries into the parent's file with a write tool; a later fork of that parent then
  // resolves to the descendant. The correct result is the parent's own state (or no candidate); this test records the
  // current vulnerable behaviour until a host-authoritative relation source repairs it, and must flip with that repair.
  it("N1z (open defect reproduction): a parent that wrote its fork's own entries into its file currently makes a later fork of it resolve to that fork", async () => {
    const service = createService();
    const { snapshot, uuids, file } = await parent(service, "parent-a");
    const own = randomUUID();
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", own, OWN]]);
    expect(start(service, "fork-f", "fork", childFile)).toEqual({});
    prompt(service, "fork-f", childFile);
    expect(load(service, "fork-f", inspect(service, "fork-f", childFile)).error).toBeNull();
    const childSnapshot = checkpoint(service, "fork-f", childFile, { requestId: "f-own", expectedRevision: snapshot.revision });
    await appendFile(file, line("parent-a", own) + "\n", "utf8");
    checkpoint(service, "parent-a", file, { requestId: "a-copied-f", expectedRevision: snapshot.revision });
    const laterFile = await fork(service, "fork-g", [...uuids, own]);
    expect(inspect(service, "fork-g", laterFile).summary).toMatchObject({ taskCorrelation: childSnapshot.taskCorrelation, revision: childSnapshot.revision });
  });

  it("T1b: a fork entry without a host write time is treated as copied, never as the fork's own anchor", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const untimed = randomUUID();
    const siblingFile = await transcript([...uuids.map(uuid => ["fork-u", uuid] as [string, string])], JSON.stringify({ type: "user", sessionId: "fork-u", uuid: untimed }) + "\n");
    expect(start(service, "fork-u", "fork", siblingFile)).toEqual({});
    expect(load(service, "fork-u", inspect(service, "fork-u", siblingFile)).error).toBeNull();
    checkpoint(service, "fork-u", siblingFile, { requestId: "untimed", expectedRevision: snapshot.revision });
    const laterFile = await fork(service, "fork-late", [...uuids, untimed]);
    expect(inspect(service, "fork-late", laterFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
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

  // Gemini (agy) fork inheritance is an open implementation gap until its host relation evidence is observed; this
  // guards only that no lookup runs without such evidence, not that the host is excluded. Codex: see the block below.
  it("N7: without a host fork record the lookup never runs (Gemini/agy: relation evidence not yet implemented)", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const file = await transcript(uuids.map(uuid => ["never-forked", uuid] as [string, string]));
    prompt(service, "never-forked", file);
    expect(inspect(service, "never-forked", file).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    expect(service.store.hasObservation(service.correlateSession("never-forked"), 1, "fork-start")).toBe(false);
    for (const host of ["gemini", "antigravity"]) {
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

// D0352 B08 Codex: the host names the parent itself. A Codex fork's rollout starts with a host-written session_meta line
// whose payload carries the child's id, forked_from_id (the parent) and the fork instant (tester TEST, Codex 0.166).
// SessionStart source=fork fires only at the child's first prompt, so the parent's state is fixed at that fork instant.
describe("D0352 B08 Codex fork origin", () => {
  const CODEX = "codex";
  // The service clock (and so every save) is 01:00:00; a fork instant after it sees that save, one before it does not.
  const FORK_AT = "2026-11-01T01:00:05.000Z";
  const BEFORE_SAVE = "2026-11-01T00:59:00.000Z";

  async function rollout(id: string, payload: Record<string, unknown> = {}, firstLine?: string): Promise<string> {
    const file = join(await directory(), "rollout.jsonl");
    const meta = firstLine ?? JSON.stringify({ timestamp: "2026-11-01T01:00:06.000Z", type: "session_meta", ordinal: 0,
      payload: { id, session_id: id, timestamp: FORK_AT, instructions: BODY_MARKER, ...payload } });
    await writeFile(file, meta + "\n" + JSON.stringify({ type: "response_item", payload: { content: BODY_MARKER } }) + "\n", "utf8");
    return file;
  }

  function codexBound<T extends Record<string, unknown>>(service: ContinuityService, session: string, tool: string, input: T): T & { _continuityBinding: string } {
    const output = hook(service, { hook_event_name: "PreToolUse", session_id: session, tool_name: TOOL + tool, tool_input: input,
      tool_use_id: "call_" + randomUUID().replaceAll("-", "") }, CODEX) as { hookSpecificOutput: { updatedInput: T & { _continuityBinding: string } } };
    return output.hookSpecificOutput.updatedInput;
  }

  function codexCheckpoint(service: ContinuityService, session: string, overrides: Partial<CheckpointContextRequestV1> = {}): ContinuitySnapshotV1 {
    const result = service.checkpointContext(codexBound(service, session, "checkpoint_context", checkpointInput(overrides)));
    expect(result.error).toBeNull();
    return result.data!;
  }

  function codexInspect(service: ContinuityService, session: string) {
    const result = service.inspectContext(codexBound(service, session, "inspect_context", { schemaVersion: "1.0.0" }));
    expect(result.error).toBeNull();
    return result.data!;
  }

  function codexLoad(service: ContinuityService, session: string, candidate: ReturnType<typeof codexInspect>) {
    return service.loadContext(codexBound(service, session, "load_context", loadInput(candidate)));
  }

  /** The child's SessionStart(source=fork) at its first prompt, then that prompt. */
  function codexFork(service: ContinuityService, child: string, file?: string, extra: Record<string, unknown> = {}) {
    expect(hook(service, { hook_event_name: "SessionStart", source: "fork", session_id: child, ...(file ? { transcript_path: file } : {}), ...extra }, CODEX)).toEqual({});
    expect(hook(service, { hook_event_name: "UserPromptSubmit", session_id: child, prompt: "continue", ...(file ? { transcript_path: file } : {}) }, CODEX)).toEqual({});
  }

  it("C-P1: a Codex fork inspects and loads its host-named parent's checkpoint, then continues without STALE_REVISION", async () => {
    const service = createService();
    const parentSnapshot = codexCheckpoint(service, "codex-p");
    codexFork(service, "codex-f", await rollout("codex-f", { forked_from_id: "codex-p", forked_from_ordinal_exclusive: 4 }));
    const candidate = codexInspect(service, "codex-f");
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: CANDIDATE });
    expect(candidate.summary).toMatchObject({ taskCorrelation: parentSnapshot.taskCorrelation, revision: parentSnapshot.revision, snapshotDigest: parentSnapshot.snapshotDigest });
    expect(codexLoad(service, "codex-f", candidate).data).toEqual(parentSnapshot);
    const next = codexCheckpoint(service, "codex-f", { requestId: "child-1", expectedRevision: parentSnapshot.revision });
    expect(next).toMatchObject({ revision: parentSnapshot.revision + 1, taskCorrelation: service.correlateSession("codex-f") });
    expect(service.store.getSnapshot(parentSnapshot.taskCorrelation, parentSnapshot.epoch)).toEqual(parentSnapshot);
  });

  it("C-F1b: a parent save after the host's fork instant (before the child's first prompt) is never the fork's state", async () => {
    const service = createService();
    codexCheckpoint(service, "codex-p");
    codexFork(service, "codex-f", await rollout("codex-f", { forked_from_id: "codex-p", timestamp: BEFORE_SAVE }));
    expect(codexInspect(service, "codex-f").reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
  });

  it("C-Q1: only a new saved revision moves the parent's save time; a re-anchor after the fork instant never makes it advanced", async () => {
    const service = createService();
    const parentSnapshot = codexCheckpoint(service, "codex-p");
    // Re-anchoring (compaction) adds lineage rows only; the snapshot and its save time stay those of the saved revision.
    service.reanchorAfterCompact("codex-p", () => ({ ids: ["entry-1"], at: [Date.parse(FORK_AT)] }));
    expect(service.store.getSnapshot(parentSnapshot.taskCorrelation, parentSnapshot.epoch)).toEqual(parentSnapshot);
    codexFork(service, "codex-f", await rollout("codex-f", { forked_from_id: "codex-p", timestamp: parentSnapshot.updatedAt }));
    expect(codexInspect(service, "codex-f").summary).toMatchObject({ taskCorrelation: parentSnapshot.taskCorrelation, revision: parentSnapshot.revision });
  });

  it("C-N5: a parent that saves again after the pin, or is suppressed, yields no candidate", async () => {
    const service = createService();
    const parentSnapshot = codexCheckpoint(service, "codex-p");
    codexFork(service, "codex-f", await rollout("codex-f", { forked_from_id: "codex-p" }));
    codexCheckpoint(service, "codex-p", { requestId: "again", expectedRevision: parentSnapshot.revision });
    expect(codexInspect(service, "codex-f").reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
    codexCheckpoint(service, "codex-q");
    service.store.setSuppressed(service.correlateSession("codex-q"), 1, "2026-11-01T01:00:00.000Z");
    codexFork(service, "codex-g", await rollout("codex-g", { forked_from_id: "codex-q" }));
    expect(codexInspect(service, "codex-g").reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_SUPPRESSED"]);
  });

  it("C-D1: a Codex grandchild takes the fork it was forked from, never the original parent", async () => {
    const service = createService();
    const parentSnapshot = codexCheckpoint(service, "codex-p");
    codexFork(service, "codex-f", await rollout("codex-f", { forked_from_id: "codex-p" }));
    expect(codexLoad(service, "codex-f", codexInspect(service, "codex-f")).error).toBeNull();
    const childSnapshot = codexCheckpoint(service, "codex-f", { requestId: "f-1", expectedRevision: parentSnapshot.revision });
    codexFork(service, "codex-g", await rollout("codex-g", { forked_from_id: "codex-f" }));
    expect(codexInspect(service, "codex-g").summary).toMatchObject({ taskCorrelation: childSnapshot.taskCorrelation, revision: childSnapshot.revision });
  });

  it("C-N1: no fork, a non-root actor, a wrong or malformed origin, or an unknown parent never yields a parent", async () => {
    const service = createService();
    codexCheckpoint(service, "codex-p");
    // A startup session whose rollout names a parent is no fork: the relation fact comes only from SessionStart source.
    const startup = await rollout("codex-s", { forked_from_id: "codex-p" });
    expect(hook(service, { hook_event_name: "SessionStart", source: "startup", session_id: "codex-s", transcript_path: startup }, CODEX)).toEqual({});
    expect(codexInspect(service, "codex-s").reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    expect(service.store.hasObservation(service.correlateSession("codex-s"), 1, "fork-start")).toBe(false);
    // A native subagent hook context (agent_id) never inherits through fork either.
    codexFork(service, "codex-sub", await rollout("codex-sub", { forked_from_id: "codex-p" }), { agent_id: "agent-1" });
    expect(service.store.hasObservation(service.correlateSession("codex-sub"), 1, "fork-start")).toBe(false);
    const cases: Array<[string, (child: string) => Promise<string | undefined>, string]> = [
      ["codex-mismatch", () => rollout("someone-else", { forked_from_id: "codex-p" }), "FORK_ORIGIN_SESSION_MISMATCH"],
      ["codex-no-origin", child => rollout(child), "FORK_ORIGIN_ABSENT"],
      ["codex-self", child => rollout(child, { forked_from_id: child }), "FORK_ORIGIN_FORMAT_INVALID"],
      ["codex-empty", child => rollout(child, { forked_from_id: "" }), "FORK_ORIGIN_FORMAT_INVALID"],
      ["codex-no-time", child => rollout(child, { forked_from_id: "codex-p", timestamp: "not a time" }), "FORK_ORIGIN_FORMAT_INVALID"],
      ["codex-not-meta", child => rollout(child, {}, JSON.stringify({ type: "response_item", payload: { id: child, forked_from_id: "codex-p", timestamp: FORK_AT } })), "FORK_ORIGIN_FORMAT_INVALID"],
      ["codex-not-json", child => rollout(child, {}, "{not json"), "FORK_ORIGIN_FORMAT_INVALID"],
      ["codex-absent", async () => join(tmpdir(), `absent-${randomUUID()}.jsonl`), "FORK_ORIGIN_TRANSCRIPT_ABSENT"],
      ["codex-unknown-parent", child => rollout(child, { forked_from_id: "never-seen" }), "FORK_PARENT_NOT_FOUND"],
      ["codex-no-path", async () => undefined, "FORK_PARENT_NOT_PINNED"],
    ];
    for (const [child, file, reason] of cases) {
      codexFork(service, child, await file(child));
      expect(codexInspect(service, child).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", reason]);
    }
  });

  it("C-N4: the pin is fixed at the fork start; a later edit of the child's rollout never changes the parent", async () => {
    const service = createService();
    const parentSnapshot = codexCheckpoint(service, "codex-p");
    codexCheckpoint(service, "codex-q");
    const file = await rollout("codex-f", { forked_from_id: "codex-p" });
    codexFork(service, "codex-f", file);
    await writeFile(file, JSON.stringify({ timestamp: FORK_AT, type: "session_meta", payload: { id: "codex-f", forked_from_id: "codex-q", timestamp: FORK_AT } }) + "\n", "utf8");
    expect(hook(service, { hook_event_name: "PreToolUse", session_id: "codex-f", tool_name: "shell", tool_input: { command: "true" }, tool_use_id: "call_x", transcript_path: file }, CODEX)).toEqual({});
    expect(codexInspect(service, "codex-f").summary).toMatchObject({ taskCorrelation: parentSnapshot.taskCorrelation, revision: parentSnapshot.revision });
    // A second fork start of the same session never re-pins either.
    codexFork(service, "codex-f", file);
    expect(codexInspect(service, "codex-f").summary).toMatchObject({ taskCorrelation: parentSnapshot.taskCorrelation });
  });

  it("C-R: resume and a child with its own state keep their own continuity", async () => {
    const service = createService();
    codexCheckpoint(service, "codex-p");
    const own = codexCheckpoint(service, "codex-f0");
    codexFork(service, "codex-f0", await rollout("codex-f0", { forked_from_id: "codex-p" }));
    expect(codexInspect(service, "codex-f0").summary).toMatchObject({ taskCorrelation: own.taskCorrelation, revision: own.revision });
    expect(service.store.firstObservationEvent(service.correlateSession("codex-f0"), 1, "fork-parent:")).toBeNull();
    const resumed = hook(service, { hook_event_name: "SessionStart", source: "resume", session_id: "codex-p" }, CODEX) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(resumed.hookSpecificOutput?.additionalContext ?? "").toContain("source=direct");
  });
});
