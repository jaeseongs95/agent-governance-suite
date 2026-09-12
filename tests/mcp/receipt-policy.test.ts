import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type {
  PlannedStageV1,
  SkillDescriptorV2,
  StageResultV1,
  TaskEnvelopeV1,
} from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { assertReceiptPolicy } from "../../mcp-server/src/receipt-policy.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const temporaryDirectories: string[] = [];
const sqliteStores = new Set<SqliteWorkflowStore>();
const capabilities = [
  "korean-prose-selection",
  "korean-prose-editing",
  "korean-prose-verification",
  "korean-prose-finalization",
] as const;
const actors = [
  "10000000-0000-4000-8000-000000000001",
  "10000000-0000-4000-8000-000000000002",
  "10000000-0000-4000-8000-000000000003",
] as const;

const outputSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://skill-suite.local/contracts/reference-only-output.fixture.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["status", "receiptRef"],
  properties: {
    status: { enum: ["selected", "edited", "verified", "finalized"] },
    receiptRef: { type: "string", pattern: "^artifact://[a-z0-9/-]+$" },
    actorId: { type: "string", format: "uuid", pattern: "^[0-9a-f-]+$" },
    actorIds: { type: "array", items: { type: "string", format: "uuid" } },
    warnings: { type: "array", items: { enum: ["PROTECTED_EDIT_RETAINED"] } },
    reference: { type: "string" },
  },
} as const;

function provider(
  index: number,
  requiredInputArtifacts: string[],
  producedArtifact: string,
): SkillDescriptorV2["providers"][number] {
  const capability = capabilities[index]!;
  return {
    capabilities: [capability],
    executionClass: "workflow",
    phase: capability,
    phaseOrder: 50 + index * 5,
    requiredInputArtifacts,
    inputBindings: requiredInputArtifacts.map((targetArtifact) => ({
      targetArtifact,
      sources: [targetArtifact === "korean-prose-request" || targetArtifact === "korean-prose-rubric"
        ? `external:${targetArtifact}`
        : targetArtifact],
      operation: "select",
    })),
    producedArtifacts: [producedArtifact],
    outputSchema: "contracts/reference-only-output.fixture.schema.json",
    resultSchema: "contracts/provider-result.v1.schema.json",
    stateMapping: {
      default: { state: "passed", errorRequired: false },
      adapterErrors: ["INVALID_INPUT", "MISSING_EVIDENCE"],
    },
    selectionCriteria: ["Korean prose workflow stage."],
    preconditions: [],
    failureHandling: "Return reference-only failure tokens.",
    gate: { kind: "none", policy: "none", validator: null },
    receiptPolicy: index < 3
      ? { mode: "reference-only", actorIdPointer: "/output/actorId", uniqueness: "run" }
      : { mode: "reference-only", actorIdsPointer: "/output/actorIds", actorIdsMatch: "prior-policy-actors" },
  };
}

const descriptor: SkillDescriptorV2 = {
  schemaVersion: "2.0.0",
  skillId: "reference-only-prose-editor",
  version: "1.1.0",
  path: "./reference-only-prose-editor",
  enabled: true,
  priority: 50,
  providers: [
    provider(0, ["korean-prose-request"], "edit-decision-set"),
    provider(1, ["korean-prose-request", "edit-decision-set"], "edit-candidate"),
    provider(2, ["korean-prose-request", "edit-decision-set", "edit-candidate", "korean-prose-rubric"], "edit-verification-report"),
    provider(3, ["korean-prose-request", "edit-candidate", "edit-verification-report"], "final-text-receipt"),
  ],
};

function task(overrides: Partial<TaskEnvelopeV1> = {}): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId: "reference-only-prose",
    objective: "Edit supplied Korean prose.",
    scope: { included: ["supplied prose"], excluded: ["publication"] },
    acceptanceCriteria: ["Preserve meaning."],
    riskLevel: "low",
    workUnits: [],
    requiredCapabilities: ["korean-prose-editing"],
    constraints: ["Do not persist source prose."],
    authorization: { allowedActions: ["edit"], prohibitedActions: ["publish"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
    ...overrides,
  };
}

async function createFixture(store?: SqliteWorkflowStore, fixtureDescriptor = descriptor): Promise<{
  service: WorkflowService;
  registryPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "receipt-policy-"));
  temporaryDirectories.push(directory);
  const contractsDirectory = join(directory, "contracts");
  const registryPath = join(directory, "skills", "registry.json");
  await mkdir(contractsDirectory, { recursive: true });
  await mkdir(join(directory, "skills"), { recursive: true });
  await copyFile(
    new URL("../../contracts/provider-result.v1.schema.json", import.meta.url),
    join(contractsDirectory, "provider-result.v1.schema.json"),
  );
  await writeFile(
    join(contractsDirectory, "reference-only-output.fixture.schema.json"),
    JSON.stringify(outputSchema),
    "utf8",
  );
  await writeFile(registryPath, JSON.stringify({ schemaVersion: "2.0.0", skills: [fixtureDescriptor] }), "utf8");
  const validator = new ContractValidator();
  return {
    service: new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store),
    registryPath,
  };
}

function openStore(databasePath: string): SqliteWorkflowStore {
  const store = new SqliteWorkflowStore(databasePath);
  sqliteStores.add(store);
  return store;
}

function closeStore(store: SqliteWorkflowStore): void {
  store.close();
  sqliteStores.delete(store);
}

function passedStage(
  runId: string,
  stage: PlannedStageV1,
  expectedRevision: number,
  actorId: string | undefined = actors[stage.order - 1],
): StageResultV1 {
  const status = ["selected", "edited", "verified", "finalized"][stage.order - 1]!;
  return {
    schemaVersion: "1.0.0",
    runId,
    stageId: stage.stageId,
    expectedRevision,
    state: "passed",
    output: {
      schemaVersion: "1.0.0",
      kind: "output",
      output: {
        status,
        receiptRef: `artifact://receipt/${stage.order}`,
        ...(actorId ? { actorId } : {}),
        ...(stage.receiptPolicy?.actorIdsPointer ? { actorIds: [...actors] } : {}),
      },
      artifacts: stage.producedArtifacts.map((artifactId) => ({
        artifactId,
        schemaId: "schema://korean-prose/receipt-v1",
        locator: `artifact://receipt/${stage.order}/${artifactId}`,
        digest: "a".repeat(64),
        targetDigest: "b".repeat(64),
        verified: true,
      })),
      error: null,
    },
    evidence: stage.requiredInputArtifacts.map((artifactId) => ({
      artifactId,
      kind: "document",
      locator: `artifact://input/${artifactId}`,
      verified: true,
      note: "",
    })),
    findings: [],
    blockers: [],
    error: null,
  };
}

afterEach(async () => {
  for (const store of sqliteStores) store.close();
  sqliteStores.clear();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("descriptor-declared reference-only receipts", () => {
  it("propagates all four policies, orders artifact dependencies, and binds policy to the plan HMAC", async () => {
    const { service } = await createFixture();
    const plan = service.planWorkflow(task()).data!;

    expect(plan.stages.map((stage) => stage.requiredCapability)).toEqual(capabilities);
    expect(plan.stages.map((stage) => stage.phaseOrder)).toEqual([50, 55, 60, 65]);
    expect(plan.stages.map((stage) => stage.receiptPolicy)).toEqual([
      { mode: "reference-only", actorIdPointer: "/output/actorId", uniqueness: "run" },
      { mode: "reference-only", actorIdPointer: "/output/actorId", uniqueness: "run" },
      { mode: "reference-only", actorIdPointer: "/output/actorId", uniqueness: "run" },
      { mode: "reference-only", actorIdsPointer: "/output/actorIds", actorIdsMatch: "prior-policy-actors" },
    ]);
    expect(plan.stages[1]?.requiredInputArtifacts).toContain("edit-decision-set");
    expect(plan.stages[2]?.requiredInputArtifacts).toEqual(expect.arrayContaining([
      "edit-decision-set",
      "edit-candidate",
      "korean-prose-rubric",
    ]));

    const modified = structuredClone(plan);
    modified.stages[0]!.receiptPolicy = { mode: "reference-only" };
    expect(service.startWorkflow(modified).error?.code).toBe("INVALID_INPUT");
    const modifiedActorIdsPointer = structuredClone(plan);
    modifiedActorIdsPointer.stages[3]!.receiptPolicy!.actorIdsPointer = "/output/unboundActors";
    expect(service.startWorkflow(modifiedActorIdsPointer).error?.code).toBe("INVALID_INPUT");
    const removedActorIdsPolicy = structuredClone(plan);
    removedActorIdsPolicy.stages[3]!.receiptPolicy = { mode: "reference-only" };
    expect(service.startWorkflow(removedActorIdsPolicy).error?.code).toBe("INVALID_INPUT");
    expect(service.startWorkflow(plan).ok).toBe(true);
  });

  it.each([
    { actorIdsPointer: "/output/actorIds" },
    { actorIdsMatch: "prior-policy-actors" },
    { actorIdsPointer: "output/actorIds", actorIdsMatch: "prior-policy-actors" },
    { actorIdsPointer: "/output/actorIds", actorIdsMatch: "any-actors" },
  ])("rejects invalid actor-array policies in descriptors and plans: %j", async (fields) => {
    const validator = new ContractValidator();
    const invalidDescriptor = structuredClone(descriptor);
    Object.assign(invalidDescriptor.providers[3]!, { receiptPolicy: { mode: "reference-only", ...fields } });
    expect(() => validator.skillDescriptorV2(invalidDescriptor)).toThrow();
    const { service } = await createFixture();
    const plan = service.planWorkflow(task()).data!;
    Object.assign(plan.stages[3]!, { receiptPolicy: { mode: "reference-only", ...fields } });
    expect(() => validator.workflowPlan(plan)).toThrow();
  });

  it.each([
    ["missing", undefined],
    ["empty", []],
    ["incomplete", actors.slice(0, 2)],
    ["extra", [...actors, "10000000-0000-4000-8000-000000000004"]],
    ["reordered", [actors[1], actors[0], actors[2]]],
    ["duplicate", [actors[0], actors[1], actors[1]]],
    ["unrelated", [actors[0], actors[1], "10000000-0000-4000-8000-000000000004"]],
  ])("rejects %s final actor arrays without changing the receipt", async (_label, actorIds) => {
    const { service } = await createFixture();
    let receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    for (const stage of receipt.plan.stages.slice(0, 3)) {
      receipt = service.recordStageResult(passedStage(receipt.runId, stage, receipt.revision)).data!;
    }
    const result = passedStage(receipt.runId, receipt.plan.stages[3]!, receipt.revision);
    if (actorIds === undefined) delete result.output.output!.actorIds;
    else result.output.output!.actorIds = actorIds;
    expect(service.recordStageResult(result).error?.code).toBe("GATE_FAILED");
    expect(service.getWorkflowStatus(receipt.runId).data).toEqual(receipt);
  });

  it("accepts a finite warning enum token declared in the bound output schema", async () => {
    const { service } = await createFixture();
    const receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    const result = passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision);
    result.output.output!.warnings = ["PROTECTED_EDIT_RETAINED"];
    result.findings = ["PROTECTED_EDIT_RETAINED"];
    expect(service.recordStageResult(result).ok).toBe(true);
  });

  it.each(["ARBITRARY_UPPERCASE_TOKEN", "PROTECTED_EDIT_RETAINED_EXTRA", "arbitrary free text"])(
    "rejects undeclared text even when the output schema permits strings: %s",
    async (value) => {
      const { service } = await createFixture();
      const receipt = service.startWorkflow(service.planWorkflow(task()).data!).data!;
      const result = passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision);
      result.output.output!.reference = value;
      expect(service.recordStageResult(result).error?.message).toBe("Reference-only receipt policy rejected free text.");
      delete result.output.output!.reference;
      result.findings = [value];
      expect(service.recordStageResult(result).error?.message).toBe("Reference-only receipt policy rejected free text.");
    },
  );

  it("rejects out-of-order stages and missing produced or external prerequisites", async () => {
    const { service } = await createFixture();
    const started = service.startWorkflow(service.planWorkflow(task()).data!).data!;
    expect(service.recordStageResult(
      passedStage(started.runId, started.plan.stages[1]!, started.revision),
    ).error?.code).toBe("INVALID_TRANSITION");

    const missingExternal = passedStage(started.runId, started.plan.stages[0]!, started.revision);
    missingExternal.evidence = [];
    expect(service.recordStageResult(missingExternal).error?.code).toBe("MISSING_EVIDENCE");

    const missingProduced = passedStage(started.runId, started.plan.stages[0]!, started.revision);
    missingProduced.output.artifacts = [];
    expect(service.recordStageResult(missingProduced).error?.code).toBe("MISSING_EVIDENCE");
  });

  it("rejects actor reuse after SQLite restart", async () => {
    const databaseDirectory = await mkdtemp(join(tmpdir(), "receipt-policy-db-"));
    temporaryDirectories.push(databaseDirectory);
    const databasePath = join(databaseDirectory, "workflow.sqlite3");
    const firstStore = openStore(databasePath);
    const fixture = await createFixture(firstStore);
    let receipt = fixture.service.startWorkflow(fixture.service.planWorkflow(task({ taskId: "actor-restart" })).data!).data!;
    receipt = fixture.service.recordStageResult(
      passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision, actors[0]),
    ).data!;
    closeStore(firstStore);

    const secondStore = openStore(databasePath);
    const validator = new ContractValidator();
    const resumed = new WorkflowService(new FileSkillRegistry(fixture.registryPath, validator), validator, secondStore);
    const reused = passedStage(receipt.runId, receipt.plan.stages[1]!, receipt.revision, actors[0]);
    expect(resumed.recordStageResult(reused).error).toMatchObject({ code: "GATE_FAILED" });
    expect(resumed.getWorkflowStatus(receipt.runId).data?.revision).toBe(1);
  });

  it("binds arbitrary capability actor arrays in plan order after SQLite restart", async () => {
    const genericDescriptor = structuredClone(descriptor);
    genericDescriptor.providers.forEach((entry, index) => {
      entry.capabilities = [`custom-stage-${index + 1}`];
      entry.phase = `custom-phase-${index + 1}`;
    });
    const databaseDirectory = await mkdtemp(join(tmpdir(), "receipt-policy-array-db-"));
    temporaryDirectories.push(databaseDirectory);
    const databasePath = join(databaseDirectory, "workflow.sqlite3");
    const firstStore = openStore(databasePath);
    const fixture = await createFixture(firstStore, genericDescriptor);
    const genericTask = task({ requiredCapabilities: genericDescriptor.providers.flatMap((entry) => entry.capabilities) });
    let receipt = fixture.service.startWorkflow(fixture.service.planWorkflow(genericTask).data!).data!;
    const boundActors = actors.map((actorId) => actorId.replace(/^1/, "2"));
    for (const stage of receipt.plan.stages.slice(0, 3)) {
      receipt = fixture.service.recordStageResult(
        passedStage(receipt.runId, stage, receipt.revision, boundActors[stage.order - 1]),
      ).data!;
    }
    closeStore(firstStore);
    const validator = new ContractValidator();
    const resumed = new WorkflowService(new FileSkillRegistry(fixture.registryPath, validator), validator, openStore(databasePath));
    const finalStage = receipt.plan.stages[3]!;
    const finalResult = passedStage(receipt.runId, finalStage, receipt.revision);
    expect(resumed.recordStageResult(finalResult).error?.code).toBe("GATE_FAILED");
    finalResult.output.output!.actorIds = boundActors;

    const unorderedReceipt = structuredClone(receipt);
    unorderedReceipt.stageResults.reverse();
    const tokens = new Set(["finalized"]);
    expect(() => assertReceiptPolicy(unorderedReceipt, finalStage, finalResult, tokens)).not.toThrow();
    unorderedReceipt.stageResults.pop();
    expect(() => assertReceiptPolicy(unorderedReceipt, finalStage, finalResult, tokens)).toThrow(
      "A prior policy stage has no valid actor binding.",
    );
    expect(resumed.recordStageResult(finalResult).ok).toBe(true);
    expect(resumed.finalizeWorkflow(receipt.runId, receipt.revision + 1).ok).toBe(true);
  });

  it("rejects raw output and receipt text surfaces before SQLite persistence", async () => {
    const databaseDirectory = await mkdtemp(join(tmpdir(), "receipt-policy-raw-db-"));
    temporaryDirectories.push(databaseDirectory);
    const databasePath = join(databaseDirectory, "workflow.sqlite3");
    const store = openStore(databasePath);
    const { service } = await createFixture(store);
    const receipt = service.startWorkflow(service.planWorkflow(task({ taskId: "raw-sentinel" })).data!).data!;
    const rawSentinel = "RAW SOURCE SENTINEL must never persist";
    const leaked = passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision);
    leaked.evidence[0]!.note = rawSentinel;

    expect(service.recordStageResult(leaked).error?.code).toBe("INVALID_INPUT");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare("SELECT receipt_json FROM workflow_runs WHERE run_id = ?").get(receipt.runId) as {
        receipt_json: string;
      };
      expect(row.receipt_json).not.toContain(rawSentinel);
      expect(JSON.parse(row.receipt_json)).toMatchObject({ revision: 0, stageResults: [] });
    } finally {
      database.close();
    }
  });

  it.each([
    ["output", (result: StageResultV1) => { result.output.output!.receiptRef = "raw prose sentinel"; }],
    ["evidence locator", (result: StageResultV1) => { result.evidence[0]!.locator = "raw prose sentinel"; }],
    ["evidence note", (result: StageResultV1) => { result.evidence[0]!.note = "raw prose sentinel"; }],
    ["finding", (result: StageResultV1) => { result.findings = ["raw prose sentinel"]; }],
    ["blocker", (result: StageResultV1) => { result.blockers = ["raw prose sentinel"]; }],
  ])("rejects free text through %s", async (_surface, mutate) => {
    const { service } = await createFixture();
    const receipt = service.startWorkflow(service.planWorkflow(task({ taskId: `surface-${_surface}` })).data!).data!;
    const result = passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision);
    mutate(result);
    expect(service.recordStageResult(result).error?.code).toBe("INVALID_INPUT");
  });

  it.each([
    ["message", "raw error message", null],
    ["details", "INVALID_INPUT", { leaked: "raw error details" }],
    ["details key", "INVALID_INPUT", { "raw error key": null }],
  ])("rejects free text through error %s", async (_surface, message, details) => {
    const { service } = await createFixture();
    const receipt = service.startWorkflow(service.planWorkflow(task({ taskId: `error-${_surface}` })).data!).data!;
    const providerError = { code: "INVALID_INPUT" as const, message, details };
    const result: StageResultV1 = {
      ...passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision),
      state: "blocked",
      output: {
        schemaVersion: "1.0.0",
        kind: "adapter-error",
        output: null,
        artifacts: [],
        error: providerError,
      },
      error: providerError,
    };
    expect(service.recordStageResult(result).error?.code).toBe("INVALID_INPUT");
  });

  it("rejects non-opaque actor labels", async () => {
    const { service } = await createFixture();
    const receipt = service.startWorkflow(service.planWorkflow(task({ taskId: "actor-label" })).data!).data!;
    const result = passedStage(receipt.runId, receipt.plan.stages[0]!, receipt.revision, "selection-agent");
    expect(service.recordStageResult(result).error).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("finalizes deterministically without requiring a fourth actor and keeps direct mode unverified", async () => {
    const { service } = await createFixture();
    let receipt = service.startWorkflow(service.planWorkflow(task({ taskId: "finalization" })).data!).data!;
    for (const stage of receipt.plan.stages) {
      receipt = service.recordStageResult(
        passedStage(receipt.runId, stage, receipt.revision, actors[stage.order - 1]),
      ).data!;
    }
    expect(receipt.stageResults[3]?.output.output).not.toHaveProperty("actorId");
    expect(service.finalizeWorkflow(receipt.runId, receipt.revision)).toMatchObject({
      ok: true,
      data: { state: "passed", revision: 5 },
    });

    const direct = service.planWorkflow(task({
      taskId: "direct-prose",
      orchestration: { requested: false, mcpAvailable: true },
    })).data!;
    expect(direct.executionMode).toBe("direct");
    expect(direct.stages.map((stage) => stage.requiredCapability)).toEqual(capabilities);
    expect(service.startWorkflow(direct).error?.code).toBe("INVALID_TRANSITION");
  });
});
