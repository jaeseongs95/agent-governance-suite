import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateRequest as validateScopeRequest, validateTaskEnvelope } from "../../skills/change-scope-guardian/scripts/lib.mjs";
import {
  compileAllSchemas,
  validateTaskEnvelopeSchema,
  validateWorkflowReceiptSchema,
} from "../../skills/recovery-strategy-selector/scripts/schema-validation.mjs";

const fixture = JSON.parse(await readFile(new URL("../task-contract/fixtures/normal/simple-read.json", import.meta.url), "utf8"));
const artifactContract = {
  capability: "fixture-capability",
  produced: [{ artifactId: "fixture-report", schemaId: "fixture/v1", targetDigest: "sha256:" + "a".repeat(64) }],
};

function task(withArtifactContract = true) {
  const envelope = structuredClone(fixture.report.taskEnvelope);
  if (withArtifactContract) envelope.artifactContracts = [structuredClone(artifactContract)];
  return envelope;
}

function malformedTask(mutation) {
  const envelope = task();
  if (mutation === "target") envelope.artifactContracts[0].produced[0].targetDigest = "not-a-digest";
  else envelope.undeclaredField = true;
  return envelope;
}

function receipt(withArtifactContract = true) {
  const schema = { path: "contracts/fixture.schema.json", digest: "sha256:" + "b".repeat(64) };
  const stage = {
    stageId: "fixture-stage", order: 1, requiredCapability: "fixture-capability", satisfiedCapabilities: ["fixture-capability"],
    skillId: "fixture", phase: "execution", selectionReason: "Fixture contract.", state: "ready",
    requiredArtifacts: ["fixture-report"], riskGate: "none", providerKey: "fixture:0", executionClass: "workflow", phaseOrder: 1,
    requiredInputArtifacts: [], inputBindings: [], producedArtifacts: ["fixture-report"],
    outputSchema: structuredClone(schema), resultSchema: structuredClone(schema),
    stateMapping: { default: { state: "passed", errorRequired: false }, adapterErrors: [] },
    gate: { kind: "none", policy: "none", validator: null, validatorSchema: null },
  };
  if (withArtifactContract) stage.artifactContract = structuredClone(artifactContract);
  return {
    schemaVersion: "1.0.0", runId: "fixture-run", revision: 0, state: "ready",
    plan: {
      schemaVersion: "1.0.0", taskId: fixture.report.taskEnvelope.taskId, integrityToken: "A".repeat(43),
      executionMode: "orchestrated", state: "ready", selectedSkills: ["fixture"], stages: [stage],
      currentStageId: null, nextStageId: stage.stageId, errors: [],
    },
    stageResults: [], blockers: [], unresolved: [], error: null,
  };
}

describe("AL06 current TaskEnvelope runtime consumers", () => {
  it.each([false, true])("change-scope lib accepts artifactContracts present=%s", (present) => {
    const envelope = task(present);
    if (!present) expect(envelope).not.toHaveProperty("artifactContracts");
    expect(validateTaskEnvelope(envelope)).toBe(envelope);
  });

  it.each(["target", "unknown"])("change-scope lib rejects malformed %s input", (mutation) => {
    expect(() => validateTaskEnvelope(malformedTask(mutation))).toThrow();
  });

  it.each(["capture", "verify"])("change-scope %s request reaches the real lib guard with optional fields", (mode) => {
    const request = { schemaVersion: "1.0.0", mode, repositoryRoot: "fixture", comparisonTarget: "working-tree", taskEnvelope: task() };
    expect(validateScopeRequest(request, mode)).toBe(request);
  });

  it.each([false, true])("recovery task schema accepts artifactContracts present=%s", (present) => {
    expect(validateTaskEnvelopeSchema(task(present)), JSON.stringify(validateTaskEnvelopeSchema.errors)).toBe(true);
  });

  it.each(["target", "unknown"])("recovery task schema rejects malformed %s input", (mutation) => {
    expect(validateTaskEnvelopeSchema(malformedTask(mutation))).toBe(false);
  });

  it("compiles the current workflow receipt reference closure in its isolated schema check", () => {
    expect(() => compileAllSchemas()).not.toThrow();
  });

  it.each([false, true])("recovery receipt resolves stage artifactContract present=%s", (present) => {
    expect(validateWorkflowReceiptSchema(receipt(present)), JSON.stringify(validateWorkflowReceiptSchema.errors)).toBe(true);
  });

  it.each(["target", "unknown"])("recovery receipt rejects malformed artifactContract %s through the workflow-plan ref", (mutation) => {
    const value = receipt();
    const contract = value.plan.stages[0].artifactContract;
    if (mutation === "target") contract.produced[0].targetDigest = "not-a-digest";
    else contract.undeclaredField = true;
    expect(validateWorkflowReceiptSchema(value)).toBe(false);
  });
});
