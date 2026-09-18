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
import { inlineSchemaReferences } from "./tool-schema-inline.js";
import { PLUGIN_INFO } from "./plugin-info.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import {
  convergenceRootHandle,
  convergenceStatusSummary,
  workflowStatusSummary,
} from "./response-projections.js";
import { WorkflowService } from "./workflow-service.js";
import type { HostAttestationProvider } from "./host-attestation.js";
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
if (recordStageResultInputSchema.properties) {
  delete recordStageResultInputSchema.properties.executionContext;
}
recordStageResultInputSchema.required = (recordStageResultInputSchema.required ?? [])
  .filter((name) => name !== "executionContext");

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

/**
 * Controls only the advertised tool schemas. Validation always uses the exact
 * contracts. "default" keeps the historical schemas; "anthropic" removes
 * top-level combinators that the Anthropic API rejects.
 */
export type ToolSchemaProfile = "default" | "anthropic";

const planWorkflowAnthropicInputSchema: ObjectSchema = {
  type: "object",
  description: "Send either a TaskEnvelope.v1 object at the top level, or { schemaVersion, taskEnvelope, evaluationAuditPurpose? }. The server validates the exact PlanWorkflowRequest.v1 contract.",
  additionalProperties: false,
  properties: {
    ...structuredClone(taskEnvelopeInputSchema.properties ?? {}),
    taskEnvelope: structuredClone(taskEnvelopeInputSchema),
    evaluationAuditPurpose: { enum: ["design-readiness", "quality-or-release"] },
  },
};

export function planWorkflowToolInputSchema(profile: ToolSchemaProfile = "default"): Record<string, unknown> {
  return profile === "anthropic" ? planWorkflowAnthropicInputSchema : planWorkflowInputSchema;
}

/**
 * Session instructions for Claude Code, which places MCP server instructions in
 * its system prompt once per session. Claude Code sessions start implementing
 * as soon as a request arrives, so this asks for an intake-time failure-impact
 * classification before the first action. The default profile advertises none.
 */
export const ANTHROPIC_SERVER_INSTRUCTIONS = "agent-governance-suite 접수 규칙: 사용자 요청을 받을 때마다, 파일을 고치거나 명령을 실행하기 전에 이 요청이 잘못 수행됐을 때의 실패 영향을 한 줄로 분류한다(낮음 또는 높음). CI·CD, 릴리스·배포, 권한·신뢰 경계, 전역 설정, 데이터·스키마, 공개 저장소의 기본 브랜치처럼 실패 영향이 큰 작업이면 구현을 시작하기 전에 Skill 도구로 /agent-governance-suite:orchestrator를 호출해 이 요청에 필요한 전문 스킬 단계와 생략할 단계를 이유와 함께 정하고, 정한 단계를 그 시점에 실제로 호출한다. 사용자가 특정 스킬을 지정한 경우에만 orchestrator 없이 그 스킬을 바로 호출한다. 실패 영향이 낮으면 그 이유를 한 줄로 밝히고 진행한다.";

export function serverInstructions(profile: ToolSchemaProfile = "default"): string | undefined {
  return profile === "anthropic" ? ANTHROPIC_SERVER_INSTRUCTIONS : undefined;
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
  toolSchemaProfile: ToolSchemaProfile = "default",
  hostAttestation: HostAttestationProvider | null = null,
): Server {
  const instructions = serverInstructions(toolSchemaProfile);
  const server = new Server(
    { name: PLUGIN_INFO.id, version: PLUGIN_INFO.version },
    { capabilities: { tools: {} }, ...(instructions === undefined ? {} : { instructions }) },
  );

  const contractDocuments = Object.values(contractSchemas) as Array<Record<string, unknown>>;
  // Anthropic hosts cannot resolve $ref in tool schemas, so they receive fully inlined copies.
  const advertise = <T extends { inputSchema: Record<string, unknown> }>(tools: T[]): T[] =>
    toolSchemaProfile === "anthropic"
      ? tools.map((tool) => {
        if (!JSON.stringify(tool.inputSchema).includes('"$ref"')) return tool;
        try {
          return { ...tool, inputSchema: inlineSchemaReferences(tool.inputSchema, contractDocuments) };
        } catch {
          // A schema that cannot be inlined keeps its references rather than hiding every tool.
          return tool;
        }
      })
      : tools;

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: advertise([
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
        description: "Read the current skill registry and return a capability-based workflow plan without storing a run. Orchestrated semantic workflows require server-side trusted execution attestation; callers cannot submit executionContext. Trusted observation claims are persisted even though no workflow run is stored. Evaluation validity audits also bind their purpose.",
        inputSchema: planWorkflowToolInputSchema(toolSchemaProfile),
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
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
    ]),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = asRecord(request.params.arguments);
    // Only a host with an attestation adapter strips and verifies the hook token.
    const attested = <T>(tool: string, call: (input: Record<string, unknown>) => T): T =>
      hostAttestation ? hostAttestation.run(tool, args, call) : call(args);
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
          result = attested("plan_workflow", (input) => service.planWorkflow(input, true));
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
          result = service.claimWorkflowAttempt(args, true);
          break;
        case "start_guarded_workflow":
          {
            const mode = responseMode(args, "responseMode");
            result = mode === null
              ? invalidInput("responseMode must be compact or full.")
              : projectResult<WorkflowReceiptV1, ReturnType<typeof workflowStatusSummary>>(
                  service.startGuardedWorkflow(domainArguments(args, "responseMode"), true),
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
                  attested("record_stage_result", (input) => service.recordStageResult(domainArguments(input, "responseMode"), true)),
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
