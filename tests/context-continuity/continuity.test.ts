import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CheckpointContextRequestV1,
  ConvergenceRootV1,
  TaskEnvelopeV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook as handleNativeContinuityHook, runContinuityHook as runNativeContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { SessionActorProofs, withoutSessionProof } from "../../mcp-server/src/session-actor-proof.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter, withHookHostAdapter, type AdaptedHostInput, type ContinuityAction, type HookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { ContinuityService, UnavailableContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { createInactiveSharedStores } from "../../mcp-server/src/inactive-shared-stores.js";

// Owned fake core observation only; this adapter is not native role evidence.
const syntheticHost = "synthetic-continuity-lifecycle";
registerHookHostAdapter(syntheticHost, {
  processPid: () => undefined,
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_CONTINUITY_ROOT" } } };
  },
});

const handleContinuityHook = (payload: Record<string, unknown>, service: ContinuityService) => handleNativeContinuityHook(payload, service, syntheticHost);


const sharedOwners = new Set<ReturnType<typeof createInactiveSharedStores>["owner"]>();
const temporaryDirectories: string[] = [];
const stores = new Set<SqliteContinuityStore>();

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  for (const owner of sharedOwners) owner.close();
  sharedOwners.clear();
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

function nonCanonicalSignatureAlias(token: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const [body, signature] = token.split(".") as [string, string];
  const lastIndex = alphabet.indexOf(signature.at(-1)!);
  if (lastIndex < 0 || lastIndex % 4 !== 0 || lastIndex >= alphabet.length - 1) throw new Error("Unexpected canonical SHA-256 signature encoding.");
  return `${body}.${signature.slice(0, -1)}${alphabet[lastIndex + 1]}`;
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

    const tamperedToken = nonCanonicalSignatureAlias(candidate.restoreToken!);
    expect(Buffer.from(tamperedToken.split(".")[1]!, "base64url")).toEqual(Buffer.from(candidate.restoreToken!.split(".")[1]!, "base64url"));
    const tampered = { ...loadInput, candidateToken: tamperedToken };
    expect(service.loadContext(bound(service, "raw-session", "load_context", tampered)).error?.code).toBe("BINDING_INVALID");
    expect(service.loadContext(bound(service, "other-session", "load_context", loadInput)).error?.code).toBe("BINDING_INVALID");
  });

  it.each(["SessionStart", "PreCompact", "PostCompact", "PreToolUse"])("unsupported native Gemini %s cannot mutate lifecycle state or receive context", (event) => {
    const service = createService();
    const output = handleNativeContinuityHook({ hook_event_name: event, session_id: "native-unobserved", source: "resume",
      agent_id: "", turn_id: "native-turn", tool_name: "mcp__agent-governance-suite__inspect_context", tool_input: {} }, service, "gemini");
    expect(output).toEqual({});
    expect(service.store.getTask(service.correlateSession("native-unobserved"))).toBeNull();
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

  it("keeps revisions monotonic and makes an old purge stale across identical snapshot cycles", () => {
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

    const secondCheckpoint = checkpointInput({ requestId: "checkpoint-second", expectedRevision: firstSnapshot.revision });
    const secondSnapshot = service.checkpointContext(bound(service, "repeated-purge-session", "checkpoint_context", secondCheckpoint)).data!;
    expect(secondSnapshot.revision).toBe(firstSnapshot.revision + 1);
    expect(secondSnapshot.snapshotDigest).not.toBe(firstSnapshot.snapshotDigest);
    const secondPurgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-second",
      expectedEpoch: 1,
      expectedRevision: secondSnapshot.revision,
    };
    const secondPurge = service.purgeDirectContext(bound(service, "repeated-purge-session", "purge_direct_context", secondPurgeInput));
    expect(secondPurge.data?.purged).toBe(true);
    expect(secondPurge.data?.purgedAt).toBe(firstPurge.data?.purgedAt);
    expect(secondPurge.data?.tombstoneDigest).not.toBe(firstPurge.data?.tombstoneDigest);

    const replayedFirst = service.purgeDirectContext(bound(service, "repeated-purge-session", "purge_direct_context", firstPurgeInput));
    expect(replayedFirst.error?.code).toBe("STALE_REVISION");
    expect(replayedFirst.data).toBeNull();
  });

  it("does not replay a purge requestId across snapshot generations", () => {
    const service = createService();
    const session = "purge-request-generation-session";
    const firstSnapshot = directCheckpoint(service, session).data!;
    const purgeInput = {
      schemaVersion: "1.0.0" as const,
      requestId: "purge-generation-bound",
      expectedEpoch: 1,
      expectedRevision: firstSnapshot.revision,
    };
    expect(service.purgeDirectContext(bound(service, session, "purge_direct_context", purgeInput)).data?.purged).toBe(true);

    const secondCheckpoint = checkpointInput({ requestId: "checkpoint-next-generation", expectedRevision: firstSnapshot.revision });
    const secondSnapshot = service.checkpointContext(bound(service, session, "checkpoint_context", secondCheckpoint)).data!;
    const staleReplay = service.purgeDirectContext(bound(service, session, "purge_direct_context", purgeInput));
    expect(staleReplay.error).toMatchObject({ code: "STALE_REVISION", details: { actualRevision: secondSnapshot.revision } });
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toEqual(secondSnapshot);

    const reusedForCurrent = { ...purgeInput, expectedRevision: secondSnapshot.revision };
    expect(service.purgeDirectContext(bound(service, session, "purge_direct_context", reusedForCurrent)).error?.code).toBe("REQUEST_CONFLICT");
    expect(service.store.getSnapshot(service.correlateSession(session), 1)).toEqual(secondSnapshot);
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

    const secondCheckpoint = checkpointInput({ requestId: "checkpoint-after-malformed-purge", expectedRevision: firstSnapshot.revision });
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
  }, 15_000);
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
    expect(input).toMatchObject({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { _continuityBinding: expect.any(String) } } });
    expect(input.hookSpecificOutput).not.toHaveProperty("permissionDecision");
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


// Explicit step barriers exercise distinct SQLite connections; no timer ordering assumptions.
async function twoContinuityConnections() {
  const directory = await mkdtemp(join(tmpdir(), "continuity-current-race-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "continuity.sqlite3");
  return { databasePath, first: createService(databasePath), second: createService(databasePath) };
}
function directLoadInput(service: ContinuityService, session: string) {
  const candidate = service.candidateForSession(session);
  expect(candidate.decision).toBe("DEFER");
  return { schemaVersion: "1.0.0" as const, candidateToken: candidate.restoreToken!,
    epoch: candidate.summary!.epoch, revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
}
function clearAfterMetadataRead(first: ContinuityService, second: ContinuityService, session: string) {
  const original = first.store.getTask.bind(first.store);
  vi.spyOn(first.store, "getTask").mockImplementationOnce((correlation) => {
    const stale = original(correlation);
    second.clearSession(session);
    return stale;
  });
}

describe("current continuity authority versus historical payload", () => {
  for (const operation of ["checkpoint", "replay", "load", "purge"] as const) {
    it(operation + ": clear committed after metadata read rejects stale authority without body or mutation", async () => {
      const { first, second } = await twoContinuityConnections();
      const session = "preflight-" + operation;
      const snapshot = directCheckpoint(first, session).data!;
      const loadInput = directLoadInput(first, session);
      const checkpoint = operation === "replay" ? checkpointInput() : checkpointInput({ requestId: "after-read", expectedRevision: 1 });
      const checkpointRequest = bound(first, session, "checkpoint_context", checkpoint);
      const loadRequest = bound(first, session, "load_context", loadInput);
      const purgeRequest = bound(first, session, "purge_direct_context", {
        schemaVersion: "1.0.0" as const, requestId: "purge-after-read", expectedEpoch: 1, expectedRevision: 1,
      });
      clearAfterMetadataRead(first, second, session);
      const result = operation === "load" ? first.loadContext(loadRequest)
        : operation === "purge" ? first.purgeDirectContext(purgeRequest) : first.checkpointContext(checkpointRequest);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("BINDING_INVALID");
      expect(result.data).toBeNull();
      expect(JSON.stringify(result)).not.toContain(snapshot.core.objective);
      const correlation = first.correlateSession(session);
      expect(second.store.getTask(correlation)?.currentEpoch).toBe(2);
      expect(second.store.getSnapshot(correlation, 1)).toEqual(snapshot);
      expect(second.store.getSnapshot(correlation, 2)).toBeNull();
      expect(second.store.getRequest(correlation, 1, first.hashOpaque("request", "after-read"))).toBeNull();
      expect(second.store.getRequest(correlation, 1, first.hashOpaque("request", "purge-after-read"))).toBeNull();
      expect(second.store.getTask(correlation)?.pendingSource).toBeNull();
    });
  }

  it("inspect rechecks its binding epoch after stale metadata without publishing an old candidate", async () => {
    const { first, second } = await twoContinuityConnections();
    directCheckpoint(first, "inspect-race");
    const request = bound(first, "inspect-race", "inspect_context", { schemaVersion: "1.0.0" as const });
    clearAfterMetadataRead(first, second, "inspect-race");
    const result = first.inspectContext(request);
    expect(result.data?.decision).toBe("REJECT");
    expect(result.data?.restoreToken).toBeNull();
    expect(result.data?.summary).toBeNull();
  });

  for (const change of ["clear", "root"] as const) {
    for (const replay of [false, true]) {
      it(change + " before checkpoint transaction rejects " + (replay ? "replay" : "write"), async () => {
        const { first, second } = await twoContinuityConnections();
        const session = "transaction-" + change + replay;
        const snapshot = directCheckpoint(first, session).data!;
        const correlation = first.correlateSession(session);
        const input = replay ? checkpointInput() : checkpointInput({ requestId: "new-receipt", expectedRevision: 1 });
        const request = bound(first, session, "checkpoint_context", input);
        const original = first.store.checkpoint.bind(first.store);
        vi.spyOn(first.store, "checkpoint").mockImplementationOnce((...args) => {
          if (change === "clear") second.clearSession(session);
          else expect(second.store.bindRoot(correlation, 1, "root-after-read", "2026-09-13T01:00:00.000Z")).toBe(true);
          return original(...args);
        });
        const result = first.checkpointContext(request);
        expect(result.error?.code).toBe(change === "clear" ? "BINDING_INVALID" : "SNAPSHOT_CONFLICT");
        expect(result.data).toBeNull();
        expect(second.store.getSnapshot(correlation, 1)).toEqual(snapshot);
        expect(second.store.getRequest(correlation, 1, first.hashOpaque("request", "new-receipt"))).toBeNull();
      });
    }
  }

  it("clear after idempotent receipt lookup cannot return the historical payload", async () => {
    const { first, second } = await twoContinuityConnections();
    const snapshot = directCheckpoint(first, "replay-body").data!;
    const request = bound(first, "replay-body", "checkpoint_context", checkpointInput());
    const original = first.store.checkpoint.bind(first.store);
    vi.spyOn(first.store, "checkpoint").mockImplementationOnce((...args) => {
      const replay = original(...args);
      expect(replay.kind).toBe("replay");
      second.clearSession("replay-body");
      return replay;
    });
    const result = first.checkpointContext(request);
    expect(result.error?.code).toBe("BINDING_INVALID");
    expect(result.data).toBeNull();
    expect(second.store.getSnapshot(first.correlateSession("replay-body"), 1)).toEqual(snapshot);
  });

  it("root-bound missing projection never falls back to a direct body and explicit purge remains available", async () => {
    const { first, second } = await twoContinuityConnections();
    const session = "missing-root";
    const snapshot = directCheckpoint(first, session).data!;
    const load = bound(first, session, "load_context", directLoadInput(first, session));
    const correlation = first.correlateSession(session);
    expect(second.store.bindRoot(correlation, 1, "root-without-projection", "2026-09-13T01:00:00.000Z")).toBe(true);
    expect(first.loadContext(load).error?.code).toBe("SNAPSHOT_CONFLICT");
    expect(first.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
    first.markPreCompact(session);
    expect(first.compactContext(session)).toBeNull();
    expect(first.store.getTask(correlation)?.pendingSource).toBeNull();
    expect(first.store.getSnapshot(correlation, 1)).toEqual(snapshot);
    const purge = { schemaVersion: "1.0.0" as const, requestId: "root-purge", expectedEpoch: 1, expectedRevision: 1 };
    expect(first.purgeDirectContext(bound(first, session, "purge_direct_context", purge)).data?.purged).toBe(true);
    expect(first.store.getTask(correlation)?.rootId).toBe("root-without-projection");
  });

  it("purge transaction rejects a stale current binding but a newly bound request can purge the old epoch", async () => {
    const { first, second } = await twoContinuityConnections();
    directCheckpoint(first, "purge-authority");
    const correlation = first.correlateSession("purge-authority");
    const input = { schemaVersion: "1.0.0" as const, requestId: "purge-guard", expectedEpoch: 1, expectedRevision: 1 };
    const request = bound(first, "purge-authority", "purge_direct_context", input);
    const original = first.store.purge.bind(first.store);
    vi.spyOn(first.store, "purge").mockImplementationOnce((...args) => {
      second.clearSession("purge-authority");
      return original(...args);
    });
    expect(first.purgeDirectContext(request).error?.code).toBe("BINDING_INVALID");
    expect(first.store.getSnapshot(correlation, 1)).not.toBeNull();
    expect(first.purgeDirectContext(bound(first, "purge-authority", "purge_direct_context", input)).data?.purged).toBe(true);
    expect(first.store.getSnapshot(correlation, 1)).toBeNull();
    expect(first.store.getTask(correlation)?.currentEpoch).toBe(2);
  });

  it("pending markers reject wrong root, direct source after binding, suppression, and stale epoch", () => {
    const service = createService();
    const task = service.ensureSession("marker-guards");
    const c = task.taskCorrelation;
    const now = "2026-09-13T01:00:00.000Z";
    const digest = convergenceDigest("marker");
    expect(service.store.bindRoot(c, 1, "root-a", now)).toBe(true);
    expect(service.store.setPendingMarker(c, 1, "direct", 1, digest, null, now)).toBe(false);
    expect(service.store.setPendingMarker(c, 1, "workflow", 1, digest, "root-b", now)).toBe(false);
    expect(service.store.setPendingMarker(c, 1, "workflow", 1, digest, "root-a", now)).toBe(true);
    expect(service.store.bindRoot(c, 1, "root-b", now)).toBe(true);
    expect(service.store.consumeWorkflowMarker(c, 1, "root-a", 1, digest, now)).toBe(false);
    expect(service.store.setPendingMarker(c, 1, "workflow", 1, digest, "root-b", now)).toBe(true);
    expect(service.store.setSuppressed(c, 1, now)).toBe(true);
    expect(service.store.consumeWorkflowMarker(c, 1, "root-b", 1, digest, now)).toBe(false);
    expect(service.store.setPendingMarker(c, 1, "workflow", 1, digest, "root-b", now)).toBe(false);
    service.clearSession("marker-guards");
    expect(service.store.setPendingMarker(c, 1, "direct", 1, digest, null, now)).toBe(false);
    expect(service.store.getTask(c)?.pendingSource).toBeNull();
  });

  it("a different root committed before workflow marker consumption prevents injection", () => {
    const workflow = new InMemoryWorkflowStore();
    const root = workflowRoot();
    workflow.insertConvergenceRoot(root);
    const service = createService(":memory:", workflow);
    const c = service.ensureSession("consume-root").taskCorrelation;
    expect(service.store.bindRoot(c, 1, root.rootId, root.updatedAt)).toBe(true);
    service.markPreCompact("consume-root");
    expect(service.store.getTask(c)).toMatchObject({ pendingSource: "workflow", pendingRootId: root.rootId,
      pendingRevision: root.revision, pendingConsumed: false });
    expect(service.store.getTask(c)?.pendingDigest).toMatch(/^sha256:/u);
    const consume = service.store.consumeWorkflowMarker.bind(service.store);
    let switched = false;
    const consumeSpy = vi.spyOn(service.store, "consumeWorkflowMarker").mockImplementationOnce((...args) => {
      switched = service.store.bindRoot(c, 1, "different-root", root.updatedAt);
      return consume(...args);
    });
    expect(service.compactContext("consume-root")).toBeNull();
    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(switched).toBe(true);
    expect(service.store.getTask(c)).toMatchObject({ rootId: "different-root", pendingConsumed: false });
  });

  it("current read holds the SQLite writer barrier; the identical competing statement succeeds afterwards", async () => {
    const { first, databasePath } = await twoContinuityConnections();
    const snapshot = directCheckpoint(first, "writer-barrier").data!;
    const c = first.correlateSession("writer-barrier");
    const competing = new DatabaseSync(databasePath);
    try {
      competing.exec("PRAGMA busy_timeout = 0");
      const rotate = competing.prepare("UPDATE continuity_tasks SET current_epoch = current_epoch + 1 WHERE task_correlation = ?");
      const selected = first.store.readCurrentState(c, 1, "direct", () => {
        expect(() => rotate.run(c)).toThrow(/locked|busy/iu);
        return first.store.getSnapshot(c, 1);
      });
      expect(selected).toMatchObject({ kind: "available", value: snapshot });
      expect(rotate.run(c).changes).toBe(1);
      expect(first.store.readCurrentState(c, 1, "direct", () => { throw new Error("stale callback must not run"); })).toEqual({ kind: "epoch-mismatch" });
      expect(first.store.getSnapshot(c, 1)).toEqual(snapshot);
    } finally { competing.close(); }
  });

  it("shared workflow and continuity reads use the owner transaction without poisoning rollback", async () => {
    const directory = await mkdtemp(join(tmpdir(), "continuity-shared-"));
    temporaryDirectories.push(directory);
    const now = new Date("2026-09-13T01:00:00.000Z");
    const bundle = createInactiveSharedStores({ directory, mode: "fixture-only", clock: () => now.getTime(),
      syntheticKeys: { workflow: Buffer.alloc(32, 1).toString("base64url"), continuity: Buffer.alloc(32, 2).toString("base64url"), trust: Buffer.alloc(32, 3).toString("base64url") } });
    sharedOwners.add(bundle.owner);
    const service = new ContinuityService(bundle.continuity, new ContractValidator(), bundle.workflow, () => now);
    const root = workflowRoot();
    expect(bundle.workflow.insertConvergenceRoot(root)).toBeNull();
    const c = service.ensureSession("shared-workflow").taskCorrelation;
    expect(bundle.continuity.bindRoot(c, 1, root.rootId, now.toISOString())).toBe(true);
    expect(service.candidateForSession("shared-workflow").summary?.source).toBe("workflow");
    const candidate = service.candidateForSession("shared-workflow");
    const input = { schemaVersion: "1.0.0" as const, candidateToken: candidate.restoreToken!,
      epoch: candidate.summary!.epoch, revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
    expect(service.loadContext(bound(service, "shared-workflow", "load_context", input)).ok).toBe(true);
    service.markPreCompact("shared-workflow");
    expect(service.compactContext("shared-workflow")).toContain("decision=INJECT");
    const beforeRollback = bundle.continuity.getTask(c);
    let callbackReached = false;
    let nestedWriteSucceeded = false;
    expect(() => bundle.owner.transaction(() => {
      bundle.continuity.readCurrentState(c, 1, "workflow", () => {
        callbackReached = true;
        nestedWriteSucceeded = bundle.continuity.setPendingMarker(c, 1, "workflow", 99, convergenceDigest("rollback-only"), root.rootId, now.toISOString());
        throw new Error("fixed-current-read-fault");
      });
    })).toThrow();
    expect(callbackReached).toBe(true);
    expect(nestedWriteSucceeded).toBe(true);
    expect(bundle.continuity.getTask(c)).toEqual(beforeRollback);
    expect(service.candidateForSession("shared-workflow").summary?.source).toBe("workflow");
    expect(bundle.workflow.getConvergenceSnapshot(root.rootId)?.root).toEqual(root);
  });
});

// Owned synthetic lifecycle/identity fixtures; these are not native capture evidence.
function normalizedAdapter(observation: () => AdaptedHostInput): HookHostAdapter {
  return { processPid: () => undefined, attestationKind: "owned-continuity",
    deliveryProfile: () => ({ transport: "owned-continuity", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
    ownsTool: tool => tool.startsWith("owned__"), adaptInput: observation };
}

function normalizedLifecycle(host: string, sessionId: string, action: ContinuityAction): AdaptedHostInput {
  return { lifecycle: action.kind === "pre-compact" || action.kind === "post-compact" ? "none" : "start",
    outputEventName: "LifecycleNotice", continuityAction: action,
    observation: { host, sessionId, kind: "unknown", actor: { role: "root", basis: "observed", reasonCode: "OWNED_NORMALIZED_ROOT" } } };
}

async function normalizedEnvironment() {
  const directory = await mkdtemp(join(tmpdir(), "normalized-continuity-"));
  temporaryDirectories.push(directory);
  return { directory, env: { AGENT_GOVERNANCE_DB_PATH: join(directory, "workflow.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, "continuity.sqlite3") } };
}

function seedCompactMarker(service: ContinuityService, session: string) {
  const checkpoint = directCheckpoint(service, session);
  expect(checkpoint.error).toBeNull();
  service.markPreCompact(session);
  const state = service.store.getTask(service.correlateSession(session))!;
  expect(state).toMatchObject({ pendingSource: "direct", pendingRevision: checkpoint.data!.revision,
    pendingDigest: checkpoint.data!.snapshotDigest, pendingConsumed: false });
  expect(state.pendingRevision).not.toBeNull(); expect(state.pendingDigest).not.toBeNull();
  return state;
}

describe("normalized continuity semantics and one-call snapshots", () => {
  it("ignores raw clear/action decoys while issuing valid root and continuity proofs without changing the epoch or compact marker", async () => {
    const { env } = await normalizedEnvironment(), host = `owned-${randomUUID()}`, session = "normalized-inspect-session";
    const service = createService(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH, new InMemoryWorkflowStore(), () => new Date());
    const before = seedCompactMarker(service, session);
    let translations = 0;
    const adapter = normalizedAdapter(() => {
      expect(++translations).toBe(1);
      return { lifecycle: "none", outputEventName: "BeforeOperation", observation: { host, sessionId: session, callId: randomUUID(),
        kind: "tool-boundary", boundaryPhase: "before", toolName: "owned__inspect_context", toolInput: { schemaVersion: "1.0.0" },
        actor: { role: "root", basis: "observed", reasonCode: "OWNED_NORMALIZED_ROOT" } } };
    });
    const result = await runGovernanceHook(host, JSON.stringify({ hook_event_name: "SessionStart", source: "clear",
      continuityAction: { kind: "clear" }, turn_id: "raw-decoy-turn", error: null }), env,
    new Map([[host, { host, modelClassForModel: () => null }]]), {
      inputAdapter: adapter, attestation: { kind: "owned-continuity", strategy: { observe() { throw new Error("A continuity read must not request model attestation."); } } },
    });
    expect(result.ok).toBe(true);
    const output = JSON.parse(result.output);
    expect(output.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", updatedInput: {
      _sessionProof: expect.any(String), _continuityBinding: expect.any(String),
    } });
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    const args = output.hookSpecificOutput.updatedInput as Record<string, unknown>, workflow = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
    try { expect(new SessionActorProofs(workflow).verify("inspect_context", args)).toMatchObject({ host, sessionId: session, actor: { role: "root", basis: "observed" } }); }
    finally { workflow.close(); }
    const inspected = service.inspectContext(withoutSessionProof(args));
    expect(inspected.error).toBeNull(); expect(inspected.data?.summary?.snapshotDigest).toBe(before.pendingDigest);
    expect(translations).toBe(1);
    expect(service.store.getTask(service.correlateSession(session))).toEqual(before);
  });

  it("preserves startup, clear, resume, compact and pre/post state transitions without native event fields", async () => {
    const { env } = await normalizedEnvironment(), host = `owned-${randomUUID()}`, session = "normalized-lifecycle-session";
    const service = createService(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    const event = (action: ContinuityAction) => withHookHostAdapter(host, normalizedAdapter(() => normalizedLifecycle(host, session, action)),
      async () => handleNativeContinuityHook({}, service, host));
    const correlation = service.correlateSession(session);
    expect(service.store.getTask(correlation)).toBeNull();
    await event({ kind: "startup" }); expect(service.store.getTask(correlation)?.currentEpoch).toBe(1);
    const checkpoint = directCheckpoint(service, session); expect(checkpoint.error).toBeNull();
    const resumed = await event({ kind: "resume" });
    expect(resumed).toMatchObject({ hookSpecificOutput: { hookEventName: "LifecycleNotice", additionalContext: expect.stringContaining("decision=DEFER") } });
    await event({ kind: "pre-compact" });
    const marker = service.store.getTask(service.correlateSession(session))!;
    expect(marker).toMatchObject({ pendingSource: "direct", pendingRevision: checkpoint.data!.revision, pendingDigest: checkpoint.data!.snapshotDigest });
    const compacted = await event({ kind: "compact" });
    expect(compacted).toMatchObject({ hookSpecificOutput: { hookEventName: "LifecycleNotice", additionalContext: expect.stringContaining("decision=DEFER") } });
    await event({ kind: "post-compact", turnId: "normalized-turn", successful: false });
    const database = new DatabaseSync(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    try { expect(database.prepare("SELECT task_correlation, turn_hash, success FROM continuity_observations").get()).toMatchObject({
      task_correlation: service.correlateSession(session), turn_hash: service.hashOpaque("turn", "normalized-turn"), success: 0,
    }); } finally { database.close(); }
    await event({ kind: "clear" });
    expect(service.store.getTask(service.correlateSession(session))).toMatchObject({ currentEpoch: 2, pendingSource: null, pendingRevision: null, pendingDigest: null });
  });

  it("uses normalized actions for workflow projection and translates the direct run entry once", async () => {
    const { env } = await normalizedEnvironment(), host = `owned-${randomUUID()}`, session = "normalized-projection-session";
    const service = createService(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    const checkpoint = directCheckpoint(service, session); expect(checkpoint.error).toBeNull();
    const close = vi.spyOn(SqliteWorkflowStore.prototype, "close");
    for (const action of [{ kind: "pre-compact" }, { kind: "resume" }, { kind: "compact" }] satisfies ContinuityAction[]) {
      let translations = 0;
      const adapter = normalizedAdapter(() => { expect(++translations).toBe(1); return normalizedLifecycle(host, session, action); });
      const output = await withHookHostAdapter(host, adapter, async () => runNativeContinuityHook("{}", env, host, true));
      expect(translations).toBe(1);
      if (action.kind !== "pre-compact") expect(JSON.parse(output)).toMatchObject({ hookSpecificOutput: { hookEventName: "LifecycleNotice", additionalContext: expect.any(String) } });
    }
    expect(close).toHaveBeenCalledTimes(3);
    expect(service.store.getTask(service.correlateSession(session))).toMatchObject({ pendingSource: "direct", pendingRevision: checkpoint.data!.revision, pendingDigest: checkpoint.data!.snapshotDigest });
  });

  it("rejects contradictory lifecycle/tool semantics before any epoch or marker mutation", async () => {
    const service = createService(), host = `owned-${randomUUID()}`, session = "normalized-conflict-session";
    const before = seedCompactMarker(service, session);
    const base: AdaptedHostInput = { lifecycle: "none", outputEventName: "BeforeOperation", observation: {
      host, sessionId: session, kind: "tool-boundary", boundaryPhase: "before", toolName: "owned__inspect_context", toolInput: { schemaVersion: "1.0.0" },
      actor: { role: "root", basis: "observed", reasonCode: "OWNED_NORMALIZED_ROOT" } } };
    for (const adapted of [{ ...base, continuityAction: { kind: "clear" } }, { ...base, lifecycle: "start" },
      { ...base, lifecycle: "end", observation: { host, sessionId: session, kind: "unknown", actor: base.observation.actor }, continuityAction: { kind: "clear" } },
    ] satisfies AdaptedHostInput[]) {
      await expect(withHookHostAdapter(host, normalizedAdapter(() => adapted), async () => handleNativeContinuityHook({ hook_event_name: "SessionStart", source: "clear" }, service, host)))
        .rejects.toMatchObject({ code: "BINDING_INVALID", details: { reasonCode: "CONTINUITY_HOOK_OBSERVATION_CONFLICT" } });
      expect(service.store.getTask(service.correlateSession(session))).toEqual(before);
    }
    const { env } = await normalizedEnvironment();
    const bad = normalizedAdapter(() => ({ ...base, continuityAction: { kind: "clear" } }));
    await expect(withHookHostAdapter(host, bad, async () => runNativeContinuityHook("{}", env, host, true)))
      .rejects.toMatchObject({ details: { reasonCode: "CONTINUITY_HOOK_OBSERVATION_CONFLICT" } });
    expect(existsSync(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH)).toBe(false); expect(existsSync(env.AGENT_GOVERNANCE_DB_PATH)).toBe(false);
  });

  it("pins selected host identity before checking a getter-backed observation and issuing its actual root proof", async () => {
    const { env } = await normalizedEnvironment(), host = `owned-${randomUUID()}`, session = "snapshot-host-session";
    let outerReads = 0, hostReads = 0;
    const observation = { get host() { return ++hostReads === 1 ? host : "other-owned-host"; }, sessionId: session, callId: randomUUID(),
      kind: "tool-boundary" as const, boundaryPhase: "before" as const, toolName: "owned__get_trust_capabilities", toolInput: {},
      actor: { role: "root" as const, basis: "observed" as const, reasonCode: "OWNED_NORMALIZED_ROOT" } };
    const adapter = normalizedAdapter(() => ({ lifecycle: "none", outputEventName: "BeforeOperation", get observation() { outerReads++; return observation; } }));
    const result = await runGovernanceHook(host, "{}", env, new Map([[host, { host, modelClassForModel: () => null }]]), {
      inputAdapter: adapter, attestation: { kind: "owned-continuity", strategy: { observe: () => ({}) } },
    });
    expect(result.ok).toBe(true); expect(outerReads).toBe(1); expect(hostReads).toBe(1);
    const args = JSON.parse(result.output).hookSpecificOutput.updatedInput as Record<string, unknown>, workflow = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
    try { expect(new SessionActorProofs(workflow).verify("get_trust_capabilities", args)).toMatchObject({ host, sessionId: session, actor: { role: "root", basis: "observed" } }); }
    finally { workflow.close(); }
  });

  it("uses one lifecycle/action scalar snapshot for post-compact validation and storage", async () => {
    const { env } = await normalizedEnvironment(), host = `owned-${randomUUID()}`, session = "snapshot-post-session";
    const service = createService(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    let kindReads = 0, turnReads = 0, successReads = 0, lifecycleReads = 0;
    const action: ContinuityAction = { get kind(): "post-compact" { kindReads++; return "post-compact"; },
      get turnId() { return ++turnReads === 1 ? "normalized-first-turn" : "changed-turn"; }, get successful() { return ++successReads !== 1; } };
    const adapter = normalizedAdapter(() => ({ ...normalizedLifecycle(host, session, { kind: "post-compact", turnId: null, successful: true }),
      get lifecycle() { return ++lifecycleReads === 1 ? "none" : "start"; }, continuityAction: action }));
    await withHookHostAdapter(host, adapter, async () => handleNativeContinuityHook({ hook_event_name: "PostCompact", turn_id: "raw-decoy", error: null }, service, host));
    expect([kindReads, turnReads, successReads, lifecycleReads]).toEqual([1, 1, 1, 1]);
    const database = new DatabaseSync(env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    try { expect(database.prepare("SELECT turn_hash, success FROM continuity_observations").get()).toMatchObject({ turn_hash: service.hashOpaque("turn", "normalized-first-turn"), success: 0 }); }
    finally { database.close(); }
  });

  it("keeps builtin native lifecycle translation and the existing Claude compact actor denial separate", () => {
    for (const source of ["startup", "clear", "resume", "compact"] as const) {
      const mapped = adaptHostInput({ hook_event_name: "SessionStart", source, session_id: "builtin-session" }, "claude-code");
      expect(mapped.lifecycle).toBe("start"); expect(mapped.continuityAction).toEqual({ kind: source });
    }
    const pre = adaptHostInput({ hook_event_name: "PreCompact", session_id: "builtin-session" }, "claude-code");
    expect(pre.continuityAction).toEqual({ kind: "pre-compact" }); expect(pre.observation.actor.role).toBe("indeterminate");
    for (const [error, successful] of [[undefined, true], [null, true], [false, false], ["failed", false]] as const) {
      const post = adaptHostInput({ hook_event_name: "PostCompact", session_id: "builtin-session", turn_id: "builtin-turn", error }, "claude-code");
      expect(post.continuityAction).toEqual({ kind: "post-compact", turnId: "builtin-turn", successful }); expect(post.observation.actor.role).toBe("indeterminate");
    }
  });
});
