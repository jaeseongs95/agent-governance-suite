import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ConvergenceFrameV1, SkillDescriptorV2, StageResultV1, TaskEnvelopeV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { planWorkflowToolInputSchema } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

type AuditPhase = "pre-execution" | "post-execution" | "pre-deploy" | "post-deploy";
type Surface = "inline" | "file";
const repository = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const subject = `sha256:${"b".repeat(64)}` as const;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ags-al06-audit-phase-"));
  directories.push(root);
  mkdirSync(path.join(root, "contracts"));
  mkdirSync(path.join(root, "skills"));
  for (const file of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json"]) {
    copyFileSync(path.join(repository, "contracts", file), path.join(root, "contracts", file));
  }
  const descriptor: SkillDescriptorV2 = {
    schemaVersion: "2.0.0", skillId: "al06-audit-fixture", version: "1.0.0", path: "./al06-audit-fixture", enabled: true, priority: 10,
    providers: [{
      capabilities: ["independent-audit"], executionClass: "workflow", phase: "completion-gate", phaseOrder: 90,
      requiredInputArtifacts: [], inputBindings: [], producedArtifacts: ["gate-verdict"],
      outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
      stateMapping: { selector: "/output/gateVerdict", values: { PASS: { state: "passed", errorRequired: false } }, default: "reject", adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"] },
      selectionCriteria: ["fixture"], preconditions: [], failureHandling: "Return a structured audit result.",
      gate: { kind: "completion", policy: "mandatory", validator: "independent-audit" },
    }],
  };
  const registryPath = path.join(root, "skills/registry.json");
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [descriptor] }));
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "al06-phase-task", objective: "Preserve the requested audit phase.",
    scope: { included: ["candidate.txt"], excluded: [] }, acceptanceCriteria: ["The audit result must satisfy the planned phase."], riskLevel: "low",
    workUnits: [], requiredCapabilities: ["independent-audit"], constraints: [],
    authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
    artifactContracts: [{ capability: "independent-audit", produced: [{ artifactId: "gate-verdict", schemaId: "fixture/audit-v1", targetDigest: subject }] }],
  };
  return { root, validator, store, service, task };
}

function planned(f: ReturnType<typeof fixture>, phase: AuditPhase): WorkflowPlanV1 {
  const result = f.service.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope: f.task, requiredAuditPhase: phase });
  expect(result.error).toBeNull();
  expect(result.data!.stages[0]).toMatchObject({ phase: "completion-gate", requiredAuditPhase: phase });
  return result.data!;
}

function running(f: ReturnType<typeof fixture>, phase: AuditPhase): WorkflowReceiptV1 {
  const result = f.service.startWorkflow(planned(f, phase));
  expect(result.error).toBeNull();
  expect(f.store.getRun(result.data!.runId)!.plan.stages[0]!.requiredAuditPhase).toBe(phase);
  return result.data!;
}

function auditOutput(phase: AuditPhase, verified: boolean): Record<string, unknown> {
  return { gateVerdict: "PASS", auditorId: "independent-auditor", implementationActorIds: ["implementation-actor"],
    auditTarget: "fixture:final-target", currentTarget: "fixture:final-target", phase, freshContext: true,
    delegationAllowed: false, blockingFindings: [], stale: false, postExecutionVerified: verified };
}

function result(f: ReturnType<typeof fixture>, receipt: WorkflowReceiptV1, phase: AuditPhase, verified: boolean, surface: Surface): StageResultV1 {
  const output = auditOutput(phase, verified);
  const bytes = JSON.stringify(output);
  const locator = path.join(f.root, "audit-output.json");
  if (surface === "file") writeFileSync(locator, bytes);
  return {
    schemaVersion: "1.0.0", runId: receipt.runId, stageId: receipt.plan.stages[0]!.stageId, expectedRevision: receipt.revision, state: "passed",
    ...(surface === "file" ? { outputFile: { locator, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` as const } } : {}),
    output: { schemaVersion: "1.0.0", kind: "output", output: surface === "inline" ? output : null,
      artifacts: [{ artifactId: "gate-verdict", schemaId: "fixture/audit-v1", locator: "fixture:gate-verdict", digest: "a".repeat(64), targetDigest: subject, verified: true }], error: null },
    evidence: [{ artifactId: "audit-proof", kind: "test", locator: "al06-audit-phase-freeze.test.ts", verified: true, note: "Synthetic audit fixture." }],
    findings: [], blockers: [], error: null,
  };
}

describe.each(["inline", "file"] as const)("D0040 frozen audit phase through %s output", surface => {
  it.each([["post-execution", "pre-execution"], ["post-deploy", "pre-deploy"]] as const)("rejects %s requirements satisfied by %s self-declaration without committing state", (required, actual) => {
    const f = fixture();
    const receipt = running(f, required);
    const before = f.store.getRun(receipt.runId);
    expect(f.service.recordStageResult(result(f, receipt, actual, false, surface)).error?.code).toBe("GATE_FAILED");
    expect(f.store.getRun(receipt.runId)).toEqual(before);
    expect(f.store.getRun(receipt.runId)).toMatchObject({ revision: 0, stageResults: [] });
  });

  it.each(["post-execution", "post-deploy"] as const)("requires resulting-state verification for the planned %s phase", phase => {
    const f = fixture();
    const receipt = running(f, phase);
    const before = f.store.getRun(receipt.runId);
    expect(f.service.recordStageResult(result(f, receipt, phase, false, surface)).error?.code).toBe("GATE_FAILED");
    expect(f.store.getRun(receipt.runId)).toEqual(before);
  });

  it.each(["pre-execution", "pre-deploy", "post-execution", "post-deploy"] as const)("accepts a legitimate exact %s phase through finalization", phase => {
    const f = fixture();
    const receipt = running(f, phase);
    const recorded = f.service.recordStageResult(result(f, receipt, phase, phase.startsWith("post-"), surface));
    expect(recorded.error).toBeNull();
    expect(recorded.data).toMatchObject({ revision: 1, stageResults: [expect.objectContaining({ state: "passed" })] });
    expect(f.service.finalizeWorkflow(receipt.runId, recorded.data!.revision).data).toMatchObject({ state: "passed", revision: 2 });
  });

  it("rechecks the planned phase on a previously persisted passed output before finalization", () => {
    const f = fixture();
    const receipt = running(f, "post-execution");
    const recorded = f.service.recordStageResult(result(f, receipt, "post-execution", true, surface));
    expect(recorded.error).toBeNull();
    const persisted = f.store.getRun(receipt.runId)!;
    persisted.stageResults[0] = { ...result(f, persisted, "pre-execution", false, surface), expectedRevision: 0 };
    expect(f.store.updateRun(persisted, persisted.revision)).toBe(true);
    const before = f.store.getRun(receipt.runId);
    expect(f.service.finalizeWorkflow(receipt.runId, persisted.revision).error?.code).toBe("GATE_FAILED");
    expect(f.store.getRun(receipt.runId)).toEqual(before);
  });
});

it.each(["default", "inline-references", "anthropic"] as const)("D0040 advertises the shared phase contract through the %s tool schema", profile => {
  const properties = { requiredAuditPhase: { enum: ["pre-execution", "post-execution", "pre-deploy", "post-deploy"] } };
  const schema = planWorkflowToolInputSchema(profile);
  expect(schema).toMatchObject(profile === "default" ? { oneOf: [expect.anything(), { properties }] } : { properties });
});

it("D0040 freezes the default post phase for a new legacy-form planning request", () => {
  const f = fixture();
  const plan = f.service.planWorkflow(f.task);
  expect(plan.error).toBeNull();
  expect(plan.data!.stages[0]).toMatchObject({ phase: "completion-gate", requiredAuditPhase: "post-execution" });
});

it("D0040 rejects changing the signed phase before start", () => {
  const f = fixture();
  const plan = planned(f, "post-execution");
  plan.stages[0]!.requiredAuditPhase = "pre-execution";
  expect(f.service.startWorkflow(plan).error?.code).toBe("INVALID_INPUT");
});

it("D0040 keeps an explicit pre phase through the guarded claim/store/start reconstruction", () => {
  const f = fixture();
  const plan = planned(f, "pre-deploy");
  const frame: ConvergenceFrameV1 = { schemaVersion: "1.0.0", workspace: { workspaceId: "al06-phase-workspace", locator: "fixture:workspace" },
    controlArtifacts: [{ artifactId: "contract", role: "validator", locator: "fixture:contract", digest: `sha256:${"c".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "candidate.txt", digest: subject }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 } };
  const opened = f.service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: f.task, frame, userApprovalRefs: [] });
  expect(opened.error).toBeNull();
  const lease = f.service.claimWorkflowAttempt({ schemaVersion: "1.0.0", rootId: opened.data!.rootId, expectedRevision: opened.data!.revision,
    taskEnvelope: f.task, frame, plan, actorId: "fixture-actor", outputTargets: ["candidate.txt"], priorFailure: null });
  expect(lease.error).toBeNull();
  const started = f.service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.data!.leaseId, expectedRootRevision: lease.data!.rootRevision, plan });
  expect(started.error).toBeNull();
  expect(started.data!.plan.stages[0]!.requiredAuditPhase).toBe("pre-deploy");
  expect(f.store.getRun(started.data!.runId)!.plan.stages[0]!.requiredAuditPhase).toBe("pre-deploy");
});

it.each(["inline", "file"] as const)("D0040 rejects an unknown result phase through %s without changing history", surface => {
  const f = fixture();
  const receipt = running(f, "post-execution");
  const missing = result(f, receipt, "post-execution", true, surface);
  const output = auditOutput("post-execution", true);
  delete output.phase;
  if (surface === "inline") missing.output.output = output;
  else {
    const bytes = JSON.stringify(output);
    writeFileSync(missing.outputFile!.locator, bytes);
    missing.outputFile!.digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  }
  const before = f.store.getRun(receipt.runId);
  expect(f.service.recordStageResult(missing).error?.code).toBe("GATE_FAILED");
  expect(f.store.getRun(receipt.runId)).toEqual(before);
});
