import { isDeepStrictEqual } from "node:util";

type History = { system?: unknown; tools?: unknown; messages: readonly unknown[] };
type Surface = "messages-api-direct" | "claude-code-managed" | "claude-agent-sdk-managed";
type Change = "append" | "provider-compaction" | "checkpoint-new-session";
export type ConversationBindingResult =
  | { status: "native-owned"; dispatchAuthorized: false }
  | { status: "append-only"; historyAction: "preserve-original"; modelChanged: boolean; modelCompatibility: "provider-decides"; dispatchAuthorized: false }
  | { status: "provider-validation-required"; dispatchAuthorized: false }
  | { status: "checkpoint-authorization-required"; dispatchAuthorized: false }
  | { status: "prefix-edited"; field: "system" | "tools" | "messages"; dispatchAuthorized: false }
  | { status: "invalid-history" | "unsupported-target"; dispatchAuthorized: false };

/** Preflight for application-owned Messages API history; it never rewrites a provider transcript. */
export function guardClaudeConversationBinding(input: {
  surface: Surface;
  previousModelId: string;
  nextModelId: string;
  previous: History;
  next: History;
  change: Change;
}): ConversationBindingResult {
  if (input.surface === "claude-code-managed" || input.surface === "claude-agent-sdk-managed")
    return { status: "native-owned", dispatchAuthorized: false };
  if (input.surface !== "messages-api-direct") return { status: "invalid-history", dispatchAuthorized: false };
  if (!input.previousModelId?.startsWith("claude-") || !input.nextModelId?.startsWith("claude-"))
    return { status: "unsupported-target", dispatchAuthorized: false };
  if (!Array.isArray(input.previous?.messages) || !Array.isArray(input.next?.messages))
    return { status: "invalid-history", dispatchAuthorized: false };
  if (input.change === "checkpoint-new-session")
    return { status: "checkpoint-authorization-required", dispatchAuthorized: false };
  if (input.change === "provider-compaction")
    return { status: "provider-validation-required", dispatchAuthorized: false };
  if (input.change !== "append") return { status: "invalid-history", dispatchAuthorized: false };
  for (const field of ["system", "tools"] as const) {
    if (!isDeepStrictEqual(input.previous[field], input.next[field]))
      return { status: "prefix-edited", field, dispatchAuthorized: false };
  }
  if (input.next.messages.length < input.previous.messages.length
    || input.previous.messages.some((message, index) => !isDeepStrictEqual(message, input.next.messages[index])))
    return { status: "prefix-edited", field: "messages", dispatchAuthorized: false };
  return { status: "append-only", historyAction: "preserve-original",
    modelChanged: input.previousModelId !== input.nextModelId,
    modelCompatibility: "provider-decides", dispatchAuthorized: false };
}

export type ThinkingTransformation = "model-binding-drop" | "prefix-binding-drop" | "prefix-binding-allowed" | "unknown";

/** Classify only provider-reported transformations; absence cannot establish enforcement or readability. */
export function classifyClaudeThinkingTransformation(value: unknown): ThinkingTransformation {
  if (!value || typeof value !== "object") return "unknown";
  const entry = value as { type?: unknown; reason?: unknown };
  if (entry.type === "thinking_dropped" && entry.reason === "model_binding_mismatch") return "model-binding-drop";
  if (entry.type === "thinking_dropped" && entry.reason === "prefix_binding_mismatch") return "prefix-binding-drop";
  if (entry.type === "thinking_mismatch_allowed" && entry.reason === "prefix_binding_mismatch") return "prefix-binding-allowed";
  return "unknown";
}

/** An independent reviewer receives only explicitly allowed evidence identifiers, never conversation history. */
export function claudeIndependentReviewEvidence(
  requested: readonly { id: string; kind: "test-result" | "artifact-diff" | "checkpoint-summary" | "provider-transcript" }[],
  allowed: ReadonlySet<string>,
): { id: string; kind: "test-result" | "artifact-diff" | "checkpoint-summary" }[] {
  return requested.filter((item): item is { id: string; kind: "test-result" | "artifact-diff" | "checkpoint-summary" } =>
    ["test-result", "artifact-diff", "checkpoint-summary"].includes(item.kind) && allowed.has(item.id));
}
