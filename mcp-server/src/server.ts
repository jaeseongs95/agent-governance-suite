import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { type ApiResultV1, type PluginUpdateStatusV1 } from "../../contracts/types.js";
import { contractSchemas } from "./schema-validator.js";
import { PLUGIN_INFO } from "./plugin-info.js";
import { PluginUpdateService } from "./plugin-update-service.js";
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

const updateCheckInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    force: { type: "boolean", default: false },
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
  const content: Array<{ type: "text"; text: string }> = [
    { type: "text", text: JSON.stringify(result) },
  ];
  return {
    content,
    isError: !result.ok,
  };
}

function apiOk<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function invalidInput(message: string): ApiResultV1<never> {
  return {
    schemaVersion: "1.0.0",
    ok: false,
    data: null,
    error: { code: "INVALID_INPUT", message, details: null },
  };
}

function validUpdateArguments(args: Record<string, unknown>): boolean {
  return Object.keys(args).every((key) => key === "force")
    && (args.force === undefined || typeof args.force === "boolean");
}

/** Exposes only the orchestration layer; direct specialist invocation bypasses MCP. */
export function createMcpServer(service: WorkflowService, updates: PluginUpdateService): Server {
  const server = new Server(
    { name: PLUGIN_INFO.id, version: PLUGIN_INFO.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "check_for_updates",
        description: "Check the fixed Agent Governance Suite repository for a newer stable plugin tag without installing it.",
        inputSchema: updateCheckInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      },
      {
        name: "plan_workflow",
        description: "Read the current skill registry and return a capability-based workflow plan without storing a run.",
        inputSchema: contractSchemas.taskEnvelope,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_workflow",
        description: "Create a durable running run from a ready orchestrated workflow plan.",
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
        description: "Read the current persisted run receipt.",
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
        description: "Abort a non-terminal persisted workflow using optimistic revision control.",
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asRecord(request.params.arguments);
    let updateStatus: PluginUpdateStatusV1 | null = null;
    let result: ApiResultV1<unknown>;

    if (request.params.name === "check_for_updates") {
      if (!validUpdateArguments(args)) {
        result = invalidInput("check_for_updates accepts only an optional boolean force field.");
      } else {
        updateStatus = await updates.check(args.force === true);
        result = apiOk(updateStatus);
      }
    } else {
      updateStatus = await updates.check(false);
      switch (request.params.name) {
        case "plan_workflow":
          result = service.planWorkflow(args);
          break;
        case "start_workflow":
          result = service.startWorkflow(args);
          break;
        case "record_stage_result":
          result = service.recordStageResult(args);
          break;
        case "get_workflow_status":
          result = service.getWorkflowStatus(String(args.runId ?? ""));
          break;
        case "finalize_workflow":
          result = service.finalizeWorkflow(String(args.runId ?? ""), integer(args.expectedRevision));
          break;
        case "abort_workflow":
          result = service.abortWorkflow(String(args.runId ?? ""), integer(args.expectedRevision));
          break;
        default:
          result = {
          schemaVersion: "1.0.0",
          ok: false,
          data: null,
          error: {
            code: "INVALID_INPUT",
            message: "Unknown workflow tool.",
            details: { tool: request.params.name },
          },
          };
      }
    }

    const response = toolResult(result);
    const notice = updateStatus ? updates.takeNotice(updateStatus) : null;
    if (notice) response.content.push({ type: "text", text: JSON.stringify(notice) });
    return response;
  });

  return server;
}
