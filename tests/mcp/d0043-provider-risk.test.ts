import { createHmac } from "node:crypto";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ConvergenceFrameV1, ExecutionContextV1, RiskLevel, SkillDescriptorV2, StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { canonicalJson } from "../../mcp-server/src/convergence-logic.js";
import { WorkflowService, type TrustedExecutionContextProvider } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore, PLAN_SIGNING_KEY } from "../../mcp-server/src/workflow-store.js";

const directories: string[] = [];
const context: ExecutionContextV1 = {
  schemaVersion: "1.0.0", model: "fixture", modelClass: "general", reasoningEffort: "high",
  source: "runtime", observedAt: "2026-09-14T00:00:00.000Z",
};

function descriptor(id: string, capabilities: string[], risk?: RiskLevel): SkillDescriptorV2 {
  return {
    schemaVersion: "2.0.0", skillId: id, version: "1.0.0", path: `./${id}`, priority: 10, enabled: true,
    providers: [{
      capabilities, executionClass: "workflow", ...(risk === undefined ? {} : { executionRiskLevel: risk }),
      phase: "execution", phaseOrder: 50, requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [],
      outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
      stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"] },
      selectionCriteria: ["capability match"], preconditions: [], failureHandling: "Return a structured result.",
      gate: { kind: "none", policy: "none", validator: null },
    }],
  };
}

function task(riskLevel: RiskLevel, requiredCapabilities: string[]): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0", taskId: "d0043-test", objective: "Check registered execution risk.",
    scope: { included: ["fixture"], excluded: [] }, acceptanceCriteria: ["Preserve the execution floor."],
    riskLevel, workUnits: [], requiredCapabilities, constraints: [],
    authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
}

async function harness(
  descriptors: SkillDescriptorV2[], trustedProvider: TrustedExecutionContextProvider | null = null,
  store?: InMemoryWorkflowStore,
) {
  const root = await mkdtemp(join(tmpdir(), "d0043-risk-"));
  directories.push(root);
  await mkdir(join(root, "skills"));
  await mkdir(join(root, "contracts"));
  for (const name of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json"]) {
    await copyFile(new URL(`../../contracts/${name}`, import.meta.url), join(root, "contracts", name));
  }
  const registryPath = join(root, "skills", "registry.json");
  const writeRegistry = () => writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: descriptors }), "utf8");
  await writeRegistry();
  const validator = new ContractValidator();
  const registry = new FileSkillRegistry(registryPath, validator);
  return { service: new WorkflowService(registry, validator, store, context, trustedProvider), registry, writeRegistry };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("D0043: 등록된 제공자의 실행 위험", () => {
  it("스키마는 위험 선언을 보존하고 잘못된 값은 거부한다", async () => {
    const candidate = descriptor("unlisted-provider", ["new-capability"], "high");
    const { registry, writeRegistry } = await harness([candidate]);
    expect(registry.read()[0]?.executionRiskLevel).toBe("high");
    (candidate.providers[0] as unknown as { executionRiskLevel: string }).executionRiskLevel = "unknown";
    await writeRegistry();
    expect(() => registry.read()).toThrow();
  });

  it.each([
    { taskRisk: "low", providerRisk: "high", expected: ["general", "high"] },
    { taskRisk: "medium", providerRisk: "critical", expected: ["general", "high"] },
    { taskRisk: "low", providerRisk: undefined, expected: [null, null] },
    { taskRisk: "high", providerRisk: "low", expected: ["general", "high"] },
    { taskRisk: "critical", providerRisk: "medium", expected: ["general", "high"] },
  ] as const)("task $taskRisk / provider $providerRisk 의 기존 하한을 보존한다", async ({ taskRisk, providerRisk, expected }) => {
    const selected = descriptor("unlisted-provider", ["new-capability"], providerRisk);
    const audit = descriptor("audit-fixture", ["independent-audit"]);
    const { service } = await harness([selected, audit]);
    const result = service.planWorkflow(task(taskRisk, ["new-capability"]));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages.find((stage) => stage.skillId === "unlisted-provider")?.executionRequirement).toMatchObject({
      kind: "semantic", minimumModelClass: expected[0], minimumReasoningEffort: expected[1], observationRequired: true,
    });
  });

  it("제공자별 요구는 분리되고 gate 정책 변경은 실행 하한을 바꾸지 않는다", async () => {
    const high = descriptor("high-provider", ["new-capability"], "high");
    const ordinary = descriptor("ordinary-provider", ["other-capability"]);
    const { service, writeRegistry } = await harness([high, ordinary]);
    const input = task("low", ["new-capability", "other-capability"]);
    const plan = service.planWorkflow(input).data!;
    expect(plan.stages.find((stage) => stage.skillId === "high-provider")?.executionRequirement).toMatchObject({
      minimumModelClass: "general", minimumReasoningEffort: "high",
    });
    expect(plan.stages.find((stage) => stage.skillId === "ordinary-provider")?.executionRequirement).toMatchObject({
      minimumModelClass: null, minimumReasoningEffort: null,
    });
    high.providers[0]!.gate = { kind: "precondition", policy: "conditional", validator: null };
    await writeRegistry();
    const changed = service.planWorkflow(input).data!;
    expect(changed.stages.find((stage) => stage.skillId === "high-provider")?.executionRequirement)
      .toEqual(plan.stages.find((stage) => stage.skillId === "high-provider")?.executionRequirement);
  });

  it.each([
    ["korean-prose-finalization", "new-capability"],
    ["new-capability", "korean-prose-finalization"],
  ])("혼합 제공자는 capability 순서에 무관하게 의미 기반 하한을 적용한다: %s, %s", async (first, second) => {
    const { service } = await harness([descriptor("mixed-provider", [first, second], "high")]);
    const result = service.planWorkflow(task("low", [first, second]));
    expect(result.ok, result.error?.message).toBe(true);
    expect(result.data!.stages).toHaveLength(1);
    expect(result.data!.stages[0]!.executionRequirement).toMatchObject({
      kind: "semantic", minimumModelClass: "general", minimumReasoningEffort: "high", observationRequired: true,
    });
  });

  it("위험 선언이 없는 혼합 단계도 결정적 capability만으로 축소하지 않는다", async () => {
    const capabilities = ["korean-prose-finalization", "new-capability"];
    const { service } = await harness([descriptor("mixed-provider", capabilities)]);
    const plan = service.planWorkflow(task("low", capabilities));
    expect(plan.ok, plan.error?.message).toBe(true);
    expect(plan.data!.stages[0]!.executionRequirement).toMatchObject({ kind: "semantic", observationRequired: true });
  });

  it("단일 결정적 단계와 별도 제공자 단계의 기존 경계를 보존한다", async () => {
    const { service } = await harness([
      descriptor("deterministic-provider", ["korean-prose-finalization"], "high"),
      descriptor("ordinary-provider", ["new-capability"]),
    ]);
    const result = service.planWorkflow(task("low", ["korean-prose-finalization", "new-capability"]));
    expect(result.ok, result.error?.message).toBe(true);
    const deterministic = result.data!.stages.find((stage) => stage.skillId === "deterministic-provider")!;
    const ordinary = result.data!.stages.find((stage) => stage.skillId === "ordinary-provider")!;
    expect(deterministic.executionRequirement).toMatchObject({ kind: "deterministic", observationRequired: false });
    expect(ordinary.executionRequirement).toMatchObject({ kind: "semantic", minimumModelClass: null, minimumReasoningEffort: null });
  });

  it("등록 하한이 바뀐 이전 계획은 claim을 거절하고 새 계획은 새 요구를 반영한다", async () => {
    const candidate = descriptor("unlisted-provider", ["new-capability"], "high");
    const { service, writeRegistry } = await harness([candidate]);
    const input = task("low", ["new-capability"]);
    const oldPlan = service.planWorkflow(input).data!;
    const frame: ConvergenceFrameV1 = {
      schemaVersion: "1.0.0", workspace: { workspaceId: "d0043-fixture", locator: "fixture:workspace" },
      controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
      targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
      operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
    };
    const root = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: input, frame, userApprovalRefs: [] }).data!;
    const proposal = {
      schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision,
      taskEnvelope: input, frame, plan: oldPlan, outputTargets: ["fixture.md"], priorFailure: null,
    };
    candidate.providers[0]!.executionRiskLevel = "low";
    await writeRegistry();
    expect(service.claimWorkflowAttempt(proposal).error?.code).toBe("LEASE_CONFLICT");
    const newPlan = service.planWorkflow(input).data!;
    expect(newPlan.stages[0]!.executionRequirement).toMatchObject({ minimumModelClass: null, minimumReasoningEffort: null });
    const claimed = service.claimWorkflowAttempt({ ...proposal, plan: newPlan });
    expect(claimed.ok, claimed.error?.message).toBe(true);
    const started = service.startGuardedWorkflow({
      schemaVersion: "1.0.0", leaseId: claimed.data!.leaseId, expectedRootRevision: claimed.data!.rootRevision, plan: newPlan,
    });
    expect(started.ok, started.error?.message).toBe(true);
    expect(started.data!.plan.stages[0]!.executionRequirement).toEqual(newPlan.stages[0]!.executionRequirement);
  });

  it("기존 서명 계획에 혼합 단계 요구가 누락되면 엄격한 claim과 결과 기록에서 거절한다", async () => {
    const signingKey = Buffer.alloc(32, 9).toString("base64url");
    const store = new InMemoryWorkflowStore();
    store.getOrCreateSecret(PLAN_SIGNING_KEY, () => signingKey);
    const capabilities = ["korean-prose-finalization", "new-capability"];
    const provider: TrustedExecutionContextProvider = {
      observe: (binding) => ({
        ...context, observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
        observationId: "d0043-legacy-bootstrap-observation", actorId: "fixture-actor",
        taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId, revision: binding.revision,
      }),
    };
    const { service } = await harness([descriptor("mixed-provider", capabilities)], provider, store);
    const input = task("low", capabilities);
    const plan = service.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope: input }, true).data!;
    expect(plan.bootstrapExecution).toBeDefined();
    expect(plan.stages[0]!.requiredCapability).toBe("korean-prose-finalization");
    delete plan.stages[0]!.executionRequirement;
    // 시험 소유 키로 기존 서명 계획을 재현한다. 운영 호출자의 서명 권한을 뜻하지 않는다.
    const unsigned = { ...plan } as Record<string, unknown>;
    delete unsigned.integrityToken;
    plan.integrityToken = createHmac("sha256", Buffer.from(signingKey, "base64url"))
      .update(canonicalJson(unsigned)).digest("base64url");
    const frame: ConvergenceFrameV1 = {
      schemaVersion: "1.0.0", workspace: { workspaceId: "d0043-legacy", locator: "fixture:workspace" },
      controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
      targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
      operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
    };
    const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: input, frame, userApprovalRefs: [] });
    expect(opened.ok, opened.error?.message).toBe(true);
    const claim = service.claimWorkflowAttempt({
      schemaVersion: "1.0.0", rootId: opened.data!.rootId, expectedRevision: opened.data!.revision,
      taskEnvelope: input, frame, plan, outputTargets: ["fixture.md"], priorFailure: null,
    }, true);
    expect(claim.error?.code).toBe("BINDING_REQUIRED");
    expect(claim.error?.message).toContain("Workflow attempt stage");

    const started = service.startWorkflow(plan);
    expect(started.ok, started.error?.message).toBe(true);
    const receipt = started.data!;
    const result: StageResultV1 = {
      schemaVersion: "1.0.0", runId: receipt.runId, stageId: receipt.plan.stages[0]!.stageId,
      expectedRevision: receipt.revision, state: "passed",
      output: { schemaVersion: "1.0.0", kind: "output", output: { accepted: true }, artifacts: [], error: null },
      evidence: [{ artifactId: "proof", kind: "test", locator: "fixture:proof", verified: true, note: "합성 시험" }],
      findings: [], blockers: [], error: null,
    };
    const recorded = service.recordStageResult(result, true);
    expect(recorded.error?.code).toBe("BINDING_REQUIRED");
    expect(recorded.error?.message).toContain("has no execution assurance requirement");
    expect(service.getWorkflowStatus(receipt.runId).data?.stageResults).toEqual([]);
  });

  // 3.9.0 (AGS3-D-0058): the signed plan keeps general/high as the recommendation, and a passed stage observed below it is
  // recorded with the observed class and effort instead of being refused.
  it("서명된 고위험 권장값을 유지하고 그보다 낮은 신뢰된 실제 단계 관측도 기록한다", async () => {
    let sequence = 0;
    const stageBelowFloor = true;
    const observedPhases: string[] = [];
    const trustedProvider: TrustedExecutionContextProvider = {
      observe: (binding) => {
        observedPhases.push(binding.phase);
        return {
          ...context, modelClass: binding.phase === "stage" && stageBelowFloor ? "lightweight" : "general",
          reasoningEffort: binding.phase === "stage" && stageBelowFloor ? "low" : "high",
          observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(),
          observationId: `d0043-observation-${++sequence}`, actorId: "fixture-actor",
          taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId, revision: binding.revision,
        };
      },
    };
    const { service } = await harness([descriptor("unlisted-provider", ["new-capability"], "high")], trustedProvider);
    const plan = service.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope: task("low", ["new-capability"]) }, true).data!;
    expect(plan.stages[0]!.executionRequirement).toMatchObject({
      kind: "semantic", minimumModelClass: "general", minimumReasoningEffort: "high", observationRequired: true,
    });
    const started = service.startWorkflow(plan).data!;
    const stage = started.plan.stages[0]!;
    const result: StageResultV1 = {
      schemaVersion: "1.0.0", runId: started.runId, stageId: stage.stageId, expectedRevision: started.revision,
      state: "passed",
      output: { schemaVersion: "1.0.0", kind: "output", output: { accepted: true }, artifacts: [], error: null },
      evidence: [{ artifactId: "proof", kind: "test", locator: "fixture:proof", verified: true, note: "합성 시험" }],
      findings: [], blockers: [], error: null,
    };
    const recorded = service.recordStageResult(result, true);
    expect(recorded.ok, recorded.error?.message).toBe(true);
    expect(recorded.data?.stageResults[0]?.executionContext).toMatchObject({ modelClass: "lightweight", reasoningEffort: "low" });
    expect(recorded.data?.plan.stages[0]?.executionRequirement).toMatchObject({ minimumModelClass: "general", minimumReasoningEffort: "high" });
    expect(observedPhases).toEqual(["bootstrap", "stage"]);
  });
});
