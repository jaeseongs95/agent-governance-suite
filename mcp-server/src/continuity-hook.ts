import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

import { ContinuityService } from "./continuity-service.js";
import { ContinuityStoreError, SqliteContinuityStore } from "./continuity-store.js";
import { hookFailureContext, hookFailureReason } from "./hook-error-diagnostics.js";
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

type ContinuityHookPhase = "stdin" | "input" | "storage" | "workflow-store" | "handle" | "close" | "stdout";

/** Bounded diagnostics only: stable reason codes and error metadata, never session IDs, inputs, SQL or paths. */
function reportContinuityFailure(phase: ContinuityHookPhase, cause: unknown): void {
  try {
    const isObject = Boolean(cause) && (typeof cause === "object" || typeof cause === "function");
    const storeError = isObject && !types.isProxy(cause) && cause instanceof ContinuityStoreError ? cause : null;
    const reason = hookFailureReason(cause)
      ?? (storeError ? storeError.reason
        : phase === "input" && isObject && !types.isProxy(cause) && cause instanceof SyntaxError ? "INVALID_JSON"
          : "UNEXPECTED_FAILURE");
    console.error("[agent-governance-suite] continuity-hook-failure " + JSON.stringify({
      phase, reason, context: hookFailureContext(cause),
      ...(storeError && storeError.causeValue !== undefined ? { storeCause: hookFailureContext(storeError.causeValue) } : {}),
    }));
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}

/**
 * Runs one lifecycle event and returns the JSON to print. Continuity stays optional (fail open with no
 * context), but every failure is reported with its phase and original cause instead of being discarded.
 */
export function runContinuityHook(raw: string, environment: NodeJS.ProcessEnv = process.env): string {
  let phase: ContinuityHookPhase = "input";
  let continuity: SqliteContinuityStore | null = null;
  let workflow: SqliteWorkflowStore | null = null;
  try {
    const input = JSON.parse(raw) as HookInput;
    phase = "storage";
    const workflowDatabasePath = resolveWorkflowDatabasePath(environment);
    const continuityDatabasePath = resolveContinuityDatabasePath(environment);
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    continuity = new SqliteContinuityStore(continuityDatabasePath);
    const event = input.hook_event_name;
    const source = input.source;
    const needsWorkflowProjection = event === "PreCompact"
      || (event === "SessionStart" && (source === "resume" || source === "compact"));
    if (needsWorkflowProjection) {
      try { workflow = new SqliteWorkflowStore(workflowDatabasePath); }
      catch (cause) {
        // The projection is optional; continue without it but keep the cause visible.
        reportContinuityFailure("workflow-store", cause);
        workflow = null;
      }
    }
    phase = "handle";
    const output = handleContinuityHook(input, new ContinuityService(continuity, null, workflow));
    return Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    reportContinuityFailure(phase, cause);
    return "";
  } finally {
    try { workflow?.close(); } catch (cause) { reportContinuityFailure("close", cause); }
    try { continuity?.close(); } catch (cause) { reportContinuityFailure("close", cause); }
  }
}

function main(): void {
  let raw: string;
  try { raw = readFileSync(0, "utf8"); }
  catch (cause) { reportContinuityFailure("stdin", cause); return; }
  const output = runContinuityHook(raw);
  if (!output) return;
  try { process.stdout.write(output); } catch (cause) { reportContinuityFailure("stdout", cause); }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) main();
