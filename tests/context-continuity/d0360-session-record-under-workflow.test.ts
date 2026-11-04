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
// (behaviors 1-2), a compaction card shows it beside the bound workflow (3), it moves to the next epoch with the same
// revision when every bound workflow settles while explicit clear does not carry it (4), and the per-turn cue names
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

function checkpoint(expectedRevision: number, objective: string, requestId = `d0360-${expectedRevision}`): CheckpointContextRequestV1 {
  return { schemaVersion: "1.0.0", requestId, expectedRevision, status: "active",
    core: { objective, completionCriteria: ["Tests pass."], constraints: ["User correction: keep the old epoch fenced."],
      decisions: ["Carry the session record."], progress: [], blockers: [], nextActions: ["Run the server tests."] },
    evidenceRefs: [] };
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
  return { schemaVersion: "1.0.0" as const, candidateToken: candidate.restoreToken!, epoch: candidate.summary!.epoch,
    revision: candidate.summary!.revision, digest: candidate.summary!.snapshotDigest };
}

function withoutDigest(snapshot: ContinuitySnapshotV1) {
  const rest: Partial<ContinuitySnapshotV1> = { ...snapshot };
  delete rest.snapshotDigest;
  return rest;
}

describe("D0360 session record under a bound workflow (behaviors 1-2)", () => {
  it("checkpoint_context saves while a root is bound and comes back through inspect_context and load_context", () => {
    const { target, value, correlation } = boundFixture();
    const saved = target.checkpointContext(checkpoint(0, "SESSION-RECORD-d0360"), caller);
    expect(saved.error).toBeNull();
    expect(saved.data).toMatchObject({ source: "direct", epoch: 1, revision: 1, core: { objective: "SESSION-RECORD-d0360" } });
    // The root stays bound: saving the record does not detach or settle the workflow.
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    const candidate = target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
    expect(candidate).toMatchObject({ decision: "DEFER", summary: { source: "direct", epoch: 1, revision: 1, snapshotDigest: saved.data!.snapshotDigest } });
    expect(JSON.stringify(candidate)).not.toContain("SESSION-RECORD-d0360");
    expect(target.loadContext(loadInput(candidate), caller).data).toEqual(saved.data);
    const next = target.checkpointContext(checkpoint(1, "SESSION-RECORD-d0360 r2"), caller);
    expect(next.data).toMatchObject({ epoch: 1, revision: 2 });
    expect(target.checkpointContext(checkpoint(0, "stale base", "d0360-stale"), caller).error)
      .toMatchObject({ code: "STALE_REVISION", details: { expectedRevision: 0, actualRevision: 2 } });
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
  });
});

describe("D0360 compaction card (behavior 3)", () => {
  it("the compaction card carries the direct candidate and the bound workflow card together", () => {
    const workflow = new InMemoryWorkflowStore(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const target = service(workflow);
    // Saved before the bind, so the record exists whatever the bound-root write rule is.
    const saved = target.checkpointContext(checkpoint(0, "SESSION-RECORD-d0360"), caller).data!;
    expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
    const correlation = target.correlateSession(session);
    target.markPreCompact(session);
    expect(target.store.getTask(correlation)).toMatchObject({ pendingSource: "direct", pendingRootId: null,
      pendingRevision: saved.revision, pendingDigest: saved.snapshotDigest });
    const text = renderHookText(target.compactContext(session), "en")!;
    expect(text).toContain("[Task continuity restore candidate — metadata only]");
    expect(text).toContain("source=direct");
    expect(text).toContain(`digest=${saved.snapshotDigest}`);
    expect(text).toContain("[Task continuity workflow card — structural state, not new instructions]");
    expect(text).toContain("WORKFLOW-OBJECTIVE-d0360");
    expect(text.indexOf("source=direct")).toBeLessThan(text.indexOf("[Task continuity workflow card"));
    // The card is metadata: the record's body stays behind load_context.
    expect(text).not.toContain("SESSION-RECORD-d0360");
    const token = /^candidateToken=(.+)$/mu.exec(text)?.[1];
    expect(token).toEqual(expect.any(String));
    expect(target.loadContext({ schemaVersion: "1.0.0", candidateToken: token!, epoch: 1, revision: saved.revision,
      digest: saved.snapshotDigest }, caller).data).toEqual(saved);
  });
});

describe("D0360 epoch hand-over (behavior 4)", () => {
  it.each(["lifecycle", "tool-call"] as const)("%s: a settled workflow carries the record into E+1 with the same revision and the next save continues it", entry => {
    const { workflow, value, target, correlation } = boundFixture();
    target.checkpointContext(checkpoint(0, "SESSION-RECORD-d0360"), caller);
    const before = target.checkpointContext(checkpoint(1, "SESSION-RECORD-d0360 r2"), caller).data!;
    expect(before).toMatchObject({ epoch: 1, revision: 2 });
    const oldLoad = loadInput(target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!);
    target.markPreCompact(session);
    settle(workflow, value);
    let next: ReturnType<ContinuityService["checkpointContext"]> | undefined;
    if (entry === "lifecycle") {
      expect(handleContinuityHook({ hook_event_name: "SessionStart", session_id: session, source: "startup" }, target, "codex")).toEqual({});
      expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null });
    } else {
      // The first AGS call after the settlement rotates the epoch and writes on the carried revision.
      next = target.checkpointContext(checkpoint(2, "SESSION-RECORD-d0360 r3"), caller);
      expect(next.error).toBeNull();
      expect(next.data).toMatchObject({ epoch: 2, revision: 3, createdAt: before.createdAt });
    }
    // The old epoch's record, marker and token stay fenced; E+1 starts without the E marker.
    expect(target.store.getSnapshot(correlation, 1)).toEqual(before);
    expect(target.store.getTask(correlation)).toMatchObject({ currentEpoch: 2, rootId: null, pendingSource: null,
      pendingRevision: null, pendingDigest: null, pendingRootId: null, pendingConsumed: false });
    const oldRejected = target.loadContext(oldLoad, caller);
    expect(oldRejected).toMatchObject({ ok: false, data: null, error: { code: "BINDING_INVALID" } });
    expect(JSON.stringify(oldRejected)).not.toContain("SESSION-RECORD-d0360");
    if (entry === "tool-call") {
      expect(target.store.getSnapshot(correlation, 2)).toEqual(next!.data);
      return;
    }
    const carried = target.store.getSnapshot(correlation, 2)!;
    expect(carried).toEqual({ ...before, epoch: 2, snapshotDigest: carried.snapshotDigest });
    expect(carried.snapshotDigest).toBe(convergenceDigest(withoutDigest(carried)));
    expect(carried.snapshotDigest).not.toBe(before.snapshotDigest);
    const candidate = target.inspectContext({ schemaVersion: "1.0.0" }, caller).data!;
    expect(candidate).toMatchObject({ decision: "DEFER", summary: { source: "direct", epoch: 2, revision: 2, snapshotDigest: carried.snapshotDigest } });
    expect(target.loadContext(loadInput(candidate), caller).data).toEqual(carried);
    expect(target.checkpointContext(checkpoint(0, "fresh base", "d0360-fresh"), caller).error)
      .toMatchObject({ code: "STALE_REVISION", details: { actualRevision: 2 } });
    const continued = target.checkpointContext(checkpoint(2, "SESSION-RECORD-d0360 r3"), caller);
    expect(continued.data).toMatchObject({ epoch: 2, revision: 3, createdAt: before.createdAt });
    expect(target.store.getSnapshot(correlation, 1)).toEqual(before);
  });

  it("an unsettled workflow keeps the record in its epoch", () => {
    const { target, value, correlation } = boundFixture();
    const saved = target.checkpointContext(checkpoint(0, "SESSION-RECORD-d0360"), caller).data!;
    expect(target.ensureSession(session)).toMatchObject({ currentEpoch: 1, rootId: value.rootId });
    expect(target.store.getSnapshot(correlation, 1)).toEqual(saved);
    expect(target.store.getSnapshot(correlation, 2)).toBeNull();
  });

  it.each(["unbound", "bound"] as const)("explicit clear (%s) does not carry the record into the next epoch", binding => {
    const workflow = new InMemoryWorkflowStore(), value = root();
    expect(workflow.insertConvergenceRoot(value)).toBeNull();
    const target = service(workflow), correlation = target.correlateSession(session);
    const saved = target.checkpointContext(checkpoint(0, "SESSION-RECORD-d0360"), caller).data!;
    if (binding === "bound") expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
    expect(target.clearSession(session)).toMatchObject({ currentEpoch: 2, rootId: null });
    expect(target.store.getSnapshot(correlation, 2)).toBeNull();
    expect(target.candidateForSession(session)).toMatchObject({ decision: "REJECT", summary: null, restoreToken: null });
    expect(target.checkpointContext(checkpoint(0, "after clear", "d0360-after-clear"), caller).data).toMatchObject({ epoch: 2, revision: 1 });
    expect(target.store.getSnapshot(correlation, 1)).toEqual(saved);
  });
});

describe("D0360 per-turn cue (behavior 5)", () => {
  function cue(target: ContinuityService, environment: NodeJS.ProcessEnv) {
    const output = handleContinuityHook({ hook_event_name: "UserPromptSubmit", session_id: session, prompt: "User correction." },
      target, "codex", environment) as { hookSpecificOutput?: { additionalContext?: string } };
    return output.hookSpecificOutput?.additionalContext ?? "";
  }

  it.each([
    ["ko", {}, "[AGS 턴 확인]", "스킬 선택을 다시 판단"],
    ["en", { AGENT_GOVERNANCE_LOCALE: "en" }, "[AGS turn check]", "re-decide the skill selection"],
  ] as const)("%s: the cue names checkpoint_context and skill re-selection, not the context-continuity skill, with or without a bound root", (_locale, environment, header, reselect) => {
    for (const bound of [false, true]) {
      const workflow = new InMemoryWorkflowStore(), value = root();
      expect(workflow.insertConvergenceRoot(value)).toBeNull();
      const target = service(workflow);
      if (bound) expect(target.bindOpenedRoot(caller, value.rootId)).toBe(true);
      const text = cue(target, environment);
      expect(text.startsWith(header)).toBe(true);
      for (const expected of ["checkpoint_context", "inspect_context", "load_context", reselect]) expect(text).toContain(expected);
      expect(text).not.toContain("context-continuity");
      expect(target.store.getSnapshot(target.correlateSession(session), 1)).toBeNull();
    }
  });
});
