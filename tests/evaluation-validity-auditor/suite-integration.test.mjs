import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { assertTaskEnvelope } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { analyzeEvaluation, sha256Canonical } from "../../skills/evaluation-validity-auditor/scripts/core.mjs";
import { validateTaskContract } from "../../skills/task-contract/scripts/validate-task-contract.mjs";
import { makeFixture, makePostFixture, rawDigest } from "./fixture.mjs";

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
    artifactContracts: [{
      capability: "evaluation-validity-audit",
      produced: ["evaluation-validity-report", "verified-evaluation-evidence-index"].map((artifactId) => ({
        artifactId, schemaId: "schema://evaluation-validity/report-v1", targetDigest: rawDigest("candidate-v1"),
      })),
    }],
    constraints: ["Keep receipt output reference-only."],
    authorization: { allowedActions: ["read"], prohibitedActions: ["write"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function planRequest(taskEnvelope = task(), evaluationAuditPurpose = "quality-or-release") {
  return { schemaVersion: "1.0.0", taskEnvelope, evaluationAuditPurpose };
}

// A schema-valid report rewritten to claim PASS, with its blocking evidence removed and its digest recomputed.
function forgedPass(report) {
  const forged = structuredClone(report);
  forged.verdict = "PASS";
  forged.qualifiesAsQualityOrReleaseEvidence = forged.auditStage === "post-execution";
  forged.limitations = forged.limitations.filter((item) => item !== "COOPERATIVE_PROVENANCE_ASSERTIONS");
  forged.blockingCodes = [];
  Object.assign(forged.checks.find((item) => item.checkId === "ROLE_INDEPENDENCE"), { status: "PASS", code: "CHECK_PASSED" });
  delete forged.reportDigest;
  return { ...forged, reportDigest: sha256Canonical(forged) };
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

  it("records the suite-managed v1.0.0 checksum without external provenance", () => {
    const lock = JSON.parse(readFileSync(new URL("../../skills/source-lock.json", import.meta.url), "utf8"));
    const source = lock.sources.find((candidate) => candidate.skillId === "evaluation-validity-auditor");
    expect(source).toMatchObject({ updatePolicy: "internal" });
    expect(source).not.toHaveProperty("source");
    expect(source).not.toHaveProperty("ref");
    expect(source).not.toHaveProperty("upstreamChecksum");
    expect(source.integratedChecksum).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("records an unobserved-independence post-execution report as blocked and still rejects free text (D0336)", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const fixture = await makePostFixture();
    const report = await analyzeEvaluation(fixture.post, { artifactRoot: fixture.root });
    expect(report.verdict).toBe("BLOCKED");
    let receipt = service.startWorkflow(service.planWorkflow(planRequest()).data).data;
    expect(receipt.plan.stages).toHaveLength(1);
    const blocked = service.recordStageResult(stageResult(receipt, report, "blocked"));
    expect(blocked).toMatchObject({ ok: true, data: { state: "blocked", error: { code: "MISSING_EVIDENCE" } } });
    expect(service.getWorkflowStatus(receipt.runId).data.stageResults.map((item) => item.state)).toEqual(["blocked"]);
    expect(service.finalizeWorkflow(receipt.runId, blocked.data.revision).ok).toBe(false);
    expect(service.getWorkflowStatus(receipt.runId).data.state).toBe("blocked");

    receipt = service.startWorkflow(service.planWorkflow(planRequest({ ...task(), taskId: "unsafe-evaluation-validity-integration" })).data).data;
    const unsafe = structuredClone(report);
    unsafe.target.revision = "release candidate prose";
    const rejected = service.recordStageResult(stageResult(receipt, unsafe, "blocked"));
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.message).toBe("Reference-only receipt policy rejected free text.");
  });

  it("rejects a forged PASS for either purpose with the unobserved independence cause (D0336)", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const pre = await makeFixture();
    const post = await makePostFixture();
    const cases = [
      ["design-readiness", forgedPass(await analyzeEvaluation(pre.base, { artifactRoot: pre.root }))],
      ["quality-or-release", forgedPass(await analyzeEvaluation(post.post, { artifactRoot: post.root }))],
    ];
    for (const [purpose, forged] of cases) {
      expect(forged.verdict).toBe("PASS");
      const receipt = service.startWorkflow(service.planWorkflow(planRequest(task(), purpose)).data).data;
      const rejected = service.recordStageResult(stageResult(receipt, forged));
      expect(rejected.ok).toBe(false);
      expect(rejected.error).toMatchObject({ code: "GATE_FAILED", details: { cause: "WORKER_INDEPENDENCE_UNOBSERVED", purpose, verdict: "PASS" } });
      const status = service.getWorkflowStatus(receipt.runId).data;
      expect(status.stageResults).toHaveLength(0);
      expect(status.revision).toBe(receipt.revision);
    }
  });

  it("does not finalize a passed stage recorded by earlier code (D0336)", async () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    const fixture = await makePostFixture();
    const forged = forgedPass(await analyzeEvaluation(fixture.post, { artifactRoot: fixture.root }));
    const receipt = service.startWorkflow(service.planWorkflow(planRequest()).data).data;
    // Stand in for the earlier record gate that accepted this PASS, then restore the current one for finalization.
    const currentGate = service.assertEvaluationValidityGate;
    service.assertEvaluationValidityGate = () => undefined;
    const earlier = service.recordStageResult(stageResult(receipt, forged));
    service.assertEvaluationValidityGate = currentGate;
    expect(earlier.ok, earlier.error?.message).toBe(true);
    expect(earlier.data.stageResults.map((item) => item.state)).toEqual(["passed"]);
    const finalized = service.finalizeWorkflow(receipt.runId, earlier.data.revision);
    expect(finalized.ok).toBe(false);
    expect(finalized.error).toMatchObject({ code: "GATE_FAILED", details: { cause: "WORKER_INDEPENDENCE_UNOBSERVED" } });
    expect(service.getWorkflowStatus(receipt.runId).data.state).not.toBe("passed");
  });

  it("freezes the audit purpose in the signed plan", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const service = new WorkflowService(registry, new ContractValidator());
    let plan = service.planWorkflow(planRequest(task(), "design-readiness")).data;
    expect(plan.stages[0].evaluationAuditPurpose).toBe("design-readiness");

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
