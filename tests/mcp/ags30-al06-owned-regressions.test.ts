import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ConvergenceFrameV1, ConvergenceStatusV1, SkillDescriptorV2, SkillProviderV2, StageResultV1, TaskEnvelopeV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { convergenceStatusSummary, workflowStatusSummary } from "../../mcp-server/src/response-projections.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { readLocalStageOutputFile } from "../../mcp-server/src/stage-output-file.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const directories: string[] = [];
const subject = `sha256:${"b".repeat(64)}` as const;
const digest = (bytes: string | Buffer): `sha256:${string}` => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags30-al06-"));
  directories.push(directory);
  return directory;
}

function harness(overrides: Partial<SkillProviderV2> = {}) {
  const root = scratch();
  mkdirSync(path.join(root, "contracts"));
  mkdirSync(path.join(root, "skills"));
  for (const file of ["freeform-output.v1.schema.json", "provider-result.v1.schema.json"]) {
    copyFileSync(path.join(repository, "contracts", file), path.join(root, "contracts", file));
  }
  const provider: SkillProviderV2 = {
    capabilities: ["fixture-work"], executionClass: "workflow", phase: "execution", phaseOrder: 50,
    requiredInputArtifacts: [], inputBindings: [], producedArtifacts: [],
    outputSchema: "contracts/freeform-output.v1.schema.json", resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: ["MISSING_EVIDENCE"] },
    selectionCriteria: ["fixture"], preconditions: [], failureHandling: "Return a structured result.",
    gate: { kind: "none", policy: "none", validator: null }, ...overrides,
  };
  const descriptor: SkillDescriptorV2 = { schemaVersion: "2.0.0", skillId: "al06-fixture", version: "1.0.0",
    path: "./al06-fixture", priority: 10, enabled: true, providers: [provider] };
  const registryPath = path.join(root, "skills", "registry.json");
  writeFileSync(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [descriptor] }));
  const validator = new ContractValidator();
  const store = new InMemoryWorkflowStore();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store);
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "al06-task", objective: "Exercise the declared workflow boundary.",
    scope: { included: ["candidate.txt"], excluded: [] }, acceptanceCriteria: ["Preserve the declared gate."], riskLevel: "low",
    workUnits: [{ id: "work", objective: "Use fixture data.", dependencies: [], writeTargets: ["candidate.txt"] }],
    requiredCapabilities: [provider.capabilities[0]!], constraints: [],
    authorization: { allowedActions: ["test"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
    artifactContracts: [{ capability: provider.capabilities[0]!, produced: provider.producedArtifacts.map(artifactId => ({ artifactId, schemaId: "fixture/v1", targetDigest: subject })) }],
  };
  return { root, validator, store, service, task };
}

function running(service: WorkflowService, task: TaskEnvelopeV1): WorkflowReceiptV1 {
  const planned = service.planWorkflow(task);
  expect(planned.error).toBeNull();
  const started = service.startWorkflow(planned.data!);
  expect(started.error).toBeNull();
  return started.data!;
}

function result(receipt: WorkflowReceiptV1, output: Record<string, unknown> = {}): StageResultV1 {
  const stage = receipt.plan.stages[0]!;
  return {
    schemaVersion: "1.0.0", runId: receipt.runId, expectedRevision: receipt.revision, stageId: stage.stageId, state: "passed",
    output: { schemaVersion: "1.0.0", kind: "output", output, error: null,
      artifacts: stage.requiredArtifacts.map(artifactId => ({ artifactId, schemaId: "fixture/v1", locator: `fixture:${artifactId}`,
        digest: "a".repeat(64), targetDigest: subject, verified: true })) },
    evidence: [{ artifactId: "fixture", kind: "test", locator: "fixture:observed", verified: true, note: "Synthetic fixture." }],
    findings: [], blockers: [], error: null,
  };
}

function frame(): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0", workspace: { workspaceId: "al06-workspace", locator: "fixture:al06-workspace" },
    controlArtifacts: [{ artifactId: "contract", role: "validator", locator: "fixture:contract", digest: `sha256:${"c".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "candidate.txt", digest: subject }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

describe("AL06 workflow regressions", () => {
  it("D0041 keeps non-audit mandatory providers free of audit-only output fields", () => {
    const { service, task } = harness({ capabilities: ["iteration-frame-audit"],
      producedArtifacts: ["iteration-frame-comparison", "convergence-review"], gate: { kind: "completion", policy: "mandatory", validator: null } });
    const receipt = running(service, task);
    expect(receipt.plan.stages[0]!.requiredArtifacts).toEqual(["iteration-frame-comparison", "convergence-review"]);
    const recorded = service.recordStageResult(result(receipt, { route: "resume-new-epoch" }));
    expect(recorded.error).toBeNull();
    expect(service.finalizeWorkflow(receipt.runId, recorded.data!.revision).data?.state).toBe("passed");
  });

  it.each([{ capabilities: ["independent-audit"] }, { capabilities: ["audit-alias", "independent-audit"] }])("D0041 retains the mandatory independent-audit rejection for $capabilities", ({ capabilities }) => {
    const { service, task } = harness({ capabilities, producedArtifacts: ["gate-verdict"],
      gate: { kind: "completion", policy: "mandatory", validator: null } });
    const receipt = running(service, task);
    expect(service.recordStageResult(result(receipt, { gateVerdict: "PASS" })).error?.code).toBe("GATE_FAILED");
    expect(service.getWorkflowStatus(receipt.runId).data?.revision).toBe(0);
  });

  it("D0042 accepts an intentional blocked outcome only when its mapping permits no error", () => {
    const { service, task } = harness({ stateMapping: { selector: "/output/route", default: "reject", adapterErrors: [],
      values: { stop: { state: "blocked", errorRequired: false }, failure: { state: "failed", errorRequired: true } } } });
    const receipt = running(service, task);
    const failure = result(receipt, { route: "failure" });
    failure.state = "failed";
    expect(service.recordStageResult(failure).error?.code).toBe("INVALID_TRANSITION");
    expect(service.getWorkflowStatus(receipt.runId).data?.revision).toBe(0);
    const stopped = result(receipt, { route: "stop" });
    stopped.state = "blocked";
    expect(service.recordStageResult(stopped).data).toMatchObject({ state: "blocked", revision: 1, error: null });
  });

  it("D0046 leaves the third running attempt open and allows its successful completion", () => {
    const { service, task } = harness();
    const plan = service.planWorkflow(task).data!;
    const frozen = frame();
    const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame: frozen, userApprovalRefs: [] });
    expect(opened.error).toBeNull();
    const rootId = opened.data!.rootId;
    let priorFailure: Record<string, unknown> | null = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const status = service.getConvergenceStatus(rootId).data!;
      const proposal = { schemaVersion: "1.0.0", rootId, expectedRevision: status.root.revision, taskEnvelope: task,
        frame: frozen, plan, actorId: "fixture-actor", outputTargets: ["candidate.txt"], priorFailure };
      const leased = service.claimWorkflowAttempt(proposal);
      expect(leased.error).toBeNull();
      const started = service.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: leased.data!.leaseId,
        expectedRootRevision: leased.data!.rootRevision, plan });
      expect(started.error).toBeNull();
      const receipt = started.data!;
      if (attempt < 3) {
        expect(service.abortWorkflow(receipt.runId, receipt.revision).error).toBeNull();
        const failed = service.getConvergenceStatus(rootId).data!;
        priorFailure = { fingerprint: failed.outcomes.at(-1)!.failureFingerprint, hypothesis: "A different fixture observation distinguishes this retry.",
          changeSummary: "Add a fresh observation.", discriminator: "Compare the observed fixture.", evidenceRefs: [`fixture:new-${attempt}`] };
      } else {
        const before = service.getConvergenceStatus(rootId).data!;
        expect(service.claimWorkflowAttempt({ ...proposal, expectedRevision: before.root.revision }).error?.code).toBe("LEASE_CONFLICT");
        expect(service.getConvergenceStatus(rootId).data!.root).toMatchObject({ state: "open", revision: before.root.revision });
        const recorded = service.recordStageResult(result(receipt));
        expect(recorded.error).toBeNull();
        expect(service.finalizeWorkflow(receipt.runId, recorded.data!.revision).data?.state).toBe("passed");
        expect(service.getConvergenceStatus(rootId).data?.root.state).toBe("completed");
      }
    }
  });

  it("D0051 preserves the stale schema cause within the current gate envelope without consuming a revision", () => {
    const { root, service, task } = harness({ producedArtifacts: ["decision-record"],
      gate: { kind: "completion", policy: "conditional", validator: "contracts/decision.schema.json" } });
    writeFileSync(path.join(root, "contracts", "decision.schema.json"), JSON.stringify({ type: "object", required: ["originalRequired"] }));
    const receipt = running(service, task);
    expect(service.recordStageResult(result(receipt, { decisionRecord: {} })).error).toMatchObject({
      code: "GATE_FAILED", details: { causeCode: "INVALID_INPUT", causeDetails: {
        schemaPath: "contracts/decision.schema.json", validationErrors: expect.any(String),
      } },
    });
    writeFileSync(path.join(root, "contracts", "decision.schema.json"), JSON.stringify({ type: "object", required: ["changed"] }));
    const rejected = service.recordStageResult(result(receipt, { decisionRecord: {} }));
    expect(rejected.error).toMatchObject({ code: "GATE_FAILED", details: {
      causeCode: "STALE_REVISION", causeDetails: { schemaPath: "contracts/decision.schema.json" },
    } });
    const causeDetails = rejected.error?.details?.causeDetails as Record<string, unknown>;
    expect(causeDetails.expectedDigest).toBe(receipt.plan.stages[0]!.gate.validatorSchema!.digest);
    expect(causeDetails.actualDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(causeDetails.actualDigest).not.toBe(causeDetails.expectedDigest);
    expect(Object.keys(causeDetails).sort()).toEqual(["actualDigest", "expectedDigest", "schemaPath"]);
    expect(service.getWorkflowStatus(receipt.runId).data).toMatchObject({ revision: 0, stageResults: [] });
  });


});

describe("AL06 file and schema regressions", () => {
  it.each([String.raw`/\server/share/file.json`, String.raw`\/server/share/file.json`])("D0101 rejects mixed network prefix %s at the stage output boundary", locator => {
    expect(() => readLocalStageOutputFile(locator)).toThrow(/network path|absolute/u);
  });

  it.skipIf(process.platform === "win32")("D0102 refuses a FIFO without waiting for a writer", () => {
    const fifo = path.join(scratch(), "output.fifo");
    execFileSync("mkfifo", [fifo]);
    const reader = path.join(repository, "mcp-server", "src", "stage-output-file.ts");
    const script = `import { readLocalStageOutputFile } from ${JSON.stringify(reader)}; try { readLocalStageOutputFile(${JSON.stringify(fifo)}); process.exitCode = 9; } catch (error) { if (error.code !== "INVALID_INPUT") throw error; }`;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: repository, timeout: 10_000, encoding: "utf8", windowsHide: true });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
  });

  it("D0102 retains ordinary local file reads", () => {
    const file = path.join(scratch(), "ordinary.json");
    writeFileSync(file, '{"ordinary":true}');
    expect(readLocalStageOutputFile(file).toString("utf8")).toBe('{"ordinary":true}');
  });

  it("D0146 validates the digest-bound target despite an earlier schema with the same id", () => {
    const root = scratch();
    mkdirSync(path.join(root, "contracts"));
    mkdirSync(path.join(root, "skills", "fixture"), { recursive: true });
    const id = "https://al06.invalid/bound-schema";
    writeFileSync(path.join(root, "contracts", "earlier.schema.json"), JSON.stringify({ $id: id, type: "object" }));
    const relative = "skills/fixture/target.schema.json";
    const bound = JSON.stringify({ $id: id, type: "object", required: ["requiredValue"], additionalProperties: false, properties: { requiredValue: { const: "bound" } } });
    writeFileSync(path.join(root, relative), bound);
    const validator = new ContractValidator();
    const reference = { path: relative, digest: digest(bound) };
    expect(() => validator.declaredSchema(root, reference, {}, "AL06 bound schema")).toThrow(/declared schema/u);
    expect(validator.declaredSchema(root, reference, { requiredValue: "bound" }, "AL06 bound schema")).toEqual({ requiredValue: "bound" });
  });
});

describe("D0163 compact values", () => {
  it("maps actual progress, failure and empty history values", () => {
    const { service, task } = harness();
    const receipt = running(service, task);
    receipt.revision = 7;
    receipt.state = "blocked";
    receipt.plan.currentStageId = "current-fixture";
    receipt.plan.nextStageId = "next-fixture";
    receipt.blockers = ["blocker-1", "blocker-2"];
    receipt.unresolved = ["finding-1"];
    receipt.error = { code: "MISSING_EVIDENCE", message: "Fixture evidence is missing.", details: null };
    expect(workflowStatusSummary(receipt)).toEqual({ schemaVersion: "1.0.0", runId: receipt.runId, revision: 7, state: "blocked",
      currentStageId: "current-fixture", nextStageId: "next-fixture", lastRecordedStageId: null, completedStageCount: 0,
      totalStageCount: 1, blockerCount: 2, unresolvedCount: 1, errorCode: "MISSING_EVIDENCE", receiptDigest: convergenceDigest(receipt) });
    receipt.stageResults = [result(receipt)];
    expect(workflowStatusSummary(receipt)).toMatchObject({ lastRecordedStageId: receipt.plan.stages[0]!.stageId, completedStageCount: 1 });
  });

  it("uses the latest values without mistaking a later consumed lease for an issued lease", () => {
    const { service, task } = harness();
    const opened = service.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: task, frame: frame(), userApprovalRefs: [] }).data!;
    const status = service.getConvergenceStatus(opened.rootId).data!;
    const populated: ConvergenceStatusV1 = { ...status, currentEpoch: 2, attemptsUsedInEpoch: 2, attemptsRemainingInEpoch: 1,
      proposals: [{} as ConvergenceStatusV1["proposals"][number]],
      leases: [{ leaseId: "issued-old", state: "issued" }, { leaseId: "issued-current", state: "issued" }, { leaseId: "consumed-later", state: "consumed" }] as ConvergenceStatusV1["leases"],
      outcomes: [{ outcomeId: "old", state: "failed", receiptDigest: subject }, { outcomeId: "latest", state: "aborted", receiptDigest: `sha256:${"c".repeat(64)}` }] as ConvergenceStatusV1["outcomes"],
      reviews: [{} as ConvergenceStatusV1["reviews"][number]], workflowRunIds: ["run-old", "run-latest"],
      gateError: { code: "FRAME_REVIEW_REQUIRED", message: "Fixture review.", details: null } };
    expect(convergenceStatusSummary(populated)).toMatchObject({ currentEpoch: 2, maxAttemptsPerEpoch: 3, maxEpochs: 2,
      attemptsUsedInEpoch: 2, attemptsRemainingInEpoch: 1, issuedLeaseId: "issued-current", latestWorkflowRunId: "run-latest",
      latestOutcomeId: "latest", latestOutcomeState: "aborted", latestOutcomeReceiptDigest: `sha256:${"c".repeat(64)}`,
      proposalCount: 1, leaseCount: 3, outcomeCount: 2, reviewCount: 1, gateErrorCode: "FRAME_REVIEW_REQUIRED" });
    expect(convergenceStatusSummary(status)).toMatchObject({ issuedLeaseId: null, latestWorkflowRunId: null, latestOutcomeId: null,
      latestOutcomeState: null, latestOutcomeReceiptDigest: null, proposalCount: 0, leaseCount: 0, outcomeCount: 0, reviewCount: 0, gateErrorCode: null });
  });
});
