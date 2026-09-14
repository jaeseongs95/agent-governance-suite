import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { assertTaskEnvelope } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { analyzeEvaluation } from "../../skills/evaluation-validity-auditor/scripts/core.mjs";
import { validateTaskContract } from "../../skills/task-contract/scripts/validate-task-contract.mjs";
import { makeFixture, makePostFixture } from "./fixture.mjs";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

function task() {
  return {
    schemaVersion: "1.0.0",
    taskId: "evaluation-validity-integration",
    objective: "Audit frozen evaluation evidence before it is used as release evidence.",
    scope: { included: ["evaluation evidence"], excluded: ["evaluation execution"] },
    acceptanceCriteria: ["Require a post-execution PASS."],
    riskLevel: "low",
    workUnits: [],
    requiredCapabilities: ["evaluation-validity-audit"],
    constraints: ["Keep receipt output reference-only."],
    authorization: { allowedActions: ["read"], prohibitedActions: ["write"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function planRequest(taskEnvelope = task(), evaluationAuditPurpose = "quality-or-release") {
  return { schemaVersion: "1.0.0", taskEnvelope, evaluationAuditPurpose };
}

function stageResult(receipt, report, state = "passed") {
  const stage = receipt.plan.stages[0];
  const errorCode = state === "failed" ? "GATE_FAILED" : state === "blocked" ? "MISSING_EVIDENCE" : null;
  const error = errorCode === null ? null : { code: errorCode, message: errorCode, details: null };
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state,
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: report,
      artifacts: stage.producedArtifacts.map((artifactId) => ({
        artifactId,
        schemaId: "schema://evaluation-validity/report-v1",
        locator: `artifact://evaluation-validity/${artifactId}`,
        digest: report.reportDigest,
        targetDigest: report.target.digest,
        verified: true,
      })),
      error,
    },
    evidence: stage.requiredInputArtifacts.map((artifactId) => ({
      artifactId,
      kind: "document",
      locator: `artifact://evaluation-validity/input/${artifactId}`,
      verified: true,
      note: "",
    })),
    findings: [],
    blockers: [],
    error,
  };
}

describe("evaluation-validity-auditor suite descriptor", () => {
  it("selects only its explicit capability at phase order 68 with the conditional gate", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const provider = registry.read().find((candidate) => candidate.skillId === "evaluation-validity-auditor");
    expect(provider).toMatchObject({
      version: "1.0.0",
      capabilities: ["evaluation-validity-audit"],
      phase: "evaluation-validity",
      phaseOrder: 68,
      gate: { kind: "completion", policy: "conditional" },
      receiptPolicy: { mode: "reference-only", actorIdPointer: "/output/auditorActorId", uniqueness: "run" },
    });
    expect(provider.selectionCriteria).toEqual([
      "explicit-evaluation-validity-audit",
      "evaluation-result-used-as-quality-or-release-evidence",
    ]);
  });

  it("pins the unmodified v1.0.0 tag commit and checksum with auto-pr updates", () => {
    const lock = JSON.parse(readFileSync(new URL("../../skills/source-lock.json", import.meta.url), "utf8"));
    const source = lock.sources.find((candidate) => candidate.skillId === "evaluation-validity-auditor");
    expect(source).toMatchObject({
      ref: { kind: "tag", value: "v1.0.0", commit: "d1d564462ae93e205b27bcc1443ee17d04a97dcf" },
      updatePolicy: "auto-pr",
      upstreamChecksum: "sha256:083ee804efcbe785ca87c6f7a1e20e5cd71732bcc44c7e8e8546336a412f8f24",
      integratedChecksum: "sha256:083ee804efcbe785ca87c6f7a1e20e5cd71732bcc44c7e8e8546336a412f8f24",
      downstreamModifications: [],
    });
  });

  it("accepts a safe post-execution PASS receipt and still rejects free text", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const fixture = await makePostFixture();
    const report = await analyzeEvaluation(fixture.post, { artifactRoot: fixture.root });
    let receipt = service.startWorkflow(service.planWorkflow(planRequest()).data).data;
    expect(receipt.plan.stages).toHaveLength(1);
    const accepted = service.recordStageResult(stageResult(receipt, report));
    expect(accepted.ok, accepted.error?.message).toBe(true);
    expect(service.finalizeWorkflow(receipt.runId, accepted.data.revision)).toMatchObject({
      ok: true,
      data: { state: "passed" },
    });

    receipt = service.startWorkflow(service.planWorkflow(planRequest({ ...task(), taskId: "unsafe-evaluation-validity-integration" })).data).data;
    const unsafe = structuredClone(report);
    unsafe.target.revision = "release candidate prose";
    const rejected = service.recordStageResult(stageResult(receipt, unsafe));
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toBe("Reference-only receipt policy rejected free text.");
  });

  it("freezes the audit purpose in the signed plan and enforces pre versus post completion", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const pre = await makeFixture();
    const preReport = await analyzeEvaluation(pre.base, { artifactRoot: pre.root });

    let plan = service.planWorkflow(planRequest(task(), "design-readiness")).data;
    expect(plan.stages[0].evaluationAuditPurpose).toBe("design-readiness");
    let receipt = service.startWorkflow(plan).data;
    const accepted = service.recordStageResult(stageResult(receipt, preReport));
    expect(accepted.ok, accepted.error?.message).toBe(true);
    expect(service.finalizeWorkflow(receipt.runId, accepted.data.revision).ok).toBe(true);

    plan = service.planWorkflow(planRequest(task(), "quality-or-release")).data;
    receipt = service.startWorkflow(plan).data;
    const rejected = service.recordStageResult(stageResult(receipt, preReport));
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("GATE_FAILED");
    expect(service.getWorkflowStatus(receipt.runId).data.stageResults).toHaveLength(0);

    plan = service.planWorkflow(planRequest(task(), "design-readiness")).data;
    plan.stages[0].evaluationAuditPurpose = "quality-or-release";
    expect(service.startWorkflow(plan).error?.code).toBe("INVALID_INPUT");
  });

  it("requires an explicit structured purpose for evaluation validity planning", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    expect(service.planWorkflow(task()).error?.code).toBe("INVALID_INPUT");
    expect(service.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope: task() }).error?.code).toBe("INVALID_INPUT");
  });

  it("keeps one evaluation TaskEnvelope compatible with task-contract and acceptance validation", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const contractInput = JSON.parse(readFileSync(
      new URL("../task-contract/fixtures/normal/simple-read.json", import.meta.url),
      "utf8",
    ));
    contractInput.report.taskEnvelope.requiredCapabilities = ["evaluation-validity-audit"];

    const validated = await validateTaskContract(contractInput);
    expect(() => assertTaskEnvelope(validated.taskEnvelope)).not.toThrow();
    const planned = service.planWorkflow(planRequest(validated.taskEnvelope, "design-readiness"));
    expect(planned.ok, planned.error?.message).toBe(true);
    expect(planned.data.stages[0].evaluationAuditPurpose).toBe("design-readiness");
  });

  it("maps FAIL and BLOCKED reports to their fixed workflow error states", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());

    const invalid = await makeFixture();
    invalid.base.criteria[0].judgmentMethods = ["self-report"];
    const failedReport = await analyzeEvaluation(invalid.base, { artifactRoot: invalid.root });
    let receipt = service.startWorkflow(service.planWorkflow(planRequest(task(), "design-readiness")).data).data;
    const failed = service.recordStageResult(stageResult(receipt, failedReport, "failed"));
    expect(failed).toMatchObject({ ok: true, data: { state: "failed", error: { code: "GATE_FAILED" } } });

    const incomplete = await makeFixture();
    incomplete.base.artifacts.find((item) => item.role === "rubric").provenance = null;
    const blockedReport = await analyzeEvaluation(incomplete.base, { artifactRoot: incomplete.root });
    receipt = service.startWorkflow(service.planWorkflow(planRequest(task(), "design-readiness")).data).data;
    const blocked = service.recordStageResult(stageResult(receipt, blockedReport, "blocked"));
    expect(blocked).toMatchObject({ ok: true, data: { state: "blocked", error: { code: "MISSING_EVIDENCE" } } });
  });
});
