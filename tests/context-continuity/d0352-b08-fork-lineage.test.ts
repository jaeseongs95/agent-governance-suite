import { randomUUID } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../contracts/types.js";
import {
  CLAUDE_NATIVE_EXECUTABLE_PATTERN, claudeForkHostRead, distinguishedNameValue, forkParentFromArgv, ownHookLauncher, readClaudeForkHostParent,
  windowsCommandLineArgv, windowsHostReader, windowsHostSnapshot, WINDOWS_QUERY_TIMEOUT_MS, type HostProcessView, type WindowsProcessRow,
} from "../../mcp-server/src/claude-fork-host.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { claudeAdmissionIngress, codexMetaIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { admitCaller, type VerifiedCaller } from "../../mcp-server/src/caller-identity.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { codexCallMeta } from "../helpers/caller.js";

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

const PLATFORM = Object.getOwnPropertyDescriptor(process, "platform")!;
/** The Claude adapter picks its host-process read by platform; hook-driven cases pin it so every CI OS runs one path. */
function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  Object.defineProperty(process, "platform", { ...PLATFORM, value: platform });
  try { return run(); } finally { Object.defineProperty(process, "platform", PLATFORM); }
}
let hookPlatform: NodeJS.Platform = "linux";

function hook(service: ContinuityService, payload: Record<string, unknown>, host = "claude-code") {
  return withPlatform(hookPlatform, () => handleContinuityHook(payload, service, host));
}

function start(service: ContinuityService, session: string, source: string, transcriptPath?: string, host = "claude-code") {
  return hook(service, { hook_event_name: "SessionStart", source, session_id: session, ...(transcriptPath ? { transcript_path: transcriptPath } : {}) }, host);
}

/** The child's first user prompt: its parent is pinned here only when already found. */
function prompt(service: ContinuityService, session: string, transcriptPath?: string) {
  const output = hook(service, { hook_event_name: "UserPromptSubmit", session_id: session, prompt: "continue",
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}) });
  expectCheckpointCue(output);
}

function expectCheckpointCue(output: Record<string, unknown>) {
  expect(output).toMatchObject({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: expect.any(String) } });
  const context = (output as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
  expect(context).toContain("[Task continuity checkpoint check]");
  for (const tool of ["checkpoint_context", "inspect_context", "load_context"]) expect(context).toContain(tool);
  for (const forbidden of [BODY_MARKER, checkpointInput().core.objective, "candidateToken=", "restoreToken", "_continuityBinding", "decision=DEFER", "decision=INJECT"])
    expect(context).not.toContain(forbidden);
}

/** A write-capable host tool or non-AGS MCP tool boundary (before the tool runs): the final point a fork's parent is pinned. */
function tool(service: ContinuityService, session: string, transcriptPath: string, toolName = "Bash") {
  expect(hook(service, { hook_event_name: "PreToolUse", session_id: session, tool_name: toolName, tool_input: { command: "true" },
    tool_use_id: "toolu_" + randomUUID().replaceAll("-", ""), transcript_path: transcriptPath })).toEqual({});
}

const admissions = new InMemoryWorkflowStore();
/**
 * One Claude AGS call: the real PreToolUse continuity hook (which leaves the call unchanged), the admission row the
 * governance hook records for it, and the caller the server's Claude ingress admits from that row. The caller reads
 * the child's own lineage from the recorded transcript_path; the service pins and anchors from it.
 */
function admitted(service: ContinuityService, session: string, tool: string, input: Record<string, unknown>, transcriptPath?: string): VerifiedCaller {
  const callId = "toolu_" + randomUUID().replaceAll("-", "");
  expect(hook(service, {
    hook_event_name: "PreToolUse", session_id: session, tool_name: TOOL + tool, tool_input: input,
    tool_use_id: callId, ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  })).toEqual({});
  admissions.recordCallAdmission({ host: "claude-code", callId, tool, sessionId: session, agentId: null,
    execution: { unavailable: "EXECUTION_NOT_REQUIRED" }, transcriptPath: transcriptPath ?? null });
  return admitCaller(claudeAdmissionIngress(admissions)(tool, { "claudecode/toolUseId": callId }), hostActorId);
}

// Also a plain tools/call argument record.
function checkpointInput(overrides: Partial<CheckpointContextRequestV1> = {}): CheckpointContextRequestV1 & Record<string, unknown> {
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
  const input = checkpointInput(overrides);
  const result = service.checkpointContext(input, admitted(service, session, "checkpoint_context", input, transcriptPath));
  expect(result.error).toBeNull();
  return result.data!;
}

function inspect(service: ContinuityService, session: string, transcriptPath?: string) {
  const input = { schemaVersion: "1.0.0" };
  const result = service.inspectContext(input, admitted(service, session, "inspect_context", input, transcriptPath));
  expect(result.error).toBeNull();
  return result.data!;
}

function loadInput(candidate: ReturnType<typeof inspect>) {
  return { schemaVersion: "1.0.0", candidateToken: candidate.restoreToken!, epoch: candidate.summary!.epoch,
    revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
}

function load(service: ContinuityService, session: string, candidate: ReturnType<typeof inspect>) {
  const input = loadInput(candidate);
  return service.loadContext(input, admitted(service, session, "load_context", input));
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
  // resolves to the descendant. The correct result is the parent's own state (or no candidate). The repair applies
  // when the host process names the parent (H-N1z below, Linux argv); this test keeps the behaviour of a fork whose host
  // process names none (macOS, Windows, TUI /branch: not observed), which is still open (auditor 5970 b8136ae1).
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
    expect(service.suppressContextRestore(suppress, admitted(service, "parent-sup", "suppress_context_restore", suppress)).data?.suppressed).toBe(true);
    expect(inspect(service, "child-sup", suppressedChild).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_SUPPRESSED"]);

    const purgedParent = await parent(service, "parent-pur");
    const purgedChild = await fork(service, "child-pur", purgedParent.uuids);
    const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-1", expectedEpoch: 1, expectedRevision: purgedParent.snapshot.revision };
    expect(service.purgeDirectContext(purge, admitted(service, "parent-pur", "purge_direct_context", purge)).data).toMatchObject({ purged: true });
    expect(inspect(service, "child-pur", purgedChild).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
  });

  it("N5/N13: a parent that saved, purged, cleared or suppressed between inspect and load rejects the load and adopts nothing", async () => {
    const service = createService();
    const cases: Array<[string, (session: string, snapshot: ContinuitySnapshotV1, file: string) => void, string]> = [
      ["saved", (session, snapshot) => { checkpoint(service, session, join(tmpdir(), "absent-b08.jsonl"), { requestId: "again", expectedRevision: snapshot.revision }); }, "STALE_REVISION"],
      ["purged", (session, snapshot) => {
        const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-1", expectedEpoch: 1, expectedRevision: snapshot.revision };
        expect(service.purgeDirectContext(purge, admitted(service, session, "purge_direct_context", purge)).data).toMatchObject({ purged: true });
      }, "STALE_REVISION"],
      ["cleared", (session, _snapshot, file) => { start(service, session, "clear", file); }, "BINDING_INVALID"],
      ["suppressed", session => {
        const suppress = { schemaVersion: "1.0.0" as const, expectedEpoch: 1 };
        expect(service.suppressContextRestore(suppress, admitted(service, session, "suppress_context_restore", suppress)).error).toBeNull();
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

  /** One Codex AGS call: the hook leaves it unchanged; the server's Codex ingress admits the caller from the call _meta. */
  function codexAdmitted(service: ContinuityService, session: string, tool: string, input: Record<string, unknown>): VerifiedCaller {
    expect(hook(service, { hook_event_name: "PreToolUse", session_id: session, tool_name: TOOL + tool, tool_input: input,
      tool_use_id: "call_" + randomUUID().replaceAll("-", "") }, CODEX)).toEqual({});
    return admitCaller(codexMetaIngress()(tool, codexCallMeta(session)), hostActorId);
  }

  function codexCheckpoint(service: ContinuityService, session: string, overrides: Partial<CheckpointContextRequestV1> = {}): ContinuitySnapshotV1 {
    const input = checkpointInput(overrides);
    const result = service.checkpointContext(input, codexAdmitted(service, session, "checkpoint_context", input));
    expect(result.error).toBeNull();
    return result.data!;
  }

  function codexInspect(service: ContinuityService, session: string) {
    const input = { schemaVersion: "1.0.0" };
    const result = service.inspectContext(input, codexAdmitted(service, session, "inspect_context", input));
    expect(result.error).toBeNull();
    return result.data!;
  }

  function codexLoad(service: ContinuityService, session: string, candidate: ReturnType<typeof codexInspect>) {
    const input = loadInput(candidate);
    return service.loadContext(input, codexAdmitted(service, session, "load_context", input));
  }

  /** The child's SessionStart(source=fork) at its first prompt, then that prompt. */
  function codexFork(service: ContinuityService, child: string, file?: string, extra: Record<string, unknown> = {}) {
    const correlation = service.correlateSession(child), before = service.store.getTask(correlation);
    const snapshot = before ? service.store.getSnapshot(correlation, before.currentEpoch) : null;
    expect(hook(service, { hook_event_name: "SessionStart", source: "fork", session_id: child, ...(file ? { transcript_path: file } : {}), ...extra }, CODEX)).toEqual({});
    const output = hook(service, { hook_event_name: "UserPromptSubmit", session_id: child, prompt: "continue", ...(file ? { transcript_path: file } : {}), ...extra }, CODEX);
    if (Object.hasOwn(extra, "agent_id")) {
      expect(output).toEqual({});
      expect(service.store.getTask(correlation)).toEqual(before);
    } else expectCheckpointCue(output);
    expect(service.store.getSnapshot(correlation, before?.currentEpoch ?? 1)).toEqual(snapshot);
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

describe("D0352 B08 Claude fork host argv (N1z repair)", () => {
  // Shape observed by tester c613 (k2exe-r01 a9e7656f): the hook runs under sh (exe /usr/bin/dash) under this binary.
  const NATIVE = "/home/u/.local/share/ssh-approval-cli/claude/versions/2.1.314-599225981133da60/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe";
  const A = "0b6f2b8e-1c1d-4a57-9f0c-6f9a3b2d1e01";
  const SELF = "7d0c5a8e-2f44-4b61-8e3a-0c9b1d2e3f02";
  // Root-owned, not group/other writable (auditor 5970 L); the official native installer's versioned file (c613 r06).
  const SAFE = { uid: 0, mode: 0o100755 };
  const STANDALONE = "/home/u/.local/share/claude/versions/2.1.316";

  /** A host fork whose host process named its parent at the fork start (what the Claude adapter records on Linux). */
  async function hostFork(service: ContinuityService, child: string, copied: string[], named: string) {
    const file = await transcript([...copied.map(uuid => [child, uuid] as [string, string]), [child, randomUUID(), OWN]]);
    service.startFork(child, undefined, () => ({ parentSessionId: named }));
    prompt(service, child, file);
    return file;
  }

  function hostParentEvent(service: ContinuityService, session: string): string | undefined {
    const correlation = service.correlateSession(session);
    return service.store.firstObservationEvent(correlation, service.store.getTask(correlation)!.currentEpoch, "fork-host-parent:") ?? undefined;
  }

  it("H-A1: only one --resume <id> with one --fork-session names a parent; everything else is a distinct reason", () => {
    for (const [argv, expected] of [
      [["claude", "-p", "--resume", A, "--fork-session"], { parentSessionId: A }],
      [["claude", "--resume", A, "--fork-session"], { parentSessionId: A }],
      [["claude", "--fork-session", `--resume=${A}`], { parentSessionId: A }],
      [["claude", "--resume", A], { reason: "FORK_HOST_ARGV_NOT_FORK" }],
      [["claude"], { reason: "FORK_HOST_ARGV_NOT_FORK" }],
      [["claude", "--fork-session"], { reason: "FORK_HOST_ARGV_NO_PARENT" }],
      [["claude", "--continue", "--fork-session"], { reason: "FORK_HOST_ARGV_NO_PARENT" }],
      [["claude", "--resume", "--fork-session"], { reason: "FORK_HOST_ARGV_NO_PARENT" }],
      [["claude", "--resume", "--fork-session", "--fork-session"], { reason: "FORK_HOST_ARGV_AMBIGUOUS" }],
      [["claude", "--resume", A, "--resume", SELF, "--fork-session"], { reason: "FORK_HOST_ARGV_AMBIGUOUS" }],
      [["claude", "--resume", "parent-a", "--fork-session"], { reason: "FORK_HOST_ARGV_PARENT_INVALID" }],
      [["claude", "--resume", SELF, "--fork-session"], { reason: "FORK_HOST_ARGV_SELF" }],
      [["claude", "-p", "--", "--resume", A, "--fork-session"], { reason: "FORK_HOST_ARGV_NOT_FORK" }],
      // Auditor 5970 F2: the short alias is read; other short forms naming r are never read and never let an id win.
      [["claude", "-r", A, "--fork-session"], { parentSessionId: A }],
      [["claude", "-p", "run the tests", "-r", A, "--fork-session"], { parentSessionId: A }],
      [["claude", `-r${A}`, "--fork-session"], { reason: "FORK_HOST_ARGV_NO_PARENT" }],
      [["claude", `-r=${A}`, "--fork-session"], { reason: "FORK_HOST_ARGV_NO_PARENT" }],
      [["claude", "-cr", "--resume", A, "--fork-session"], { reason: "FORK_HOST_ARGV_AMBIGUOUS" }],
      [["claude", "-r", SELF, "--resume", A, "--fork-session"], { reason: "FORK_HOST_ARGV_AMBIGUOUS" }],
    ] as const) expect(forkParentFromArgv(argv, SELF), argv.join(" ")).toEqual(expected);
  });

  it("H-A2: the nearest host process past at most two shells must be the native claude of a safe install; nothing above it is read", () => {
    const chain = (...views: Array<HostProcessView | "unreadable" | "changed">) => {
      const read: number[] = [];
      return { read, reader: (pid: number) => { read.push(pid); return views[pid - 100] ?? "unreadable"; } };
    };
    const view = (exe: string, argv: string[], next: number): HostProcessView => ({ exe, argv, ppid: next, startToken: "t" + next, file: SAFE });
    const fork = ["claude", "--resume", A, "--fork-session"];
    expect(CLAUDE_NATIVE_EXECUTABLE_PATTERN.test(NATIVE)).toBe(true);
    let walk = chain(view("/usr/bin/dash", ["sh", "-c", "hook"], 101), view(NATIVE, fork, 102));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ parentSessionId: A });
    walk = chain(view("/usr/bin/dash", ["sh"], 101), view("/usr/bin/bash", ["bash"], 102), view(NATIVE, fork, 103));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ parentSessionId: A });
    // A third shell is not skipped and is its own reason (auditor 5970 W-3).
    walk = chain(view("/usr/bin/dash", ["sh"], 101), view("/usr/bin/dash", ["sh"], 102), view("/usr/bin/dash", ["sh"], 103), view(NATIVE, fork, 104));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ reason: "FORK_HOST_SHELL_DEPTH_EXCEEDED" });
    expect(walk.read).toEqual([100, 101, 102]);
    // The official native installer's versioned file is a recognized install too.
    expect(CLAUDE_NATIVE_EXECUTABLE_PATTERN.test(STANDALONE)).toBe(true);
    walk = chain(view("/usr/bin/dash", ["sh"], 101), view(STANDALONE, fork, 102));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader, null, 1001)).toEqual({ parentSessionId: A });
    // Owner and mode (auditor 5970 L): this user or root, never group/other writable, and a file must have been read.
    for (const [file, uid, expected] of [
      [{ uid: 1001, mode: 0o100755 }, 1001, { parentSessionId: A }],
      [{ uid: 1001, mode: 0o100700 }, 1001, { parentSessionId: A }],
      [{ uid: 1002, mode: 0o100755 }, 1001, { reason: "FORK_HOST_EXECUTABLE_UNSAFE" }],
      [{ uid: 0, mode: 0o100775 }, 1001, { reason: "FORK_HOST_EXECUTABLE_UNSAFE" }],
      [{ uid: 1001, mode: 0o100757 }, 1001, { reason: "FORK_HOST_EXECUTABLE_UNSAFE" }],
      [undefined, 1001, { reason: "FORK_HOST_EXECUTABLE_UNSAFE" }],
    ] as const) {
      const host: HostProcessView = { exe: STANDALONE, argv: fork, ppid: 1, startToken: "t", ...(file ? { file } : {}) };
      expect(readClaudeForkHostParent(SELF, "linux", 100, () => host, null, uid), JSON.stringify(file)).toEqual(expected);
    }
    // Nested: a claude -p run inside a forked session's Bash is the nearest host; the outer fork's argv is never used.
    walk = chain(view("/usr/bin/dash", ["sh"], 101), view(NATIVE, ["claude", "-p", "x"], 102), view("/usr/bin/bash", ["bash"], 103), view(NATIVE, fork, 104));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ reason: "FORK_HOST_ARGV_NOT_FORK" });
    expect(walk.read).toEqual([100, 101]);
    // A node + cli.js installation, another program, an unreadable or a replaced process: no parent, distinct reasons.
    walk = chain(view("/usr/bin/dash", ["sh"], 101), view("/usr/bin/node", ["node", "/opt/claude/cli.js", ...fork.slice(1)], 102));
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    // Same basename elsewhere, a relative or replaced (deleted) binary, a versioned file outside the installer's layout
    // or not a version, and shared temporary directories.
    for (const exe of ["/opt/x/bin/claude.exe", "node_modules/@anthropic-ai/claude-code/bin/claude.exe", NATIVE + " (deleted)",
      STANDALONE + " (deleted)", "/home/u/.local/share/claude/versions/latest", "/home/u/claude/versions/2.1.316",
      "/tmp/u/.local/share/claude/versions/2.1.316", "/tmp/x/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      "/var/tmp/x/node_modules/@anthropic-ai/claude-code/bin/claude.exe", "/dev/shm/node_modules/@anthropic-ai/claude-code/bin/claude.exe",
      "/home/u/Temp/node_modules/@anthropic-ai/claude-code/bin/claude.exe"]) {
      walk = chain(view(exe, fork, 101));
      expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader), exe).toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    }
    walk = chain(view("/usr/bin/dash", ["sh"], 101), "unreadable");
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ reason: "FORK_HOST_PROCESS_UNREADABLE" });
    walk = chain("changed");
    expect(readClaudeForkHostParent(SELF, "linux", 100, walk.reader)).toEqual({ reason: "FORK_HOST_PROCESS_CHANGED" });
    // macOS and other platforms are never queried.
    for (const platform of ["darwin", "freebsd"] as const) {
      walk = chain(view(NATIVE, fork, 101));
      expect(readClaudeForkHostParent(SELF, platform, 100, walk.reader)).toEqual({ reason: "FORK_HOST_PLATFORM_UNSUPPORTED" });
      expect(walk.read).toEqual([]);
    }
  });

  it("H-A4: the bundled hook passes its own Claude launcher once, and only that exact launcher (c613 k2argv1-r01)", () => {
    const chain = (...views: HostProcessView[]) => (pid: number) => views[pid - 100] ?? "unreadable";
    const view = (exe: string, argv: string[], next: number): HostProcessView => ({ exe, argv, ppid: next, startToken: "t" + next, file: SAFE });
    const fork = ["claude", "--resume", A, "--fork-session"];
    const node = "/usr/bin/node";
    // ownHookLauncher sees process.argv[1] in the native form of the host that runs the test.
    const root = resolve("/home/u/.claude/plugins/cache/ags/agent-governance-suite/3.0.0");
    const native = ownHookLauncher(join(root, "mcp-server", "dist", "continuity-hook.mjs"), node)!;
    expect(native).toEqual({ exe: node, script: join(root, "hooks", "continuity-hook.mjs") });
    expect(ownHookLauncher(join(root, "node_modules", "vitest", "vitest.mjs"), node)).toBeNull();
    expect(ownHookLauncher(undefined, node)).toBeNull();
    // The linux reads below hold linux argv, compared as linux paths; on a linux host that is exactly the launcher above
    // (a Windows runner would otherwise feed its own paths into a linux read, CI 75f9cc99 Windows shard 2).
    const linuxRoot = "/home/u/.claude/plugins/cache/ags/agent-governance-suite/3.0.0";
    const launcher = { exe: node, script: posix.join(linuxRoot, "hooks", "continuity-hook.mjs") };
    if (process.platform !== "win32") expect(native).toEqual(launcher);
    // Real-host shape: dist hook -> launcher node -> sh -> claude.exe, or the launcher directly under claude.exe.
    expect(readClaudeForkHostParent(SELF, "linux", 100, chain(view(node, [node, launcher.script], 101), view("/usr/bin/dash", ["sh", "-c", "node x"], 102),
      view(NATIVE, fork, 103)), launcher)).toEqual({ parentSessionId: A });
    expect(readClaudeForkHostParent(SELF, "linux", 100, chain(view(node, [node, `${linuxRoot}/hooks//continuity-hook.mjs`], 101), view(NATIVE, fork, 102)), launcher))
      .toEqual({ parentSessionId: A });
    // Without the launcher skip this is the reason every real-host fork recorded.
    expect(readClaudeForkHostParent(SELF, "linux", 100, chain(view(node, [node, launcher.script], 101), view(NATIVE, fork, 102)), null))
      .toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    // Another script, another node, a second launcher-like node, or the launcher above a shell: not skipped.
    for (const views of [
      [view(node, [node, posix.join(linuxRoot, "hooks", "governance-hook.mjs")], 101), view(NATIVE, fork, 102)],
      [view("/opt/node", ["/opt/node", launcher.script], 101), view(NATIVE, fork, 102)],
      [view(node, [node, launcher.script], 101), view(node, [node, launcher.script], 102), view(NATIVE, fork, 103)],
      [view("/usr/bin/dash", ["sh"], 101), view(node, [node, launcher.script], 102), view(NATIVE, fork, 103)],
    ]) expect(readClaudeForkHostParent(SELF, "linux", 100, chain(...views), launcher)).toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
  });

  it("H-A3: the adapter offers the host-process read only with a host SessionStart source=fork (auditor 5970 Q1)", () => {
    const at = (payload: Record<string, unknown>) => adaptHostInput({ session_id: SELF, ...payload }, "claude-code").readForkHostParent;
    withPlatform("linux", () => {
      expect(at({ hook_event_name: "SessionStart", source: "fork" })).toEqual(expect.any(Function));
      for (const source of ["startup", "resume", "clear", "compact"]) expect(at({ hook_event_name: "SessionStart", source }), source).toBeUndefined();
      expect(at({ hook_event_name: "UserPromptSubmit", prompt: "x" })).toBeUndefined();
      expect(at({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_1" })).toBeUndefined();
    });
    // Windows reads at the tool boundary before a tool runs instead of at the start (auditor 5970 W-2).
    const boundary = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {}, tool_use_id: "toolu_1" };
    expect(withPlatform("win32", () => at(boundary))).toEqual(expect.any(Function));
    expect(withPlatform("win32", () => at({ ...boundary, hook_event_name: "PostToolUse", tool_response: {} }))).toBeUndefined();
    expect(withPlatform("win32", () => at({ hook_event_name: "UserPromptSubmit", prompt: "x" }))).toBeUndefined();
    expect(withPlatform("win32", () => at({ hook_event_name: "SessionStart", source: "fork" })!())).toEqual({ deferred: true });
    expect(adaptHostInput({ session_id: SELF, hook_event_name: "SessionStart", source: "fork" }, "codex").readForkHostParent).toBeUndefined();
  });

  it("H-P1: a fork whose host process names its parent inspects and loads that parent's exact checkpoint", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await hostFork(service, "fork-f", uuids, "parent-a");
    expect(hostParentEvent(service, "fork-f")).toBe("fork-host-parent:" + JSON.stringify({ c: snapshot.taskCorrelation, e: snapshot.epoch }));
    const candidate = inspect(service, "fork-f", childFile);
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: CANDIDATE });
    expect(candidate.summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision, snapshotDigest: snapshot.snapshotDigest });
    expect(load(service, "fork-f", candidate).data).toEqual(snapshot);
  });

  it("H-N1z: a parent that wrote its fork's own entries into its file keeps its later fork (repair of N1z)", async () => {
    const service = createService();
    const { snapshot, uuids, file } = await parent(service, "parent-a");
    const own = randomUUID();
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", own, OWN]]);
    expect(start(service, "fork-f", "fork", childFile)).toEqual({});
    prompt(service, "fork-f", childFile);
    expect(load(service, "fork-f", inspect(service, "fork-f", childFile)).error).toBeNull();
    const childSnapshot = checkpoint(service, "fork-f", childFile, { requestId: "f-own", expectedRevision: snapshot.revision });
    await appendFile(file, line("parent-a", own) + "\n", "utf8");
    const parentAgain = checkpoint(service, "parent-a", file, { requestId: "a-copied-f", expectedRevision: snapshot.revision });
    const laterFile = await hostFork(service, "fork-g", [...uuids, own], "parent-a");
    const summary = inspect(service, "fork-g", laterFile).summary;
    expect(summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: parentAgain.revision });
    expect(summary?.taskCorrelation).not.toBe(childSnapshot.taskCorrelation);
  });

  it("H-D1: a grandchild named by its host process takes the fork it was forked from", async () => {
    const service = createService();
    const { uuids: aUuids } = await parent(service, "parent-a");
    const bRows: Array<[string, string, string?]> = [...aUuids.map(uuid => ["fork-b", uuid] as [string, string]), ["fork-b", randomUUID(), OWN]];
    const bFile = await transcript(bRows);
    service.startFork("fork-b", undefined, () => ({ parentSessionId: "parent-a" }));
    const bSnapshot = checkpoint(service, "fork-b", bFile, { requestId: "b-1" });
    const grandchild = await hostFork(service, "fork-g", bRows.map(([, uuid]) => uuid), "fork-b");
    expect(inspect(service, "fork-g", grandchild).summary).toMatchObject({ taskCorrelation: bSnapshot.taskCorrelation, revision: bSnapshot.revision });
  });

  it("H-N4: a named parent without a pre-fork save gives no candidate, even when the child's file holds another session's entries", async () => {
    // Auditor 5970 F3: a named parent with no task at the fork (e = null) and one with a task but no save both give the
    // host-named reason, distinct from lineage's own FORK_PARENT_NOT_FOUND.
    const service = createService();
    const { uuids } = await parent(service, "parent-a");
    const childFile = await hostFork(service, "fork-f", uuids, "never-saved-x");
    expect(hostParentEvent(service, "fork-f")).toContain('"e":null');
    expect(inspect(service, "fork-f", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_HOST_PARENT_NOT_FOUND"]);
    start(service, "unsaved-y", "startup");
    const secondFile = await hostFork(service, "fork-g", uuids, "unsaved-y");
    expect(hostParentEvent(service, "fork-g")).not.toContain('"e":null');
    expect(inspect(service, "fork-g", secondFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_HOST_PARENT_NOT_FOUND"]);
  });

  it("H-F1: a named parent's save after the fork is never the fork's state", async () => {
    const service = createService();
    const { snapshot, uuids, file } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    service.startFork("fork-f", undefined, () => ({ parentSessionId: "parent-a" }));
    await appendFile(file, [randomUUID(), randomUUID()].map(uuid => line("parent-a", uuid)).join("\n") + "\n", "utf8");
    checkpoint(service, "parent-a", file, { requestId: "after-fork", expectedRevision: snapshot.revision });
    expect(inspect(service, "fork-f", childFile).reasonCodes).toEqual(["NO_RESTORE_CANDIDATE", "FORK_PARENT_ADVANCED"]);
  });

  it("H-U: a host-process reason is recorded as the diagnostic and lineage still decides; the record is never replaced", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    service.startFork("fork-f", undefined, () => ({ reason: "FORK_HOST_UNRECOGNIZED" }));
    service.startFork("fork-f", undefined, () => ({ parentSessionId: "never-saved-x" }));
    expect(hostParentEvent(service, "fork-f")).toBe("fork-host-parent:" + JSON.stringify({ u: "FORK_HOST_UNRECOGNIZED" }));
    prompt(service, "fork-f", childFile);
    expect(inspect(service, "fork-f", childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });
  it("H-R04: a named parent's latest pre-fork save is chosen even when it anchors entries another session wrote into its file", async () => {
    // Tester c613 k2argv1-r04 (rwown): fork F's own entries were written into P's file under P's id, P saved again, then
    // F2 forked P. F2 never copied F's entries, so P rev 2 matches 1 of its 16 anchors; ranking by matched count chose
    // rev 1 and inspect then rejected it as advanced.
    const service = createService();
    const rows = Array.from({ length: 16 }, () => ["parent-a", randomUUID()] as [string, string]);
    const parentFile = await transcript(rows);
    const first = checkpoint(service, "parent-a", parentFile);
    const fOwn = Array.from({ length: 16 }, () => randomUUID());
    await hostFork(service, "fork-f", rows.map(([, uuid]) => uuid), "parent-a");
    const pNew = randomUUID();
    await appendFile(parentFile, [...fOwn, pNew].map(uuid => line("parent-a", uuid)).join("\n") + "\n", "utf8");
    const second = checkpoint(service, "parent-a", parentFile, { requestId: "p-2", expectedRevision: first.revision });
    const laterFile = await hostFork(service, "fork-f2", [...rows.map(([, uuid]) => uuid), pNew], "parent-a");
    const candidate = inspect(service, "fork-f2", laterFile);
    expect(candidate).toMatchObject({ decision: "DEFER", reasonCodes: CANDIDATE });
    expect(candidate.summary).toMatchObject({ taskCorrelation: first.taskCorrelation, revision: second.revision, snapshotDigest: second.snapshotDigest });
    expect(load(service, "fork-f2", candidate).data).toEqual(second);
  });

  it("H-W1: Windows command lines split as CommandLineToArgvW does", () => {
    for (const [line, expected] of [
      [`"C:\\Users\\u\\.local\\bin\\claude.exe" --resume ${A} --fork-session`, ["C:\\Users\\u\\.local\\bin\\claude.exe", "--resume", A, "--fork-session"]],
      [`claude.exe --effort high --resume ${A}`, ["claude.exe", "--effort", "high", "--resume", A]],
      [`C:\\a\\b.exe  "x y"\t z`, ["C:\\a\\b.exe", "x y", "z"]],
      [`p "a\\"b" c\\\\"d e" f\\g`, ["p", "a\"b", "c\\d e", "f\\g"]],
      [`p "a""b" ""`, ["p", "a\"b", ""]],
      [`"C:\\Program Files\\nodejs\\node.exe" "C:\\p\\hooks\\continuity-hook.mjs"`, ["C:\\Program Files\\nodejs\\node.exe", "C:\\p\\hooks\\continuity-hook.mjs"]],
    ] as const) expect(windowsCommandLineArgv(line), line).toEqual(expected);
    expect(distinguishedNameValue('CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US', "O")).toBe("Anthropic, PBC");
    expect(distinguishedNameValue('CN="Anthropic, PBC", O="Anthropic, PBC", C=US', "CN")).toBe("Anthropic, PBC");
    expect(distinguishedNameValue('CN=x, O="Anthropic, PBC Labs", C=US', "O")).toBe("Anthropic, PBC Labs");
    expect(distinguishedNameValue("CN=x, OU=Anthropic, PBC, C=US", "O")).toBeNull();
    expect(distinguishedNameValue('O="Anthropic, PBC", O=Other', "O")).toBeNull();
  });

  it("H-W2: Windows walks one snapshot past its launcher and shells to a signed claude.exe; every failure is a distinct reason", () => {
    const CLAUDE = "C:\\Users\\u\\.local\\bin\\claude.exe";
    const NODE = "C:\\Program Files\\nodejs\\node.exe";
    const SCRIPT = "C:\\Users\\u\\.claude\\plugins\\cache\\ags\\agent-governance-suite\\3.0.0\\hooks\\continuity-hook.mjs";
    const SUBJECT = 'CN="Anthropic, PBC", O="Anthropic, PBC", L=San Francisco, S=California, C=US';
    const VALID = { status: "Valid", subject: SUBJECT };
    const forkLine = `"${CLAUDE}" --resume ${A} --fork-session`;
    // Snapshot rows from this hook (pid 10) up: dist hook, launcher node, shells, claude.exe; creation times descend.
    const rows = (...above: Array<Partial<WindowsProcessRow> & { exe: string; cmd: string }>): WindowsProcessRow[] => {
      const chain = [{ exe: NODE, cmd: `"${NODE}" dist-hook` }, ...above];
      return chain.map((row, index) => ({ pid: 10 + index, ppid: 11 + index, created: String(9000 - index), sig: null, ...row }));
    };
    const launcher = { exe: NODE, script: SCRIPT };
    const read = (snapshot: WindowsProcessRow[]) => readClaudeForkHostParent(SELF, "win32", 11, windowsHostReader(snapshot), launcher);
    const launcherRow = { exe: NODE, cmd: `"${NODE}" "${SCRIPT.replace("continuity-hook.mjs", "CONTINUITY-HOOK.mjs")}"` };
    expect(read(rows(launcherRow, { exe: CLAUDE, cmd: forkLine, sig: VALID }))).toEqual({ parentSessionId: A, signer: "Anthropic, PBC" });
    const bash = (exe: string) => ({ exe, cmd: `"${exe}" -c hook` });
    expect(read(rows(launcherRow, bash("C:\\Program Files\\Git\\bin\\bash.exe"), bash("C:\\Program Files\\Git\\usr\\bin\\bash.exe"),
      bash("C:\\Program Files\\Git\\usr\\bin\\bash.exe"), { exe: CLAUDE, cmd: forkLine, sig: VALID }))).toEqual({ parentSessionId: A, signer: "Anthropic, PBC" });
    expect(read(rows(launcherRow, bash("C:\\g\\bash.exe"), bash("C:\\g\\sh.exe"), bash("C:\\g\\bash.exe"), bash("C:\\Windows\\System32\\cmd.exe"),
      { exe: CLAUDE, cmd: forkLine, sig: VALID }))).toEqual({ reason: "FORK_HOST_SHELL_DEPTH_EXCEEDED" });
    for (const [sig, reason] of [
      [null, "FORK_HOST_SIGNATURE_MISSING"],
      [{ status: "NotSigned", subject: "" }, "FORK_HOST_SIGNATURE_MISSING"],
      [{ status: "HashMismatch", subject: SUBJECT }, "FORK_HOST_SIGNATURE_INVALID"],
      [{ status: "NotTrusted", subject: SUBJECT }, "FORK_HOST_SIGNATURE_UNTRUSTED"],
      [{ status: "UnknownError", subject: SUBJECT }, "FORK_HOST_SIGNATURE_UNTRUSTED"],
      [{ status: "Valid", subject: 'CN="Anthropic, PBC", O="Anthropic, PBC Labs", C=US' }, "FORK_HOST_SIGNER_UNRECOGNIZED"],
      [{ status: "Valid", subject: 'CN="Anthropic, PBC", C=US' }, "FORK_HOST_SIGNER_UNRECOGNIZED"],
    ] as const) expect(read(rows(launcherRow, { exe: CLAUDE, cmd: forkLine, sig })), reason).toEqual({ reason });
    // Auditor 5970 F1: a subject without exactly one CN records no signer, never the organization in its place.
    for (const subject of ['O="Anthropic, PBC", C=US', 'CN=a, CN=b, O="Anthropic, PBC"']) {
      expect(read(rows(launcherRow, { exe: CLAUDE, cmd: forkLine, sig: { status: "Valid", subject } })), subject).toEqual({ parentSessionId: A });
    }
    // Another program, a claude.exe in a temporary directory, an ancestor created after its child (reused pid), a chain
    // that ends before the host, and a launcher that is not this hook's: no parent.
    expect(read(rows(launcherRow, { exe: "C:\\x\\other.exe", cmd: forkLine, sig: VALID }))).toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    expect(read(rows(launcherRow, { exe: "C:\\Users\\u\\AppData\\Local\\Temp\\claude.exe", cmd: forkLine, sig: VALID }))).toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    const reused = rows(launcherRow, { exe: CLAUDE, cmd: forkLine, sig: VALID });
    reused[2]!.created = "9500";
    expect(read(reused)).toEqual({ reason: "FORK_HOST_PROCESS_CHANGED" });
    expect(read(rows(launcherRow))).toEqual({ reason: "FORK_HOST_PROCESS_UNREADABLE" });
    expect(read(rows({ exe: NODE, cmd: `"${NODE}" C:\\other\\hooks\\continuity-hook.mjs` }, { exe: CLAUDE, cmd: forkLine, sig: VALID })))
      .toEqual({ reason: "FORK_HOST_UNRECOGNIZED" });
    // A plain resume or a nested non-fork claude is the nearest host: no parent.
    expect(read(rows(launcherRow, { exe: CLAUDE, cmd: `"${CLAUDE}" --resume ${A}`, sig: VALID }))).toEqual({ reason: "FORK_HOST_ARGV_NOT_FORK" });
  });

  it("H-W3: the Windows snapshot is one hidden PowerShell start with a bounded wait; its failures are reasons", () => {
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runner = (result: { status: number | null; stdout: string; error?: Error }) => (file: string, args: readonly string[]) => {
      calls.push({ file, args });
      return result;
    };
    const good = JSON.stringify([{ pid: 10, ppid: 11, exe: "C:\\n\\node.exe", cmd: "node", created: "2", sig: null },
      { pid: 11, ppid: 1, exe: "C:\\c\\claude.exe", cmd: "claude", created: "1", sig: { status: "Valid", subject: "O=x" } }]);
    expect(windowsHostSnapshot(10, runner({ status: 0, stdout: good }))).toEqual(JSON.parse(good));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file.toLowerCase()).toMatch(/system32\\windowspowershell\\v1\.0\\powershell\.exe$/u);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
    expect(calls[0]!.args.at(-1)).toContain("$id=10;");
    expect(calls[0]!.args.at(-1)).toContain("Get-AuthenticodeSignature");
    expect(WINDOWS_QUERY_TIMEOUT_MS).toBeLessThan(9000);
    const timedOut = Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    expect(windowsHostSnapshot(10, runner({ status: null, stdout: "", error: timedOut }))).toEqual({ reason: "FORK_HOST_QUERY_TIMEOUT" });
    for (const result of [{ status: 1, stdout: good }, { status: 0, stdout: "not json" }, { status: 0, stdout: "[]" },
      { status: 0, stdout: JSON.stringify([{ pid: 12, ppid: 1, exe: "x", cmd: "x", created: "1" }]) },
      { status: 0, stdout: JSON.stringify([{ pid: 10, ppid: 1, exe: "x", cmd: "x", created: "2026-11-01" }]) },
      { status: null, stdout: "", error: new Error("spawn ENOENT") }]) {
      expect(windowsHostSnapshot(10, runner(result)), JSON.stringify(result)).toEqual({ reason: "FORK_HOST_PROCESS_UNREADABLE" });
    }
    // SessionStart on Windows starts no process (auditor 5970 W-2); the boundary read exists only on Windows.
    expect(claudeForkHostRead(SELF, "start", "win32")!()).toEqual({ deferred: true });
    expect(claudeForkHostRead(SELF, "boundary", "linux")).toBeUndefined();
    expect(claudeForkHostRead(SELF, "boundary", "darwin")).toBeUndefined();
    expect(claudeForkHostRead(SELF, "boundary", "win32")).toEqual(expect.any(Function));
    expect(claudeForkHostRead(SELF, "start", "darwin")!()).toEqual({ reason: "FORK_HOST_PLATFORM_UNSUPPORTED" });
  });

  it("H-W4: a deferred fork reads its host parent at the first tool boundary, never pins before it, and records it once", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    service.startFork("fork-f", undefined, () => ({ deferred: true }));
    expect(hostParentEvent(service, "fork-f")).toBeUndefined();
    // The first prompt would pin from lineage alone; with the read deferred it waits.
    prompt(service, "fork-f", childFile);
    const correlation = service.correlateSession("fork-f");
    const epoch = service.store.getTask(correlation)!.currentEpoch;
    expect(service.store.firstObservationEvent(correlation, epoch, "fork-parent:") ?? null).toBeNull();
    let reads = 0;
    const read = () => { reads += 1; return { parentSessionId: "parent-a", signer: "Anthropic, PBC" }; };
    service.readDeferredForkHostParent("fork-f", read);
    service.readDeferredForkHostParent("fork-f", read);
    expect(reads).toBe(1);
    expect(hostParentEvent(service, "fork-f")).toBe("fork-host-parent:" + JSON.stringify({ c: snapshot.taskCorrelation, e: snapshot.epoch, s: "Anthropic, PBC" }));
    const candidate = inspect(service, "fork-f", childFile);
    expect(candidate.summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
    expect(load(service, "fork-f", candidate).data).toEqual(snapshot);
    // A fork whose start read the host (Linux) or that was never deferred is never read again at a boundary.
    service.startFork("fork-l", undefined, () => ({ reason: "FORK_HOST_UNRECOGNIZED" }));
    service.readDeferredForkHostParent("fork-l", read);
    start(service, "plain-s", "startup");
    // Without an open deferral the boundary never reads a task, so a task's receiver state is not touched (CI d388 Windows).
    const getTask = vi.spyOn(service.store, "getTask");
    for (const session of ["fork-f", "fork-l", "plain-s", "unknown-s"]) service.readDeferredForkHostParent(session, read);
    expect(getTask).not.toHaveBeenCalled();
    getTask.mockRestore();
    expect(reads).toBe(1);
    expect(hostParentEvent(service, "fork-l")).toBe("fork-host-parent:" + JSON.stringify({ u: "FORK_HOST_UNRECOGNIZED" }));
  });

  it("H-W8: two first boundaries of one fork reading at once keep the first record; a later row never changes the parent", async () => {
    // Auditor 5970 F2: parallel tool calls run two continuity hooks; the second finishes its read while the first reads.
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    await parent(service, "other-b");
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    service.startFork("fork-f", undefined, () => ({ deferred: true }));
    service.readDeferredForkHostParent("fork-f", () => {
      service.readDeferredForkHostParent("fork-f", () => ({ parentSessionId: "parent-a" }));
      return { reason: "FORK_HOST_QUERY_TIMEOUT" };
    });
    const correlation = service.correlateSession("fork-f");
    const epoch = service.store.getTask(correlation)!.currentEpoch;
    const database = (service.store as unknown as { database: DatabaseSync }).database;
    const rows = () => database.prepare("SELECT event FROM continuity_observations WHERE task_correlation = ? AND epoch = ? AND event LIKE 'fork-host-parent:%' ORDER BY observation_id")
      .all(correlation, epoch) as Array<{ event: string }>;
    expect(rows()).toEqual([{ event: "fork-host-parent:" + JSON.stringify({ c: snapshot.taskCorrelation, e: snapshot.epoch }) }]);
    // Even a second row that slipped in between the re-check and the insert is never read.
    service.store.recordObservation(correlation, epoch, "fork-host-parent:" + JSON.stringify({ c: service.correlateSession("other-b"), e: 1 }), null, true, OWN);
    expect(rows()).toHaveLength(2);
    expect(inspect(service, "fork-f", childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  it("H-W5: a deferred fork reaching a final boundary without a read records why and lineage decides; a read reason is kept", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    service.startFork("fork-f", undefined, () => ({ deferred: true }));
    expect(inspect(service, "fork-f", childFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
    expect(hostParentEvent(service, "fork-f")).toBe("fork-host-parent:" + JSON.stringify({ u: "FORK_HOST_PARENT_NOT_READ" }));
    // After the pin a late read changes nothing.
    service.readDeferredForkHostParent("fork-f", () => ({ parentSessionId: "never-saved-x" }));
    expect(hostParentEvent(service, "fork-f")).toBe("fork-host-parent:" + JSON.stringify({ u: "FORK_HOST_PARENT_NOT_READ" }));
    const secondFile = await transcript([...uuids.map(uuid => ["fork-g", uuid] as [string, string]), ["fork-g", randomUUID(), OWN]]);
    service.startFork("fork-g", undefined, () => ({ deferred: true }));
    service.readDeferredForkHostParent("fork-g", () => ({ reason: "FORK_HOST_QUERY_TIMEOUT" }));
    expect(hostParentEvent(service, "fork-g")).toBe("fork-host-parent:" + JSON.stringify({ u: "FORK_HOST_QUERY_TIMEOUT" }));
    expect(inspect(service, "fork-g", secondFile).summary).toMatchObject({ taskCorrelation: snapshot.taskCorrelation, revision: snapshot.revision });
  });

  it("H-W7: through the Claude hook on Windows the fork start defers, the prompt waits and the first tool reads once", async () => {
    const service = createService();
    const { snapshot, uuids } = await parent(service);
    const childFile = await transcript([...uuids.map(uuid => ["fork-f", uuid] as [string, string]), ["fork-f", randomUUID(), OWN]]);
    hookPlatform = "win32";
    try {
      expect(start(service, "fork-f", "fork", childFile)).toEqual({});
      const correlation = service.correlateSession("fork-f");
      const epoch = service.store.getTask(correlation)!.currentEpoch;
      expect(service.store.hasObservation(correlation, epoch, "fork-host-deferred")).toBe(true);
      prompt(service, "fork-f", childFile);
      expect(hostParentEvent(service, "fork-f")).toBeUndefined();
      expect(service.store.firstObservationEvent(correlation, epoch, "fork-parent:") ?? null).toBeNull();
      // The real query: this test process is not under a Claude fork, so it records a reason and lineage decides.
      tool(service, "fork-f", childFile);
      expect(hostParentEvent(service, "fork-f")).toMatch(/^fork-host-parent:\{"u":"FORK_HOST_[A-Z_]+"\}$/u);
      expect(service.store.firstObservationEvent(correlation, epoch, "fork-parent:")).toContain(snapshot.taskCorrelation);
    } finally {
      hookPlatform = "linux";
    }
  });

  it.runIf(process.platform === "win32")("H-W6: on Windows the real snapshot reads this process and its own ancestors", () => {
    const snapshot = windowsHostSnapshot();
    if ("reason" in snapshot) throw new Error(snapshot.reason);
    expect(snapshot[0]!.pid).toBe(process.pid);
    expect(snapshot[0]!.exe.toLowerCase()).toBe(process.execPath.toLowerCase());
    expect(snapshot[1]?.pid).toBe(process.ppid);
    const reader = windowsHostReader(snapshot);
    expect(reader(process.pid)).toMatchObject({ ppid: process.ppid });
  });
});
