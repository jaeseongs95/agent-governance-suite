import { ClassificationInitializationError } from "./skill-classification/runtime.js";
import { admitCaller, RESERVED_CALLER_KEYS, type CallerIngress, type VerifiedCaller } from "./caller-identity.js";
import { observedCaller } from "./caller-actor.js";
import { createRootApprovalHandler } from "./root-approval.js";
import { CONTEXT_LAYER_INPUT_SCHEMAS, createContextLayerToolHandler, isContextLayerTool } from "./context-layer-tools.js";
import type { ContextLayerService } from "./context-layer-service.js";
import { existsSync } from "node:fs";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import {
  type ApiResultV1,
  type ConvergenceRootV1,
  type ErrorCode,
  type PluginUpdateStatusV1,
  type KoreanProseGlossaryLookupResultV1,
  type ResponseModeV1,
  type SessionBoardEntryV2,
  type SessionBoardListV2,
  type SessionBoardUpdateV2,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
  contractErrorBody,
} from "../../contracts/types.js";
import { CONTENT_LANGUAGE_META, msg, render, resolveHostLocale, resolveRequestLocale, ROOT_LOCALE, type MessageKey, type MessageRef, type SupportedLocale } from "./i18n.js";
import { CATALOGS } from "./i18n-catalog.generated.js";
import { BoardFormatError, locateRepository, normalizeSummary, openBoard, readEntry, setSummary, type BoardEntry } from "../../runtime/session-board-store.mjs";
import { contractSchemas } from "./schema-validator.js";
import { contractFailure, failureContext, failureReason, retainFailureSecondary } from "./failure-diagnostics.js";
import { writeDiagnostic } from "./hook-error-diagnostics.js";
import { inlineSchemaReferences } from "./tool-schema-inline.js";
import { PLUGIN_INFO } from "./plugin-info.js";
import { installedSkillTargets, skillIntakeText } from "./skill-intake.js";
import { PluginUpdateService } from "./plugin-update-service.js";
import { type ContinuityGateway, UnavailableContinuityService } from "./continuity-service.js";
import {
  convergenceRootHandle,
  convergenceStatusSummary,
  workflowStatusSummary,
} from "./response-projections.js";
import { type RootAccess, type RootOwnerPresenceV1, type SessionWorkspaceObservation, WorkflowService } from "./workflow-service.js";
import { hostActorId, type HostAttestationProvider } from "./host-attestation.js";
import { StateCleanupService } from "./state-cleanup-service.js";
import { type KoreanProseGlossaryGateway, UnavailableKoreanProseGlossary } from "./korean-prose-glossary.js";
import { ContractValidator } from "./schema-validator.js";
import { z } from "zod";
import { classificationInputSchema, selectionInputSchema, type SkillClassificationGateway } from "./skill-classification/gateway.js";
import { SessionMessageService } from "./session-message-service.js";
import { type TrustService } from "./trust-service.js";

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

type ContractDocuments = typeof contractSchemas;

/**
 * The catalog key of the schema `description` at `pointer` in a contract file (docs/i18n-design.md 5.2):
 * schema.<file name in camel case>.<pointer segments>, e.g. stage-result.v1.schema.json#/$defs/evidence/description
 * is schema.stageResultV1.defs.evidence.description.
 */
export function schemaDescriptionKey(file: string, pointer: readonly string[]): string {
  const identifier = (text: string) => text.replace(/[^A-Za-z0-9_-]/gu, "_");
  const [first = "", ...rest] = file.replace(/\.schema\.json$/u, "").split(/[-.]/u);
  const fileId = first + rest.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
  return ["schema", identifier(fileId), ...pointer.map((segment) => (segment === "$defs" ? "defs" : identifier(segment)))].join(".");
}

/** A contract document whose catalogued descriptions are in `locale`; the files themselves are never changed (CONTENT_LOCK). */
function localizeContract(document: Record<string, unknown>, locale: SupportedLocale): Record<string, unknown> {
  const file = String(document.$id).split("/").at(-1) ?? "";
  const walk = (node: unknown, pointer: string[]): unknown => {
    if (Array.isArray(node)) return node.map((item, index) => walk(item, [...pointer, String(index)]));
    if (!node || typeof node !== "object") return node;
    return Object.fromEntries(Object.entries(node).map(([name, value]) => {
      const at = [...pointer, name];
      if (name !== "description" || typeof value !== "string") return [name, walk(value, at)];
      const key = schemaDescriptionKey(file, at);
      return [name, key in CATALOGS[ROOT_LOCALE] ? render({ key, params: {} }, locale) : value];
    }));
  };
  return walk(document, []) as Record<string, unknown>;
}

// ponytail: one localized copy per shipped locale, built on first use; the bound is the locale count.
const localizedContractCache = new Map<SupportedLocale, ContractDocuments>();

function localizedContracts(locale: SupportedLocale): ContractDocuments {
  // The schema domain's source locale is en: the contract files are its text, so they are advertised as they are.
  if (locale === ROOT_LOCALE) return contractSchemas;
  let documents = localizedContractCache.get(locale);
  if (!documents) {
    documents = Object.fromEntries(Object.entries(contractSchemas).map(([name, document]) => [name, localizeContract(document, locale)])) as ContractDocuments;
    localizedContractCache.set(locale, documents);
  }
  return documents;
}

type ToolTextKey = Extract<MessageKey, `tools.${string}`>;
const toolText = (key: ToolTextKey, locale: SupportedLocale) => render({ key, params: {} }, locale);

/** The advertised input schemas that carry descriptions, built from contract documents with their descriptions in `locale`. */
function buildInputSchemas(contracts: ContractDocuments, locale: SupportedLocale) {
  const taskEnvelopeInputSchema = embeddedSchema(contracts.taskEnvelope);
  const planWorkflow = {
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
          requiredAuditPhase: { enum: ["pre-execution", "post-execution", "pre-deploy", "post-deploy"] },
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

  const planWorkflowInline: ObjectSchema = {
    type: "object",
    description: toolText("tools.plan_workflow.inlineInput", locale),
    additionalProperties: false,
    properties: {
      ...structuredClone(taskEnvelopeInputSchema.properties ?? {}),
      taskEnvelope: structuredClone(taskEnvelopeInputSchema),
      evaluationAuditPurpose: { enum: ["design-readiness", "quality-or-release"] },
      requiredAuditPhase: { enum: ["pre-execution", "post-execution", "pre-deploy", "post-deploy"] },
    },
  };

  const openConvergenceRoot = toolSchema(contracts.openConvergenceRootRequest, {
    add: {
      responseMode: responseModeProperty,
    },
  });
  const attemptProposal = toolSchema(contracts.attemptProposal, {
    optional: ["taskEnvelope", "frame"],
  });
  attemptProposal.dependentRequired = {
    taskEnvelope: ["frame"],
    frame: ["taskEnvelope"],
  };
  const guardedWorkflowStart = toolSchema(contracts.guardedWorkflowStartRequest, {
    add: { responseMode: responseModeProperty },
    optional: ["plan"],
  });
  const resolveConvergenceGate = toolSchema(contracts.resolveConvergenceGateRequest, {
    add: { responseMode: responseModeProperty },
  });
  const recordStageResult = toolSchema(contracts.stageResult, {
    add: { responseMode: responseModeProperty },
  });
  if (recordStageResult.properties) {
    delete recordStageResult.properties.executionContext;
  }
  recordStageResult.required = (recordStageResult.required ?? [])
    .filter((name) => name !== "executionContext");

  /** start_workflow (design ags30-phase-check 7.5): the AGENT's goal, stages, acceptance criteria and write targets; the rest is defaulted. */
  const strings = { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1 } };
  const text = { type: "string", minLength: 1 };
  const minimalWorkflowStart: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["goal", "stages", "acceptanceCriteria", "writeTargets"],
    properties: {
      goal: { type: "string", minLength: 1, maxLength: 2000 },
      stages: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1 },
        description: toolText("tools.start_workflow.input.stages", locale) },
      acceptanceCriteria: { type: "array", minItems: 1, maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1 } },
      workspace: { type: "string", minLength: 1, description: toolText("tools.start_workflow.input.workspace", locale) },
      writeTargets: { ...strings, description: toolText("tools.start_workflow.input.writeTargets", locale) },
      rootId: { ...text, description: toolText("tools.start_workflow.input.rootId", locale) },
      priorFailure: {
        type: "object", additionalProperties: false, required: ["hypothesis", "changeSummary", "discriminator", "evidenceRefs"],
        properties: { hypothesis: text, changeSummary: text, discriminator: text, evidenceRefs: strings },
        description: toolText("tools.start_workflow.input.priorFailure", locale),
      },
    },
  };

  const releaseConvergenceRoot: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["rootId", "expectedRevision", "reason"],
    properties: {
      rootId: { ...text, description: toolText("tools.release_convergence_root.input.rootId", locale) },
      expectedRevision: { type: "integer", minimum: 0, description: toolText("tools.release_convergence_root.input.expectedRevision", locale) },
      reason: { type: "string", minLength: 1, maxLength: 2000, description: toolText("tools.release_convergence_root.input.reason", locale) },
      userApprovalRefs: { type: "array", maxItems: 32, uniqueItems: true, items: { type: "string", minLength: 1 },
        description: toolText("tools.release_convergence_root.input.userApprovalRefs", locale) },
    },
  };

  // D53's two load branches only distinguish absent/present candidateToken; the optional property is equivalent.
  const loadContextInline = embeddedSchema(contracts.loadContextRequest);
  delete loadContextInline.oneOf;

  const prepareSessionMessage = structuredClone(contracts.prepareSessionMessageRequest) as ObjectSchema;
  const sendBodySchema = prepareSessionMessage.properties?.body as Record<string, unknown> | undefined;
  if (sendBodySchema) sendBodySchema.description = toolText("tools.prepare_session_message.input.body", locale);

  return {
    planWorkflow, planWorkflowInline, openConvergenceRoot, attemptProposal, guardedWorkflowStart, resolveConvergenceGate,
    recordStageResult, minimalWorkflowStart, releaseConvergenceRoot, prepareSessionMessage, loadContextInline,
  };
}

type InputSchemas = ReturnType<typeof buildInputSchemas>;
// ponytail: built once per shipped locale on first use; the bound is the locale count.
const inputSchemaCache = new Map<SupportedLocale, InputSchemas>();

function inputSchemas(locale: SupportedLocale): InputSchemas {
  let schemas = inputSchemaCache.get(locale);
  if (!schemas) {
    schemas = buildInputSchemas(localizedContracts(locale), locale);
    inputSchemaCache.set(locale, schemas);
  }
  return schemas;
}

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

/** The subagent that starts a workflow owns its turn-end phase check; null = the session's root actor (AGS3-D-0061). */
const workflowOwner = (caller: VerifiedCaller): string | null => caller.actor.role === "child" ? caller.actor.id : null;

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

/**
 * The edge where a result meets its reader: the top-level error is rendered in the request's locale from its key.
 * Bodies nested in data (stored receipts) keep their root-locale text and key, so their digests do not change.
 */
/**
 * Tools whose success changes the workflow. A workflow changes because the work's purpose changed, so the next judgment
 * is matched against every installed skill again. A stage's skillId names the provider contract its result is recorded
 * under; it never narrows the skills used in that stage.
 */
const WORKFLOW_CHANGE_TOOLS = new Set(["plan_workflow", "start_workflow", "start_guarded_workflow", "record_stage_result",
  "claim_workflow_attempt", "resolve_convergence_gate", "open_convergence_root", "release_convergence_root",
  "finalize_workflow", "abort_workflow"]);

/** The skill reselection notice for a workflow change; the stage line names the stage now due, when there is one. */
export function workflowChangeNotice(data: unknown, receipt: (runId: string) => WorkflowReceiptV1 | null,
  classificationConfigured: boolean): MessageRef[] {
  const record = data !== null && typeof data === "object" ? data as Record<string, unknown> : null;
  // A plan carries its stage pointers itself; every other run response names its run.
  const plan = record && Array.isArray(record.stages) && "nextStageId" in record ? record as unknown as WorkflowPlanV1
    : typeof record?.runId === "string" ? receipt(record.runId)?.plan ?? null : null;
  const stageId = plan ? plan.currentStageId ?? plan.nextStageId : null;
  const stage = plan?.stages.find(candidate => candidate.stageId === stageId);
  return [
    ...(stage ? [msg("server.workflowChange.stage", { stageId: stage.stageId, capability: stage.requiredCapability, provider: stage.skillId })] : []),
    msg("server.workflowChange.skills", { targets: installedSkillTargets() }),
    msg("hooks.checkpointCue.refresh", {}),
    ...(classificationConfigured ? [msg("server.workflowChange.classification", {})] : []),
  ];
}

function toolResult<T>(result: ApiResultV1<T>, locale: SupportedLocale = ROOT_LOCALE) {
  const error = result.error;
  const shown = error?.messageKey ? { ...result, error: { ...error, message: render({ key: error.messageKey, params: error.params ?? {} }, locale) } } : result;
  const content: Array<{ type: "text"; text: string }> = [
    { type: "text", text: JSON.stringify(shown) },
  ];
  return {
    content,
    isError: !result.ok,
    _meta: { [CONTENT_LANGUAGE_META]: locale },
  };
}

function apiOk<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function invalidInput(message: MessageRef): ApiResultV1<never> {
  return apiError("INVALID_INPUT", message);
}

function apiError(code: ErrorCode, message: MessageRef, details: Record<string, unknown> | null = null): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: contractErrorBody(code, message, details) };
}

/**
 * Contract errors keep their own code, message key and sanitized details. Any other failure is a server failure
 * (contractFailure: MCP_UNAVAILABLE, fixed message, reason and redacted cause), never invalid input.
 * No caller text is derived from the error.
 */
function failureResult(error: unknown): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: contractFailure(error).toBody() };
}

/** send_session_message failures: a contract error also tells the caller how to retry, as one catalog sentence. */
function sendFailureResult(error: unknown): ApiResultV1<never> {
  if (!(error instanceof WorkflowContractError)) return failureResult(error);
  return apiError(error.code, msg("server.sessionMessage.sendInvalid", { cause: error.ref }), error.details);
}

const CLASSIFICATION_REQUEST_REJECTIONS = new Set([
  "OPERATION_DIGEST_CONFLICT", "STALE_CLASSIFICATION_OPERATION", "UNKNOWN_CLASSIFICATION_OPERATION",
  "CALLER_SELECTION_RECEIPT_REJECTED", "AGENT_SELECTION_MISSING",
  "REQUIRED_SKILL_SNAPSHOT_CHANGED", "SELECTION_ALREADY_RECORDED",
]);

/**
 * Session board tools. The server writes the summary under the root session of the caller it verified, and
 * lists the sessions whose messaging presence says they are running (or recently unreachable). The board file only
 * adds the one-line summary, prompt time and working directory; it never decides liveness.
 */
type BoardDatabase = ReturnType<typeof openBoard>;

function closeOnce(board: BoardDatabase | null, error: unknown): void {
  // A close failure after the primary failure stays attached as a secondary cause.
  try { board?.close(); } catch (closeError) { retainFailureSecondary(error, closeError); }
}

/**
 * The working directory the session's own hook last recorded on the board (null when the board or the row is missing),
 * or the reason the board could not be read, so start_workflow does not report an unreadable board as an unreported
 * directory. Only a default for start_workflow: the caller can always name the workspace.
 */
function observedSessionWorkspace(databasePath: string | null, caller: VerifiedCaller): SessionWorkspaceObservation {
  if (!databasePath || !existsSync(databasePath)) return { workspace: null };
  let board: BoardDatabase | null = null;
  try {
    board = openBoard(databasePath);
    const cwd = readEntry(board, caller.host, caller.sessionId)?.cwd;
    return { workspace: typeof cwd === "string" && cwd ? cwd : null };
  } catch (error) {
    const reason = (error instanceof BoardFormatError ? error.code : null) ?? failureReason(error).reason ?? "UNEXPECTED_FAILURE";
    writeDiagnostic("server", "session-workspace-unread", { reason });
    return { workspace: null, unreadable: reason };
  } finally {
    try { board?.close(); } catch { /* the read result does not depend on close */ }
  }
}

/**
 * The presence of a root's owner sessions: every session presence still keeps whose continuity binding names the root
 * (bindings hold only an HMAC of the session ID, so each known session is checked by its own ID). online wins, then
 * unreachable, then ended; unknown when no owner session is kept (a root no session bound, or one whose owner presence
 * was already dropped). A failed read is reported as unavailable, never as an absent owner.
 */
function readRootOwnerPresence(rootId: string, continuity: ContinuityGateway, sessionMessages: SessionMessageService,
  caller: VerifiedCaller): RootOwnerPresenceV1 {
  const observedAt = new Date().toISOString();
  const unavailable = (cause: unknown): RootOwnerPresenceV1 => ({ state: "unknown", self: false, ownerBound: false, sessions: [],
    unavailable: failureReason(cause).reason ?? "PRESENCE_UNAVAILABLE", observedAt });
  let ownerBound: boolean;
  let known: ReturnType<SessionMessageService["knownPresence"]>;
  try {
    ownerBound = continuity.rootBound(rootId);
    known = ownerBound ? sessionMessages.knownPresence() : [];
  } catch (cause) {
    return unavailable(cause);
  }
  const sessions: RootOwnerPresenceV1["sessions"] = [];
  try {
    for (const item of known) {
      if (item.host === caller.host && item.sessionId === caller.sessionId) continue;
      if (!continuity.ownsRoot(item.sessionId, rootId)) continue;
      sessions.push({ host: item.host, sessionId: item.sessionId, actorId: hostActorId(item.host, item.sessionId), state: item.state,
        lastSeenAt: item.heartbeatAt, endedAt: item.endedAt });
    }
  } catch (cause) {
    return unavailable(cause);
  }
  const state = (["online", "unreachable", "ended"] as const).find(candidate => sessions.some(session => session.state === candidate)) ?? "unknown";
  return { state, self: false, ownerBound, sessions, unavailable: null, observedAt };
}

/**
 * The session list the board tool shows and the admin page reuses: each present session with what its own board row
 * says (summary, self-written role, cwd). A missing board file only means nothing was written yet; it is never created.
 */
export function mergeSessionBoard(
  databasePath: string,
  present: ReadonlyArray<Awaited<ReturnType<SessionMessageService["listCurrentPresence"]>>["sessions"][number]>,
  self: { host: string; sessionId: string } | null,
  /** The user's signed bindings (ContextLayerService.signedRoles); null when unavailable, so only self-written roles show. */
  signedRoles: ReadonlyMap<string, string> | null = null,
): { sessions: SessionBoardEntryV2[]; board: SessionBoardListV2["board"] } {
  const entries = new Map<string, BoardEntry | null>();
  const key = (item: { host: string; sessionId: string }) => `${item.host}\u0000${item.sessionId}`;
  let boardStatus: SessionBoardListV2["board"] = { status: "ok" };
  // A missing file only means no summary was written yet; listing never creates it.
  if (existsSync(databasePath)) {
    let board: BoardDatabase | null = null;
    let step: "open" | "read" | "close" = "open";
    try {
      board = openBoard(databasePath);
      step = "read";
      for (const item of present) entries.set(key(item), readEntry(board, item.host, item.sessionId));
      step = "close";
      const opened = board;
      board = null;
      opened.close();
    } catch (error) {
      closeOnce(board, error);
      entries.clear();
      boardStatus = { status: "unavailable", step, cause: failureContext(error) };
    }
  }
  const sessions: SessionBoardEntryV2[] = present.map((item) => {
    const entry = entries.get(key(item)) ?? null;
    const cwd = entry?.cwd ?? item.workspaceId;
    // The user's signed binding wins over what the session wrote itself (AGS3-D-0073).
    const signedRole = signedRoles?.get(key(item)) ?? null;
    const role = signedRole ?? entry?.role ?? null;
    return {
      host: item.host,
      sessionId: item.sessionId,
      current: self !== null && item.host === self.host && item.sessionId === self.sessionId,
      presence: item.state,
      startedAt: item.startedAt,
      lastSeenAt: item.heartbeatAt,
      cwd,
      repo: locateRepository(cwd),
      summary: entry?.summary ?? null,
      summaryAt: entry?.summaryAt ?? null,
      role,
      roleSource: signedRole !== null ? "signed" : role !== null ? "self" : null,
      summaryStale: entry?.summaryStale ?? null,
      lastPromptAt: entry?.lastPromptAt ?? null,
      wake: item.autoWake ? { state: item.autoWake.state, reason: item.autoWake.reason } : null,
    };
  });
  return { sessions, board: boardStatus };
}

async function sessionBoardResult(
  tool: "update_session_status" | "list_session_status",
  args: Record<string, unknown>,
  databasePath: string | null,
  validator: ContractValidator,
  sessionMessages: SessionMessageService,
  caller: VerifiedCaller,
  contextLayers: ContextLayerService | null = null,
): Promise<ApiResultV1<unknown>> {
  let summary: string | null = null;
  // Omitted keeps the role already written; the schema admits only a role the board can store.
  let role: string | undefined;
  const binding = { host: caller.host, sessionId: caller.sessionId };
  try {
    if (tool === "update_session_status") {
      const request = validator.updateSessionStatusRequest(args);
      summary = normalizeSummary(request.summary);
      if (request.role !== undefined) role = request.role.trim();
    } else {
      validator.listSessionStatusRequest(args);
    }
  } catch (error) {
    return failureResult(error);
  }
  if (!databasePath) return apiError("MCP_UNAVAILABLE", msg("server.sessionBoard.notConfigured", {}));
  const self = binding;

  if (tool === "update_session_status") {
    let board: BoardDatabase | null = null;
    let step: "open" | "write" | "close" = "open";
    try {
      board = openBoard(databasePath);
      step = "write";
      const written: SessionBoardUpdateV2 = setSummary(board, { ...self, now: new Date().toISOString() }, summary, role);
      step = "close";
      const opened = board;
      board = null;
      opened.close();
      return apiOk(written);
    } catch (error) {
      closeOnce(board, error);
      // Bounded, redacted cause (no message, path or SQL); the session's other work is not affected.
      return apiError("MCP_UNAVAILABLE", msg("server.sessionBoard.notRecorded", {}), { step, cause: failureContext(error) });
    }
  }

  let presence: Awaited<ReturnType<SessionMessageService["listCurrentPresence"]>>;
  try {
    presence = await sessionMessages.listCurrentPresence(self);
  } catch (error) {
    // Without presence nobody can tell which sessions run; board rows are never shown in its place.
    return apiError("MCP_UNAVAILABLE", msg("server.sessionBoard.livenessUnavailable", {}),
      { step: "presence", cause: failureContext(error) });
  }
  let signedRoles: Map<string, string> | null = null;
  try {
    signedRoles = contextLayers?.signedRoles(presence.sessions) ?? null;
  } catch (error) {
    // An unreadable signed record leaves the self-written roles, labelled as such; the list itself still answers.
    writeDiagnostic("session-board", "signed-roles-unreadable", { cause: failureContext(error) });
  }
  const { sessions, board: boardStatus } = mergeSessionBoard(databasePath, presence.sessions, self, signedRoles);
  const result: SessionBoardListV2 = { sessions, truncated: presence.truncated, board: boardStatus };
  return apiOk(result);
}

/**
 * Controls only the advertised tool schemas. Validation always uses the exact
 * contracts. "default" keeps the historical schemas; "anthropic" removes
 * top-level combinators for clients requiring inlined schemas.
 */
export type ToolSchemaProfile = "default" | "inline-references" | "anthropic";

function usesInlineReferences(profile: ToolSchemaProfile): boolean {
  return profile === "inline-references" || profile === "anthropic";
}

/**
 * Failures the AGENT cannot fix by changing its input: the session's window then passes with the cause recorded.
 * BINDING_INVALID stays: a start now raises it only from the caller and host observation (adapter or capability
 * mismatch, a consumed or unbound observation), never from the session's binding, which is STALE_REVISION.
 */
const WORKFLOW_START_INFRASTRUCTURE_FAILURES: ReadonlySet<string> = new Set(["MCP_UNAVAILABLE", "CONTINUITY_UNAVAILABLE", "BINDING_REQUIRED", "BINDING_INVALID", "INTEGRITY_FAILED"]);

export function planWorkflowToolInputSchema(profile: ToolSchemaProfile = "default", locale: SupportedLocale = ROOT_LOCALE): Record<string, unknown> {
  const schemas = inputSchemas(locale);
  return usesInlineReferences(profile) ? schemas.planWorkflowInline : schemas.planWorkflow;
}

/** Every host receives the selection policy from the shared skill, not a second policy copy (skill-intake.ts). */
export const skillIntakeServerInstructions: (locale: SupportedLocale) => string = skillIntakeText;

// Prompt-engineering: preserve messaging actions while separating advisory wake state from delivery evidence.
export function sessionMessageServerInstructions(locale: SupportedLocale): string {
  return render(msg("instructions.sessionMessage.guide", {}), locale);
}

/** The instructions in their source locale (ko), as written and reviewed. */
export const SKILL_INTAKE_SERVER_INSTRUCTIONS = skillIntakeServerInstructions("ko");
export const SESSION_MESSAGE_SERVER_INSTRUCTIONS = sessionMessageServerInstructions("ko");

export function serverInstructions(locale: SupportedLocale = resolveHostLocale().locale): string {
  return `${skillIntakeServerInstructions(locale)}\n${sessionMessageServerInstructions(locale)}`;
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
  sessionBoardPath: string | null = null,
  sessionMessages: SessionMessageService = new SessionMessageService(),
  trust: TrustService | null = null,
  classification: SkillClassificationGateway | null = null,
  callerIngress: CallerIngress | null = null,
  /** The locale for requests that name none (docs/i18n-design.md 4.1 ②). */
  defaultLocale: SupportedLocale = resolveHostLocale().locale,
  /** The shared global and role contexts; null leaves their tools unavailable. */
  contextLayers: ContextLayerService | null = null,
): Server {
  const server = new Server(
    { name: PLUGIN_INFO.id, version: PLUGIN_INFO.version },
    // SDK 1.30.0 fixes instructions at construction (private _oninitialize), so they use the service default locale.
    { capabilities: { tools: {} }, instructions: serverInstructions(defaultLocale) },
  );

  const rootOperation = createRootApprovalHandler(server, service);
  const contextLayerOperation = createContextLayerToolHandler(contextLayers);

  // Anthropic hosts cannot resolve $ref in tool schemas, so they receive fully inlined copies.
  const advertise = <T extends { inputSchema: Record<string, unknown> }>(tools: T[], locale: SupportedLocale): T[] => {
    const contractDocuments = Object.values(localizedContracts(locale)) as Array<Record<string, unknown>>;
    return tools.map((tool) => {
      const inputSchema = structuredClone(tool.inputSchema) as ObjectSchema;
      if (usesInlineReferences(toolSchemaProfile) && JSON.stringify(inputSchema).includes('"$ref"')) {
        return { ...tool, inputSchema: inlineSchemaReferences(inputSchema, contractDocuments) };
      }
      return { ...tool, inputSchema };
    });
  };

  const toolList = (locale: SupportedLocale) => {
    const schemas = inputSchemas(locale);
    const contracts = localizedContracts(locale);
    const description = (key: ToolTextKey) => toolText(key, locale);
    return advertise([
      {
        name: "get_skill_inventory",
        description: description("tools.get_skill_inventory.description"),
        inputSchema: {type: "object", additionalProperties: false, properties: {}},
        // D0347: the inventory itself only reads local skill, registry and discovery sources, so the call neither
        // destroys data nor reaches an external system. readOnlyHint stays unset: the shared call boundary still
        // consumes the session proof.
        annotations: { destructiveHint: false, openWorldHint: false },
      },
      {
        name: "classify_skills",
        description: description("tools.classify_skills.description"),
        inputSchema: z.toJSONSchema(classificationInputSchema) as Record<string, unknown>,
      },
      {
        name: "record_skill_selection",
        description: description("tools.record_skill_selection.description"),
        inputSchema: z.toJSONSchema(selectionInputSchema) as Record<string, unknown>,
      },
      {
        name: "lookup_korean_prose_terms",
        description: description("tools.lookup_korean_prose_terms.description"),
        inputSchema: contracts.koreanProseGlossaryLookupRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "check_for_updates",
        description: description("tools.check_for_updates.description"),
        inputSchema: updateCheckInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: true },
      },
      {
        name: "get_trust_capabilities",
        description: description("tools.get_trust_capabilities.description"),
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "validate_collaboration_decision",
        description: description("tools.validate_collaboration_decision.description"),
        inputSchema: contracts.validateCollaborationDecisionRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "plan_workflow",
        description: description("tools.plan_workflow.description"),
        inputSchema: usesInlineReferences(toolSchemaProfile) ? schemas.planWorkflowInline : schemas.planWorkflow,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "open_convergence_root",
        description: description("tools.open_convergence_root.description"),
        inputSchema: schemas.openConvergenceRoot,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "claim_workflow_attempt",
        description: description("tools.claim_workflow_attempt.description"),
        inputSchema: schemas.attemptProposal,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_guarded_workflow",
        description: description("tools.start_guarded_workflow.description"),
        inputSchema: schemas.guardedWorkflowStart,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_convergence_status",
        description: description("tools.get_convergence_status.description"),
        inputSchema: convergenceIdInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "resolve_convergence_gate",
        description: description("tools.resolve_convergence_gate.description"),
        inputSchema: schemas.resolveConvergenceGate,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "start_workflow",
        description: description("tools.start_workflow.description"),
        inputSchema: schemas.minimalWorkflowStart,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "record_stage_result",
        description: description("tools.record_stage_result.description"),
        inputSchema: schemas.recordStageResult,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_workflow_status",
        description: description("tools.get_workflow_status.description"),
        inputSchema: workflowIdInputSchema,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "finalize_workflow",
        description: description("tools.finalize_workflow.description"),
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "abort_workflow",
        description: description("tools.abort_workflow.description"),
        inputSchema: revisionInputSchema,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "release_convergence_root",
        description: description("tools.release_convergence_root.description"),
        inputSchema: schemas.releaseConvergenceRoot,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "checkpoint_context",
        description: description("tools.checkpoint_context.description"),
        inputSchema: contracts.checkpointContextRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "inspect_context",
        description: description("tools.inspect_context.description"),
        inputSchema: contracts.inspectContextRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "load_context",
        description: description("tools.load_context.description"),
        inputSchema: usesInlineReferences(toolSchemaProfile) ? schemas.loadContextInline : contracts.loadContextRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "load_shared_context",
        description: description("tools.load_shared_context.description"),
        inputSchema: CONTEXT_LAYER_INPUT_SCHEMAS.load_shared_context,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "checkpoint_global_context",
        description: description("tools.checkpoint_global_context.description"),
        inputSchema: CONTEXT_LAYER_INPUT_SCHEMAS.checkpoint_global_context,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "bind_session_role",
        description: description("tools.bind_session_role.description"),
        inputSchema: CONTEXT_LAYER_INPUT_SCHEMAS.bind_session_role,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "checkpoint_role_context",
        description: description("tools.checkpoint_role_context.description"),
        inputSchema: CONTEXT_LAYER_INPUT_SCHEMAS.checkpoint_role_context,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "suppress_context_restore",
        description: description("tools.suppress_context_restore.description"),
        inputSchema: contracts.suppressContextRestoreRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "purge_direct_context",
        description: description("tools.purge_direct_context.description"),
        inputSchema: contracts.purgeDirectContextRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "prepare_state_cleanup",
        description: description("tools.prepare_state_cleanup.description"),
        inputSchema: contracts.prepareStateCleanupRequest,
        annotations: { readOnlyHint: true, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "execute_state_cleanup",
        description: description("tools.execute_state_cleanup.description"),
        inputSchema: contracts.executeStateCleanupRequest,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: true, openWorldHint: false },
      },
      {
        name: "update_session_status",
        description: description("tools.update_session_status.description"),
        inputSchema: contracts.updateSessionStatusRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "list_session_status",
        description: description("tools.list_session_status.description"),
        inputSchema: contracts.listSessionStatusRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "prepare_session_message",
        description: description("tools.prepare_session_message.description"),
        inputSchema: schemas.prepareSessionMessage,
        annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "send_session_message",
        description: description("tools.send_session_message.description"),
        inputSchema: contracts.sendSessionMessageRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "acknowledge_session_messages",
        description: description("tools.acknowledge_session_messages.description"),
        inputSchema: contracts.acknowledgeSessionMessagesRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "get_session_message_status",
        description: description("tools.get_session_message_status.description"),
        inputSchema: contracts.getSessionMessageStatusRequest,
        annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
      },
      {
        name: "recall_session_message",
        description: description("tools.recall_session_message.description"),
        inputSchema: contracts.recallSessionMessageRequest,
        annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true, openWorldHint: false },
      },
    ], locale);
  };
  // ponytail: each locale's list is built once and kept; the bound is the shipped locale count.
  const toolLists = new Map<SupportedLocale, ReturnType<typeof toolList>>();
  const toolsFor = (locale: SupportedLocale) => {
    let tools = toolLists.get(locale);
    if (!tools) {
      tools = toolList(locale);
      toolLists.set(locale, tools);
    }
    return tools;
  };
  // The default list is built now, so a schema that cannot be advertised fails at startup as before.
  toolsFor(defaultLocale);
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const locale = resolveRequestLocale(request.params?._meta, defaultLocale);
    return { tools: toolsFor(locale), _meta: { [CONTENT_LANGUAGE_META]: locale } };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const locale = resolveRequestLocale(request.params._meta, defaultLocale);
    const respond = <T>(result: ApiResultV1<T>) => toolResult(result, locale);
    const handle = async () => {
    const args = asRecord(request.params.arguments);
    const reserved = RESERVED_CALLER_KEYS.find(key => Object.hasOwn(args, key));
    if (reserved) return respond(apiError("INVALID_INPUT", msg("server.call.reservedCallerField", {}), {reasonCode: "RESERVED_CALLER_FIELD", field: reserved}));
    if (!callerIngress) return respond(apiError("BINDING_REQUIRED", msg("server.call.callerIngressMissing", {}), {reasonCode: "HOST_INGRESS_UNAVAILABLE"}));
    let caller: VerifiedCaller;
    try {
      const meta = request.params._meta;
      caller = admitCaller(callerIngress(request.params.name, meta && typeof meta === "object" ? meta as Record<string, unknown> : undefined,
        request.params.arguments), hostActorId);
    } catch (error) {
      if (error instanceof WorkflowContractError) {
        return respond({ schemaVersion: "1.0.0", ok: false, data: null, error: error.toBody() });
      }
      // Error model R2: a non-contract failure (e.g. the admission store) is a server failure with its reason and
      // redacted cause, not a cause-less fixed reason.
      return respond(failureResult(error));
    }
    // A subagent whose hooks run under its own session ID (agy) is tied to its session here, so its edits and turn end
    // are judged as that subagent's (AGS3-D-0061). A store failure leaves those hooks on their own session only.
    try { continuity.noteHookSession(caller); } catch { writeDiagnostic("server", "continuity-hook-session-unavailable", {}); }
    // Only a host with an execution adapter qualifies the caller's observed model and effort.
    const attested = <T>(tool: string, call: (input: Record<string, unknown>) => T): T =>
      hostAttestation ? hostAttestation.run(tool, caller, () => call(args)) : call(args);
    // Rejects an unknown mode before the call runs; compact mode projects successful results only.
    const withMode = <T, U>(field: "responseMode" | "detail", call: () => ApiResultV1<T>, project: (value: T) => U): ApiResultV1<T | U> => {
      const mode = responseMode(args, field);
      return mode === null ? invalidInput(msg("server.call.responseModeInvalid", { field })) : projectResult(call(), mode, project);
    };
    // The calling session's rights over a root: ownership from its continuity binding, owner presence read when asked.
    const rootAccess: RootAccess = {
      ownsRoot: rootId => continuity.ownsRoot(caller.sessionId, rootId),
      ownedByOtherSession: rootId => continuity.rootOwnedElsewhere(caller.sessionId, rootId) && !continuity.ownsRoot(caller.sessionId, rootId),
      ownerPresence: rootId => readRootOwnerPresence(rootId, continuity, sessionMessages, caller),
      actorId: caller.actor.id,
    };
    let updateStatus: PluginUpdateStatusV1 | null = null;
    let result: ApiResultV1<unknown>;

    if (["get_skill_inventory", "classify_skills", "record_skill_selection"].includes(request.params.name)) {
      if (!classification) result = apiError("MCP_UNAVAILABLE", msg("server.classification.notConfigured", {}));
      else {
        try {
          if (request.params.name !== "get_skill_inventory") {
            const checked = (request.params.name === "classify_skills" ? classificationInputSchema : selectionInputSchema).safeParse(args);
            if (!checked.success) return respond(invalidInput(msg("server.classification.inputMismatch", {})));
          }
          if (request.params.name === "get_skill_inventory") {
            if (Object.keys(args).length > 0) return respond(invalidInput(msg("server.classification.inventoryArguments", {})));
            result = apiOk(await classification.inventory());
          } else if (request.params.name === "classify_skills") {
            const classified = attested("classify_skills", input => {
              const observation = typeof input.requestId === "string" ? hostAttestation?.observe({phase: "bootstrap", taskId: input.requestId, runId: null, stageId: null, revision: null}) ?? null : null;
              return classification.classify(input, observation);
            });
            result = apiOk(await classified);
          }
          else {
            const recorded = attested("record_skill_selection", input => {
              const decision = asRecord(input.decision);
              const observation = typeof decision.requestDigest === "string" ? hostAttestation?.observe({phase: "bootstrap", taskId: decision.requestDigest, runId: null, stageId: null, revision: null}) ?? null : null;
              return classification.accept(input, observation);
            });
            result = apiOk(await recorded);
          }
        } catch (error) {
          if (error instanceof WorkflowContractError) {
            // The observation error keeps its own public code (BINDING_INVALID, MCP_UNAVAILABLE, ...; D0069/D0070) and
            // exposes only the typed cause, never raw observation data. A closed verifier reason (e.g.
            // MISSING_MODEL_CAPABILITY for a class-only adapter, D0089) stays visible to the caller.
            const observationReasonCode = error.details?.reasonCode;
            result = apiError(error.code, error.code === "MCP_UNAVAILABLE"
              ? msg("server.classification.observationUnavailable", {})
              : msg("server.classification.observationInvalid", {}), {
              category: "host-observation", reasonCode: error.code,
              ...(typeof observationReasonCode === "string" ? { observationReasonCode } : {}),
            });
          } else if (error instanceof Error && CLASSIFICATION_REQUEST_REJECTIONS.has(error.message)) {
            result = apiError("INVALID_INPUT", msg("server.classification.requestRejected", {}), {
              category: "request-state", reasonCode: error.message,
            });
          } else if (error instanceof ClassificationInitializationError) {
            result = apiError("MCP_UNAVAILABLE", msg("server.classification.initializationUnavailable", {}), {
              category: "configuration", phase: error.phase, reasonCode: error.message,
            });
          } else {
            result = apiError("MCP_UNAVAILABLE", msg("server.classification.runtimeUnavailable", {}), {
              reason: failureReason(error).reason ?? "INTERNAL_FAILURE", cause: failureContext(error),
            });
          }
        }
      }
    } else if (isContextLayerTool(request.params.name)) {
      result = await contextLayerOperation(request.params.name, args, caller);
    } else if (request.params.name === "lookup_korean_prose_terms") {
      try {
        const input = validator.koreanProseGlossaryLookupRequest(args);
        const output = validator.koreanProseGlossaryLookupResult(glossary.lookup(input));
        result = apiOk<KoreanProseGlossaryLookupResultV1>(output);
      } catch (error) {
        result = failureResult(error);
      }
    } else if (request.params.name === "check_for_updates") {
      if (!validUpdateArguments(args)) {
        result = invalidInput(msg("server.updates.argumentsInvalid", {}));
      } else {
        updateStatus = await updates.check(args.force === true);
        result = apiOk(updateStatus);
      }
    } else {
      updateStatus = updates.cachedStatus();
      switch (request.params.name) {
        case "get_trust_capabilities":
          result = Object.keys(args).length > 0
            ? invalidInput(msg("server.trust.capabilitiesArguments", {}))
            : trust
            ? trust.capabilities()
            : apiError("MCP_UNAVAILABLE", msg("server.trust.storeUnavailable", {}));
          break;
        case "validate_collaboration_decision":
          if (!trust) {
            result = apiError("MCP_UNAVAILABLE", msg("server.trust.storeUnavailable", {}));
            break;
          }
          try {
            result = trust.validateCollaborationDecision(validator.validateCollaborationDecisionRequest(args), caller);
          } catch (error) {
            // Contract errors keep their own code and sanitized details (including storage diagnostics).
            result = failureResult(error);
          }
          break;
        case "plan_workflow":
          result = attested("plan_workflow", (input) => service.planWorkflow(input, true));
          break;
        case "open_convergence_root": {
          const mode = responseMode(args, "responseMode");
          if (mode === null) {
            result = invalidInput(msg("server.call.responseModeInvalid", { field: "responseMode" }));
            break;
          }
          const opened = await rootOperation("replace-root", domainArguments(args, "responseMode"), rootAccess, extra) as ApiResultV1<ConvergenceRootV1>;
          if (opened.ok && opened.data && !continuity.bindOpenedRoot(caller, opened.data.rootId)) {
            writeDiagnostic("server", "continuity-root-binding-unavailable", {});
          }
          result = projectResult(opened, mode, convergenceRootHandle);
          break;
        }
        case "claim_workflow_attempt":
          result = service.claimWorkflowAttempt(args, true, observedCaller(caller), rootAccess);
          break;
        case "start_guarded_workflow":
          result = withMode("responseMode", () => service.startGuardedWorkflow(domainArguments(args, "responseMode"), true,
            rootId => continuity.prepareWorkflowStart(caller.sessionId, rootId, workflowOwner(caller))), workflowStatusSummary);
          break;
        case "get_convergence_status":
          result = withMode("detail", () => service.getConvergenceStatus(String(args.rootId ?? "")), convergenceStatusSummary);
          break;
        case "resolve_convergence_gate":
          result = withMode("responseMode", () => service.resolveConvergenceGate(domainArguments(args, "responseMode"), observedCaller(caller)), convergenceStatusSummary);
          break;
        case "start_workflow":
          result = attested("start_workflow", input => {
            const started = service.startMinimalWorkflow(input, observedCaller(caller), {
              priorFileCount: () => continuity.editWindowFileCount(caller.sessionId),
              settle: () => continuity.settleFinishedWorkflow(caller.sessionId),
              beforeCommit: rootId => continuity.prepareWorkflowStart(caller.sessionId, rootId, workflowOwner(caller)),
              ownsRoot: rootId => continuity.ownsRoot(caller.sessionId, rootId),
              ownerPresence: rootAccess.ownerPresence,
              sessionWorkspace: () => observedSessionWorkspace(sessionBoardPath, caller),
              locale,
            });
            // An AGS infrastructure failure must not leave the session's edits refused (design ags30-phase-check 7.6).
            if (!started.ok && started.error && WORKFLOW_START_INFRASTRUCTURE_FAILURES.has(started.error.code)) {
              // The recorder keeps only the code and reason; the message is carried as its key when the body has one.
              const { code, message, messageKey, params, details } = started.error;
              const ref = messageKey ? { key: messageKey, params: params ?? {} } as MessageRef : msg("workflow.service.unkeyedFailure", { message });
              try { continuity.recordWorkflowStartFailure(caller.sessionId, new WorkflowContractError(code, ref, details)); }
              catch (cause) { writeDiagnostic("server", "workflow-start-failure-unrecorded", { reason: failureReason(cause).reason ?? "UNEXPECTED_FAILURE" }); }
            }
            return started;
          });
          break;
        case "record_stage_result":
          result = withMode(
            "responseMode",
            () => attested("record_stage_result", (input) => service.recordStageResult(domainArguments(input, "responseMode"), true, observedCaller(caller))),
            workflowStatusSummary,
          );
          break;
        case "get_workflow_status":
          result = withMode("detail", () => service.getWorkflowStatus(String(args.runId ?? "")), workflowStatusSummary);
          break;
        case "finalize_workflow":
          result = withMode("responseMode", () => service.finalizeWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)), workflowStatusSummary);
          break;
        case "abort_workflow":
          result = withMode("responseMode", () => service.abortWorkflow(String(args.runId ?? ""), integer(args.expectedRevision)), workflowStatusSummary);
          break;
        case "release_convergence_root":
          result = await rootOperation("release-root", args, rootAccess, extra);
          break;
        case "checkpoint_context":
          result = continuity.checkpointContext(args, caller);
          break;
        case "inspect_context":
          result = continuity.inspectContext(args, caller);
          break;
        case "load_context":
          result = continuity.loadContext(args, caller);
          break;
        case "suppress_context_restore":
          result = continuity.suppressContextRestore(args, caller);
          break;
        case "purge_direct_context":
          result = continuity.purgeDirectContext(args, caller);
          break;
        case "prepare_state_cleanup":
          result = cleanup
            ? cleanup.prepare(args)
            : apiError("MCP_UNAVAILABLE", msg("server.stateCleanup.unavailable", {}), { reason: "STATE_CLEANUP_UNAVAILABLE" });
          break;
        case "update_session_status":
        case "list_session_status":
          result = await sessionBoardResult(request.params.name, args, sessionBoardPath, validator, sessionMessages, caller, contextLayers);
          break;
        case "prepare_session_message":
          try {
            validator.prepareSessionMessageRequest(args);
            result = await sessionMessages.prepare(args, caller);
          } catch (error) {
            result = failureResult(error);
          }
          break;
        case "send_session_message":
          try {
            validator.sendSessionMessageRequest(args);
            result = await sessionMessages.send(args, caller);
          } catch (error) {
            result = sendFailureResult(error);
          }
          break;
        case "acknowledge_session_messages":
          try {
            validator.acknowledgeSessionMessagesRequest(args);
            result = await sessionMessages.acknowledge(args, caller);
          } catch (error) {
            result = failureResult(error);
          }
          break;
        case "get_session_message_status":
          try {
            validator.getSessionMessageStatusRequest(args);
            result = await sessionMessages.status(args, caller);
          } catch (error) {
            result = failureResult(error);
          }
          break;
        case "recall_session_message":
          try {
            validator.recallSessionMessageRequest(args);
            result = await sessionMessages.recall(args, caller);
          } catch (error) {
            result = failureResult(error);
          }
          break;
        case "execute_state_cleanup":
          result = cleanup
            ? cleanup.execute(args)
            : apiError("MCP_UNAVAILABLE", msg("server.stateCleanup.unavailable", {}), { reason: "STATE_CLEANUP_UNAVAILABLE" });
          break;
        default:
          result = apiError("INVALID_INPUT", msg("server.call.unknownTool", {}), { tool: request.params.name });
      }
    }

    const response = respond(result);
    if (result.ok && WORKFLOW_CHANGE_TOOLS.has(request.params.name)) {
      const lines = workflowChangeNotice(result.data, runId => {
        const status = service.getWorkflowStatus(runId);
        return status.ok ? status.data : null;
      }, classification?.adviceReady?.() === true);
      response.content.push({ type: "text", text: lines.map(line => render(line, locale)).join("\n") });
    }
    const notice = updateStatus ? updates.takeNotice(updateStatus) : null;
    if (notice) response.content.push({ type: "text", text: JSON.stringify(notice) });
    return response;
    };
    return handle();
  });

  return server;
}
