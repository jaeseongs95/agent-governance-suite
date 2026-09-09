import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { type ApiResultV1 } from "../../contracts/types.js";
import { contractSchemas } from "./schema-validator.js";
import { WorkflowService } from "./workflow-service.js";

const revisionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "expectedRevision"],
  properties: {
    runId: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 0 },
  },
} as const;

const workflowIdInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: {
    runId: { type: "string", minLength: 1 },
  },
} as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : Number.NaN;
}

function toolResult<T>(result: ApiResultV1<T>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    isError: !result.ok,
  };
}

/** Exposes only the orchestration layer; direct specialist invocation bypasses MCP. */
export function createMcpServer(service: WorkflowService): Server {
  const server = new Server(
    { name: "agent-governance-suite", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "plan_workflow",
        description: "Read the current skill registry and return a capability-based workflow plan without storing a run.",
        inputSchema: contractSchemas.taskEnvelope,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_workflow",
        description: "Create an in-memory running run from a ready orchestrated workflow plan.",
        inputSchema: contractSchemas.workflowPlan,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "record_stage_result",
        description: "Record one ordered stage result after validating its revision and declared verified evidence obligations.",
        inputSchema: contractSchemas.stageResult,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_workflow_status",
        description: "Read the current in-memory run receipt.",
        inputSchema: workflowIdInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "finalize_workflow",
        description: "Mark a running workflow passed only after every stage, declared required artifact, blocker, and mandatory audit gate passes.",
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "abort_workflow",
        description: "Abort a non-terminal in-memory workflow using optimistic revision control.",
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asRecord(request.params.arguments);
    switch (request.params.name) {
      case "plan_workflow":
        return toolResult(service.planWorkflow(args));
      case "start_workflow":
        return toolResult(service.startWorkflow(args));
      case "record_stage_result":
        return toolResult(service.recordStageResult(args));
      case "get_workflow_status":
        return toolResult(service.getWorkflowStatus(String(args.runId ?? "")));
      case "finalize_workflow":
        return toolResult(service.finalizeWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)));
      case "abort_workflow":
        return toolResult(service.abortWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)));
      default:
        return toolResult({
          schemaVersion: "1.0.0",
          ok: false,
          data: null,
          error: {
            code: "INVALID_INPUT",
            message: "Unknown workflow tool.",
            details: { tool: request.params.name },
          },
        });
    }
  });

  return server;
}
