import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { ExecutionContextV1, StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { workflowStatusSummary } from "../../mcp-server/src/response-projections.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { RuntimeSkillClassificationGateway } from "../../mcp-server/src/skill-classification/gateway.js";
import { type ExecutionObservationBindingV1, type SkillAdviceLookup, WorkflowService } from "../../mcp-server/src/workflow-service.js";

// 5.0.0: a run start names the skills it will use. 「필수로 제출하게 해.」 The MCP boundary (requireTrustedExecutionContext)
// refuses a start without them; advice is compared and never required; a missing call is shown and never blocks.
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const skills = [{ skillId: "code-review", reason: "the change needs a check" }, { skillId: "agent-governance-suite:test-engineering", reason: "regression" }];

let sequence = 0;
function service(): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, undefined, null, {
    observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 {
      sequence += 1;
      const observedAt = new Date();
      return {
        schemaVersion: "1.0.0", model: "fixture", modelClass: "deep", reasoningEffort: "high", source: "runtime",
        observedAt: observedAt.toISOString(), observationId: `skill-declaration-${String(sequence).padStart(6, "0")}`,
        taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId, revision: binding.revision,
        actorId: "fixture-actor", expiresAt: new Date(observedAt.getTime() + 60_000).toISOString(),
      };
    },
  });
}

function begin(workflow: WorkflowService, extra: Record<string, unknown>, requireSkills = true, adviceFor?: SkillAdviceLookup) {
  sequence += 1;
  const taskEnvelope: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: `skill-declaration-${sequence}`, objective: "Change a fixture.",
    scope: { included: ["fixture.md"], excluded: [] }, acceptanceCriteria: ["The fixture changes."], riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Change a fixture.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["minimal-implementation"], constraints: [],
    authorization: { allowedActions: [], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const frame = {
    schemaVersion: "1.0.0" as const, workspace: { workspaceId: "skill-declaration", locator: "fixture:skill-declaration" },
    controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
  const plan = workflow.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope }, true).data!;
  const root = workflow.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope, frame, userApprovalRefs: [] }).data!;
  const lease = workflow.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision, taskEnvelope, frame, plan, outputTargets: ["fixture.md"], priorFailure: null }, true).data!;
  return workflow.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan, ...extra }, requireSkills, undefined, adviceFor);
}

function passed(workflow: WorkflowService, extra: Record<string, unknown> = { skills }) {
  const receipt = begin(workflow, extra).data!;
  const stage = receipt.plan.stages[0]!;
  return workflow.recordStageResult({
    schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed",
    output: { schemaVersion: "1.0.0", kind: "output", output: { status: "passed", summary: "done" }, artifacts: [], error: null },
    evidence: [{ artifactId: "run-log", kind: "document", locator: "artifact://fixture/run-log", verified: true, note: "" }],
    findings: [], blockers: [], error: null,
  } as StageResultV1, true).data!;
}

describe("a run start names its skills", () => {
  it("is refused at the MCP boundary without them, and nothing starts", () => {
    const refused = begin(service(), {});
    expect(refused.data).toBeNull();
    expect(refused.error).toMatchObject({ code: "INVALID_INPUT", details: { field: "skills", reason: "SKILLS_REQUIRED" } });
  });

  it("does not ask an embedding caller, which has no agent choosing skills", () => {
    const started = begin(service(), {}, false);
    expect(started.error).toBeNull();
    expect(started.data!.skillDeclaration).toBeUndefined();
  });

  it.each([
    ["an empty list", []],
    ["a duplicate", [skills[0], skills[0]]],
    ["a blank reason", [{ skillId: "code-review", reason: "  " }]],
    ["no reason", [{ skillId: "code-review" }]],
    ["33 skills", Array.from({ length: 33 }, (_, index) => ({ skillId: `skill-${index}`, reason: "r" }))],
    ["the same skill under two spellings", [{ skillId: "code-review", reason: "r" }, { skillId: "agent-governance-suite:code-review", reason: "r" }]],
    ["an empty name after a package prefix", [{ skillId: "agent-governance-suite:", reason: "r" }]],
    ["a placeholder instead of a choice", [{ skillId: "none", reason: "n/a" }]],
  ])("refuses %s", (_label, value) => {
    expect(begin(service(), { skills: value }).error).toMatchObject({ code: "INVALID_INPUT", details: { field: "skills", reason: "SKILLS_REQUIRED" } });
  });

  it("takes as many as apply, a skill outside AGS among them, and records them on the run", () => {
    const ten = [{ skillId: "code-review", reason: "applies" }, ...Array.from({ length: 9 }, (_, index) => ({ skillId: `other-plugin:skill-${index}`, reason: "applies" }))];
    const started = begin(service(), { skills: ten });
    expect(started.error).toBeNull();
    expect(started.data!.skillDeclaration).toEqual({ skills: ten, advice: null });
  });
});

describe("advice is compared, never required", () => {
  const advice: SkillAdviceLookup = operationId => operationId === "op-1" ? { adviser: "any-profile", recommendedSkillIds: ["code-review", "solid-design"] } : null;

  it("records what was adopted, added and not adopted, with a host's package prefix ignored", () => {
    const started = begin(service(), { skills, classificationOperationId: "op-1" }, true, advice);
    expect(started.data!.skillDeclaration!.advice).toEqual({
      operationId: "op-1", available: true, adviser: "any-profile",
      adopted: ["code-review"], added: ["test-engineering"], notAdopted: ["solid-design"],
    });
  });

  it("starts with no usable advice and says so", () => {
    const started = begin(service(), { skills, classificationOperationId: "expired" }, true, advice);
    expect(started.error).toBeNull();
    expect(started.data!.skillDeclaration!.advice).toEqual({ operationId: "expired", available: false });
  });

  it("keeps only a finished classification's needed skills as advice", () => {
    const gateway = new RuntimeSkillClassificationGateway({ root: fileURLToPath(new URL("../../", import.meta.url)), service: {} as never, readRuntime: async () => ({}) as never });
    const operations = (gateway as unknown as { operations: Map<string, unknown> }).operations;
    const held = (status: string, error: unknown) => ({ result: { attempts: [{ profileId: "profile-1" }], response: { status, error, judgments: [
      { skillId: "a", judgment: "needed" }, { skillId: "b", judgment: "not-needed" }, { skillId: "c", judgment: "uncertain" }] } } });
    operations.set("good", held("PARTIAL", null));
    operations.set("failed", held("UNAVAILABLE", { code: "X" }));
    expect(gateway.advice("good")).toEqual({ adviser: "profile-1", recommendedSkillIds: ["a"] });
    expect(gateway.advice("failed")).toBeNull();
    expect(gateway.advice("unknown")).toBeNull();
  });
});

describe("a declared skill with no call seen is shown and does not block", () => {
  it("names it on the receipt and in the summary, matching a prefixed declaration by its own name", () => {
    const workflow = service();
    const receipt = passed(workflow);
    const finished = workflow.finalizeWorkflow(receipt.runId, receipt.revision, () => new Set(["test-engineering"]));
    expect(finished.error).toBeNull();
    expect(finished.data!.state).toBe("passed");
    expect(finished.data!.skillDeclaration!.callsNotObserved).toEqual(["code-review"]);
    expect(workflowStatusSummary(finished.data!).declaredSkillsNotObserved).toEqual(["code-review"]);
  });

  it("adds nothing to the summary when every call was seen", () => {
    const workflow = service();
    const receipt = passed(workflow);
    const finished = workflow.finalizeWorkflow(receipt.runId, receipt.revision, () => new Set(["code-review", "test-engineering"]));
    expect(finished.data!.skillDeclaration!.callsNotObserved).toEqual([]);
    expect(workflowStatusSummary(finished.data!)).not.toHaveProperty("declaredSkillsNotObserved");
  });

  it("finishes and says the record could not be read", () => {
    const workflow = service();
    const receipt = passed(workflow);
    const finished = workflow.finalizeWorkflow(receipt.runId, receipt.revision, () => null);
    expect(finished.data!.state).toBe("passed");
    expect(finished.data!.skillDeclaration!.callsNotObserved).toBeNull();
    expect(workflowStatusSummary(finished.data!).declaredSkillsNotObserved).toBeNull();
  });
});
