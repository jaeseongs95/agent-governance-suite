import type { ModelClassV1 } from "../../contracts/types.js";
import type { HostExecutionAdapter } from "./host-attestation.js";

const CLAUDE_CLASSES: Readonly<Record<string, ModelClassV1>> = {
  haiku: "lightweight", sonnet: "general", opus: "deep", fable: "frontier",
};
// Native, Bedrock and Vertex model identifiers use the existing Claude policy.
const CLAUDE_MODEL_ID = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?(?:anthropic\.)?claude-(?:\d+(?:-\d+)?-)?(haiku|sonnet|opus|fable)(?:[-@:.]|$)/u;

export function modelClassForClaudeModel(model: string): ModelClassV1 | null {
  const family = CLAUDE_MODEL_ID.exec(model)?.[1];
  return family ? CLAUDE_CLASSES[family] ?? null : null;
}

// Explicit governance policy, not a quality inference from an arbitrary model name.
const CODEX_CLASSES: Readonly<Record<string, ModelClassV1>> = {
  "gpt-6-astra": "frontier",
  // Conservative governance classes for the host's workhorse/easier-task roles, not measured quality claims.
  "gpt-6-sol": "general",
  "gpt-6-luna": "lightweight",
  "gpt-5.6-sol": "deep",
  "gpt-5.6-terra": "general",
  "gpt-5.6-luna": "lightweight",
};

export const claudeCodeExecutionAdapter: HostExecutionAdapter = {
  host: "claude-code", modelClassForModel: modelClassForClaudeModel,
};
export const codexExecutionAdapter: HostExecutionAdapter = {
  host: "codex", modelClassForModel: (model) => Object.hasOwn(CODEX_CLASSES, model) ? CODEX_CLASSES[model]! : null,
};
