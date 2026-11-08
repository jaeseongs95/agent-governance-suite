import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { CheckpointContextRequestV1, ContinuityCandidateV1, ContinuitySnapshotV1, ConvergenceRootV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService, renderHookText } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { rootCaller } from "../helpers/caller.js";
import { fixtureLocator } from "../helpers/fixture-locator.js";

// d7585d74: the session's own record (checkpoint_context) stays writable and restorable while workflow roots are bound
// (behaviors 1-2), compaction restores it beside the bound workflow (3), it moves to the next epoch with a new
// opaque token when every bound workflow settles while explicit clear does not carry it (4), and the per-turn cue names
// checkpoint_context and skill re-selection instead of the context-continuity skill (5).
const now = "2026-11-04T00:00:00.000Z";
const session = "d0360-session-record";
const caller = rootCaller("codex", session);
const stores = new Set<SqliteContinuityStore>();
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
});

function service(workflow: WorkflowStore | null = new InMemoryWorkflowStore()) {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, new ContractValidator(), workflow, () => new Date(now));
}

function checkpoint(expectedStateToken: string, objective: string, requestId = `d0360-${expectedStateToken}`): CheckpointContextRequestV1 {
  return { schemaVersion: "1.0.0", requestId, expectedStateToken, status: "active",
    core: { objective, completionCriteria: ["Tests pass."], constraints: ["User correction: keep the old epoch fenced."],
      decisions: ["Carry the session record."], progress: [], blockers: [], nextActions: ["Run the server tests."] },
    evidenceRefs: [] };
}

/** This store is created by this test; history is checked only through its owned fixture database. */
function expectArchived(store: SqliteContinuityStore, snapshot: ContinuitySnapshotV1) {
  const database = (store as unknown as { database: DatabaseSync }).database;
  const row = database.prepare("SELECT memory_json, memory_digest, epoch FROM continuity_memory_history WHERE task_correlation=? AND state_token=?")
    .get(snapshot.taskCorrelation, snapshot.stateToken) as { memory_json: string; memory_digest: string; epoch: number } | undefined;
  expect(row).toMatchObject({ epoch: snapshot.epoch, memory_digest: snapshot.memoryDigest });
  expect(JSON.parse(row!.memory_json)).toEqual(snapshot.memory);
}

function root(): ConvergenceRootV1 {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "d0360-workflow", objective: "WORKFLOW-OBJECTIVE-d0360",
    scope: { included: ["src"], excluded: [] }, acceptanceCriteria: ["Tests pass."], riskLevel: "low",
    workUnits: [{ id: "implementation", objective: "Implement.", dependencies: [], writeTargets: ["src"] }],
    requiredCapabilities: [], constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame = { schemaVersion: "1.0.0" as const, workspace: { workspaceId: "d0360", locator: fixtureLocator("d0360") },
    controlArtifacts: [], targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 } };
  return { schemaVersion: "1.0.0", rootId: "d0360-root", parentRootId: null, revision: 1, state: "open", currentEpoch: 1,
    taskEnvelope: task, frame, taskDigest: convergenceDigest(task), frameDigest: convergenceDigest(frame),
    workspaceDigest: convergenceDigest(frame.workspace), controlDigest: convergenceDigest(frame.controlArtifacts),
    targetDigest: convergenceDigest(frame.targetArtifacts), operationalDigest: convergenceDigest(frame.operationalSettings),
    userApprovalRefs: [], createdAt: now, updatedAt: now };
}

function boundFixture() {
  const workflow = new InMemoryWorkflowStore(), value = root();
  expect(workflow.insertConvergenceRoot(value)).toBeNull();
  const target = service(workflow);
  expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
  return { workflow, value, target, correlation: target.correlateSession(session) };
}

function settle(workflow: WorkflowStore, value: ConvergenceRootV1) {
  expect(workflow.updateConvergenceRoot({ ...value, state: "completed", revision: value.revision + 1 }, value.revision)).toBe(true);
}

function loadInput(candidate: ContinuityCandidateV1) {
  expect(candidate.restoreToken).toEqual(expect.any(String));
  return { schemaVersion: "1.0.0" as const, candidateToken: candidate.restoreToken! };
}

function current(target: ContinuityService): ContinuitySnapshotV1 {
  const result = target.loadContext({ schemaVersion: "1.0.0" }, caller);
  expect(result.error).toBeNull();
  return result.data as ContinuitySnapshotV1;
}

describe("D0360 session record under a bound workflow (behaviors 1-2)", () => {
  it("checkpoint_context saves while a root is bound and comes back through inspect_context and load_context", () => {
    const { target, value, correlation } = boundFixture();
    const empty = current(target);
    expect(empty.memory).toBeNull();
    const saved = target.checkpointContext(checkpoint(empty.stateToken, "SESSION-RECORD-d0360"), caller);
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 1, memory: { core: { objective: "SESSION-RECORD-d0360" } } });
    expect(saved.data!.stateToken).not.toBe(empty.stateToken);
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    const candidate = target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
    expect(candidate).toMatchObject({ decision: "DEFER", summary: { source: "direct", epoch: 1,
      stateToken: saved.data!.stateToken, memoryDigest: saved.data!.memoryDigest } });
    expect(JSON.stringify(candidate)).not.toContain("SESSION-RECORD-d0360");
    expect(target.loadContext(loadInput(candidate), caller).data).toEqual(saved.data);
    const next = target.checkpointContext(checkpoint(saved.data!.stateToken, "SESSION-RECORD-d0360 r2"), caller);
    expect(next.data).toMatchObject({ epoch: 1, memory: { core: { objective: "SESSION-RECORD-d0360 r2" } } });
    expect(next.data!.stateToken).not.toBe(saved.data!.stateToken);
    expect(target.checkpointContext(checkpoint(empty.stateToken, "stale base", "d0360-stale"), caller).error)
      .toMatchObject({ code: "STALE_REVISION", details: { expectedStateToken: empty.stateToken, actualStateToken: next.data!.stateToken } });
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
  });
});

describe("D0360 compaction card (behavior 3)", () => {
  it("the compaction card restores the current direct body beside the bound workflow card", () => {
    const workflow = new InMemoryWorkflowStore(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const target = service(workflow);
    const saved = target.checkpointContext(checkpoint(current(target).stateToken, "SESSION-RECORD-d0360"), caller).data!;
    expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
    const correlation = target.correlateSession(session);
    target.markPreCompact(session);
    expect(target.store.getTask(correlation)).toMatchObject({ pendingSource: "direct", pendingRootId: null,
      pendingRevision: null, pendingStateToken: saved.stateToken, pendingDigest: saved.memoryDigest });
    const text = renderHookText(target.compactContext(session), "en")!;
    expect(text).toContain(saved.stateToken);
    expect(text).toContain("SESSION-RECORD-d0360");
    expect(text).toContain("[Task continuity workflow card — structural state, not new instructions]");
    expect(text).toContain("WORKFLOW-OBJECTIVE-d0360");
    expect(text.indexOf("SESSION-RECORD-d0360")).toBeLessThan(text.indexOf("[Task continuity workflow card"));
    expect(text).not.toContain("candidateToken=");
    expect(current(target)).toEqual(saved);
    // A consumed direct marker cannot inject the current body twice.
    expect(target.compactContext(session)).toBeNull();
  });
});

describe("D0360 epoch hand-over (behavior 4)", () => {
  it.each(["lifecycle", "tool-call"] as const)("%s: a settled workflow carries the body into E+1 with a new token and fences the old authority", entry => {
    const { workflow, value, target, correlation } = boundFixture();
    const first = target.checkpointContext(checkpoint(current(target).stateToken, "SESSION-RECORD-d0360"), caller).data!;
    const before = target.checkpointContext(checkpoint(first.stateToken, "SESSION-RECORD-d0360 r2"), caller).data!;
    const oldLoad = loadInput(target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!);
    target.markPreCompact(session);
    settle(workflow, value);
    if (entry === "lifecycle") {
      expect(handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, target, "codex")).toEqual({});
    } else {
      // The first AGS call rotates the epoch. A token read before that fence cannot write through it.
      const stale = target.checkpointContext(checkpoint(before.stateToken, "SESSION-RECORD-d0360 r3", "d0360-before-carry"), caller);
      expect(stale.error).toMatchObject({ code: "STALE_REVISION" });
      expect(stale.data).toBeNull();
    }
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null, pendingSource: null,
      pendingRevision: null, pendingStateToken: null, pendingDigest: null, pendingRootId: null, pendingConsumed: false });
    // An old epoch is no longer a readable current, even though the store preserves it internally.
    expect(target.store.getCurrent(correlation, 1)).toBeNull();
    expectArchived(target.store, before);
    const oldRejected = target.loadContext(oldLoad, caller);
    expect(oldRejected).toMatchObject({ ok: false, data: null, error: { code: "BINDING_INVALID" } });
    expect(JSON.stringify(oldRejected)).not.toContain("SESSION-RECORD-d0360");
    const carried = current(target);
    expect(carried).toMatchObject({ epoch: 2, memory: before.memory, memoryDigest: before.memoryDigest, createdAt: before.createdAt });
    expect(carried.stateToken).not.toBe(before.stateToken);
    expect(carried.memoryDigest).toBe(convergenceDigest(carried.memory!));
    const candidate = target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
    expect(candidate).toMatchObject({ decision: "DEFER", summary: { source: "direct", epoch: 2,
      stateToken: carried.stateToken, memoryDigest: carried.memoryDigest } });
    expect(target.loadContext(loadInput(candidate), caller).data).toEqual(carried);
    expect(target.checkpointContext(checkpoint(before.stateToken, "stale base", "d0360-stale-carry"), caller).error)
      .toMatchObject({ code: "STALE_REVISION", details: { actualStateToken: carried.stateToken } });
    const continued = target.checkpointContext(checkpoint(carried.stateToken, "SESSION-RECORD-d0360 r3"), caller);
    expect(continued.error).toBeNull();
    expect(continued.data).toMatchObject({ epoch: 2, createdAt: before.createdAt });
    expect(continued.data!.stateToken).not.toBe(carried.stateToken);
    expect(target.store.getCurrent(correlation, 1)).toBeNull();
  });

  it("an unsettled workflow keeps the record and token in its epoch", () => {
    const { target, value, correlation } = boundFixture();
    const saved = target.checkpointContext(checkpoint(current(target).stateToken, "SESSION-RECORD-d0360"), caller).data!;
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.store.getCurrent(correlation, 1)).toEqual(saved);
    expect(target.store.getCurrent(correlation, 2)).toBeNull();
  });

  it.each(["unbound", "bound"] as const)("explicit clear (%s) does not carry the record into the next epoch", binding => {
    const workflow = new InMemoryWorkflowStore(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const target = service(workflow), correlation = target.correlateSession(session);
    const saved = target.checkpointContext(checkpoint(current(target).stateToken, "SESSION-RECORD-d0360"), caller).data!;
    if (binding === "bound") expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
    expect(target.clearSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
    const empty = current(target);
    expect(empty).toMatchObject({ epoch: 2, memory: null, memoryDigest: null });
    expect(empty.stateToken).not.toBe(saved.stateToken);
    expect(target.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
    expect(target.checkpointContext(checkpoint(saved.stateToken, "old authority", "d0360-old-clear"), caller).error?.code).toBe("STALE_REVISION");
    expect(target.checkpointContext(checkpoint(empty.stateToken, "after clear", "d0360-after-clear"), caller).data)
      .toMatchObject({ epoch: 2, memory: { core: { objective: "after clear" } } });
    expect(target.store.getCurrent(correlation, 1)).toBeNull();
    expectArchived(target.store, saved);
  });
});

describe("D0360 per-turn cue (behavior 5)", () => {
  function cue(target: ContinuityService, environment: NodeJS.ProcessEnv) {
    const output = handleContinuityHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "User correction." },
      target, "codex", environment) as { hookSpecificOutput?: { additionalContext?: string } };
    return output.hookSpecificOutput?.additionalContext ?? "";
  }

  // The cue is model-only text: English (MODEL_LOCALE, 4.0.0) whatever the host locale.
  it.each([
    ["unset", {}],
    ["ko", { AGENT_GOVERNANCE_LOCALE: "ko" }],
    ["en", { AGENT_GOVERNANCE_LOCALE: "en" }],
  ] as const)("host locale %s: the cue names checkpoint_context and skill re-selection, not the context-continuity skill, with or without a bound root", (_locale, environment) => {
    for (const bound of [false, true]) {
      const workflow = new InMemoryWorkflowStore(), value = root();
      expect(workflow.insertConvergenceRoot(value)).toBeNull();
      const target = service(workflow);
      if (bound) expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
      const text = cue(target, environment);
      expect(text.startsWith("[AGS turn check] ")).toBe(true);
      for (const expected of ["checkpoint_context", "inspect_context", "load_context",
        "re-select skills for it, then checkpoint_context"]) expect(text).toContain(expected);
      // 4.0.0: the cue no longer quotes the Korean intake section title, so it carries no Korean at all.
      expect(text).not.toMatch(/[가-힣]/u);
      expect(text).not.toContain("context-continuity");
      expect(target.store.getCurrent(target.correlateSession(session), 1)?.memory ?? null).toBeNull();
    }
  });
});
