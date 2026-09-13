import { describe, expect, it } from "vitest";

import type {
  ConvergenceStatusV1,
  PlannedStageV1,
  StageResultV1,
  WorkflowReceiptV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import {
  convergenceRootHandle,
  convergenceStatusSummary,
  workflowStatusSummary,
} from "../../mcp-server/src/response-projections.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

function digest(seed: string): `sha256:${string}` {
  return `sha256:${seed.repeat(64).slice(0, 64)}`;
}

function plannedStage(index: number, state: PlannedStageV1["state"]): PlannedStageV1 {
  const stageId = `stage-${String(index).padStart(2, "0")}`;
  return {
    stageId,
    order: index,
    requiredCapability: `capability-${index}`,
    satisfiedCapabilities: [`capability-${index}`],
    skillId: `skill-${index}`,
    phase: "execution",
    selectionReason: "fixture",
    state,
    requiredArtifacts: [],
    riskGate: "none",
    providerKey: `skill-${index}#0`,
    executionClass: "workflow",
    phaseOrder: index,
    requiredInputArtifacts: [],
    inputBindings: [],
    producedArtifacts: [],
    outputSchema: { path: "contracts/freeform-output.v1.schema.json", digest: digest("a") },
    resultSchema: { path: "contracts/provider-result.v1.schema.json", digest: digest("b") },
    stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: [] },
    gate: { kind: "none", policy: "none" },
  };
}

function stageResult(index: number): StageResultV1 {
  return {
    schemaVersion: "1.0.0",
    runId: "run-payload-fixture-1",
    stageId: `stage-${String(index).padStart(2, "0")}`,
    expectedRevision: index - 1,
    state: "passed",
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: { payload: "x".repeat(8 * 1024) },
      artifacts: [],
      error: null,
    },
    evidence: [{
      artifactId: `evidence-${index}`,
      kind: "test",
      locator: `tests/results/${index}.json`,
      verified: true,
      note: "verified",
    }],
    findings: [],
    blockers: [],
    error: null,
  };
}

function receipt(completed: number): WorkflowReceiptV1 {
  const stages = Array.from({ length: 6 }, (_, index) => plannedStage(index + 1, index < completed ? "passed" : "ready"));
  return {
    schemaVersion: "1.0.0",
    runId: "run-payload-fixture-1",
    revision: completed,
    state: "running",
    plan: {
      schemaVersion: "1.0.0",
      taskId: "payload-fixture",
      taskDigest: digest("c"),
      integrityToken: "signed-plan",
      executionMode: "orchestrated",
      state: "running",
      selectedSkills: stages.map((stage) => stage.skillId),
      stages,
      currentStageId: stages[completed]?.stageId ?? null,
      nextStageId: stages[completed]?.stageId ?? null,
      errors: [],
    },
    stageResults: Array.from({ length: completed }, (_, index) => stageResult(index + 1)),
    blockers: [],
    unresolved: [],
    error: null,
  };
}

describe("compact MCP response projections", () => {
  it("keeps successful workflow progress fixed-size and reduces repeated payload bytes by at least 80%", () => {
    const validator = new ContractValidator();
    const fullBytes: number[] = [];
    const compactBytes: number[] = [];

    for (let completed = 1; completed <= 6; completed += 1) {
      const full = receipt(completed);
      const compact = workflowStatusSummary(full);
      expect(validator.workflowStatusSummary(compact)).toEqual(compact);
      expect(compact).not.toHaveProperty("plan");
      expect(compact).not.toHaveProperty("stageResults");
      fullBytes.push(Buffer.byteLength(JSON.stringify({ schemaVersion: "1.0.0", ok: true, data: full, error: null })));
      compactBytes.push(Buffer.byteLength(JSON.stringify({ schemaVersion: "1.0.0", ok: true, data: compact, error: null })));
    }

    expect(Math.max(...compactBytes) - Math.min(...compactBytes)).toBeLessThanOrEqual(32);
    expect(compactBytes.reduce((sum, size) => sum + size, 0))
      .toBeLessThan(fullBytes.reduce((sum, size) => sum + size, 0) * 0.2);
  });

  it("projects convergence roots and status without task, frame, or append-only history", () => {
    const root: ConvergenceStatusV1["root"] = {
      schemaVersion: "1.0.0",
      rootId: "root-summary-fixture",
      parentRootId: null,
      revision: 4,
      state: "open",
      currentEpoch: 1,
      taskEnvelope: {
        schemaVersion: "1.0.0",
        taskId: "summary-fixture",
        objective: "x".repeat(8 * 1024),
        scope: { included: ["src/**"], excluded: [] },
        acceptanceCriteria: ["Pass."],
        riskLevel: "low",
        workUnits: [{ id: "work", objective: "Work.", dependencies: [], writeTargets: ["src/**"] }],
        requiredCapabilities: ["fixture"],
        constraints: [],
        authorization: { allowedActions: ["write"], prohibitedActions: [], approvalRequired: [] },
        decision: { complexity: "simple", hasConflicts: false },
        orchestration: { requested: true, mcpAvailable: true },
      },
      frame: {
        schemaVersion: "1.0.0",
        workspace: { workspaceId: "workspace", locator: "D:/workspace" },
        controlArtifacts: [{ artifactId: "control", role: "validator", locator: "control.json", digest: digest("d") }],
        targetArtifacts: [{ artifactId: "target", role: "candidate", locator: "target.json", digest: digest("e") }],
        operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
      },
      taskDigest: digest("f"),
      frameDigest: digest("1"),
      workspaceDigest: digest("2"),
      controlDigest: digest("3"),
      targetDigest: digest("4"),
      operationalDigest: digest("5"),
      userApprovalRefs: [],
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:01:00.000Z",
    };
    const status: ConvergenceStatusV1 = {
      schemaVersion: "1.0.0",
      root,
      currentEpoch: 1,
      maxAttemptsPerEpoch: 3,
      maxEpochs: 2,
      attemptsUsedInEpoch: 0,
      attemptsRemainingInEpoch: 3,
      proposals: [],
      leases: [],
      outcomes: [],
      reviews: [],
      workflowRunIds: [],
      gateError: null,
    };

    const handle = convergenceRootHandle(root);
    const compact = convergenceStatusSummary(status);
    const validator = new ContractValidator();
    expect(validator.convergenceRootHandle(handle)).toEqual(handle);
    expect(validator.convergenceStatusSummary(compact)).toEqual(compact);
    expect(handle).not.toHaveProperty("taskEnvelope");
    expect(handle).not.toHaveProperty("frame");
    expect(compact).not.toHaveProperty("proposals");
    expect(compact).not.toHaveProperty("leases");
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(Buffer.byteLength(JSON.stringify(status)) * 0.2);
    expect(compact.root.taskDigest).toBe(root.taskDigest);
    expect(convergenceDigest(root.taskEnvelope)).not.toBe("");
  });
});
