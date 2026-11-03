import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConvergenceRootV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { handleContinuityHook, runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { InMemoryWorkflowStore, type WorkflowStore } from "../../mcp-server/src/workflow-store.js";

// Design docs/ags30-phase-check-design.md 3.2-3.4, 4 and 7 (enforcement, 3.1.0). Synthetic store and hook inputs only.
const stores = new Set<SqliteContinuityStore>();
const directories: string[] = [];
const session = "phase-check-session";
const at = "2026-11-02T03:00:00.000Z";
const CUE_HEAD = "[AGS 단계 확인] 진행 중인 workflow에 아직 passed가 아닌 단계가 있다: ";
// Codex and agy continue the turn with the cue as its only instruction: it names the workflow's goal and says to keep
// working toward it, so the continued turn does not end after recording stages or after the last request (3.1.1).
const CUE_GOAL = "workflow 목표: Phase check fixture.";
const CUE_TAIL = "이 목표가 아직 이뤄지지 않았으면 멈추지 말고 남은 작업을 이어서 하라. 방금 받은 요청을 끝냈어도 목표가 남았으면 이어서 한다. 단계 결과는 그 단계의 작업과 검증을 실제로 마친 뒤에만 기록하고, 기록만 하고 끝내지 마라.\n"
  + "사용자의 답이나 승인이 있어야 진행할 수 있으면 무엇을 기다리는지 한 줄로 쓰고 끝내라. 필요 없는 단계는 계획을 고쳐 뺀다.";
const UNAVAILABLE = "[AGS] workflow 상태를 확인하지 못해 이번 구간의 제품 파일 변경을 막지 않았다. 원인 코드: ";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores) store.close();
  stores.clear();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function createService(workflow: WorkflowStore | null = null, databasePath = ":memory:") {
  const store = new SqliteContinuityStore(databasePath);
  stores.add(store);
  return new ContinuityService(store, null, workflow, () => new Date(at));
}

function cue(missing: string): string {
  return `${CUE_HEAD}${missing}.\n${CUE_GOAL}\n${CUE_TAIL}`;
}

function workflowRoot(state: ConvergenceRootV1["state"] = "open"): ConvergenceRootV1 {
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "phase-task", objective: "Phase check fixture.",
    scope: { included: ["src"], excluded: [] }, acceptanceCriteria: ["Tests pass."], riskLevel: "low",
    workUnits: [{ id: "implementation", objective: "Implement.", dependencies: [], writeTargets: ["src"] }],
    requiredCapabilities: [], constraints: [], authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame = {
    schemaVersion: "1.0.0" as const, workspace: { workspaceId: "workspace", locator: "D:/workspace" }, controlArtifacts: [], targetArtifacts: [],
    operationalSettings: { maxAttemptsPerEpoch: 3 as const, maxEpochs: 2 as const, leaseTtlSeconds: 300 },
  };
  return {
    schemaVersion: "1.0.0", rootId: "phase-root", parentRootId: null, revision: 1, state, currentEpoch: 1, taskEnvelope: task, frame,
    taskDigest: convergenceDigest(task), frameDigest: convergenceDigest(frame), workspaceDigest: convergenceDigest(frame.workspace),
    controlDigest: convergenceDigest(frame.controlArtifacts), targetDigest: convergenceDigest(frame.targetArtifacts),
    operationalDigest: convergenceDigest(frame.operationalSettings), userApprovalRefs: [], createdAt: at, updatedAt: at,
  };
}

/** Binds the session's task to a root whose latest run planned `stages`, of which `passed` passed. */
function boundWorkflow(stages: string[], passed: string[], state: ConvergenceRootV1["state"] = "open") {
  const workflow = new InMemoryWorkflowStore();
  const root = workflowRoot(state);
  expect(workflow.insertConvergenceRoot(root)).toBeNull();
  const snapshot = workflow.getConvergenceSnapshot.bind(workflow);
  vi.spyOn(workflow, "getConvergenceSnapshot").mockImplementation(rootId => {
    const current = snapshot(rootId);
    return current ? { ...current, workflowRunIds: ["run-old", "run-latest"] } : null;
  });
  vi.spyOn(workflow, "getRun").mockImplementation(runId => (runId === "run-latest" ? {
    plan: { stages: stages.map(stageId => ({ stageId })) },
    stageResults: passed.map(stageId => ({ stageId, state: "passed" })),
  } : { plan: { stages: [] }, stageResults: [] }) as never);
  const service = createService(workflow);
  bindRoot(service, root.rootId);
  return service;
}

function bindRoot(service: ContinuityService, rootId: string) {
  const correlation = service.correlateSession(session);
  service.store.ensureTask(correlation, at);
  expect(service.store.bindRoot(correlation, 1, rootId, at)).toBe(true);
}

function lastIds(service: ContinuityService) {
  const correlation = service.correlateSession(session);
  return { edit: service.store.lastObservationId(correlation, 1, "phase-edit"), check: service.store.lastObservationId(correlation, 1, "phase-check") };
}

function checkRows(service: ContinuityService) {
  const database = (service.store as unknown as { database: DatabaseSync }).database;
  return database.prepare("SELECT success FROM continuity_observations WHERE event = 'phase-check' ORDER BY observation_id").all()
    .map(row => ({ ...row }));
}

describe("phase check store", () => {
  it("reads the newest observation id per event across edit, check, edit", () => {
    const service = createService();
    const correlation = service.correlateSession(session);
    service.store.ensureTask(correlation, at);
    expect(lastIds(service)).toEqual({ edit: null, check: null });
    service.store.recordObservation(correlation, 1, "phase-edit", null, true, at);
    service.store.recordObservation(correlation, 1, "phase-check", null, false, at);
    const { edit: first, check } = lastIds(service);
    expect(first).not.toBeNull(); expect(check).not.toBeNull();
    expect(first!).toBeLessThan(check!);
    service.store.recordObservation(correlation, 1, "phase-edit", null, true, at);
    const { edit: second } = lastIds(service);
    expect(second!).toBeGreaterThan(check!);
    // Another epoch's or task's rows are not this one's.
    expect(service.store.lastObservationId(correlation, 2, "phase-edit")).toBeNull();
    expect(service.store.lastObservationId(service.correlateSession("other"), 1, "phase-edit")).toBeNull();
  });
});

describe("phase check service", () => {
  it("returns null and records no check when nothing was edited", () => {
    const service = createService();
    expect(service.phaseCheckForSession(session)).toBeNull();
    service.store.ensureTask(service.correlateSession(session), at);
    expect(service.phaseCheckForSession(session)).toBeNull();
    expect(lastIds(service)).toEqual({ edit: null, check: null });
  });

  it("gives no output for a change made without a workflow, but records the check", () => {
    const service = createService();
    service.recordEditForSession(session);
    expect(service.phaseCheckForSession(session)).toBeNull();
    expect(checkRows(service)).toEqual([{ success: 1 }]);
  });

  it("names the latest run's stages that did not pass", () => {
    const service = boundWorkflow(["stage-01-design", "stage-02-implementation", "stage-03-testing"], ["stage-02-implementation"]);
    service.recordEditForSession(session);
    expect(service.phaseCheckForSession(session)).toBe(cue("stage-01-design, stage-03-testing"));
  });

  it("returns null and records a successful check when every stage passed or the root finished", () => {
    for (const service of [boundWorkflow(["stage-01-testing"], ["stage-01-testing"]), boundWorkflow(["stage-01-testing"], [], "completed")]) {
      service.recordEditForSession(session);
      expect(service.phaseCheckForSession(session)).toBeNull();
      expect(checkRows(service)).toEqual([{ success: 1 }]);
    }
  });

  it("names an unopened workflow store by its cause code", () => {
    const service = createService(null);
    bindRoot(service, "phase-root");
    service.recordEditForSession(session);
    expect(service.phaseCheckForSession(session)).toBe(`${UNAVAILABLE}phase-gate-unavailable:WORKFLOW_STORE_UNAVAILABLE.`);
  });

  it("does not repeat a check, keeps one edit row per run of edits, and checks again after a new edit", () => {
    const service = boundWorkflow(["stage-01-testing"], []);
    service.recordEditForSession(session);
    const { edit } = lastIds(service);
    service.recordEditForSession(session);
    expect(lastIds(service).edit).toBe(edit);
    expect(service.phaseCheckForSession(session)).toBe(cue("stage-01-testing"));
    expect(service.phaseCheckForSession(session)).toBeNull();
    service.recordEditForSession(session);
    expect(lastIds(service).edit!).toBeGreaterThan(lastIds(service).check!);
    expect(service.phaseCheckForSession(session)).toBe(cue("stage-01-testing"));
    expect(service.phaseCheckForSession(session)).toBeNull();
    expect(checkRows(service)).toEqual([{ success: 0 }, { success: 0 }]);
  });
});

describe("phase check hook", () => {
  const pre = (tool: string, extra: Record<string, unknown> = {}) => ({ hook_event_name: "PreToolUse", session_id: session, tool_name: tool, tool_input: {}, ...extra });
  const stop = { hook_event_name: "Stop", session_id: session };

  it("Claude: an Edit before the tool, then Stop, gives the cue as Stop additionalContext", () => {
    const service = boundWorkflow(["stage-01-testing"], []);
    expect(handleContinuityHook(pre("Edit"), service, "claude-code")).toEqual({});
    expect(handleContinuityHook(stop, service, "claude-code")).toEqual({ hookSpecificOutput: { hookEventName: "Stop", additionalContext: cue("stage-01-testing") } });
    expect(handleContinuityHook(stop, service, "claude-code")).toEqual({});
  });

  it("Codex: apply_patch then Stop gives a block decision whose reason is the cue", () => {
    const service = boundWorkflow(["stage-01-testing"], []);
    expect(handleContinuityHook(pre("apply_patch"), service, "codex")).toEqual({});
    expect(handleContinuityHook(stop, service, "codex")).toEqual({ decision: "block", reason: cue("stage-01-testing") });
    expect(handleContinuityHook(stop, service, "codex")).toEqual({});
  });

  it("does not count Bash, PowerShell, Agent or Task as edits", () => {
    const service = boundWorkflow(["stage-01-testing"], []);
    for (const tool of ["Bash", "PowerShell", "Agent", "Task"]) expect(handleContinuityHook(pre(tool), service, "claude-code")).toEqual({});
    expect(handleContinuityHook(stop, service, "claude-code")).toEqual({});
    // Positive control: the root's own edit is counted.
    expect(handleContinuityHook(pre("Write"), service, "claude-code")).toEqual({});
    expect(handleContinuityHook(stop, service, "claude-code")).toMatchObject({ hookSpecificOutput: { additionalContext: cue("stage-01-testing") } });
  });

  it("does not check at SessionEnd; the pending edit is checked at the next Stop", () => {
    const service = boundWorkflow(["stage-01-testing"], []);
    expect(handleContinuityHook(pre("MultiEdit"), service, "claude-code")).toEqual({});
    expect(handleContinuityHook({ hook_event_name: "SessionEnd", session_id: session, reason: "other" }, service, "claude-code")).toEqual({});
    expect(lastIds(service).check).toBeNull();
    expect(handleContinuityHook(stop, service, "claude-code")).toMatchObject({ hookSpecificOutput: { hookEventName: "Stop" } });
  });

  it("opens the workflow store at Stop to read the bound root", async () => {
    const directory = await mkdtemp(join(tmpdir(), "phase-check-"));
    directories.push(directory);
    const env = { AGENT_GOVERNANCE_DB_PATH: join(directory, "workflow.sqlite3"), AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(directory, "continuity.sqlite3") };
    const workflow = new SqliteWorkflowStore(env.AGENT_GOVERNANCE_DB_PATH);
    try { expect(workflow.insertConvergenceRoot(workflowRoot("completed"))).toBeNull(); } finally { workflow.close(); }
    const service = createService(null, env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH);
    bindRoot(service, "phase-root");
    expect(runContinuityHook(JSON.stringify(pre("apply_patch")), env, "codex", true)).toBe("");
    // A finished root has no missing stage; without the store the check would report it as unavailable.
    expect(runContinuityHook(JSON.stringify(stop), env, "codex", true)).toBe("");
    const { edit, check } = lastIds(service);
    expect(edit).not.toBeNull();
    expect(check!).toBeGreaterThan(edit!);
  });
});
