import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// D0352 B08 r03: a real Claude fork child (host SessionStart source=fork) may take its parent's exact
// direct checkpoint through inspect/load; unrelated sessions, copies and other hosts never do.
const TOOL = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const stores: SqliteContinuityStore[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function createService(): ContinuityService {
  const store = new SqliteContinuityStore(":memory:");
  stores.push(store);
  return new ContinuityService(store, new ContractValidator(), new InMemoryWorkflowStore(), () => new Date("2026-11-01T01:00:00.000Z"));
}

async function transcript(rows: Array<[sessionId: string, uuid: string]>, extra = ""): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ags-b08-"));
  directories.push(directory);
  const file = join(directory, "session.jsonl");
  const lines = rows.map(([sessionId, uuid]) => JSON.stringify({ type: "user", sessionId, uuid, message: { role: "user", content: "x" } }));
  await writeFile(file, lines.join("\n") + "\n" + extra, "utf8");
  return file;
}

function start(service: ContinuityService, session: string, source: string, transcriptPath?: string, host = "claude-code") {
  return handleContinuityHook({ hook_event_name: "SessionStart", source, session_id: session, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }, service, host);
}

function hookBound<T extends Record<string, unknown>>(service: ContinuityService, session: string, tool: string, input: T, transcriptPath?: string): T & { _continuityBinding: string } {
  const output = handleContinuityHook({
    hook_event_name: "PreToolUse", session_id: session, tool_name: TOOL + tool, tool_input: input,
    tool_use_id: "toolu_" + randomUUID().replaceAll("-", ""), ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  }, service, "claude-code") as { hookSpecificOutput: { updatedInput: T & { _continuityBinding: string } } };
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

/** Parent A checkpoints over its own transcript; returns A's snapshot and the rows a fork would copy. */
async function parent(service: ContinuityService, session = "parent-a") {
  const rows: Array<[string, string]> = [[session, randomUUID()], [session, randomUUID()], [session, randomUUID()]];
  const snapshot = checkpoint(service, session, await transcript(rows));
  return { snapshot, uuids: rows.map(([, uuid]) => uuid) };
}

/** A host fork: copied parent uuids rewritten to the child session id, then the child's own entries. */
async function fork(service: ContinuityService, child: string, copied: string[]) {
  const file = await transcript([...copied.map(uuid => [child, uuid] as [string, string]), [child, randomUUID()]]);
  expect(start(service, child, "fork", file)).toEqual({});
  return file;
}

describe("D0352 B08 fork lineage", () => {
  it("P1: a fork child inspects and loads the parent's exact checkpoint, then continues without STALE_REVISION", async () => {
    const service = createService();
    const { snapshot: parentSnapshot, uuids } = await parent(service);
    const childFile = await fork(service, "fork-f", uuids);
    const candidate = inspect(service, "fork-f", childFile);
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: ["EXPLICIT_LOAD_REQUIRED", "FORK_PARENT_CANDIDATE"] });
    expect(candidate.summary).toMatchObject({ source: "direct", taskCorrelation: parentSnapshot.taskCorrelation,
      revision: parentSnapshot.revision, snapshotDigest: parentSnapshot.snapshotDigest });
    const loaded = service.loadContext(hookBound(service, "fork-f", "load_context", loadInput(candidate), childFile));
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

  it("N1: an unrelated startup session holding the parent's uuids in its own file or a copy gets nothing", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const copied = await transcript(uuids.map(uuid => ["unrelated-c", uuid] as [string, string]));
    expect(start(service, "unrelated-c", "startup", copied)).toEqual({});
    expect(inspect(service, "unrelated-c", copied)).toMatchObject({ decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"], restoreToken: null });
    for (const source of ["resume", "clear"]) {
      expect(start(service, `unrelated-${source}`, source, copied)).toBeDefined();
      expect(inspect(service, `unrelated-${source}`, copied).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    }
  });

  it("N4: a real fork of an unrelated parent does not receive another session's state", async () => {
    const service = createService();
    await parent(service, "parent-a");
    const childFile = await fork(service, "fork-of-b", [randomUUID(), randomUUID()]);
    expect(inspect(service, "fork-of-b", childFile)).toMatchObject({ decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE", "FORK_PARENT_NOT_FOUND"] });
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

  it("N5: a candidate inspected before the parent saved again is STALE at load and adopts nothing", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await fork(service, "fork-late", uuids);
    const candidate = inspect(service, "fork-late", childFile);
    checkpoint(service, "parent-a", await transcript([["parent-a", randomUUID()]]), { requestId: "again", expectedRevision: snapshot.revision });
    expect(service.loadContext(hookBound(service, "fork-late", "load_context", loadInput(candidate), childFile)).error?.code).toBe("STALE_REVISION");
    expect(service.store.getSnapshot(service.correlateSession("fork-late"), 1)).toBeNull();
  });

  it("N6: missing, unreadable-format or foreign-session transcripts close with a stable reason", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const missingDirectory = await mkdtemp(join(tmpdir(), "ags-b08-missing-"));
    directories.push(missingDirectory);
    const missing = join(missingDirectory, "absent.jsonl");
    expect(start(service, "child-missing", "fork", missing)).toEqual({});
    expect(inspect(service, "child-missing", missing).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "LINEAGE_TRANSCRIPT_ABSENT"]);
    // Parent rows whose sessionId was not rewritten are not the child's own entries.
    const foreign = await transcript(uuids.map(uuid => ["parent-a", uuid] as [string, string]), "{not json child-garbled\n");
    expect(start(service, "child-garbled", "fork", foreign)).toEqual({});
    expect(inspect(service, "child-garbled", foreign).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "LINEAGE_IDS_ABSENT"]);
    // A fork whose host supplied no transcript path performs no lookup.
    expect(start(service, "child-no-path", "fork")).toEqual({});
    expect(inspect(service, "child-no-path").reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
  });

  it("N7: without a host fork record the lookup never runs, and other hosts keep fork as startup", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const file = await transcript(uuids.map(uuid => ["never-forked", uuid] as [string, string]));
    expect(inspect(service, "never-forked", file).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE"]);
    expect(start(service, "codex-fork", "fork", file, "codex")).toEqual({});
    expect(service.store.hasObservation(service.correlateSession("codex-fork"), 1, "fork-start")).toBe(false);
    expect(service.store.hasObservation(service.correlateSession("never-forked"), 1, "fork-start")).toBe(false);
  });

  it("N9: a fork candidate cannot be loaded by another child or by the parent", async () => {
    const service = createService();
    const { uuids } = await parent(service);
    const childFile = await fork(service, "fork-owner", uuids);
    const candidate = inspect(service, "fork-owner", childFile);
    const otherFile = await fork(service, "fork-other", uuids);
    expect(service.loadContext(hookBound(service, "fork-other", "load_context", loadInput(candidate), otherFile)).error?.code).toBe("BINDING_INVALID");
    expect(service.loadContext(hookBound(service, "parent-a", "load_context", loadInput(candidate))).error?.code).toBe("BINDING_INVALID");
    expect(service.store.getSnapshot(service.correlateSession("fork-other"), 1)).toBeNull();
  });
});
