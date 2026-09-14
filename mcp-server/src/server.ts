import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  type ApiResultV1,
  type ConvergenceRootV1,
  type ConvergenceStatusV1,
  type PluginUpdateStatusV1,
  type KoreanProseGlossaryLookupResultV1,
  type ResponseModeV1,
  type WorkflowReceiptV1,
} from "../../contracts/types.js";
import { contractSchemas } from "./schema-validator.js";
import { PLUGIN_INFO } from "./plugin-info.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import {
  convergenceRootHandle,
  convergenceStatusSummary,
  workflowStatusSummary,
} from "./response-projections.js";
import { WorkflowService } from "./workflow-service.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { type KoreanProseGlossaryGateway, UnavailableKoreanProseGlossary } from "./korean-prose-glossary.js";
import { ContractValidator } from "./schema-validator.js";

type ObjectSchema = Record<string, unknown> & {
  properties?: Record<string, unknown>;
  required?: string[];
};

const responseModeProperty = { enum: ["compact", "full"], default: "full" } as const;

function toolSchema(
  source: Record<string, unknown>,
  options: { add?: Record<string, unknown>; optional?: string[] } = {},
): ObjectSchema {
  const schema = structuredClone(source) as ObjectSchema;
  schema.properties = { ...(schema.properties ?? {}), ...(options.add ?? {}) };
  schema.required = (schema.required ?? []).filter((name) => !(options.optional ?? []).includes(name));
  return schema;
}

function embeddedSchema(source: Record<string, unknown>): ObjectSchema {
  const schema = structuredClone(source) as ObjectSchema & { $schema?: string; $id?: string };
  delete schema.$schema;
  delete schema.$id;
  return schema;
}

const taskEnvelopeInputSchema = embeddedSchema(contractSchemas.taskEnvelope);
const executionContextInputSchema = embeddedSchema(contractSchemas.executionContext);
const planWorkflowInputSchema = {
  type: "object",
  oneOf: [
    taskEnvelopeInputSchema,
    {
      type: "object",
      additionalProperties: false,
      required: ["schemaVersion", "taskEnvelope"],
      properties: {
        schemaVersion: { const: "1.0.0" },
        taskEnvelope: taskEnvelopeInputSchema,
        executionContext: executionContextInputSchema,
        evaluationAuditPurpose: { enum: ["design-readiness", "quality-or-release"] },
      },
      allOf: [{
        if: {
          properties: {
            taskEnvelope: {
              properties: {
                requiredCapabilities: {
                  type: "array",
                  contains: { const: "evaluation-validity-audit" },
                },
              },
              required: ["requiredCapabilities"],
            },
          },
        },
        then: { required: ["evaluationAuditPurpose"] },
      }],
    },
  ],
} as const;

const openConvergenceRootInputSchema = toolSchema(contractSchemas.openConvergenceRootRequest, {
  add: {
    responseMode: responseModeProperty,
    _continuityBinding: { type: "string", minLength: 16 },
  },
});
const attemptProposalInputSchema = toolSchema(contractSchemas.attemptProposal, {
  optional: ["taskEnvelope", "frame"],
});
attemptProposalInputSchema.dependentRequired = {
  taskEnvelope: ["frame"],
  frame: ["taskEnvelope"],
};
const guardedWorkflowStartInputSchema = toolSchema(contractSchemas.guardedWorkflowStartRequest, {
  add: { responseMode: responseModeProperty },
  optional: ["plan"],
});
const resolveConvergenceGateInputSchema = toolSchema(contractSchemas.resolveConvergenceGateRequest, {
  add: { responseMode: responseModeProperty },
});
const recordStageResultInputSchema = toolSchema(contractSchemas.stageResult, {
  add: { responseMode: responseModeProperty },
});

const revisionInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId", "expectedRevision"],
  properties: {
    runId: { type: "string", minLength: 1 },
    expectedRevision: { type: "integer", minimum: 0 },
    responseMode: responseModeProperty,
  },
} as const;

const workflowIdInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["runId"],
  properties: {
    runId: { type: "string", minLength: 1 },
    detail: responseModeProperty,
  },
} as const;

const convergenceIdInputSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rootId"],
  properties: {
    rootId: { type: "string", minLength: 1 },
    detail: responseModeProperty,
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

function responseMode(args: Record<string, unknown>, field: "responseMode" | "detail"): ResponseModeV1 | null {
  const value = args[field];
  return value === undefined || value === "full" ? "full" : value === "compact" ? "compact" : null;
}

function domainArguments(args: Record<string, unknown>, field: "responseMode" | "detail"): Record<string, unknown> {
  const result = { ...args };
  delete result[field];
  delete result._continuityBinding;
  return result;
}

function projectResult<T, U>(
  result: ApiResultV1<T>,
  mode: ResponseModeV1,
  project: (value: T) => U,
): ApiResultV1<T | U> {
  if (mode === "full" || !result.ok || result.data === null) return result;
  return { ...result, data: project(result.data) };
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
export function createMcpServer(
  service: WorkflowService,
  updates: PluginUpdateService,
  continuity: ContinuityGateway = new UnavailableContinuityService(),
  cleanup?: StateCleanupService,
  glossary: KoreanProseGlossaryGateway = new UnavailableKoreanProseGlossary(),
  validator: ContractValidator = new ContractValidator(),
): Server {
  const server = new Server(
    { name: PLUGIN_INFO.id, version: PLUGIN_INFO.version },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "lookup_korean_prose_terms",
        description: "Look up curated Korean prose glossary terms once before MCP selection. The source and matches are never persisted.",
        inputSchema: contractSchemas.koreanProseGlossaryLookupRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "check_for_updates",
        description: "Check the fixed Agent Governance Suite repository for a newer stable plugin tag without installing it.",
        inputSchema: updateCheckInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      },
      {
        name: "plan_workflow",
        description: "Read the current skill registry and return a capability-based workflow plan without storing a run. Orchestrated workflows use the structured wrapper to bind host-observed execution context; evaluation validity audits also bind their purpose.",
        inputSchema: planWorkflowInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "open_convergence_root",
        description: "Create one durable immutable task lineage; use responseMode=compact to avoid echoing task and frame inputs.",
        inputSchema: openConvergenceRootInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "claim_workflow_attempt",
        description: "Issue a one-use lease after validating stability and attempt budget; taskEnvelope and frame may be omitted to reuse the bound root.",
        inputSchema: attemptProposalInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_guarded_workflow",
        description: "Atomically consume a lease and start its bound plan; plan may be omitted and responseMode=compact avoids returning the full receipt.",
        inputSchema: guardedWorkflowStartInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_convergence_status",
        description: "Read convergence state; detail=compact returns handles and counts, while the default full mode includes complete history.",
        inputSchema: convergenceIdInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "resolve_convergence_gate",
        description: "Record a fresh independent frame review; use responseMode=compact to return handles and counts only.",
        inputSchema: resolveConvergenceGateInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_workflow",
        description: "Create a durable running run from a ready orchestrated workflow plan.",
        inputSchema: contractSchemas.workflowPlan,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "record_stage_result",
        description: "Record one ordered stage result; use responseMode=compact to avoid echoing the accumulated receipt.",
        inputSchema: recordStageResultInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_workflow_status",
        description: "Read workflow state; detail=compact returns fixed-size progress metadata, while the default full mode returns the receipt.",
        inputSchema: workflowIdInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "finalize_workflow",
        description: "Finalize a fully passed workflow; use responseMode=compact to avoid returning the full terminal receipt.",
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "abort_workflow",
        description: "Abort a non-terminal workflow; use responseMode=compact to avoid returning the full terminal receipt.",
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "checkpoint_context",
        description: "Replace the current direct-task continuity snapshot using CAS and an idempotent requestId; nextActions remain historical candidates.",
        inputSchema: contractSchemas.checkpointContextRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "inspect_context",
        description: "Inspect continuity metadata and obtain an opaque restore candidate without returning snapshot body text.",
        inputSchema: contractSchemas.inspectContextRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "load_context",
        description: "Explicitly load a restore candidate after rechecking its task, epoch, revision, and digest.",
        inputSchema: contractSchemas.loadContextRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "suppress_context_restore",
        description: "Suppress automatic restore candidates for the current epoch without deleting stored payloads.",
        inputSchema: contractSchemas.suppressContextRestoreRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "purge_direct_context",
        description: "Delete the current direct-task payload and retain only a hash tombstone; workflow receipts are never deleted.",
        inputSchema: contractSchemas.purgeDirectContextRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "prepare_state_cleanup",
        description: "Preview fixed retention cleanup candidates and issue a 15-minute, one-use token without deleting data.",
        inputSchema: contractSchemas.prepareStateCleanupRequest,
        annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "execute_state_cleanup",
        description: "Recheck a preview token, create verified SQLite backups, and atomically delete only the bound inactive candidates. Backups are retained until manually deleted.",
        inputSchema: contractSchemas.executeStateCleanupRequest,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asRecord(request.params.arguments);
    let updateStatus: PluginUpdateStatusV1 | null = null;
    let result: ApiResultV1<unknown>;

    if (request.params.name === "lookup_korean_prose_terms") {
      try {
        const input = validator.koreanProseGlossaryLookupRequest(args);
        const output = validator.koreanProseGlossaryLookupResult(glossary.lookup(input));
        result = apiOk<KoreanProseGlossaryLookupResultV1>(output);
      } catch (error) {
        result = invalidInput(error instanceof Error ? error.message : "Glossary lookup input is invalid.");
      }
    } else if (request.params.name === "check_for_updates") {
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
          result = service.planWorkflow(args, true);
          break;
        case "open_convergence_root":
          {
            const mode = responseMode(args, "responseMode");
            if (mode === null) {
              result = invalidInput("responseMode must be compact or full.");
            } else {
              const opened = service.openConvergenceRoot(domainArguments(args, "responseMode"));
              if (opened.ok && opened.data) continuity.bindOpenedRoot(args, opened.data.rootId);
              result = projectResult<ConvergenceRootV1, ReturnType<typeof convergenceRootHandle>>(
                opened, mode, convergenceRootHandle,
              );
            }
          }
          break;
        case "claim_workflow_attempt":
          result = service.claimWorkflowAttempt(args);
          break;
        case "start_guarded_workflow":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.startGuardedWorkflow(domainArguments(args, "responseMode")),
                  mode,
                  workflowStatusSummary,
                );
          }
          break;
        case "get_convergence_status":
          {
            const mode = responseMode(args, "detail");
            result = mode === null
              ? invalidInput("detail must be compact or full.")
              : projectResult<ConvergenceStatusV1, ReturnType<typeof convergenceStatusSummary>>(
                  service.getConvergenceStatus(String(args.rootId ?? "")),
                  mode,
                  convergenceStatusSummary,
                );
          }
          break;
        case "resolve_convergence_gate":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<ConvergenceStatusV1, ReturnType<typeof convergenceStatusSummary>>(
                  service.resolveConvergenceGate(domainArguments(args, "responseMode")),
                  mode,
                  convergenceStatusSummary,
                );
          }
          break;
        case "start_workflow":
          result = service.rejectUnguardedWorkflow(args);
          break;
        case "record_stage_result":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.recordStageResult(domainArguments(args, "responseMode")),
                  mode,
                  workflowStatusSummary,
                );
          }
          break;
        case "get_workflow_status":
          {
            const mode = responseMode(args, "detail");
            result = mode === null
              ? invalidInput("detail must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.getWorkflowStatus(String(args.runId ?? "")),
                  mode,
                  workflowStatusSummary,
                );
          }
          break;
        case "finalize_workflow":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.finalizeWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)),
                  mode,
                  workflowStatusSummary,
                );
          }
          break;
        case "abort_workflow":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.abortWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)),
                  mode,
                  workflowStatusSummary,
                );
          }
          break;
        case "checkpoint_context":
          result = continuity.checkpointContext(args);
          break;
        case "inspect_context":
          result = continuity.inspectContext(args);
          break;
        case "load_context":
          result = continuity.loadContext(args);
          break;
        case "suppress_context_restore":
          result = continuity.suppressContextRestore(args);
          break;
        case "purge_direct_context":
          result = continuity.purgeDirectContext(args);
          break;
        case "prepare_state_cleanup":
          result = cleanup
            ? cleanup.prepare(args)
            : invalidInput("State cleanup is unavailable because its local stores did not initialize.");
          break;
        case "execute_state_cleanup":
          result = cleanup
            ? cleanup.execute(args)
            : invalidInput("State cleanup is unavailable because its local stores did not initialize.");
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
