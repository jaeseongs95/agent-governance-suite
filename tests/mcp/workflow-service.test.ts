import { readFileSync, readdirSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { type PlannedStageV1, type SkillDescriptorV2, type StageResultV1, type TaskEnvelopeV1 } from "../../contracts/types.js";
import { validateDecisionRecordSemantics } from "../../mcp-server/src/decision-record-validator.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const temporaryDirectories: string[] = [];
const validDecisionRecordDirectory = new URL(
  "../../skills/independent-deliberation-panel/evals/fixtures/valid/",
  import.meta.url,
);
const invalidDecisionRecordDirectory = new URL(
  "../../skills/independent-deliberation-panel/evals/fixtures/invalid/",
  import.meta.url,
);
function decisionRecordFixtures(directory: URL): Array<{ name: string; record: Record<string, unknown> }> {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => ({
      name,
      record: JSON.parse(readFileSync(new URL(name, directory), "utf8")) as Record<string, unknown>,
    }));
}
const validDecisionRecord = JSON.parse(readFileSync(new URL(
  "../../skills/independent-deliberation-panel/evals/fixtures/valid/rc03_high_fresh_judge.json",
  import.meta.url,
), "utf8")) as Record<string, unknown>;

function descriptor(
  input: { id: string; capabilities: string[]; phase: string; riskGate: "none" | "conditional" | "mandatory"; priority: number; producedArtifacts: string[]; phaseOrder: number },
): SkillDescriptorV2 {
  const stateMapping = input.riskGate === "mandatory"
    ? {
        selector: "/output/gateVerdict",
        values: {
          PASS: { state: "passed" as const, errorRequired: false },
          FAIL: { state: "failed" as const, errorRequired: true, allowedErrorCodes: ["GATE_FAILED" as const] },
        },
        default: "reject" as const,
        adapterErrors: ["INVALID_INPUT" as const, "MISSING_EVIDENCE" as const],
      }
    : {
        default: { state: "passed" as const, errorRequired: false },
        adapterErrors: ["INVALID_INPUT" as const, "MISSING_EVIDENCE" as const],
      };
  return {
    schemaVersion: "2.0.0",
    skillId: input.id,
    version: "1.0.0",
    path: `./${input.id}`,
    priority: input.priority,
    enabled: true,
    providers: [{
      capabilities: input.capabilities,
      executionClass: "workflow",
      phase: input.phase,
      phaseOrder: input.phaseOrder,
      requiredInputArtifacts: [],
      inputBindings: [],
      producedArtifacts: input.producedArtifacts,
      outputSchema: "contracts/freeform-output.v1.schema.json",
      resultSchema: "contracts/provider-result.v1.schema.json",
      stateMapping,
      selectionCriteria: ["capability match"],
      preconditions: [],
      failureHandling: "Return a structured result.",
      gate: {
        kind: input.riskGate === "mandatory" ? "completion" : "none",
        policy: input.riskGate,
        validator: input.producedArtifacts.includes("decision-record")
          ? "contracts/decision-record.v1.schema.json"
          : null,
      },
    }],
  };
}

const skills: SkillDescriptorV2[] = [
  descriptor({ id: "thread-conductor", capabilities: ["subagent-coordination", "task-decomposition"], phase: "execution-planning", phaseOrder: 35, riskGate: "none", priority: 10, producedArtifacts: [] }),
  descriptor({ id: "reasoning-panel", capabilities: ["independent-deliberation"], phase: "decision-analysis", phaseOrder: 40, riskGate: "none", priority: 10, producedArtifacts: ["decision-record"] }),
  descriptor({ id: "evidence-gate", capabilities: ["independent-audit"], phase: "completion-gate", phaseOrder: 90, riskGate: "mandatory", priority: 90, producedArtifacts: ["audit-report", "gate-verdict"] }),
  descriptor({ id: "draft-specialist", capabilities: ["draft"], phase: "execution", phaseOrder: 50, riskGate: "none", priority: 10, producedArtifacts: ["draft"] }),
  {
    ...descriptor({ id: "failure-analyst", capabilities: ["blocker-diagnosis"], phase: "failure-diagnosis", phaseOrder: 10, riskGate: "none", priority: 10, producedArtifacts: ["diagnosis-report"] }),
    providers: [{
      ...descriptor({ id: "failure-analyst", capabilities: ["blocker-diagnosis"], phase: "failure-diagnosis", phaseOrder: 10, riskGate: "none", priority: 10, producedArtifacts: ["diagnosis-report"] }).providers[0]!,
      executionClass: "recovery",
    }],
  },
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

async function createService(descriptors: SkillDescriptorV2[] = skills): Promise<{ service: WorkflowService; registryPath: string; rootDirectory: string }> {
  const directory = await mkdtemp(join(tmpdir(), "skill-suite-mcp-"));
  temporaryDirectories.push(directory);
  const registryPath = join(directory, "skills", "registry.json");
  await mkdir(join(directory, "skills"), { recursive: true });
  await mkdir(join(directory, "contracts"), { recursive: true });
  await copyFile(new URL("../../contracts/freeform-output.v1.schema.json", import.meta.url), join(directory, "contracts", "freeform-output.v1.schema.json"));
  await copyFile(new URL("../../contracts/provider-result.v1.schema.json", import.meta.url), join(directory, "contracts", "provider-result.v1.schema.json"));
  await copyFile(new URL("../../contracts/task-envelope.v1.schema.json", import.meta.url), join(directory, "contracts", "task-envelope.v1.schema.json"));
  await copyFile(
    new URL("../../skills/independent-deliberation-panel/contracts/decision-record.v1.schema.json", import.meta.url),
    join(directory, "contracts", "decision-record.v1.schema.json"),
  );
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: descriptors }), "utf8");
  const validator = new ContractValidator();
  return { service: new WorkflowService(new FileSkillRegistry(registryPath, validator), validator), registryPath, rootDirectory: directory };
}

function passedStage(runId: string, stage: PlannedStageV1, expectedRevision: number): StageResultV1 {
  const artifactIds = stage.requiredArtifacts.length > 0 ? stage.requiredArtifacts : ["completion-proof"];
  return {
    schemaVersion: "1.0.0",
    runId,
    stageId: stage.stageId,
    expectedRevision,
    state: "passed",
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: stage.riskGate === "mandatory"
      ? {
          gateVerdict: "PASS",
          auditorId: "independent-auditor",
          implementationActorIds: ["implementation-agent"],
          auditTarget: "commit:fixture-target",
          currentTarget: "commit:fixture-target",
          phase: "post-execution",
          freshContext: true,
          delegationAllowed: false,
          blockingFindings: [],
          stale: false,
          postExecutionVerified: true,
        }
      : stage.requiredArtifacts.includes("decision-record")
        ? { decisionRecord: structuredClone(validDecisionRecord) }
        : { accepted: true },
      artifacts: artifactIds.map((artifactId) => ({
        artifactId,
        schemaId: "fixture/v1",
        locator: `tests/${stage.stageId}/${artifactId}.json`,
        digest: "a".repeat(64),
        targetDigest: "b".repeat(64),
        verified: true,
      })),
      error: null,
    },
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

  it("creates one stage when one provider satisfies multiple requested capabilities", async () => {
    const { service } = await createService();
    const result = service.planWorkflow(task({
      taskId: "deduplicated-provider",
      riskLevel: "low",
      requiredCapabilities: ["task-decomposition"],
      decision: { complexity: "simple", hasConflicts: false },
    }));

    const coordinationStages = result.data?.stages.filter((stage) => stage.skillId === "thread-conductor") ?? [];
    expect(coordinationStages).toHaveLength(1);
    expect(coordinationStages[0]?.satisfiedCapabilities).toEqual([
      "subagent-coordination",
      "task-decomposition",
    ]);
  });

  it("re-reads the runtime registry for each new plan", async () => {
    const { service, registryPath } = await createService();
    expect(service.planWorkflow(task({ taskId: "first" })).data?.selectedSkills).toContain("draft-specialist");

    const replacement = skills.map((skill) => skill.skillId === "draft-specialist" ? { ...skill, skillId: "replacement-drafter", path: "./replacement-drafter" } : skill);
    await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: replacement }), "utf8");

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
    missingArtifact.output.artifacts = [{ ...missingArtifact.output.artifacts[0]!, artifactId: "wrong-artifact" }];
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
    missingProducedArtifact.output.artifacts = [{ ...missingProducedArtifact.output.artifacts[0]!, artifactId: "wrong-artifact" }];

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
          output: {
            schemaVersion: "1.0.0",
            kind: "output",
            output: { gateVerdict: "FAIL" },
            artifacts: [],
            error: { code: "GATE_FAILED", message: "Independent audit failed.", details: null },
          },
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

  it("keeps bootstrap providers before planning and isolates recovery workflows", async () => {
    const { service } = await createService([
      ...skills,
      {
        ...descriptor({ id: "instruction-reader", capabilities: ["instruction-scope-resolution"], phase: "instruction-resolution", phaseOrder: 10, riskGate: "none", priority: 10, producedArtifacts: ["instruction-scope-resolution"] }),
        providers: [{
          ...descriptor({ id: "instruction-reader", capabilities: ["instruction-scope-resolution"], phase: "instruction-resolution", phaseOrder: 10, riskGate: "none", priority: 10, producedArtifacts: ["instruction-scope-resolution"] }).providers[0]!,
          executionClass: "bootstrap",
        }],
      },
    ]);
    const bootstrap = service.planWorkflow(task({
      taskId: "bootstrap-stage-rejected",
      riskLevel: "low",
      workUnits: [],
      requiredCapabilities: ["instruction-scope-resolution"],
      decision: { complexity: "simple", hasConflicts: false },
    }));
    expect(bootstrap.data?.state).toBe("blocked");
    expect(bootstrap.data?.errors[0]?.code).toBe("GATE_FAILED");

    const recovery = service.planWorkflow(task({
      taskId: "recovery-only",
      riskLevel: "low",
      workUnits: [],
      requiredCapabilities: ["blocker-diagnosis"],
      decision: { complexity: "simple", hasConflicts: false },
    }));
    expect(recovery.data?.stages).toHaveLength(1);
    expect(recovery.data?.stages[0]).toMatchObject({ executionClass: "recovery", requiredCapability: "blocker-diagnosis" });

    const mixed = service.planWorkflow(task({
      taskId: "mixed-recovery",
      riskLevel: "low",
      workUnits: [],
      requiredCapabilities: ["blocker-diagnosis", "draft"],
      decision: { complexity: "simple", hasConflicts: false },
    }));
    expect(mixed.data?.state).toBe("blocked");
    expect(mixed.data?.errors.some((error) => error.code === "INVALID_TRANSITION")).toBe(true);
  });

  it("rejects provider schemas changed after planning", async () => {
    const { service, rootDirectory } = await createService();
    const plan = service.planWorkflow(task({
      taskId: "stale-provider-schema",
      riskLevel: "low",
      workUnits: [],
      requiredCapabilities: ["draft"],
      decision: { complexity: "simple", hasConflicts: false },
    })).data!;
    const receipt = service.startWorkflow(plan).data!;
    const schemaPath = join(rootDirectory, "contracts", "provider-result.v1.schema.json");
    const original = readFileSync(schemaPath, "utf8");
    await writeFile(schemaPath, `${original}\n`, "utf8");
    expect(service.recordStageResult(passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision)).error?.code)
      .toBe("STALE_REVISION");
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

  it("moves an explicitly requested audit to the final stage at every risk level", async () => {
    const { service } = await createService();
    for (const riskLevel of ["low", "medium"] as const) {
      const plan = service.planWorkflow(task({
        taskId: `explicit-audit-${riskLevel}`,
        riskLevel,
        decision: { complexity: "simple", hasConflicts: false },
        requiredCapabilities: ["independent-audit", "draft"],
      }));

      expect(plan.data?.stages.map((stage) => stage.requiredCapability)).toEqual([
        "subagent-coordination",
        "draft",
        "independent-audit",
      ]);
    }
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
    failingVerdict.output = {
      ...failingVerdict.output,
      output: { ...failingVerdict.output.output, gateVerdict: "FAIL" },
      error: { code: "GATE_FAILED", message: "Independent audit failed.", details: null },
    };
    failingVerdict.state = "failed";
    failingVerdict.error = failingVerdict.output.error;
    const failedReceipt = service.recordStageResult(failingVerdict);
    expect(failedReceipt.data?.state).toBe("failed");

    const { service: independentService } = await createService();
    let independentReceipt = independentService.startWorkflow(independentService.planWorkflow(task({ taskId: "self-audit" })).data!).data!;
    for (const stage of independentReceipt.plan.stages.filter((item) => item.riskGate !== "mandatory")) {
      independentReceipt = independentService.recordStageResult(passedStage(independentReceipt.runId, stage, independentReceipt.revision)).data!;
    }
    const independentAuditStage = independentReceipt.plan.stages.find((stage) => stage.riskGate === "mandatory")!;
    const selfAudited = passedStage(independentReceipt.runId, independentAuditStage, independentReceipt.revision);
    selfAudited.output = {
      ...selfAudited.output,
      output: { ...selfAudited.output.output, auditorId: "implementation-agent", implementationActorIds: ["implementation-agent"] },
    };
    expect(independentService.recordStageResult(selfAudited).error?.code).toBe("GATE_FAILED");
  });

  it("rejects deliberation without an eligible DecisionRecord", async () => {
    const { service } = await createService();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    const coordination = receipt.plan.stages[0]!;
    receipt = service.recordStageResult(passedStage(receipt.runId, coordination, receipt.revision)).data!;
    const deliberation = receipt.plan.stages.find((stage) => stage.requiredArtifacts.includes("decision-record"))!;

    const missing = passedStage(receipt.runId, deliberation, receipt.revision);
    missing.output = { ...missing.output, output: { accepted: true } };
    expect(service.recordStageResult(missing).error?.code).toBe("GATE_FAILED");

    const provisional = passedStage(receipt.runId, deliberation, receipt.revision);
    const provisionalRecord = structuredClone(validDecisionRecord) as Record<string, unknown> & {
      run: Record<string, unknown>;
    };
    provisionalRecord.run.assurance = "provisional";
    provisional.output = { ...provisional.output, output: { decisionRecord: provisionalRecord } };
    expect(service.recordStageResult(provisional).error?.code).toBe("GATE_FAILED");
  });

  it("validates a replacement deliberation provider without a hardcoded skill path", async () => {
    const replacementSkills = skills.map((skill) => skill.skillId === "reasoning-panel"
      ? { ...skill, skillId: "alternate-reasoner", path: "./alternate-reasoner" }
      : skill);
    const { service } = await createService(replacementSkills);
    let receipt = service.startWorkflow(service.planWorkflow(task({ taskId: "alternate-deliberation" })).data!).data!;
    receipt = service.recordStageResult(passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision)).data!;
    const deliberation = receipt.plan.stages.find((stage) => stage.skillId === "alternate-reasoner")!;

    const accepted = service.recordStageResult(passedStage(receipt.runId, deliberation, receipt.revision));
    expect(accepted.ok).toBe(true);
    expect(accepted.data?.stageResults.at(-1)?.state).toBe("passed");
  });

  it("rejects incomplete or stale mandatory audit handoffs", async () => {
    const { service } = await createService();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    for (const stage of receipt.plan.stages.filter((item) => item.riskGate !== "mandatory")) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }
    const auditStage = receipt.plan.stages.find((stage) => stage.riskGate === "mandatory")!;

    const missingSafetyFields = passedStage(receipt.runId, auditStage, receipt.revision);
    missingSafetyFields.output = {
      ...missingSafetyFields.output,
      output: {
        gateVerdict: "PASS",
        auditorId: "independent-auditor",
        implementationActorIds: ["implementation-agent"],
      },
    };
    expect(service.recordStageResult(missingSafetyFields).error?.code).toBe("GATE_FAILED");

    const stale = passedStage(receipt.runId, auditStage, receipt.revision);
    stale.output = { ...stale.output, output: { ...stale.output.output, stale: true } };
    expect(service.recordStageResult(stale).error?.code).toBe("GATE_FAILED");

    const wrongTarget = passedStage(receipt.runId, auditStage, receipt.revision);
    wrongTarget.output = { ...wrongTarget.output, output: { ...wrongTarget.output.output, currentTarget: "commit:changed-after-audit" } };
    expect(service.recordStageResult(wrongTarget).error?.code).toBe("GATE_FAILED");
  });

  it("matches the canonical semantic verdict for every DecisionRecord fixture", () => {
    const valid = decisionRecordFixtures(validDecisionRecordDirectory);
    const invalid = decisionRecordFixtures(invalidDecisionRecordDirectory);
    expect(valid).toHaveLength(24);
    expect(invalid).toHaveLength(24);
    for (const fixture of valid) {
      expect(validateDecisionRecordSemantics(fixture.record), fixture.name).toEqual([]);
    }
    for (const fixture of invalid) {
      expect(validateDecisionRecordSemantics(fixture.record).length, fixture.name).toBeGreaterThan(0);
    }

    const reordered = structuredClone(validDecisionRecord) as Record<string, unknown> & {
      panel_manifest: Array<Record<string, unknown>>;
    };
    reordered.panel_manifest = reordered.panel_manifest.map((worker) => Object.fromEntries(
      Object.entries(worker).reverse(),
    ));
    expect(validateDecisionRecordSemantics(reordered), "object key order must not affect parity").toEqual([]);
 });

  it("rejects every canonical invalid DecisionRecord at the MCP gate", async () => {
    for (const fixture of decisionRecordFixtures(invalidDecisionRecordDirectory)) {
      const { service } = await createService();
      let receipt = service.startWorkflow(service.planWorkflow(task({ taskId: `invalid-${fixture.name}` })).data!).data!;
      receipt = service.recordStageResult(passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision)).data!;
      const deliberation = receipt.plan.stages.find((stage) => stage.requiredArtifacts.includes("decision-record"))!;
      const result = passedStage(receipt.runId, deliberation, receipt.revision);
      result.output = { ...result.output, output: { decisionRecord: fixture.record } };
      expect(service.recordStageResult(result).error?.code, fixture.name).toBe("GATE_FAILED");
    }
  }, 30_000);
});
