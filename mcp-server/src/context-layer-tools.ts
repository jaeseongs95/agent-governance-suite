import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import { type ApiResultV1, WorkflowContractError, contractErrorBody } from "../../contracts/types.js";
import { bodyDigest } from "./context-layer-store.js";
import {
  type ContextLayerService,
  GLOBAL_CONTEXT_MAX_BYTES,
  type PendingContextChange,
  ROLE_CONTEXT_MAX_BYTES,
  ROLE_NAME_MAX_LENGTH,
} from "./context-layer-service.js";
import type { VerifiedCaller } from "./caller-identity.js";
import { failureContext, failureReason } from "./failure-diagnostics.js";
import { msg, render, type MessageRef, type SupportedLocale } from "./i18n.js";

export const CONTEXT_LAYER_TOOLS = ["load_shared_context", "checkpoint_global_context", "bind_session_role", "checkpoint_role_context"] as const;
export type ContextLayerTool = (typeof CONTEXT_LAYER_TOOLS)[number];

export function isContextLayerTool(name: string): name is ContextLayerTool {
  return (CONTEXT_LAYER_TOOLS as readonly string[]).includes(name);
}

const version = { const: "1.0.0" } as const;
const token = { type: ["string", "null"], minLength: 1, maxLength: 200 } as const;
/** Input schemas; the limits are the server's, and the server checks them again (UTF-8 bytes are not a JSON Schema length). */
export const CONTEXT_LAYER_INPUT_SCHEMAS: Record<ContextLayerTool, Record<string, unknown>> = {
  load_shared_context: { type: "object", additionalProperties: false, required: ["schemaVersion"], properties: { schemaVersion: version } },
  checkpoint_global_context: { type: "object", additionalProperties: false, required: ["schemaVersion", "expectedStateToken", "body"],
    properties: { schemaVersion: version, expectedStateToken: token, body: { type: "string", maxLength: GLOBAL_CONTEXT_MAX_BYTES } } },
  bind_session_role: { type: "object", additionalProperties: false, required: ["schemaVersion", "role"],
    properties: { schemaVersion: version, role: { type: ["string", "null"], minLength: 1, maxLength: ROLE_NAME_MAX_LENGTH } } },
  checkpoint_role_context: { type: "object", additionalProperties: false, required: ["schemaVersion", "expectedStateToken", "body"],
    properties: { schemaVersion: version, expectedStateToken: token, body: { type: "string", maxLength: ROLE_CONTEXT_MAX_BYTES } } },
};

function result<T>(data: T): ApiResultV1<T> {
  return { schemaVersion: "1.0.0", ok: true, data, error: null };
}

function failed(error: WorkflowContractError): ApiResultV1<never> {
  return { schemaVersion: "1.0.0", ok: false, data: null, error: error.toBody() };
}

function arguments_(tool: ContextLayerTool, args: Record<string, unknown>): Record<string, unknown> {
  const schema = CONTEXT_LAYER_INPUT_SCHEMAS[tool] as { required: string[]; properties: Record<string, unknown> };
  const extra = Object.keys(args).filter(key => !(key in schema.properties));
  const missing = schema.required.filter(key => !Object.hasOwn(args, key));
  if (extra.length || missing.length || args.schemaVersion !== "1.0.0") {
    throw new WorkflowContractError("INVALID_INPUT", msg("continuity.layers.argumentsInvalid", { tool }), { reasonCode: "CONTEXT_LAYER_ARGUMENTS_INVALID", extra, missing });
  }
  return args;
}

function approvalFailure(reason: string, code: "MCP_UNAVAILABLE" | "INVALID_TRANSITION", details: Record<string, unknown> = {}): WorkflowContractError {
  return new WorkflowContractError(code, msg("continuity.layers.approvalFailed", { reason }), { reasonCode: reason, ...details });
}

function approvalMessage(change: PendingContextChange, caller: VerifiedCaller): MessageRef {
  const session = `${caller.host} ${caller.sessionId}`;
  if (change.kind === "global") {
    return msg("continuity.layers.approveGlobal", { session, bytes: change.bytes, limit: GLOBAL_CONTEXT_MAX_BYTES, digest: change.digest,
      body: change.body || msg("continuity.layers.emptyBody", {}) });
  }
  return change.role === null
    ? msg("continuity.layers.approveUnbind", { session, role: change.currentRole ?? "-" })
    : msg("continuity.layers.approveBind", { session, role: change.role, current: change.currentRole ?? "-" });
}

/**
 * The context layer tools. A global save and a role binding change only after the user accepts the MCP form that shows
 * the exact change (the same producer as the root approvals, root-approval.ts); a client without form elicitation is
 * refused with its reason, never passed. The answer comes from the client transport, never from tool arguments.
 */
export function createContextLayerToolHandler(server: Pick<Server, "getClientCapabilities" | "elicitInput">, service: ContextLayerService | null) {
  const connectionId = randomUUID();
  return async (tool: ContextLayerTool, args: Record<string, unknown>, caller: VerifiedCaller, locale: SupportedLocale,
    extra: { requestId: string | number; signal: AbortSignal }): Promise<ApiResultV1<unknown>> => {
    try {
      if (!service) throw new WorkflowContractError("MCP_UNAVAILABLE", msg("continuity.layers.unavailable", {}), { reasonCode: "CONTEXT_LAYER_UNAVAILABLE" });
      const input = arguments_(tool, args);
      if (tool === "load_shared_context") return result(service.load(caller.host, caller.sessionId));
      if (tool === "checkpoint_role_context") {
        return result(service.saveRole(caller.host, caller.sessionId, input.expectedStateToken, input.body, caller.actor.id));
      }
      const change = tool === "checkpoint_global_context"
        ? service.prepareGlobal(input.expectedStateToken, input.body)
        : service.prepareBinding(caller.host, caller.sessionId, input.role);
      if (!server.getClientCapabilities()?.elicitation?.form) throw approvalFailure("USER_APPROVAL_PRODUCER_UNSUPPORTED", "MCP_UNAVAILABLE");
      const message = render(approvalMessage(change, caller), locale);
      const response = await server.elicitInput({ mode: "form", message, requestedSchema: { type: "object",
        properties: { confirm: { type: "boolean", title: render(msg("continuity.layers.approveConfirm", {}), locale) } }, required: ["confirm"] } },
      { relatedRequestId: extra.requestId, signal: extra.signal });
      if (extra.signal.aborted) throw approvalFailure("USER_APPROVAL_CANCELLED", "INVALID_TRANSITION");
      if (response.action !== "accept" || response.content?.confirm !== true) {
        throw approvalFailure(response.action === "cancel" ? "USER_APPROVAL_CANCELLED" : "USER_APPROVAL_DECLINED", "INVALID_TRANSITION");
      }
      const committed = service.commit(change, caller.actor.id,
        { kind: "mcp-form", connectionId, requestId: JSON.stringify(extra.requestId), shownDigest: bodyDigest(message) });
      return result(committed.kind === "global" ? committed.layer : { binding: committed.binding });
    } catch (cause) {
      if (cause instanceof WorkflowContractError) return failed(cause);
      if (extra.signal.aborted) return failed(approvalFailure("USER_APPROVAL_CANCELLED", "INVALID_TRANSITION"));
      return { schemaVersion: "1.0.0", ok: false, data: null, error: contractErrorBody("MCP_UNAVAILABLE", msg("continuity.layers.unavailable", {}),
        { reasonCode: "CONTEXT_LAYER_UNAVAILABLE", reason: failureReason(cause).reason ?? "UNEXPECTED_FAILURE", cause: failureContext(cause) }) };
    }
  };
}
