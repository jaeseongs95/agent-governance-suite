import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type PlannedStageV1, type SkillDescriptorV1, type StageResultV1, type TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const temporaryDirectories: string[] = [];

function descriptor(
  input: Pick<SkillDescriptorV1, "id" | "capabilities" | "phase" | "riskGate" | "priority">
    & Pick<SkillDescriptorV1, "producedArtifacts">,
): SkillDescriptorV1 {
  return {
    schemaVersion: "1.0.0",
    id: input.id,
    version: "1.0.0",
    path: `skills/${input.id}`,
    phase: input.phase,
    capabilities: input.capabilities,
    priority: input.priority,
    selectionCriteria: ["capability match"],
    preconditions: [],
    requiredArtifacts: input.id === "draft-specialist" ? ["draft"] : [`${input.id}-evidence`],
    producedArtifacts: input.producedArtifacts,
    riskGate: input.riskGate,
    enabled: true,
  };
}

const skills: SkillDescriptorV1[] = [
  descriptor({ id: "thread-conductor", capabilities: ["subagent-coordination"], phase: "execution-planning", riskGate: "conditional", priority: 10, producedArtifacts: [] }),
  descriptor({ id: "reasoning-panel", capabilities: ["independent-deliberation"], phase: "decision-analysis", riskGate: "conditional", priority: 10, producedArtifacts: ["decision-record"] }),
  descriptor({ id: "evidence-gate", capabilities: ["independent-audit"], phase: "completion-gate", riskGate: "mandatory", priority: 90, producedArtifacts: ["audit-report", "gate-verdict"] }),
  descriptor({ id: "draft-specialist", capabilities: ["draft"], phase: "execution", riskGate: "none", priority: 10, producedArtifacts: ["draft"] }),
];

function task(overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "task-001",
    objective: "Prepare a high-risk, conflicting draft.",
    scope: { included: ["draft"], excluded: ["deployment"] },
    acceptanceCriteria: ["Produce an evidence-backed draft."],
    riskLevel: "high",
    workUnits: [
      { id: "research", objective: "Collect evidence.", dependencies: [], writeTargets: ["evidence.md"] },
      { id: "draft", objective: "Write the draft.", dependencies: [], writeTargets: ["draft.md"] },
    ],
    requiredCapabilities: ["draft"],
    constraints: ["Keep the work local."],
    authorization: {
      allowedActions: ["read", "write"],
      prohibitedActions: ["deploy"],
      approvalRequired: ["external publication"],
    },
    decision: { complexity: "complex", hasConflicts: true },
    orchestration: { requested: true, mcpAvailable: true },
    ...overrides,
  };
}

async function createService(descriptors = skills): Promise<{ service: WorkflowService; registryPath: string }> {
  const directory = await mkdtemp(join(tmpdir(), "skill-suite-mcp-"));
  temporaryDirectories.push(directory);
  const registryPath = join(directory, "registry.json");
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "1.0.0", skills: descriptors }), "utf8");
  const validator = new ContractValidator();
  return { service: new WorkflowService(new FileSkillRegistry(registryPath, validator), validator), registryPath };
}

function passedStage(runId: string, stage: PlannedStageV1, expectedRevision: number): StageResultV1 {
  const artifactIds = stage.requiredArtifacts.length > 0 ? stage.requiredArtifacts : ["completion-proof"];
  return {
    schemaVersion: "1.0.0",
    runId,
    stageId: stage.stageId,
    expectedRevision,
    state: "passed",
    output: stage.riskGate === "mandatory"
      ? { gateVerdict: "PASS", auditorId: "independent-auditor", implementationActorIds: ["implementation-agent"] }
      : { accepted: true },
    evidence: artifactIds.map((artifactId) => ({
      artifactId,
      kind: "test",
      locator: `tests/${stage.stageId}/${artifactId}.json`,
      verified: true,
      note: "fixture verified",
    })),
    findings: [],
    blockers: [],
    error: null,
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("WorkflowService", () => {
  it("plans from runtime capabilities without persisting a run", async () => {
    const { service } = await createService();
    const result = service.planWorkflow(task());

    expect(result.ok).toBe(true);
    expect(result.data?.state).toBe("ready");
    expect(result.data?.stages.map((stage) => stage.requiredCapability)).toEqual([
      "subagent-coordination",
      "independent-deliberation",
      "draft",
      "independent-audit",
    ]);
    expect(result.data?.stages.map((stage) => stage.skillId)).toEqual([
      "thread-conductor",
      "reasoning-panel",
      "draft-specialist",
      "evidence-gate",
    ]);
    expect(result.data?.currentStageId).toBeNull();
    expect(result.data?.nextStageId).toBe(result.data?.stages[0]?.stageId);
    expect(result.data?.stages.every((stage) => stage.selectionReason.length > 0)).toBe(true);
    expect(result.data?.stages.find((stage) => stage.skillId === "draft-specialist")?.requiredArtifacts).toEqual(["draft"]);
    expect(result.data?.stages.find((stage) => stage.skillId === "thread-conductor")?.requiredArtifacts)
      .toEqual([]);
    expect(service.getWorkflowStatus("run-task-001-1").error?.code).toBe("RUN_NOT_FOUND");
  });

  it("re-reads the runtime registry for each new plan", async () => {
    const { service, registryPath } = await createService();
    expect(service.planWorkflow(task({ taskId: "first" })).data?.selectedSkills).toContain("draft-specialist");

    const replacement = skills.map((skill) => skill.id === "draft-specialist" ? { ...skill, id: "replacement-drafter", path: "skills/replacement-drafter" } : skill);
    await writeFile(registryPath, JSON.stringify({ schemaVersion: "1.0.0", skills: replacement }), "utf8");

    expect(service.planWorkflow(task({ taskId: "second" })).data?.selectedSkills).toContain("replacement-drafter");
  });

  it("starts from a plan and enforces revision, ordering, and evidence", async () => {
    const { service } = await createService();
    const plan = service.planWorkflow(task()).data!;
    const started = service.startWorkflow(plan).data!;
    expect(started.state).toBe("running");
    expect(started.revision).toBe(0);
    expect(started.plan.currentStageId).toBe(started.plan.stages[0]?.stageId);
    expect(started.plan.nextStageId).toBe(started.plan.stages[1]?.stageId);

    const secondStage = started.plan.stages[1]!;
    const outOfOrder = service.recordStageResult(passedStage(started.runId, secondStage, started.revision));
    expect(outOfOrder.ok).toBe(false);
    expect(outOfOrder.error?.code).toBe("INVALID_TRANSITION");

    const firstStage = started.plan.stages[0]!;
    const missingEvidence = passedStage(started.runId, firstStage, started.revision);
    missingEvidence.evidence = [];
    expect(service.recordStageResult(missingEvidence).error?.code).toBe("MISSING_EVIDENCE");

    let receipt = service.recordStageResult(passedStage(started.runId, firstStage, started.revision)).data!;
    expect(receipt.plan.currentStageId).toBe(receipt.plan.stages[1]?.stageId);
    for (const stage of receipt.plan.stages.slice(1)) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }

    const finalized = service.finalizeWorkflow(receipt.runId, receipt.revision);
    expect(finalized.ok).toBe(true);
    expect(finalized.data?.state).toBe("passed");
    expect(finalized.data?.plan.stages.find((stage) => stage.riskGate === "mandatory")?.state).toBe("passed");
    expect(finalized.data?.plan).toMatchObject({ currentStageId: null, nextStageId: null });

    expect(service.abortWorkflow(started.runId, started.revision).error?.code).toBe("STALE_REVISION");
  });

  it("requires the mandatory audit artifacts before the audit stage can advance", async () => {
    const { service } = await createService();
    const started = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    let receipt = started;
    for (const stage of receipt.plan.stages.filter((item) => item.riskGate !== "mandatory")) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }

    const auditStage = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory")!;
    const missingArtifact = passedStage(receipt.runId, auditStage, receipt.revision);
    missingArtifact.evidence = [{ ...missingArtifact.evidence[0]!, artifactId: "wrong-artifact" }];
    expect(service.recordStageResult(missingArtifact).error?.code).toBe("MISSING_EVIDENCE");
  });

  it("validates produced-artifact evidence before a subsequent stage can advance", async () => {
    const { service } = await createService();
    const started = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    let receipt = started;
    const producedArtifactStage = receipt.plan.stages.find((stage) => stage.requiredArtifacts.length > 0)!;
    for (const stage of receipt.plan.stages.filter((stage) => stage.order < producedArtifactStage.order)) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }
    const missingProducedArtifact = passedStage(receipt.runId, producedArtifactStage, receipt.revision);
    missingProducedArtifact.evidence = [{ ...missingProducedArtifact.evidence[0]!, artifactId: "wrong-artifact" }];

    expect(service.recordStageResult(missingProducedArtifact).error?.code).toBe("MISSING_EVIDENCE");
    const subsequentStage = receipt.plan.stages.find((stage) => stage.order === producedArtifactStage.order + 1)!;
    expect(service.recordStageResult(passedStage(receipt.runId, subsequentStage, receipt.revision)).error?.code)
      .toBe("INVALID_TRANSITION");
  });

  it("does not finalize after a failed independent audit", async () => {
    const { service } = await createService();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    for (const stage of receipt.plan.stages) {
      if (stage.riskGate === "mandatory") {
        const failedAudit: StageResultV1 = {
          ...passedStage(receipt.runId, stage, receipt.revision),
          state: "failed",
          evidence: [],
          blockers: ["material-audit-finding"],
          error: { code: "GATE_FAILED", message: "Independent audit failed.", details: null }
        };
        receipt = service.recordStageResult(failedAudit).data!;
      } else {
        receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
      }
    }

    expect(receipt.state).toBe("failed");
    expect(receipt.blockers).toContain("material-audit-finding");
    expect(service.finalizeWorkflow(receipt.runId, receipt.revision).error?.code).toBe("INVALID_TRANSITION");
  });

  it("blocks only orchestrated work when MCP is unavailable", async () => {
    const { service } = await createService();
    const direct = service.planWorkflow(task({
      taskId: "direct",
      riskLevel: "low",
      workUnits: [{ id: "direct", objective: "Draft directly.", dependencies: [], writeTargets: ["draft.md"] }],
      decision: { complexity: "simple", hasConflicts: false },
      orchestration: { requested: false, mcpAvailable: false },
    }));
    expect(direct.ok).toBe(true);
    expect(direct.data?.state).toBe("ready");
    expect(direct.data?.executionMode).toBe("direct");

    const orchestrated = service.planWorkflow(task({ taskId: "orchestrated", orchestration: { requested: true, mcpAvailable: false } }));
    expect(orchestrated.ok).toBe(true);
    expect(orchestrated.data?.state).toBe("blocked");
    expect(orchestrated.data?.errors[0]?.code).toBe("MCP_UNAVAILABLE");
  });

  it("rejects unknown and cyclic work unit dependencies", async () => {
    const { service } = await createService();
    const unknownDependency = service.planWorkflow(task({
      workUnits: [{ id: "draft", objective: "Draft.", dependencies: ["missing"], writeTargets: ["draft.md"] }],
    }));
    expect(unknownDependency.error?.code).toBe("INVALID_INPUT");

    const cycle = service.planWorkflow(task({
      workUnits: [
        { id: "first", objective: "First.", dependencies: ["second"], writeTargets: ["first.md"] },
        { id: "second", objective: "Second.", dependencies: ["first"], writeTargets: ["second.md"] },
      ],
    }));
    expect(cycle.error?.code).toBe("INVALID_INPUT");
  });

  it("adds coordination only when work units contain an independent pair", async () => {
    const { service } = await createService();
    const sequential = service.planWorkflow(task({
      workUnits: [
        { id: "first", objective: "First.", dependencies: [], writeTargets: ["first.md"] },
        { id: "second", objective: "Second.", dependencies: ["first"], writeTargets: ["second.md"] },
      ],
    }));

    expect(sequential.ok).toBe(true);
    expect(sequential.data?.stages.map((stage) => stage.requiredCapability)).not.toContain("subagent-coordination");
  });

  it("keeps a high-risk audit requested by the caller as the final policy stage", async () => {
    const { service } = await createService();
    const plan = service.planWorkflow(task({ requiredCapabilities: ["independent-audit", "draft"] }));

    expect(plan.data?.stages.map((stage) => stage.requiredCapability)).toEqual([
      "subagent-coordination",
      "independent-deliberation",
      "draft",
      "independent-audit",
    ]);
  });

  it("rejects forged, modified, and foreign-process plans without creating a run", async () => {
    const { service } = await createService();
    const validPlan = service.planWorkflow(task()).data!;
    const forgedEmptyPlan = {
      ...validPlan,
      selectedSkills: [],
      stages: [],
      currentStageId: null,
      nextStageId: null,
    };
    expect(service.startWorkflow(forgedEmptyPlan).error?.code).toBe("INVALID_INPUT");

    const modifiedAuditPlan = {
      ...validPlan,
      stages: validPlan.stages.map((stage) => (
        stage.riskGate === "mandatory" ? { ...stage, riskGate: "none" as const } : stage
      )),
    };
    expect(service.startWorkflow(modifiedAuditPlan).error?.code).toBe("INVALID_INPUT");

    const { service: separateProcessService } = await createService();
    expect(separateProcessService.startWorkflow(validPlan).error?.code).toBe("INVALID_INPUT");

    const validStart = service.startWorkflow(validPlan);
    expect(validStart.data?.runId).toBe("run-task-001-1");
  });

  it("does not finalize when passed stages still report blockers", async () => {
    const { service } = await createService();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    for (const stage of receipt.plan.stages) {
      const result = passedStage(receipt.runId, stage, receipt.revision);
      if (stage.order === 1) {
        result.findings = ["confirmation remains pending"];
        result.blockers = ["awaiting-confirmation"];
      }
      receipt = service.recordStageResult(result).data!;
    }

    expect(receipt.stageResults[0]?.findings).toContain("confirmation remains pending");
    expect(receipt.unresolved).toContain("awaiting-confirmation");
    expect(service.finalizeWorkflow(receipt.runId, receipt.revision).error?.code).toBe("GATE_FAILED");
  });

  it("requires a PASS verdict and an auditor independent from implementation actors", async () => {
    const { service } = await createService();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    for (const stage of receipt.plan.stages.filter((item) => item.riskGate !== "mandatory")) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }

    const auditStage = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory")!;
    const failingVerdict = passedStage(receipt.runId, auditStage, receipt.revision);
    failingVerdict.output = { gateVerdict: "FAIL", auditorId: "independent-auditor", implementationActorIds: ["implementation-agent"] };
    expect(service.recordStageResult(failingVerdict).error?.code).toBe("GATE_FAILED");

    const selfAudited = passedStage(receipt.runId, auditStage, receipt.revision);
    selfAudited.output = { gateVerdict: "PASS", auditorId: "implementation-agent", implementationActorIds: ["implementation-agent"] };
    expect(service.recordStageResult(selfAudited).error?.code).toBe("GATE_FAILED");
  });
});
