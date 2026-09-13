import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";

import type {
  CheckpointContextRequestV1,
  ConvergenceRootV1,
  TaskEnvelopeV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService, UnavailableContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const temporaryDirectories: string[] = [];
const stores = new Set<SqliteContinuityStore>();

afterEach(async () => {
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function createService(
  databasePath = ":memory:",
  workflow = new InMemoryWorkflowStore(),
  now = () => new Date("2026-09-13T01:00:00.000Z"),
): ContinuityService {
  const store = new SqliteContinuityStore(databasePath);
  stores.add(store);
  return new ContinuityService(store, new ContractValidator(), workflow, now);
}

function checkpointInput(overrides: Partial<CheckpointContextRequestV1> = {}): Omit<CheckpointContextRequestV1, "_continuityBinding"> {
  return {
    schemaVersion: "1.0.0",
    requestId: "checkpoint-1",
    expectedRevision: 0,
    status: "active",
    core: {
      objective: "Finish the continuity implementation.",
      completionCriteria: ["Tests pass."],
      constraints: ["Do not change workflow schema v3."],
      decisions: ["Use a separate continuity database."],
      progress: ["Storage implemented."],
      blockers: [],
      nextActions: ["Historical candidate: run tests."],
    },
    evidenceRefs: [{ artifactId: "test", locator: "tests/context-continuity", digest: convergenceDigest("tests"), verified: true }],
    ...overrides,
  };
}

function bound<T extends Record<string, unknown>>(service: ContinuityService, session: string, tool: string, input: T): T & { _continuityBinding: string } {
  return { ...input, _continuityBinding: service.issueToolBinding(session, tool, input) };
}

function directCheckpoint(service: ContinuityService, session = "raw-session") {
  const input = checkpointInput();
  return service.checkpointContext(bound(service, session, "checkpoint_context", input));
}

function taskEnvelope(): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "workflow-task",
    objective: "Finish an orchestrated task.",
    scope: { included: ["src"], excluded: ["deploy"] },
    acceptanceCriteria: ["Tests pass."],
    riskLevel: "low",
    workUnits: [{ id: "implementation", objective: "Implement.", dependencies: [], writeTargets: ["src"] }],
    requiredCapabilities: [],
    constraints: ["Keep scope fixed."],
    authorization: { allowedActions: ["edit"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function workflowRoot(): ConvergenceRootV1 {
  const task = taskEnvelope();
  const frame = {
    schemaVersion: "1.0.0" as const,
    workspace: { workspaceId: "workspace", locator: "D:/workspace" },
    controlArtifacts: [],
    targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 },
  };
  return {
    schemaVersion: "1.0.0",
    rootId: "root-1",
    parentRootId: null,
    revision: 1,
    state: "open",
    currentEpoch: 1,
    taskEnvelope: task,
    frame,
    taskDigest: convergenceDigest(task),
    frameDigest: convergenceDigest(frame),
    workspaceDigest: convergenceDigest(frame.workspace),
    controlDigest: convergenceDigest(frame.controlArtifacts),
    targetDigest: convergenceDigest(frame.targetArtifacts),
    operationalDigest: convergenceDigest(frame.operationalSettings),
    userApprovalRefs: [],
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

describe("direct task continuity", () => {
  it("stores replacement snapshots with CAS and request idempotency", () => {
    const service = createService();
    const first = directCheckpoint(service);
    expect(first.data?.revision).toBe(1);

    const replayInput = checkpointInput();
    const replay = service.checkpointContext(bound(service, "raw-session", "checkpoint_context", replayInput));
    expect(replay).toEqual(first);

    const conflictInput = checkpointInput({ core: { ...checkpointInput().core, objective: "Different content." } });
    expect(service.checkpointContext(bound(service, "raw-session", "checkpoint_context", conflictInput)).error?.code).toBe("REQUEST_CONFLICT");

    const staleInput = checkpointInput({ requestId: "checkpoint-2" });
    expect(service.checkpointContext(bound(service, "raw-session", "checkpoint_context", staleInput)).error).toMatchObject({
      code: "STALE_REVISION",
      details: { actualRevision: 1 },
    });

    const replacementInput = checkpointInput({
      requestId: "checkpoint-3",
      expectedRevision: 1,
      core: { ...checkpointInput().core, progress: ["Replacement contains only current progress."] },
    });
    const replacement = service.checkpointContext(bound(service, "raw-session", "checkpoint_context", replacementInput));
    expect(replacement.data).toMatchObject({ revision: 2, core: { progress: ["Replacement contains only current progress."] } });
  });

  it("returns body-free candidates and loads body only after exact revalidation", () => {
    const service = createService();
    const snapshot = directCheckpoint(service).data!;
    const inspectInput = { schemaVersion: "1.0.0" as const };
    const inspected = service.inspectContext(bound(service, "raw-session", "inspect_context", inspectInput));
    expect(JSON.stringify(inspected)).not.toContain(snapshot.core.objective);
    expect(inspected.data?.decision).toBe("DEFER");

    const candidate = inspected.data!;
    const loadInput = {
      schemaVersion: "1.0.0" as const,
      candidateToken: candidate.restoreToken!,
      epoch: candidate.summary!.epoch,
      revision: candidate.summary!.revision,
      digest: candidate.summary!.snapshotDigest,
    };
    expect(service.loadContext(bound(service, "raw-session", "load_context", loadInput)).data).toEqual(snapshot);

    const tampered = { ...loadInput, candidateToken: `${candidate.restoreToken!.slice(0, -1)}x` };
    expect(service.loadContext(bound(service, "raw-session", "load_context", tampered)).error?.code).toBe("BINDING_INVALID");
    expect(service.loadContext(bound(service, "other-session", "load_context", loadInput)).error?.code).toBe("BINDING_INVALID");
  });

  it("keeps direct compact and resume output candidate-only", () => {
    const service = createService();
    directCheckpoint(service);
    const resume = handleContinuityHook({ hook_event_name: "SessionStart", session_id: "raw-session", source: "resume" }, service);
    expect(JSON.stringify(resume)).toContain("decision=DEFER");
    expect(JSON.stringify(resume)).not.toContain("Finish the continuity implementation");

    handleContinuityHook({ hook_event_name: "PreCompact", session_id: "raw-session", trigger: "auto" }, service);
    const compact = handleContinuityHook({ hook_event_name: "SessionStart", session_id: "raw-session", source: "compact" }, service);
    expect(JSON.stringify(compact)).toContain("decision=DEFER");
    expect(JSON.stringify(compact)).not.toContain("Finish the continuity implementation");
  });

  it("separates suppression and clear while allowing old-epoch purge without retained payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-purge-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const service = createService(databasePath);
    const marker = "PLAINTEXT-SNAPSHOT-MUST-BE-DELETED";
    const checkpoint = checkpointInput({
      core: { ...checkpointInput().core, objective: marker },
    });
    const snapshot = service.checkpointContext(bound(service, "raw-session", "checkpoint_context", checkpoint)).data!;
    const beforePurge = new DatabaseSync(databasePath);
    const requestJson = beforePurge.prepare("SELECT result_json FROM continuity_requests").get() as { result_json: string };
    expect(requestJson.result_json).not.toContain(marker);
    beforePurge.prepare("UPDATE continuity_requests SET result_json = ?").run(JSON.stringify(snapshot));
    beforePurge.close();

    const suppress = { schemaVersion: "1.0.0" as const, expectedEpoch: 1 };
    expect(service.suppressContextRestore(bound(service, "raw-session", "suppress_context_restore", suppress)).data?.suppressed).toBe(true);
    expect(service.candidateForSession("raw-session").decision).toBe("REJECT");

    service.clearSession("raw-session");
    expect(service.candidateForSession("raw-session")).toMatchObject({ decision: "REJECT", reasonCodes: ["NO_RESTORE_CANDIDATE"] });

    const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-1", expectedEpoch: 1, expectedRevision: snapshot.revision };
    const purged = service.purgeDirectContext(bound(service, "raw-session", "purge_direct_context", purge));
    expect(purged.data).toMatchObject({ purged: true, epoch: 1, revision: snapshot.revision });
    expect(service.purgeDirectContext(bound(service, "raw-session", "purge_direct_context", purge))).toEqual(purged);

    const afterPurge = new DatabaseSync(databasePath);
    const snapshotCount = afterPurge.prepare("SELECT COUNT(*) AS count FROM continuity_snapshots").get() as { count: number };
    const storedRequests = afterPurge.prepare("SELECT result_json FROM continuity_requests").all() as Array<{ result_json: string }>;
    afterPurge.close();
    expect(snapshotCount.count).toBe(0);
    expect(JSON.stringify(storedRequests)).not.toContain(marker);
  });

  it("preserves each purge receipt across later checkpoint and purge cycles", () => {
    const service = createService();
    const firstSnapshot = directCheckpoint(service, "repeated-purge-session").data!;
    const firstPurgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-first",
      expectedEpoch: 1,
      expectedRevision: firstSnapshot.revision,
    };
    const firstPurge = service.purgeDirectContext(bound(service, "repeated-purge-session", "purge_direct_context", firstPurgeInput));
    expect(firstPurge.data?.purged).toBe(true);

    const secondCheckpoint = checkpointInput({
      requestId: "checkpoint-second",
      core: { ...checkpointInput().core, objective: "Second snapshot." },
    });
    const secondSnapshot = service.checkpointContext(bound(service, "repeated-purge-session", "checkpoint_context", secondCheckpoint)).data!;
    const secondPurgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-second",
      expectedEpoch: 1,
      expectedRevision: secondSnapshot.revision,
    };
    expect(service.purgeDirectContext(bound(service, "repeated-purge-session", "purge_direct_context", secondPurgeInput)).data?.purged).toBe(true);

    const replayedFirst = service.purgeDirectContext(bound(service, "repeated-purge-session", "purge_direct_context", firstPurgeInput));
    expect(replayedFirst.error?.code).toBe("STALE_REVISION");
    expect(replayedFirst.data).toBeNull();
  });

  it("rejects and later scrubs a malformed purge receipt with extra snapshot content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-purge-receipt-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const service = createService(databasePath);
    const session = "malformed-purge-session";
    const firstSnapshot = directCheckpoint(service, session).data!;
    const firstPurgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-malformed-first",
      expectedEpoch: 1,
      expectedRevision: firstSnapshot.revision,
    };
    const firstPurge = service.purgeDirectContext(bound(service, session, "purge_direct_context", firstPurgeInput)).data!;
    const marker = "MALFORMED-PURGE-BODY-MUST-NOT-SURVIVE";
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE continuity_requests SET result_json = ? WHERE result_json LIKE ?").run(JSON.stringify({
      ...firstPurge,
      tombstoneDigest: `sha256:${"f".repeat(64)}`,
      core: { objective: marker },
    }), "%\"purged\":true%");
    database.close();

    const rejected = service.purgeDirectContext(bound(service, session, "purge_direct_context", firstPurgeInput));
    expect(rejected.error?.code).toBe("STALE_REVISION");
    expect(JSON.stringify(rejected)).not.toContain(marker);

    const secondCheckpoint = checkpointInput({ requestId: "checkpoint-after-malformed-purge" });
    const secondSnapshot = service.checkpointContext(bound(service, session, "checkpoint_context", secondCheckpoint)).data!;
    const secondPurgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-after-malformed-purge",
      expectedEpoch: 1,
      expectedRevision: secondSnapshot.revision,
    };
    expect(service.purgeDirectContext(bound(service, session, "purge_direct_context", secondPurgeInput)).data?.purged).toBe(true);

    const after = new DatabaseSync(databasePath);
    const requests = after.prepare("SELECT result_json FROM continuity_requests").all();
    after.close();
    expect(JSON.stringify(requests)).not.toContain(marker);
  });

  it("purges a direct payload after workflow binding without deleting the workflow root", () => {
    const workflow = new InMemoryWorkflowStore();
    const root = workflowRoot();
    workflow.insertConvergenceRoot(root);
    const service = createService(":memory:", workflow);
    const snapshot = directCheckpoint(service, "mixed-session").data!;
    const openInput = { schemaVersion: "1.0.0", taskEnvelope: root.taskEnvelope, frame: root.frame, parentRootId: null, userApprovalRefs: [] };
    service.bindOpenedRoot(bound(service, "mixed-session", "open_convergence_root", openInput), root.rootId);

    const purge = { schemaVersion: "1.0.0" as const, requestId: "purge-mixed", expectedEpoch: 1, expectedRevision: snapshot.revision };
    expect(service.purgeDirectContext(bound(service, "mixed-session", "purge_direct_context", purge)).data?.purged).toBe(true);
    expect(service.store.getSnapshot(service.correlateSession("mixed-session"), 1)).toBeNull();
    expect(workflow.getConvergenceSnapshot(root.rootId)?.root).toEqual(root);
  });

  it("allows only one winner across two SQLite connections using the same CAS revision", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-cas-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const first = createService(databasePath);
    const second = createService(databasePath);
    const left = checkpointInput({ requestId: "left" });
    const right = checkpointInput({ requestId: "right", core: { ...checkpointInput().core, progress: ["Competing update."] } });
    const results = await Promise.all([
      Promise.resolve().then(() => first.checkpointContext(bound(first, "same-session", "checkpoint_context", left))),
      Promise.resolve().then(() => second.checkpointContext(bound(second, "same-session", "checkpoint_context", right))),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => result.error?.code === "STALE_REVISION")).toHaveLength(1);
  });

  it("rejects a payload whose stored JSON no longer matches its digest", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-integrity-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const service = createService(databasePath);
    directCheckpoint(service);
    const inspected = service.inspectContext(bound(service, "raw-session", "inspect_context", { schemaVersion: "1.0.0" })).data!;

    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT task_correlation, epoch, snapshot_json FROM continuity_snapshots").get() as {
      task_correlation: string; epoch: number; snapshot_json: string;
    };
    const changed = JSON.parse(row.snapshot_json) as { core: { objective: string } };
    changed.core.objective = "Tampered objective.";
    database.prepare("UPDATE continuity_snapshots SET snapshot_json = ? WHERE task_correlation = ? AND epoch = ?")
      .run(JSON.stringify(changed), row.task_correlation, row.epoch);
    database.close();

    const load = {
      schemaVersion: "1.0.0" as const,
      candidateToken: inspected.restoreToken!,
      epoch: inspected.summary!.epoch,
      revision: inspected.summary!.revision,
      digest: inspected.summary!.snapshotDigest,
    };
    expect(service.loadContext(bound(service, "raw-session", "load_context", load)).error?.code).toBe("INTEGRITY_FAILED");
  });
});

describe("workflow projection and fail-open lifecycle", () => {
  it("injects one bounded structural workflow card only when marker and projection match", () => {
    const workflow = new InMemoryWorkflowStore();
    const root = workflowRoot();
    expect(workflow.insertConvergenceRoot(root)).toBeNull();
    const service = createService(":memory:", workflow);
    const openInput = { schemaVersion: "1.0.0", taskEnvelope: root.taskEnvelope, frame: root.frame, parentRootId: null, userApprovalRefs: [] };
    service.bindOpenedRoot(bound(service, "workflow-session", "open_convergence_root", openInput), root.rootId);

    service.markPreCompact("workflow-session");
    const injected = service.compactContext("workflow-session");
    expect(injected).toContain("decision=INJECT");
    expect(injected).toContain(root.taskEnvelope.objective);
    expect(injected!.length).toBeLessThan(12_000);
    expect(service.compactContext("workflow-session")).toBeNull();
  });

  it("does not inject a workflow card after the projection changes behind its compact marker", () => {
    const workflow = new InMemoryWorkflowStore();
    const root = workflowRoot();
    workflow.insertConvergenceRoot(root);
    const service = createService(":memory:", workflow);
    const openInput = { schemaVersion: "1.0.0", taskEnvelope: root.taskEnvelope, frame: root.frame, parentRootId: null, userApprovalRefs: [] };
    service.bindOpenedRoot(bound(service, "workflow-session", "open_convergence_root", openInput), root.rootId);
    service.markPreCompact("workflow-session");
    const changed = { ...root, revision: 2, updatedAt: "2026-09-13T00:01:00.000Z" };
    expect(workflow.updateConvergenceRoot(changed, 1)).toBe(true);
    expect(service.compactContext("workflow-session")).toBeNull();
  });

  it("keeps workflow storage usable when continuity initialization is corrupt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-fail-open-"));
    temporaryDirectories.push(directory);
    const corrupt = join(directory, "continuity.sqlite3");
    await writeFile(corrupt, "not a sqlite database", "utf8");
    expect(() => new SqliteContinuityStore(corrupt)).toThrow();
    const workflow = new SqliteWorkflowStore(join(directory, "workflows.sqlite3"));
    expect(workflow.nextRunSequence()).toBe(1);
    workflow.close();
    expect(new UnavailableContinuityService().inspectContext().error?.code).toBe("CONTINUITY_UNAVAILABLE");
  });

  it("rejects a workflow database before creating any continuity tables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-schema-boundary-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "workflows.sqlite3");
    const workflow = new SqliteWorkflowStore(databasePath);
    workflow.close();
    const database = new DatabaseSync(databasePath);
    const before = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    database.close();

    expect(() => new SqliteContinuityStore(databasePath)).toThrow(/Cannot initialize the continuity database/u);

    const reopened = new DatabaseSync(databasePath);
    const after = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
    reopened.close();
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("continuity_");
  });

  it("rewrites only bound MCP tool inputs and persists only HMAC lifecycle correlations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-hmac-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "continuity.sqlite3");
    const service = createService(databasePath);
    const input = handleContinuityHook({
      hook_event_name: "PreToolUse",
      session_id: "raw-secret-session-id",
      turn_id: "raw-secret-turn-id",
      tool_name: "mcp__agent-governance-suite__inspect_context",
      tool_input: { schemaVersion: "1.0.0" },
    }, service);
    expect(input).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } });
    expect(JSON.stringify(input)).not.toContain("raw-secret-session-id");
    expect(handleContinuityHook({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {} }, service)).toEqual({});
    handleContinuityHook({
      hook_event_name: "PostCompact",
      session_id: "raw-secret-session-id",
      turn_id: "raw-secret-turn-id",
      trigger: "auto",
    }, service);
    const database = new DatabaseSync(databasePath);
    const stored = database.prepare("SELECT task_correlation, turn_hash FROM continuity_observations").get() as {
      task_correlation: string; turn_hash: string;
    };
    database.close();
    expect(stored.task_correlation).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(stored.turn_hash).toMatch(/^hmac-sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(stored)).not.toContain("raw-secret");
  });
});
