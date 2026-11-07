import { type ApiResultV1, WorkflowContractError, contractErrorBody } from "../../contracts/types.js";
import {
  type ContextLayerService,
  GLOBAL_CONTEXT_MAX_BYTES,
  ROLE_CONTEXT_MAX_BYTES,
  ROLE_NAME_MAX_LENGTH,
} from "./context-layer-service.js";
import type { VerifiedCaller } from "./caller-identity.js";
import { failureContext, failureReason } from "./failure-diagnostics.js";
import { msg } from "./i18n.js";

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

/**
 * The context layer tools. An agent never changes what the user decides: a global change or a role binding is stored
 * as a request (proposal) and applies only when the user signs it with a passkey on the local admin page
 * (AGS3-T-0024). The tool returns where the user approves it.
 */
export function createContextLayerToolHandler(service: ContextLayerService | null) {
  return async (tool: ContextLayerTool, args: Record<string, unknown>, caller: VerifiedCaller): Promise<ApiResultV1<unknown>> => {
    try {
      if (!service) throw new WorkflowContractError("MCP_UNAVAILABLE", msg("continuity.layers.unavailable", {}), { reasonCode: "CONTEXT_LAYER_UNAVAILABLE" });
      const input = arguments_(tool, args);
      if (tool === "load_shared_context") return result(service.load(caller.host, caller.sessionId));
      if (tool === "checkpoint_role_context") {
        return result(service.saveRole(caller.host, caller.sessionId, input.expectedStateToken, input.body, caller.actor.id));
      }
      const requester = { host: caller.host, sessionId: caller.sessionId, actor: caller.actor.id };
      return result(tool === "checkpoint_global_context"
        ? service.proposeGlobal(requester, input.expectedStateToken, input.body)
        : service.proposeBinding(requester, input.role));
    } catch (cause) {
      if (cause instanceof WorkflowContractError) return failed(cause);
      return { schemaVersion: "1.0.0", ok: false, data: null, error: contractErrorBody("MCP_UNAVAILABLE", msg("continuity.layers.unavailable", {}),
        { reasonCode: "CONTEXT_LAYER_UNAVAILABLE", reason: failureReason(cause).reason ?? "UNEXPECTED_FAILURE", cause: failureContext(cause) }) };
    }
  };
}
