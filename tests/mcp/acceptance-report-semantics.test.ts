import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionContextV1, SkillDescriptorV2, StageResultV1, TaskEnvelopeV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const directories: string[] = [];
const CONTEXT: ExecutionContextV1 = {
  schemaVersion: "1.0.0",
  model: "fixture-deep",
  modelClass: "deep",
  reasoningEffort: "high",
  source: "runtime",
  observedAt: "2026-09-14T00:00:00.000Z",
};
const ARTIFACT_TARGET = "b".repeat(64);
const REPORT_TARGET = `sha256:${"a".repeat(64)}`;
const PRODUCED = ["acceptance-evidence-report", "verified-evidence-index"];

const acceptanceSkill: SkillDescriptorV2 = {
  schemaVersion: "2.0.0",
  skillId: "fixture-acceptance",
  version: "1.0.0",
  path: "./fixture-acceptance",
  enabled: true,
  priority: 50,
  providers: [{
    capabilities: ["acceptance-evidence-validation"],
    executionClass: "workflow",
    phase: "acceptance-verification",
    phaseOrder: 70,
    requiredInputArtifacts: [],
    inputBindings: [],
    producedArtifacts: PRODUCED,
    outputSchema: "contracts/freeform-output.v1.schema.json",
    resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: {
      selector: "/output/verdict",
      values: {
        PASS: { state: "passed", errorRequired: false },
        FAIL: { state: "failed", errorRequired: true, allowedErrorCodes: ["GATE_FAILED"] },
        BLOCKED: { state: "blocked", errorRequired: true, allowedErrorCodes: ["MISSING_EVIDENCE"] },
      },
      default: "reject",
      adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
    },
    selectionCriteria: ["capability match"],
    preconditions: [],
    failureHandling: "Return a structured result.",
    gate: { kind: "completion", policy: "conditional", validator: "acceptance-evidence-validation" },
  }],
};

const taskEnvelope: TaskEnvelopeV1 = {
  schemaVersion: "1.0.0",
  taskId: "acceptance-semantics",
  objective: "Judge acceptance evidence.",
  scope: { included: ["src"], excluded: [] },
  acceptanceCriteria: ["Valid input returns PASS."],
  riskLevel: "low",
  workUnits: [],
  requiredCapabilities: ["acceptance-evidence-validation"],
  artifactContracts: [{
    capability: "acceptance-evidence-validation",
    produced: PRODUCED.map((artifactId) => ({ artifactId, schemaId: "fixture/v1", targetDigest: `sha256:${ARTIFACT_TARGET}` as const })),
  }],
  constraints: [],
  authorization: { allowedActions: ["read"], prohibitedActions: [], approvalRequired: [] },
  decision: { complexity: "simple", hasConflicts: false },
  orchestration: { requested: true, mcpAvailable: true },
};

async function createService(): Promise<WorkflowService> {
  const directory = await mkdtemp(join(tmpdir(), "acceptance-semantics-"));
  directories.push(directory);
  await mkdir(join(directory, "skills"), { recursive: true });
  await mkdir(join(directory, "contracts"), { recursive: true });
  for (const name of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json", "task-envelope.v1.schema.json"]) {
    await copyFile(new URL(`../../contracts/${name}`, import.meta.url), join(directory, "contracts", name));
  }
  const registryPath = join(directory, "skills", "registry.json");
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [acceptanceSkill] }), "utf8");
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, undefined, CONTEXT);
}

function validReport(): Record<string, unknown> {
  return {
    schemaVersion: "1.0.0",
    target: { kind: "commit", identifier: "abc123", digest: REPORT_TARGET },
    criteria: [{
      criterionId: "AC-001",
      statement: "Valid input returns PASS.",
      status: "satisfied",
      evidenceRefs: ["test-pass"],
      observedResult: "Fixture returned PASS.",
      rationale: "Verified evidence for the current target supports this criterion.",
    }],
    verifiedEvidenceIndex: [{
      evidenceId: "test-pass",
      kind: "test",
      locator: "tests/results/pass.txt",
      digest: `sha256:${"c".repeat(64)}`,
      targetDigest: REPORT_TARGET,
      criterionIds: ["AC-001"],
      direction: "supports",
    }],
    unresolvedCriteria: [],
    limitations: [],
    verdict: "PASS",
  };
}

function stageResult(receipt: WorkflowReceiptV1, report: Record<string, unknown>): StageResultV1 {
  const stage = receipt.plan.stages[0]!;
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state: "passed",
    executionContext: structuredClone(CONTEXT),
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: report,
      artifacts: PRODUCED.map((artifactId) => ({
        artifactId,
        schemaId: "fixture/v1",
        locator: `tests/${artifactId}.json`,
        digest: "a".repeat(64),
        targetDigest: ARTIFACT_TARGET,
        verified: true,
      })),
      error: null,
    },
    evidence: PRODUCED.map((artifactId) => ({
      artifactId,
      kind: "test",
      locator: `tests/${artifactId}.json`,
      verified: true,
      note: "fixture verified",
    })),
    findings: [],
    blockers: [],
    error: null,
  };
}

async function startedRun(): Promise<{ service: WorkflowService; receipt: WorkflowReceiptV1 }> {
  const service = await createService();
  const plan = service.planWorkflow(taskEnvelope);
  expect(plan.ok, JSON.stringify(plan.error)).toBe(true);
  expect(plan.data?.state).toBe("ready");
  expect(plan.data?.stages[0]?.requiredCapability).toBe("acceptance-evidence-validation");
  const started = service.startWorkflow(plan.data!);
  expect(started.ok, JSON.stringify(started.error)).toBe(true);
  return { service, receipt: started.data! };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("acceptance evidence report semantics at the MCP gate", () => {
  it("rejects a PASS verdict over an unsatisfied criterion, then accepts a consistent report", async () => {
    const { service, receipt } = await startedRun();
    const forged = validReport();
    (forged.criteria as Array<Record<string, unknown>>)[0]!.status = "unsatisfied";
    (forged.verifiedEvidenceIndex as Array<Record<string, unknown>>)[0]!.direction = "refutes";
    const rejected = service.recordStageResult(stageResult(receipt, forged));
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("INVALID_INPUT");
    expect(service.getWorkflowStatus(receipt.runId).data).toMatchObject({ revision: 0, stageResults: [] });

    const accepted = service.recordStageResult(stageResult(receipt, validReport()));
    expect(accepted.ok, JSON.stringify(accepted.error)).toBe(true);
    expect(accepted.data?.stageResults[0]?.state).toBe("passed");
  });

  it("rejects a PASS verdict over a criterion without evidence", async () => {
    const { service, receipt } = await startedRun();
    const forged = validReport();
    const criterion = (forged.criteria as Array<Record<string, unknown>>)[0]!;
    criterion.status = "insufficient-evidence";
    criterion.evidenceRefs = [];
    const rejected = service.recordStageResult(stageResult(receipt, forged));
    expect(rejected.ok).toBe(false);
    expect(rejected.error?.code).toBe("INVALID_INPUT");
  });
});
