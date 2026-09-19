import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionContextV1, SchemaReferenceV1, StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { type ExecutionObservationBindingV1, WorkflowService } from "../../mcp-server/src/workflow-service.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const registry = new FileSkillRegistry(registryPath, new ContractValidator());
const rootDirectory = registry.rootDirectory;

function providerSchemas(capability: string): { resultSchema: SchemaReferenceV1; outputSchema: SchemaReferenceV1; declaresVersion: boolean } {
  const provider = registry.read().find((candidate) => candidate.capabilities.includes(capability));
  if (!provider) throw new Error(`no provider for ${capability}`);
  const raw = JSON.parse(readFileSync(path.join(rootDirectory, provider.resultSchema), "utf8")) as { properties?: Record<string, unknown> };
  return {
    resultSchema: { path: provider.resultSchema, digest: provider.resultSchemaDigest },
    outputSchema: { path: provider.outputSchema, digest: provider.outputSchemaDigest },
    declaresVersion: Boolean(raw.properties?.schemaVersion),
  };
}

const envelope = {
  schemaVersion: "1.0.0",
  kind: "adapter-error",
  output: null,
  artifacts: [],
  error: { code: "INVALID_INPUT", message: "fixture", details: null },
};

describe("provider result envelope", () => {
  it.each(["acceptance-evidence-validation", "blocker-diagnosis", "recovery-strategy-selection"])(
    "accepts the shared envelope version for %s even though its provider schema omits it",
    (capability) => {
      const { resultSchema, outputSchema, declaresVersion } = providerSchemas(capability);
      expect(declaresVersion).toBe(false);
      const validator = new ContractValidator();
      expect(validator.providerResult(rootDirectory, resultSchema, outputSchema, envelope)).toEqual(envelope);
      // Keys the provider schema does not know are still rejected.
      expect(() => validator.providerResult(rootDirectory, resultSchema, outputSchema, { ...envelope, unexpected: true }))
        .toThrow(/does not match its declared schema/u);
    },
  );

  it("keeps validating schemaVersion where the provider schema declares it", () => {
    const { resultSchema, outputSchema, declaresVersion } = providerSchemas("change-scope-baseline-capture");
    expect(declaresVersion).toBe(true);
    const validator = new ContractValidator();
    expect(validator.providerResult(rootDirectory, resultSchema, outputSchema, envelope)).toEqual(envelope);
    expect(() => validator.providerResult(rootDirectory, resultSchema, outputSchema, { ...envelope, schemaVersion: "9.9.9" }))
      .toThrow(/does not match its declared schema/u);
  });
});

const bareDigest = "d".repeat(64);
const prefixedDigest = `sha256:${bareDigest}`;

function artifact(artifactId: string, digest: string, targetDigest = digest) {
  return { artifactId, schemaId: "fixture/v1", locator: `fixture:${artifactId}`, digest, targetDigest, verified: true };
}

function outputEnvelope(artifacts: unknown[]) {
  return { schemaVersion: "1.0.0", kind: "output", output: null, artifacts, error: null };
}

describe("artifact digest form", () => {
  // change-scope-guardian declares bare digests; mutation-risk-preflight declares sha256:-prefixed ones through a $ref.
  it.each([
    ["change-scope-baseline-capture", prefixedDigest],
    ["mutation-risk-preflight", bareDigest],
  ])("accepts a digest that differs only by the sha256: prefix for %s and returns the caller's value", (capability, digest) => {
    const { resultSchema, outputSchema } = providerSchemas(capability);
    const value = outputEnvelope([artifact("fixture", digest)]);
    const returned = new ContractValidator().providerResult(rootDirectory, resultSchema, outputSchema, value);
    expect(returned).toEqual(value);
    expect(returned.artifacts[0]!.digest).toBe(digest);
  });

  it.each(["change-scope-baseline-capture", "mutation-risk-preflight"])("still rejects digests that are not lowercase SHA-256 hex for %s", (capability) => {
    const { resultSchema, outputSchema } = providerSchemas(capability);
    const validator = new ContractValidator();
    for (const digest of ["D".repeat(64), "d".repeat(63), `sha256:${"g".repeat(64)}`, `sha512:${bareDigest}`, `sha256:${prefixedDigest}`]) {
      expect(() => validator.providerResult(rootDirectory, resultSchema, outputSchema, outputEnvelope([artifact("fixture", digest)])))
        .toThrow(/does not match its declared schema/u);
    }
  });
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

let observations = 0;
function observedService(): WorkflowService {
  const validator = new ContractValidator();
  return new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, undefined, null, {
    observe(binding: ExecutionObservationBindingV1): ExecutionContextV1 {
      observations += 1;
      const observedAt = new Date();
      return {
        schemaVersion: "1.0.0", model: "fixture", modelClass: "deep", reasoningEffort: "high", source: "runtime",
        observedAt: observedAt.toISOString(), observationId: `provider-result-${String(observations).padStart(6, "0")}`,
        taskId: binding.taskId, runId: binding.runId, stageId: binding.stageId, revision: binding.revision,
        actorId: "fixture-actor", expiresAt: new Date(observedAt.getTime() + 60_000).toISOString(),
      };
    },
  });
}

describe("recorded artifact digests", () => {
  it("stores the caller's digest form and still reports missing artifacts and output-file mismatches", () => {
    const workflow = observedService();
    const taskEnvelope: TaskEnvelopeV1 = {
      schemaVersion: "1.0.0",
      taskId: "digest-form",
      objective: "Record a baseline artifact whose digest carries the other prefix form.",
      scope: { included: ["fixture.md"], excluded: ["deployment"] },
      acceptanceCriteria: ["Record the planned stage through the MCP boundary."],
      riskLevel: "low",
      workUnits: [{ id: "unit-1", objective: "Run the fixture.", dependencies: [], writeTargets: ["fixture.md"] }],
      requiredCapabilities: ["change-scope-baseline-capture"],
      constraints: ["Use only fixture data."],
      authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
      decision: { complexity: "simple", hasConflicts: false },
      orchestration: { requested: true, mcpAvailable: true },
    };
    const frame = {
      schemaVersion: "1.0.0" as const,
      workspace: { workspaceId: "digest-form", locator: "fixture:digest-form" },
      controlArtifacts: [{ artifactId: "acceptance", role: "pass-condition", locator: "fixture:acceptance", digest: `sha256:${"a".repeat(64)}` }],
      targetArtifacts: [{ artifactId: "candidate", role: "candidate", locator: "fixture:candidate", digest: `sha256:${"b".repeat(64)}` }],
      operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
    };
    const plan = workflow.planWorkflow({ schemaVersion: "1.0.0", taskEnvelope }, true).data!;
    const root = workflow.openConvergenceRoot({ schemaVersion: "1.0.0", parentRootId: null, taskEnvelope, frame, userApprovalRefs: [] }).data!;
    const lease = workflow.claimWorkflowAttempt({
      schemaVersion: "1.0.0", rootId: root.rootId, expectedRevision: root.revision, taskEnvelope, frame,
      plan, actorId: "fixture-actor", outputTargets: ["fixture.md"], priorFailure: null,
    }, true).data!;
    const receipt = workflow.startGuardedWorkflow({ schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan }, true).data!;
    const stage = receipt.plan.stages[0]!;
    expect(stage.requiredArtifacts).toEqual(["workspace-baseline"]);
    const record = (artifacts: unknown[], outputFile?: { locator: string; digest: string }) => workflow.recordStageResult({
      schemaVersion: "1.0.0", runId: receipt.runId, stageId: stage.stageId, expectedRevision: receipt.revision, state: "passed",
      ...(outputFile ? { outputFile } : {}),
      output: outputEnvelope(artifacts),
      evidence: [{ artifactId: "fixture", kind: "test", locator: "provider-result-envelope.test.ts", verified: true, note: "fixture" }],
      findings: [], blockers: [], error: null,
    } as StageResultV1, true);

    const missing = record([artifact("unrelated", prefixedDigest)]);
    expect(missing.error?.code).toBe("MISSING_EVIDENCE");
    expect(missing.error?.details).toMatchObject({ missingArtifacts: ["workspace-baseline"] });

    const directory = mkdtempSync(path.join(tmpdir(), "provider-result-"));
    directories.push(directory);
    const locator = path.join(directory, "output.json");
    writeFileSync(locator, "{}");
    const otherDigest = `sha256:${createHash("sha256").update("other").digest("hex")}`;
    expect(record([artifact("workspace-baseline", prefixedDigest)], { locator, digest: otherDigest }).error?.code).toBe("INTEGRITY_FAILED");

    const recorded = record([artifact("workspace-baseline", prefixedDigest)]);
    expect(recorded.error).toBeNull();
    expect(recorded.data!.stageResults[0]!.output.artifacts[0]).toMatchObject({ digest: prefixedDigest, targetDigest: prefixedDigest });
  });
});
