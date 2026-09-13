import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type { ApiResultV1, PluginUpdateStatusV1, StageResultV1, TaskEnvelopeV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";

const rootDirectory = fileURLToPath(new URL("../../", import.meta.url));
const bundledServer = fileURLToPath(new URL("../../mcp-server/dist/server.mjs", import.meta.url));

function toolArguments(value: object): Record<string, unknown> {
  return value as unknown as Record<string, unknown>;
}

function toolData<T>(result: unknown): ApiResultV1<T> {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) throw new Error("MCP response did not contain content.");
  const text = content.find((item): item is { type: "text"; text: string } => (
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
  ));
  if (!text) throw new Error("MCP response did not contain a text result.");
  return JSON.parse(text.text) as ApiResultV1<T>;
}

function textContents(result: unknown): string[] {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => (
    Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
      ? [(item as { text: string }).text]
      : []
  ));
}

function seedAvailableUpdate(databasePath: string): void {
  const store = new SqliteWorkflowStore(databasePath);
  try {
    store.putPluginUpdateState({
      targetId: "agent-governance-suite",
      currentVersion: "1.1.0",
      latestVersion: "1.2.0",
      latestTag: "v1.2.0",
      latestCommit: "c".repeat(40),
      etag: "stdio-fixture",
      comparison: "update-available",
      lastAttemptAt: "2026-09-13T00:00:00.000Z",
      lastSuccessfulCheckAt: "2026-09-13T00:00:00.000Z",
      nextCheckAt: "2099-01-01T00:00:00.000Z",
      lastNotifiedVersion: null,
      lastNotifiedAt: null,
      lastErrorCode: null,
    });
  } finally {
    store.close();
  }
}

describe("bundled STDIO MCP server", () => {
  it("starts from an isolated plugin tree without node_modules", async () => {
    const isolatedRoot = await mkdtemp(join(tmpdir(), "skill-suite-clean-room-"));
    const isolatedServer = join(isolatedRoot, "mcp-server", "dist", "server.mjs");
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    environment.AGENT_GOVERNANCE_DB_PATH = join(isolatedRoot, "state", "workflow-state.sqlite3");
    let transport: StdioClientTransport | undefined;

    try {
      await mkdir(join(isolatedRoot, "mcp-server", "dist"), { recursive: true });
      await Promise.all([
        cp(bundledServer, isolatedServer),
        cp(join(rootDirectory, "contracts"), join(isolatedRoot, "contracts"), { recursive: true }),
        cp(join(rootDirectory, "skills"), join(isolatedRoot, "skills"), { recursive: true }),
      ]);

      transport = new StdioClientTransport({
        command: process.execPath,
        args: [isolatedServer],
        cwd: isolatedRoot,
        env: environment,
        stderr: "pipe",
      });
      const client = new Client({ name: "clean-room-install-test", version: "1.0.0" });
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "check_for_updates",
        "plan_workflow",
        "start_workflow",
        "record_stage_result",
        "get_workflow_status",
        "finalize_workflow",
        "abort_workflow",
      ]);
      expect(listed.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);
    } finally {
      try {
        await transport?.close();
      } finally {
        await rm(isolatedRoot, { recursive: true, force: true });
      }
    }
  });

  it("starts with the packaged registry and executes complete and abort paths", async () => {
    const stateDirectory = await mkdtemp(join(tmpdir(), "skill-suite-stdio-"));
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    const databasePath = join(stateDirectory, "workflow-state.sqlite3");
    environment.AGENT_GOVERNANCE_DB_PATH = databasePath;
    seedAvailableUpdate(databasePath);
    let transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    let client = new Client({ name: "stdio-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "check_for_updates",
        "plan_workflow",
        "start_workflow",
        "record_stage_result",
        "get_workflow_status",
        "finalize_workflow",
        "abort_workflow",
      ]);
      expect(listed.tools.find((tool) => tool.name === "plan_workflow")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "check_for_updates")?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      });
      expect(listed.tools.find((tool) => tool.name === "get_workflow_status")?.annotations?.readOnlyHint).toBe(true);
      expect(listed.tools.find((tool) => tool.name === "start_workflow")?.annotations?.readOnlyHint).toBe(false);

      const task: TaskEnvelopeV1 = {
        schemaVersion: "1.0.0",
        taskId: "stdio-default-registry",
        objective: "Plan two independent implementation units.",
        scope: { included: ["implementation planning"], excluded: ["deployment"] },
        acceptanceCriteria: ["Return an executable work plan."],
        riskLevel: "low",
        workUnits: [
          { id: "first", objective: "First unit.", dependencies: [], writeTargets: ["first.md"] },
          { id: "second", objective: "Second unit.", dependencies: [], writeTargets: ["second.md"] },
        ],
        requiredCapabilities: ["task-decomposition"],
        constraints: ["Use local files only."],
        authorization: {
          allowedActions: ["read"],
          prohibitedActions: ["deploy"],
          approvalRequired: [],
        },
        decision: { complexity: "simple", hasConflicts: false },
        orchestration: { requested: true, mcpAvailable: true },
      };
      const plannedResponse = await client.callTool({
        name: "plan_workflow",
        arguments: toolArguments(task),
      });
      const planned = toolData<WorkflowPlanV1>(plannedResponse);
      const plannedContents = textContents(plannedResponse);
      expect(plannedContents).toHaveLength(2);
      expect(JSON.parse(plannedContents[1]!)).toMatchObject({
        kind: "plugin-update-notice",
        currentVersion: "1.1.0",
        latestVersion: "1.2.0",
        automaticInstall: false,
      });
      expect(planned.ok).toBe(true);
      expect(planned.data?.state).toBe("ready");
      expect(planned.data?.selectedSkills).toContain("coordinate-subagents");
      expect(planned.data?.stages).toHaveLength(1);
      expect(planned.data?.stages[0]?.satisfiedCapabilities).toEqual(["task-decomposition"]);

      const startedResponse = await client.callTool({
        name: "start_workflow",
        arguments: toolArguments(planned.data!),
      });
      expect(textContents(startedResponse)).toHaveLength(1);
      const started = toolData<WorkflowReceiptV1>(startedResponse);
      expect(started.data).toMatchObject({ state: "running", revision: 0 });

      const updateStatus = toolData<PluginUpdateStatusV1>(await client.callTool({
        name: "check_for_updates",
        arguments: { force: false },
      }));
      expect(updateStatus.data).toMatchObject({
        currentVersion: "1.1.0",
        latestVersion: "1.2.0",
        comparison: "update-available",
        automaticInstall: false,
      });

      const stage = started.data!.plan.stages[0]!;
      const stageResult: StageResultV1 = {
        schemaVersion: "1.0.0",
        runId: started.data!.runId,
        stageId: stage.stageId,
        expectedRevision: started.data!.revision,
        state: "passed",
        output: {
          schemaVersion: "1.0.0",
          kind: "output",
          output: { completed: true },
          artifacts: stage.requiredArtifacts.map((artifactId) => ({
            artifactId,
            schemaId: "stdio-fixture/v1",
            locator: `tests/mcp/stdio/${artifactId}.json`,
            digest: "a".repeat(64),
            targetDigest: "b".repeat(64),
            verified: true,
          })),
          error: null,
        },
        evidence: [{
          artifactId: "stdio-execution",
          kind: "test",
          locator: "tests/mcp/stdio-integration.test.ts",
          verified: true,
          note: "Executed through the bundled STDIO transport.",
        }],
        findings: [],
        blockers: [],
        error: null,
      };
      const recorded = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "record_stage_result",
        arguments: toolArguments(stageResult),
      }));
      expect(recorded.data).toMatchObject({ state: "running", revision: 1 });

      await transport.close();
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [bundledServer],
        cwd: rootDirectory,
        env: environment,
        stderr: "pipe",
      });
      client = new Client({ name: "stdio-restart-test", version: "1.0.0" });
      await client.connect(transport);

      const statusResponse = await client.callTool({
        name: "get_workflow_status",
        arguments: { runId: recorded.data!.runId },
      });
      expect(textContents(statusResponse)).toHaveLength(1);
      const status = toolData<WorkflowReceiptV1>(statusResponse);
      expect(status.data?.runId).toBe(started.data?.runId);
      expect(status.data?.revision).toBe(recorded.data?.revision);

      const finalized = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "finalize_workflow",
        arguments: { runId: status.data!.runId, expectedRevision: status.data!.revision },
      }));
      expect(finalized.data).toMatchObject({ state: "passed", revision: 2 });

      const abortTask = { ...task, taskId: "stdio-abort-path" };
      const abortPlan = toolData<WorkflowPlanV1>(await client.callTool({
        name: "plan_workflow",
        arguments: toolArguments(abortTask),
      }));
      const abortRun = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "start_workflow",
        arguments: toolArguments(abortPlan.data!),
      }));
      const aborted = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "abort_workflow",
        arguments: { runId: abortRun.data!.runId, expectedRevision: abortRun.data!.revision },
      }));
      expect(aborted.data).toMatchObject({ state: "blocked", revision: 1 });
    } finally {
      try {
        await transport.close();
      } finally {
        await rm(stateDirectory, { recursive: true, force: true });
      }
    }
  });
});
