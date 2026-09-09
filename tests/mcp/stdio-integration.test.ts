import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";

import type { ApiResultV1, TaskEnvelopeV1, WorkflowPlanV1, WorkflowReceiptV1 } from "../../contracts/types.js";

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

describe("bundled STDIO MCP server", () => {
  it("starts with the packaged registry and executes the plan/start/get/abort path", async () => {
    const environment = getDefaultEnvironment();
    delete environment.SKILL_REGISTRY_PATH;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bundledServer],
      cwd: rootDirectory,
      env: environment,
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-integration-test", version: "1.0.0" });

    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "plan_workflow",
        "start_workflow",
        "record_stage_result",
        "get_workflow_status",
        "finalize_workflow",
        "abort_workflow",
      ]);
      expect(listed.tools.find((tool) => tool.name === "plan_workflow")?.annotations?.readOnlyHint).toBe(true);
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
      const planned = toolData<WorkflowPlanV1>(await client.callTool({
        name: "plan_workflow",
        arguments: toolArguments(task),
      }));
      expect(planned.ok).toBe(true);
      expect(planned.data?.state).toBe("ready");
      expect(planned.data?.selectedSkills).toContain("coordinate-subagents");

      const started = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "start_workflow",
        arguments: toolArguments(planned.data!),
      }));
      expect(started.data).toMatchObject({ state: "running", revision: 0 });

      const status = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "get_workflow_status",
        arguments: { runId: started.data!.runId },
      }));
      expect(status.data?.runId).toBe(started.data?.runId);

      const aborted = toolData<WorkflowReceiptV1>(await client.callTool({
        name: "abort_workflow",
        arguments: { runId: started.data!.runId, expectedRevision: status.data!.revision },
      }));
      expect(aborted.data).toMatchObject({ state: "blocked", revision: 1 });
    } finally {
      await transport.close();
    }
  });
});
