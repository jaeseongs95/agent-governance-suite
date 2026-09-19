import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ContinuityService } from "./continuity-service.js";
import { SqliteContinuityStore } from "./continuity-store.js";
import {
  assertDistinctDatabasePaths,
  resolveContinuityDatabasePath,
  resolveWorkflowDatabasePath,
} from "./runtime-config.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";

type HookInput = Record<string, unknown>;

const BOUND_TOOLS = new Set([
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context",
]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function localToolName(canonicalName: string): string | null {
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1)! : canonicalName;
  return BOUND_TOOLS.has(tool) ? tool : null;
}

function sessionOutput(additionalContext: string | null): Record<string, unknown> {
  return additionalContext ? {
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext },
  } : {};
}

export function handleContinuityHook(input: HookInput, service: ContinuityService): Record<string, unknown> {
  const event = typeof input.hook_event_name === "string" ? input.hook_event_name : "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  if (!sessionId) return {};

  if (event === "SessionStart") {
    const source = input.source;
    if (source === "startup") {
      service.ensureSession(sessionId);
      return {};
    }
    if (source === "clear") {
      service.clearSession(sessionId);
      return {};
    }
    if (source === "resume") return sessionOutput(service.formatCandidate(service.candidateForSession(sessionId)));
    if (source === "compact") return sessionOutput(service.compactContext(sessionId));
    return {};
  }

  if (event === "PreCompact") {
    service.markPreCompact(sessionId);
    return {};
  }

  if (event === "PostCompact") {
    const turnId = typeof input.turn_id === "string" ? input.turn_id : null;
    service.recordPostCompact(sessionId, turnId, input.error === undefined || input.error === null);
    return {};
  }

  if (event === "PreToolUse") {
    const canonicalName = typeof input.tool_name === "string" ? input.tool_name : "";
    const toolName = localToolName(canonicalName);
    if (!toolName) return {};
    const toolInput = record(input.tool_input);
    const token = service.issueToolBinding(sessionId, toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...toolInput, _continuityBinding: token },
      },
    };
  }

  return {};
}

async function main(): Promise<void> {
  let continuity: SqliteContinuityStore | null = null;
  let workflow: SqliteWorkflowStore | null = null;
  try {
    const input = JSON.parse(readFileSync(0, "utf8")) as HookInput;
    const workflowDatabasePath = resolveWorkflowDatabasePath();
    const continuityDatabasePath = resolveContinuityDatabasePath();
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    continuity = new SqliteContinuityStore(continuityDatabasePath);
    const event = input.hook_event_name;
    const source = input.source;
    const needsWorkflowProjection = event === "PreCompact"
      || (event === "SessionStart" && (source === "resume" || source === "compact"));
    if (needsWorkflowProjection) {
      try { workflow = new SqliteWorkflowStore(workflowDatabasePath); } catch { workflow = null; }
    }
    const output = handleContinuityHook(input, new ContinuityService(continuity, null, workflow));
    if (Object.keys(output).length > 0) process.stdout.write(JSON.stringify(output));
  } catch {
    // Continuity is optional: every lifecycle failure exits successfully and emits no context.
  } finally {
    try { workflow?.close(); } catch { /* Fail open. */ }
    try { continuity?.close(); } catch { /* Fail open. */ }
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) await main();
