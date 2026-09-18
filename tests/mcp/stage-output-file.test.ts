import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ConvergenceFrameV1,
  ExecutionContextV1,
  StageResultV1,
  TaskEnvelopeV1,
  WorkflowReceiptV1,
} from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { loadStageOutputFile, MAX_STAGE_OUTPUT_FILE_BYTES, readLocalStageOutputFile } from "../../mcp-server/src/stage-output-file.js";
import { type ExecutionObservationBindingV1, WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "stage-output-file-"));
  directories.push(directory);
  return directory;
}

function writeOutput(content: string | Buffer): { locator: string; digest: `sha256:${string}` } {
  const locator = path.join(scratch(), "output.json");
  writeFileSync(locator, content);
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return { locator, digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
}

function task(taskId: string, capabilities: string[] = ["task-decomposition"]): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Record a stage output by file reference.",
    scope: { included: ["integration test"], excluded: ["deployment"] },
    acceptanceCriteria: ["Complete the planned stage through the MCP boundary."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Run the fixture.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: capabilities,
    constraints: ["Use only fixture data."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function frame(taskId: string): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId: `file-${taskId}`, locator: `fixture:${taskId}` },
    controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
    targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: `fixture:${taskId}`, digest: `sha256:${"b".repeat(64)}` }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

let observations = 0;
function service(): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore(), null, {
    observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 {
      observations += 1;
      const observedAt = new Date();
      return {
        schemaVersion: "1.0.0", model: "fixture", modelClass: "deep", reasoningEffort: "high", source: "runtime",
        observedAt: observedAt.toISOString(), observationId: `stage-output-file-${String(observations).padStart(6, "0")}`,
        taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId, revision: binding.revision,
        actorId: "fixture-actor", expiresAt: new Date(observedAt.getTime() + 60_000).toISOString(),
      };
    },
  });
}

function running(workflow: WorkflowService, taskId: string, capabilities?: string[]): WorkflowReceiptV1 {
  const envelope = task(taskId, capabilities);
  const plan = workflow.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope: envelope }, true).data!;
  const root = workflow.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: envelope, frame: frame(taskId), userApprovalRefs: [] }).data!;
  const lease = workflow.claimWorkflowAttempt({
    schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision, taskEnvelope: envelope, frame: frame(taskId),
    plan, actorId: "fixture-actor", outputTargets: ["fixture.md"], priorFailure: null,
  }, true).data!;
  return workflow.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan }, true).data!;
}

function stageResult(receipt: WorkflowReceiptV1, output: Record<string, unknown> | null, outputFile?: { locator: string; digest: string }): StageResultV1 {
  const stage = receipt.plan.stages[0]!;
  return {
    schemaVersion: "1.0.0",
    runId: receipt.runId,
    stageId: stage.stageId,
    expectedRevision: receipt.revision,
    state: "passed",
    ...(outputFile ? { outputFile } : {}),
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output,
      artifacts: stage.requiredArtifacts.map((artifactId) => ({
        artifactId, schemaId: "fixture/v1", locator: `fixture:${artifactId}`, digest: "d".repeat(64), targetDigest: "e".repeat(64), verified: true,
      })),
      error: null,
    },
    evidence: [{ artifactId: "fixture", kind: "test", locator: "stage-output-file.test.ts", verified: true, note: "fixture" }],
    findings: [],
    blockers: [],
    error: null,
  } as StageResultV1;
}

describe("stage output by file reference", () => {
  it("validates a file-backed output like inline output and stores only the reference", () => {
    const workflow = service();
    const receipt = running(workflow, "file-ok");
    const file = writeOutput(JSON.stringify({ completed: true, rows: Array.from({ length: 2000 }, (_, index) => `row-${index}`) }));
    const recorded = workflow.recordStageResult(stageResult(receipt, null, file), true);
    expect(recorded.error).toBeNull();
    const stored = recorded.data!.stageResults[0]!;
    expect(stored.outputFile).toEqual(file);
    expect(stored.output.output).toBeNull();
    expect(JSON.stringify(recorded.data)).not.toContain("row-1999");
    expect(workflow.finalizeWorkflow(receipt.runId, recorded.data!.revision).data?.state).toBe("passed");
  });

  it("keeps inline output unchanged", () => {
    const workflow = service();
    const receipt = running(workflow, "inline");
    const recorded = workflow.recordStageResult(stageResult(receipt, { completed: true }), true);
    expect(recorded.error).toBeNull();
    expect(recorded.data!.stageResults[0]!.output.output).toEqual({ completed: true });
    expect(recorded.data!.stageResults[0]!.outputFile).toBeUndefined();
  });

  it("fails closed on inline content next to a file, digest mismatch and unreadable files", () => {
    const workflow = service();
    const receipt = running(workflow, "file-bad");
    const file = writeOutput(JSON.stringify({ completed: true }));
    const code = (result: StageResultV1) => workflow.recordStageResult(result, true).error?.code;
    expect(code(stageResult(receipt, { completed: true }, file))).toBe("INVALID_INPUT");
    expect(code(stageResult(receipt, null, { ...file, digest: `sha256:${"0".repeat(64)}` }))).toBe("INTEGRITY_FAILED");
    expect(code(stageResult(receipt, null, { ...file, locator: "relative/output.json" }))).toBe("INVALID_INPUT");
    expect(code(stageResult(receipt, null, { ...file, locator: path.join(scratch(), "missing.json") }))).toBe("INVALID_INPUT");
    expect(code(stageResult(receipt, null, { ...file, locator: scratch() }))).toBe("INVALID_INPUT");
    const notJson = writeOutput("not json");
    expect(code(stageResult(receipt, null, notJson))).toBe("INVALID_INPUT");
    const array = writeOutput("[1,2,3]");
    expect(code(stageResult(receipt, null, array))).toBe("INVALID_INPUT");
    // Nothing was recorded by the rejected attempts.
    expect(workflow.getWorkflowStatus(receipt.runId).data!.stageResults).toHaveLength(0);
  });

  it("accepts a byte order mark and rejects oversized content from the reader", () => {
    const withBom = writeOutput(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"completed":true}', "utf8")]));
    expect(loadStageOutputFile(withBom)).toEqual({ completed: true });
    const big = Buffer.alloc(MAX_STAGE_OUTPUT_FILE_BYTES + 1, 0x20);
    expect(() => loadStageOutputFile({ locator: "/virtual/big.json", digest: `sha256:${"0".repeat(64)}` }, () => big))
      .toThrow(/16 MiB/u);
  });

  it("keeps receipt-policy stages inline so cross-stage actor checks still see their output", () => {
    const workflow = service();
    const receipt = running(workflow, "policy-stage", ["korean-prose-selection"]);
    expect(receipt.plan.stages[0]?.receiptPolicy).toBeTruthy();
    const file = writeOutput("{}");
    const rejected = workflow.recordStageResult(stageResult(receipt, null, file), true);
    expect(rejected.error?.code).toBe("INVALID_INPUT");
    expect(rejected.error?.message).toMatch(/receipt policy/u);
  });

  it("reads regular local files only, bounded by the size limit, and never echoes the actual digest", () => {
    // POSIX treats a backslash UNC path as relative; either way it is refused.
    expect(() => readLocalStageOutputFile(String.raw`\\server\share\output.json`)).toThrow(/network path|absolute/u);
    expect(() => readLocalStageOutputFile("//server/share/output.json")).toThrow(/network path|absolute/u);
    const oversized = path.join(scratch(), "big.json");
    writeFileSync(oversized, Buffer.alloc(MAX_STAGE_OUTPUT_FILE_BYTES + 1, 0x20));
    expect(() => readLocalStageOutputFile(oversized)).toThrow(/16 MiB/u);
    const file = writeOutput('{"completed":true}');
    expect(readLocalStageOutputFile(file.locator).toString("utf8")).toBe('{"completed":true}');
    try {
      loadStageOutputFile({ ...file, digest: `sha256:${"0".repeat(64)}` });
      throw new Error("expected a digest mismatch");
    } catch (error) {
      expect(JSON.stringify((error as { details?: unknown }).details)).not.toContain(file.digest.slice(7));
    }
  });

  it("rejects outputFile fields that break the contract", () => {
    const workflow = service();
    const receipt = running(workflow, "file-contract");
    const file = writeOutput("{}");
    expect(workflow.recordStageResult({ ...stageResult(receipt, null, file), outputFile: { ...file, extra: true } }, true).error?.code).toBe("INVALID_INPUT");
    expect(workflow.recordStageResult({ ...stageResult(receipt, null, file), outputFile: { locator: file.locator, digest: "0".repeat(64) } }, true).error?.code).toBe("INVALID_INPUT");
  });
});
