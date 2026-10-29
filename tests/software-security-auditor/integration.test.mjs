import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { digest, targetDigest } from "../../skills/software-security-auditor/scripts/core.mjs";
import { fixture, finding } from "./fixture.mjs";
import { analyzeAcceptance, assertTaskEnvelope } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";

const context = { schemaVersion: "1.0.0", model: "fixture-deep", modelClass: "deep", reasoningEffort: "high", source: "runtime", observedAt: new Date().toISOString() };
const task = (capabilities = ["software-security-audit"], artifactTarget = null) => ({ schemaVersion: "1.0.0", taskId: "security-integration", objective: "Produce security evidence", scope: { included: ["fixture"], excluded: [] }, acceptanceCriteria: ["Report uncertainty"], riskLevel: "low", workUnits: [], requiredCapabilities: capabilities, constraints: [], authorization: { allowedActions: ["read"], prohibitedActions: ["deploy"], approvalRequired: [] }, decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  ...(artifactTarget ? { artifactContracts: [{ capability: "software-security-audit", produced: [{ artifactId: "security-audit-report", schemaId: "SecurityAuditReport.v1", targetDigest: artifactTarget }] }] } : {}),
});
function service(tree = "") {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(fileURLToPath(new URL(`../../${tree}skills/registry.json`, import.meta.url)), validator), validator, undefined, context);
}
function result(receipt, report) {
  const stage = receipt.plan.stages[0]; const blocked = report.status === "blocked";
  const error = blocked ? { code: "MISSING_EVIDENCE", message: "missing evidence", details: null } : null;
  return { schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: blocked ? "blocked" : "passed", executionContext: context,
    output: { schemaVersion: "1.0.0", kind: "output", output: report, artifacts: [{ artifactId: "security-audit-report", schemaId: "SecurityAuditReport.v1", locator: "report.json", digest: digest(report), targetDigest: report.targetDigest, verified: true }], error },
    evidence: [{ artifactId: "security-audit-request", kind: "document", locator: "request.json", verified: true, note: "fixture only" }], findings: [], blockers: [], error };
}
describe("security audit integration", () => {
  it.each(["", "claude-plugin/"])("loads schema and maps complete report with findings in %s", (tree) => {
    const { request, report } = fixture();
    const svc = service(tree); const plan = svc.planWorkflow(task(undefined, targetDigest(request))); expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
    expect(plan.data.stages[0]).toMatchObject({ phase: "security-audit", executionRequirement: { minimumModelClass: null, minimumReasoningEffort: null, observationRequired: true } });
    const receipt = svc.startWorkflow(plan.data).data; report.findings.push(finding());
    const recorded = svc.recordStageResult(result(receipt, report)); expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true);
  });
  it("rejects semantic lies even with schema-valid fields and verified booleans", () => {
    const { request, report } = fixture();
    const svc = service(); const receipt = svc.startWorkflow(svc.planWorkflow(task(undefined, targetDigest(request))).data).data;
    report.checks[0].evidenceRefs = ["missing"];
    expect(svc.recordStageResult(result(receipt, report)).error.code).toBe("INVALID_INPUT");
  });
  it.each(["partial", "blocked"])("preserves %s rather than converting uncertainty to safety", (status) => {
    const { request, report } = fixture();
    const svc = service(); const receipt = svc.startWorkflow(svc.planWorkflow(task(undefined, targetDigest(request))).data).data;
    if (status === "partial") {
      report.request.checks.push({ id: "C2", description: "missing runtime" });
      report.checks.push({ id: "C2", status: "not-checked", evidenceRefs: [], observation: "missing runtime", method: "not-executed" });
    } else Object.assign(report.checks[0], { status: "not-checked", evidenceRefs: [], method: "not-executed" });
    report.status = status; report.limitations = ["missing runtime"]; report.requestDigest = digest(report.request);
    const recorded = svc.recordStageResult(result(receipt, report)); expect(recorded.ok, JSON.stringify(recorded.error)).toBe(true);
    expect(recorded.data.stageResults[0].output.output.status).toBe(status);
  });
  it("orders research before acceptance and independent audit without adding a gate", () => {
    const plan = service().planWorkflow(task(["software-security-audit", "acceptance-evidence-validation", "independent-audit"]));
    expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
    expect(plan.data.stages.map((s) => s.requiredCapability)).toEqual(["software-security-audit", "acceptance-evidence-validation", "independent-audit"]);
    expect(plan.data.stages[0].gate.kind).toBe("none");
  });
  it("passes findings as refuting evidence to acceptance without treating research completion as safety", () => {
    const { report } = fixture(); report.findings.push(finding());
    const taskEnvelope = task(); taskEnvelope.acceptanceCriteria = ["No unresolved cross-user disclosure"];
    const input = { schemaVersion: "1.0.0", taskEnvelope, target: { kind: "artifact", identifier: "fixture", digest: report.targetDigest },
      evidence: [{ id: "security-report", kind: "document", locator: "report.json", digest: digest(report), targetDigest: report.targetDigest, verified: true, criterionIds: ["AC-001"], direction: "refutes", observedResult: report.findings[0].impact }], verificationCommands: [], knownLimitations: report.limitations, criterionOverrides: [] };
    const acceptance = analyzeAcceptance(input);
    expect(acceptance.verdict).toBe("FAIL");
    expect(acceptance.verifiedEvidenceIndex[0].targetDigest).toBe(report.targetDigest);
    input.evidence = []; input.knownLimitations = ["runtime was not checked"];
    expect(analyzeAcceptance(input).verdict).toBe("BLOCKED");
  });
  it("accepts artifact declarations on the shared TaskEnvelope at the direct acceptance boundary", () => {
    const { request, report } = fixture();
    const taskEnvelope = task(undefined, targetDigest(request));
    expect(() => assertTaskEnvelope(taskEnvelope)).not.toThrow();
    const input = { schemaVersion: "1.0.0", taskEnvelope,
      target: { kind: "artifact", identifier: "fixture", digest: targetDigest(request) },
      evidence: [{ id: "security-report", kind: "document", locator: "report.json", digest: digest(report),
        targetDigest: targetDigest(request), verified: true, criterionIds: ["AC-001"], direction: "supports", observedResult: "Uncertainty is explicitly reported." }],
      verificationCommands: [], knownLimitations: [], criterionOverrides: [] };
    const acceptance = analyzeAcceptance(input);
    expect(acceptance.verdict).toBe("PASS");
    expect(acceptance.criteria).toMatchObject([{ criterionId: "AC-001", status: "satisfied", evidenceRefs: ["security-report"] }]);
    const malformed = structuredClone(input);
    malformed.taskEnvelope.artifactContracts[0].produced[0].targetDigest = "not-a-digest";
    expect(() => assertTaskEnvelope(malformed.taskEnvelope)).toThrow();
    expect(() => analyzeAcceptance(malformed)).toThrow();
    expect(() => analyzeAcceptance({ ...input, taskEnvelope: { ...taskEnvelope, undeclaredField: true } })).toThrow();
  });
});
