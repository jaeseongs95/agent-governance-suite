import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type {
  ApiResultV1,
  AttemptLeaseV1,
  ConvergenceFrameV1,
  ConvergenceRootV1,
  StageResultV1,
  TaskEnvelopeV1,
  WorkflowPlanV1,
  WorkflowReceiptV1,
} from "../../contracts/types.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import {
  type ExecutionObservationBindingV1,
  WorkflowService,
} from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { CURRENT_VERSION } from "./version-fixtures.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

function task(taskId: string): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0",
    taskId,
    objective: "Exercise a trusted semantic MCP workflow.",
    scope: { included: ["integration test"], excluded: ["deployment"] },
    acceptanceCriteria: ["Complete the planned stage through the MCP boundary."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Run the fixture.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"],
    constraints: ["Use only fixture data."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function frame(taskId: string): ConvergenceFrameV1 {
  return {
    schemaVersion: "1.0.0",
    workspace: { workspaceId: `trusted-${taskId}`, locator: "tests/mcp/trusted-mcp-integration.test.ts" },
    controlArtifacts: [{
      artifactId: "acceptance",
      role: "pass-condition",
      locator: "fixture:acceptance",
      digest: `sha256:${"a".repeat(64)}`,
    }],
    targetArtifacts: [{
      artifactId: "candidate",
      role: "candidate",
      locator: `fixture:${taskId}`,
      digest: `sha256:${"b".repeat(64)}`,
    }],
    operationalSettings: { maxAttemptsPerEpoch: 3, maxEpochs: 2, leaseTtlSeconds: 300 },
  };
}

function result<T>(response: unknown): ApiResultV1<T> {
  const content = (response as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  const text = content.find((item) => item.type === "text" && typeof item.text === "string")?.text;
  if (!text) throw new Error("MCP response did not contain a JSON text result.");
  return JSON.parse(text) as ApiResultV1<T>;
}

describe("trusted MCP server boundary", () => {
  it("completes and aborts guarded workflows with server-side observations", async () => {
    let observationSequence = 0;
    const validator = new ContractValidator();
    const workflowStore = new InMemoryWorkflowStore();
    const service = new WorkflowService(
      new FileSkillRegistry(registryPath, validator),
      validator,
      workflowStore,
      null,
      {
        observe(binding: ExecutionObservationBindingV1) {
          observationSequence += 1;
          const observedAt = new Date();
          return {
            schemaVersion: "1.0.0" as const,
            model: "trusted-integration-fixture",
            modelClass: "deep" as const,
            reasoningEffort: "high" as const,
            source: "runtime" as const,
            observedAt: observedAt.toISOString(),
            observationId: `trusted-integration-${String(observationSequence).padStart(4, "0")}`,
            taskId: binding.taskId,
            runId: binding.runId,
            stageId: binding.stageId,
            revision: binding.revision,
            actorId: "trusted-integration-actor",
            expiresAt: new Date(observedAt.getTime() + 60_000).toISOString(),
          };
        },
      },
    );
    const updateStore = new InMemoryPluginUpdateStore();
    updateStore.putPluginUpdateState({
      targetId: "agent-governance-suite",
      currentVersion: CURRENT_VERSION,
      latestVersion: CURRENT_VERSION,
      latestTag: `v${CURRENT_VERSION}`,
      latestCommit: "c".repeat(40),
      etag: "trusted-integration",
      comparison: "up-to-date",
      lastAttemptAt: "2026-09-15T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-15T00:00:00.000Z",
      nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null,
      lastNotifiedAt: null,
      lastErrorCode: null,
    });
    const server = createMcpServer(service, new PluginUpdateService(updateStore), undefined, undefined, undefined, validator);
    const client = new Client({ name: "trusted-mcp-integration", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const completeTask = task("trusted-complete");
      const plan = result<WorkflowPlanV1>(await client.callTool({
        name: "plan_workflow",
        arguments: { schemaVersion: "1.0.0", taskEnvelope: completeTask },
      })).data!;
      expect(plan.bootstrapExecution?.context.actorId).toBe("trusted-integration-actor");
      const completeFrame = frame(completeTask.taskId);
      const root = result<ConvergenceRootV1>(await client.callTool({
        name: "open_convergence_root",
        arguments: { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: completeTask, frame: completeFrame, userApprovalRefs: [] },
      })).data!;
      const lease = result<AttemptLeaseV1>(await client.callTool({
        name: "claim_workflow_attempt",
        arguments: {
          schemaVersion: "1.0.0",
          rootId: root.rootId,
          expectedRevision: root.revision,
          taskEnvelope: completeTask,
          frame: completeFrame,
          plan,
          actorId: "trusted-integration-actor",
          outputTargets: ["fixture.md"],
          priorFailure: null,
        },
      })).data!;
      const receipt = result<WorkflowReceiptV1>(await client.callTool({
        name: "start_guarded_workflow",
        arguments: { schemaVersion: "1.0.0", leaseId: lease.leaseId, expectedRootRevision: lease.rootRevision, plan },
      })).data!;
      const stage = receipt.plan.stages[0]!;
      const stageResult: StageResultV1 = {
        schemaVersion: "1.0.0",
        runId: receipt.runId,
        stageId: stage.stageId,
        expectedRevision: receipt.revision,
        state: "passed",
        output: {
          schemaVersion: "1.0.0",
          kind: "output",
          output: { completed: true },
          artifacts: stage.requiredArtifacts.map((artifactId) => ({
            artifactId,
            schemaId: "trusted-integration/v1",
            locator: `fixture:${artifactId}`,
            digest: "d".repeat(64),
            targetDigest: "e".repeat(64),
            verified: true,
          })),
          error: null,
        },
        evidence: [{ artifactId: "trusted-mcp", kind: "test", locator: "trusted-mcp-integration.test.ts", verified: true, note: "In-memory MCP transport." }],
        findings: [],
        blockers: [],
        error: null,
      };
      const recorded = result<WorkflowReceiptV1>(await client.callTool({
        name: "record_stage_result",
        arguments: stageResult as unknown as Record<string, unknown>,
      })).data!;
      expect(recorded.stageResults[0]?.executionContext).toMatchObject({
        runId: recorded.runId,
        stageId: stage.stageId,
        revision: 0,
      });
      const finalized = result<WorkflowReceiptV1>(await client.callTool({
        name: "finalize_workflow",
        arguments: { runId: recorded.runId, expectedRevision: recorded.revision },
      }));
      expect(finalized.data).toMatchObject({ state: "passed", revision: 2 });

      const abortTask = task("trusted-abort");
      const abortPlan = result<WorkflowPlanV1>(await client.callTool({
        name: "plan_workflow",
        arguments: { schemaVersion: "1.0.0", taskEnvelope: abortTask },
      })).data!;
      const abortFrame = frame(abortTask.taskId);
      const abortRoot = result<ConvergenceRootV1>(await client.callTool({
        name: "open_convergence_root",
        arguments: { schemaVersion: "1.0.0", parentRootId: null, taskEnvelope: abortTask, frame: abortFrame, userApprovalRefs: [] },
      })).data!;
      const abortLease = result<AttemptLeaseV1>(await client.callTool({
        name: "claim_workflow_attempt",
        arguments: {
          schemaVersion: "1.0.0",
          rootId: abortRoot.rootId,
          expectedRevision: abortRoot.revision,
          taskEnvelope: abortTask,
          frame: abortFrame,
          plan: abortPlan,
          actorId: "trusted-integration-actor",
          outputTargets: ["fixture.md"],
          priorFailure: null,
        },
      })).data!;
      const abortReceipt = result<WorkflowReceiptV1>(await client.callTool({
        name: "start_guarded_workflow",
        arguments: { schemaVersion: "1.0.0", leaseId: abortLease.leaseId, expectedRootRevision: abortLease.rootRevision, plan: abortPlan },
      })).data!;
      const aborted = result<WorkflowReceiptV1>(await client.callTool({
        name: "abort_workflow",
        arguments: { runId: abortReceipt.runId, expectedRevision: abortReceipt.revision },
      }));
      expect(aborted.data).toMatchObject({ state: "blocked", revision: 1 });
      expect(observationSequence).toBe(3);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
