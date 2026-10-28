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
    const seenDigests = new Set<string>();

    for (let completed = 1; completed <= 6; completed += 1) {
      const full = receipt(completed);
      const compact = workflowStatusSummary(full);
      expect(validator.workflowStatusSummary(compact)).toEqual(compact);
      expect(compact).not.toHaveProperty("plan");
      expect(compact).not.toHaveProperty("stageResults");
      expect(compact).toEqual({
        schemaVersion: "1.0.0",
        runId: full.runId,
        revision: completed,
        state: full.state,
        currentStageId: completed < 6 ? `stage-0${completed + 1}` : null,
        nextStageId: completed < 6 ? `stage-0${completed + 1}` : null,
        lastRecordedStageId: `stage-0${completed}`,
        completedStageCount: completed,
        totalStageCount: 6,
        blockerCount: 0,
        unresolvedCount: 0,
        errorCode: null,
        receiptDigest: convergenceDigest(full),
      });
      seenDigests.add(compact.receiptDigest);
      fullBytes.push(Buffer.byteLength(JSON.stringify({ schemaVersion: "1.0.0", ok: true, data: full, error: null })));
      compactBytes.push(Buffer.byteLength(JSON.stringify({ schemaVersion: "1.0.0", ok: true, data: compact, error: null })));
    }

    expect(seenDigests.size).toBe(6);
    expect(Math.max(...compactBytes) - Math.min(...compactBytes)).toBeLessThanOrEqual(32);
    expect(compactBytes.reduce((sum, size) => sum + size, 0))
      .toBeLessThan(fullBytes.reduce((sum, size) => sum + size, 0) * 0.2);

    const blockedFull: WorkflowReceiptV1 = {
      ...receipt(2),
      revision: 9,
      state: "blocked",
      blockers: ["blocker-1", "blocker-2"],
      unresolved: ["unresolved-1"],
      error: { code: "GATE_FAILED", message: "stage gate blocked", details: null },
    };
    const blockedCompact = workflowStatusSummary(blockedFull);
    expect(validator.workflowStatusSummary(blockedCompact)).toEqual(blockedCompact);
    expect(blockedCompact).toEqual({
      schemaVersion: "1.0.0",
      runId: blockedFull.runId,
      revision: 9,
      state: "blocked",
      currentStageId: "stage-03",
      nextStageId: "stage-03",
      lastRecordedStageId: "stage-02",
      completedStageCount: 2,
      totalStageCount: 6,
      blockerCount: 2,
      unresolvedCount: 1,
      errorCode: "GATE_FAILED",
      receiptDigest: convergenceDigest(blockedFull),
    });
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
    const samplePlan = receipt(1).plan;
    const status: ConvergenceStatusV1 = {
      schemaVersion: "1.0.0",
      root,
      currentEpoch: 1,
      maxAttemptsPerEpoch: 3,
      maxEpochs: 2,
      attemptsUsedInEpoch: 2,
      attemptsRemainingInEpoch: 1,
      proposals: [{
        schemaVersion: "1.0.0",
        rootId: root.rootId,
        expectedRevision: 3,
        taskEnvelope: root.taskEnvelope,
        frame: root.frame,
        plan: samplePlan,
        actorId: "actor-impl",
        outputTargets: ["src/index.ts"],
        priorFailure: null,
      }],
      leases: [
        {
          schemaVersion: "1.0.0",
          leaseId: "lease-01",
          rootId: root.rootId,
          rootRevision: 2,
          epoch: 1,
          ordinal: 1,
          proposalDigest: digest("6"),
          taskDigest: root.taskDigest,
          frameDigest: root.frameDigest,
          workspaceDigest: root.workspaceDigest,
          controlDigest: root.controlDigest,
          targetDigest: root.targetDigest,
          operationalDigest: root.operationalDigest,
          outputTargetsDigest: digest("7"),
          planIntegrityToken: "signed-plan-1",
          actorId: "actor-impl",
          outputTargets: ["src/index.ts"],
          issuedAt: "2026-09-13T00:00:10.000Z",
          expiresAt: "2026-09-13T00:05:10.000Z",
          state: "consumed",
        },
        {
          schemaVersion: "1.0.0",
          leaseId: "lease-02",
          rootId: root.rootId,
          rootRevision: 3,
          epoch: 1,
          ordinal: 2,
          proposalDigest: digest("8"),
          taskDigest: root.taskDigest,
          frameDigest: root.frameDigest,
          workspaceDigest: root.workspaceDigest,
          controlDigest: root.controlDigest,
          targetDigest: root.targetDigest,
          operationalDigest: root.operationalDigest,
          outputTargetsDigest: digest("7"),
          planIntegrityToken: "signed-plan-2",
          actorId: "actor-impl",
          outputTargets: ["src/index.ts"],
          issuedAt: "2026-09-13T00:00:20.000Z",
          expiresAt: "2026-09-13T00:05:20.000Z",
          state: "issued",
        },
      ],
      outcomes: [
        {
          schemaVersion: "1.0.0",
          outcomeId: "outcome-01",
          rootId: root.rootId,
          rootRevision: 2,
          leaseId: "lease-01",
          epoch: 1,
          ordinal: 1,
          workflowRunId: "run-01",
          state: "failed",
          receiptDigest: digest("9"),
          failureFingerprint: "fp-1",
          evidenceRefs: ["evidence-1"],
          recordedAt: "2026-09-13T00:00:15.000Z",
        },
        {
          schemaVersion: "1.0.0",
          outcomeId: "outcome-02",
          rootId: root.rootId,
          rootRevision: 4,
          leaseId: "lease-02",
          epoch: 1,
          ordinal: 2,
          workflowRunId: "run-02",
          state: "aborted",
          receiptDigest: digest("a"),
          failureFingerprint: "fp-2",
          evidenceRefs: ["evidence-2"],
          recordedAt: "2026-09-13T00:00:30.000Z",
        },
      ],
      reviews: [{
        schemaVersion: "1.0.0",
        reviewId: "review-01",
        rootId: root.rootId,
        rootRevision: 4,
        epoch: 1,
        reviewerActorId: "actor-auditor",
        implementationActorIds: ["actor-impl"],
        freshContext: { confirmed: true, evidenceRef: "fresh-1" },
        classification: "semantics-preserving",
        comparability: { comparable: true, rationale: "same frame" },
        route: "resume-new-epoch",
        proposedFrame: null,
        evidenceRefs: ["review-evidence-1"],
        userApprovalRefs: [],
        reviewedAt: "2026-09-13T00:00:40.000Z",
      }],
      workflowRunIds: ["run-01", "run-02"],
      gateError: { code: "GATE_FAILED", message: "convergence gate blocked", details: null },
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
    expect(handle).toEqual({
      schemaVersion: "1.0.0",
      rootId: root.rootId,
      revision: root.revision,
      state: root.state,
      currentEpoch: root.currentEpoch,
      taskDigest: root.taskDigest,
      frameDigest: root.frameDigest,
      workspaceDigest: root.workspaceDigest,
      controlDigest: root.controlDigest,
      targetDigest: root.targetDigest,
      operationalDigest: root.operationalDigest,
    });
    expect(compact).toEqual({
      schemaVersion: "1.0.0",
      root: handle,
      currentEpoch: 1,
      maxAttemptsPerEpoch: 3,
      maxEpochs: 2,
      attemptsUsedInEpoch: 2,
      attemptsRemainingInEpoch: 1,
      issuedLeaseId: "lease-02",
      latestWorkflowRunId: "run-02",
      latestOutcomeId: "outcome-02",
      latestOutcomeState: "aborted",
      latestOutcomeReceiptDigest: digest("a"),
      proposalCount: 1,
      leaseCount: 2,
      outcomeCount: 2,
      reviewCount: 1,
      gateErrorCode: "GATE_FAILED",
    });
    expect(convergenceDigest(root.taskEnvelope)).not.toBe("");

    const emptyCompact = convergenceStatusSummary({
      ...status,
      attemptsUsedInEpoch: 0,
      attemptsRemainingInEpoch: 3,
      proposals: [],
      leases: [],
      outcomes: [],
      reviews: [],
      workflowRunIds: [],
      gateError: null,
    });
    expect(validator.convergenceStatusSummary(emptyCompact)).toEqual(emptyCompact);
    expect(emptyCompact).toMatchObject({
      issuedLeaseId: null,
      latestWorkflowRunId: null,
      latestOutcomeId: null,
      latestOutcomeState: null,
      latestOutcomeReceiptDigest: null,
      proposalCount: 0,
      leaseCount: 0,
      outcomeCount: 0,
      reviewCount: 0,
      gateErrorCode: null,
    });
  });
});
