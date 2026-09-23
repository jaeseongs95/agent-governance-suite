import compatibility from "./model-request-compatibility.json" with { type: "json" };

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type NativeControl =
  | { kind: "enum"; value: string }
  | { kind: "toggle"; enabled: boolean }
  | { kind: "token-budget"; budgetTokens: number }
  | { kind: "not-exposed" };
type CommonRequest = { modelId: string; nativeControl: NativeControl; minimumEffort?: Effort };
export type ClaudeManagedRequest = CommonRequest & { surface: "claude-code-managed" };
export type ClaudeMessagesRequest = CommonRequest & {
  surface: "messages-api-direct";
  platform?: "anthropic-api" | "google-cloud" | "bedrock";
  thinking?: { type: string; budget_tokens?: number };
  toolChoice?: { type: string; name?: string };
  tools?: Array<{ type?: string; name?: string; strict?: boolean }>;
  structuredOutput?: boolean;
  requiredTool?: {
    name: string;
    alternative: "strict-auto" | "structured-output";
    validateDomain: (toolInput: unknown, toolResult: unknown) => boolean;
  };
  computerTool?: { platform: "anthropic-api" | "google-cloud" | "bedrock"; type: string };
};
export type ClaudeRequest = ClaudeManagedRequest | ClaudeMessagesRequest;
export type UnsupportedCode =
  | "INVALID_MODEL_ID" | "UNSUPPORTED_SURFACE" | "UNSUPPORTED_NATIVE_CONTROL" | "UNSUPPORTED_EFFORT" | "EFFORT_BELOW_FLOOR"
  | "API_FIELD_ON_MANAGED_HOST" | "UNSUPPORTED_THINKING" | "UNSUPPORTED_FORCED_TOOL"
  | "REQUIRED_TOOL_UNENFORCED" | "UNSUPPORTED_COMPUTER_TOOL" | "COMPUTER_PLATFORM_UNKNOWN"
  | "REQUIRED_TOOL_MISSING" | "TOOL_RESULT_MISSING" | "DOMAIN_VALIDATION_FAILED";
export type GuardResult =
  | { status: "compatible-settings"; modelId: string; effort: Effort; hostSupported: "unknown"; dispatchAuthorized: false; requiresToolResultValidation: boolean }
  | { status: "legacy-unmodified"; modelId: string; dispatchAuthorized: false }
  | { status: "unsupported"; code: UnsupportedCode; field: string; dispatchAuthorized: false };

const unsupported = (code: UnsupportedCode, field: string): GuardResult =>
  ({ status: "unsupported", code, field, dispatchAuthorized: false });
const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Settings compatibility only. M08 must still prove the concrete installed host binding before dispatch. */
export function guardClaudeModelRequest(request: ClaudeRequest): GuardResult {
  if (typeof request?.modelId !== "string" || request.modelId.length === 0) return unsupported("INVALID_MODEL_ID", "modelId");
  if (request.modelId !== compatibility.modelId) return { status: "legacy-unmodified", modelId: request.modelId, dispatchAuthorized: false };
  if (request.surface !== "claude-code-managed" && request.surface !== "messages-api-direct")
    return unsupported("UNSUPPORTED_SURFACE", "surface");
  if (request.surface === "claude-code-managed"
    && ["thinking", "toolChoice", "tools", "structuredOutput", "requiredTool", "computerTool"]
      .some(field => Object.hasOwn(request, field))) return unsupported("API_FIELD_ON_MANAGED_HOST", "surface");

  const control = request.nativeControl;
  if (!control || control.kind !== "enum") return unsupported("UNSUPPORTED_NATIVE_CONTROL", "nativeControl.kind");
  const effort = control.value;
  const levels = compatibility.efforts;
  if (!levels.includes(effort)) return unsupported("UNSUPPORTED_EFFORT", "nativeControl.value");
  if (request.minimumEffort && !levels.includes(request.minimumEffort)) return unsupported("UNSUPPORTED_EFFORT", "minimumEffort");
  if (request.minimumEffort && levels.indexOf(effort) < levels.indexOf(request.minimumEffort))
    return unsupported("EFFORT_BELOW_FLOOR", "minimumEffort");

  if (request.surface === "messages-api-direct") {
    if (request.thinking && (!compatibility.messagesApi.supportedThinkingTypes.includes(request.thinking.type)
      || request.thinking.budget_tokens !== undefined)) return unsupported("UNSUPPORTED_THINKING", "thinking");
    if (request.toolChoice && (compatibility.messagesApi.unsupportedToolChoices.includes(request.toolChoice.type)
      || !["auto", "none"].includes(request.toolChoice.type)))
      return unsupported("UNSUPPORTED_FORCED_TOOL", "toolChoice.type");
    const computerTypes = [...(request.tools ?? []).map(tool => tool.type).filter((type): type is string => typeof type === "string" && type.startsWith("computer_")),
      ...(request.computerTool ? [request.computerTool.type] : [])];
    if (computerTypes.length) {
      const platform = request.platform ?? request.computerTool?.platform;
      if (!platform || !["anthropic-api", "google-cloud", "bedrock"].includes(platform)
        || request.computerTool && request.platform && request.computerTool.platform !== request.platform)
        return unsupported("COMPUTER_PLATFORM_UNKNOWN", "platform");
      const blocked = compatibility.messagesApi.unsupportedComputerTool[platform as keyof typeof compatibility.messagesApi.unsupportedComputerTool];
      if (computerTypes.includes(blocked)) return unsupported("UNSUPPORTED_COMPUTER_TOOL", "tools");
    }
    if (request.requiredTool) {
      const required = request.requiredTool;
      const alternativeReady = required.alternative === "strict-auto"
        ? request.tools?.some(tool => tool.name === required.name && tool.strict === true)
        : required.alternative === "structured-output" && request.structuredOutput === true;
      if (request.toolChoice?.type !== "auto" || !alternativeReady || typeof required.validateDomain !== "function")
        return unsupported("REQUIRED_TOOL_UNENFORCED", "requiredTool");
    }
  }
  return { status: "compatible-settings", modelId: request.modelId, effort: effort as Effort,
    hostSupported: "unknown", dispatchAuthorized: false,
    requiresToolResultValidation: request.surface === "messages-api-direct" && request.requiredTool !== undefined };
}

/** A required tool is satisfied only by its actual call, matching result, and domain check. */
export function validateClaudeRequiredToolResult(request: ClaudeMessagesRequest, response: unknown, toolResults: unknown): GuardResult {
  const preflight = guardClaudeModelRequest(request);
  if (preflight.status !== "compatible-settings" || !request.requiredTool) return preflight;
  const content = object(response)?.content;
  const calls = Array.isArray(content) ? content.map(object).filter(item => item !== null && item.type === "tool_use"
    && item.name === request.requiredTool?.name && typeof item.id === "string") : [];
  if (calls.length === 0) return unsupported("REQUIRED_TOOL_MISSING", "response.content");
  const results = Array.isArray(toolResults) ? toolResults.map(object) : [];
  for (const call of calls) {
    const result = results.find(item => item !== null && item.tool_use_id === call?.id && item.is_error !== true);
    if (!result) continue;
    try {
      if (request.requiredTool.validateDomain(call?.input, result.content)) return preflight;
    } catch { /* A throwing domain validator is a failed result. */ }
    return unsupported("DOMAIN_VALIDATION_FAILED", "toolResults");
  }
  return unsupported("TOOL_RESULT_MISSING", "toolResults");
}
