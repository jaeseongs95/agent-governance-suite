import { isHookEntry } from "./hook-entry.js";
import { actorAccess, type InputObservation } from "./input-observation.js";
import { WorkflowContractError } from "../../contracts/types.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";
import { types } from "node:util";

import { ContinuityService } from "./continuity-service.js";
import { ContinuityStoreError, SqliteContinuityStore } from "./continuity-store.js";
import { hookFailureContext, hookFailureReason, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { adaptHostInput, isGovernanceHookTool, resolveHookHost, type AdaptedHostInput, type ContinuityAction } from "./host-input-adapter.js";
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

function localToolName(host: string, canonicalName: string): string | null {
  if (!isGovernanceHookTool(host, canonicalName)) return null;
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1)! : canonicalName;
  return BOUND_TOOLS.has(tool) ? tool : null;
}

interface NormalizedContinuityInput {
  observation: InputObservation;
  outputEventName: string;
  action: ContinuityAction | undefined;
}

function continuityConflict(): never {
  throw new WorkflowContractError("BINDING_INVALID", "Continuity lifecycle conflicts with the normalized host observation.", {
    reasonCode: "CONTINUITY_HOOK_OBSERVATION_CONFLICT",
  });
}

/** Snapshot and validate once, before opening stores or dispatching any state transition. */
function normalizedContinuityInput(adapted: AdaptedHostInput): NormalizedContinuityInput {
  const { observation: sourceObservation, lifecycle, outputEventName, continuityAction: sourceAction } = adapted;
  const observation = { ...sourceObservation };
  let action: ContinuityAction | undefined;
  if (observation.kind === "tool-boundary") {
    if (lifecycle !== "none" || sourceAction !== undefined) continuityConflict();
  } else if (sourceAction !== undefined) {
    if (!sourceAction || typeof sourceAction !== "object" || Array.isArray(sourceAction)) continuityConflict();
    const kind = sourceAction.kind;
    switch (kind) {
      case "startup": case "clear": case "resume": case "compact":
        if (lifecycle !== "start") continuityConflict();
        action = Object.freeze({ kind });
        break;
      case "pre-compact":
        if (lifecycle !== "none") continuityConflict();
        action = Object.freeze({ kind });
        break;
      case "post-compact": {
        const { turnId, successful } = sourceAction;
        if (lifecycle !== "none" || (turnId !== null && typeof turnId !== "string") || typeof successful !== "boolean") continuityConflict();
        action = Object.freeze({ kind, turnId, successful });
        break;
      }
      default: continuityConflict();
    }
    if (observation.boundaryPhase !== undefined) continuityConflict();
  }
  return { observation, outputEventName, action };
}

function sessionOutput(eventName: string, additionalContext: string | null): Record<string, unknown> {
  return additionalContext ? {
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  } : {};
}

function handleNormalizedContinuityHook(input: NormalizedContinuityInput, service: ContinuityService, host: string): Record<string, unknown> {
  const { observation, action, outputEventName } = input;
  const sessionId = observation.sessionId;
  if (!sessionId || !actorAccess(observation.actor).allowed) return {};
  switch (action?.kind) {
    case "startup": service.ensureSession(sessionId); return {};
    case "clear": service.clearSession(sessionId); return {};
    case "resume": return sessionOutput(outputEventName, service.formatCandidate(service.candidateForSession(sessionId)));
    case "compact": return sessionOutput(outputEventName, service.compactContext(sessionId));
    case "pre-compact": service.markPreCompact(sessionId); return {};
    case "post-compact": service.recordPostCompact(sessionId, action.turnId, action.successful); return {};
  }
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before") {
    const toolName = localToolName(host, observation.toolName ?? "");
    if (!toolName) return {};
    const toolInput = observation.toolInput ?? {};
    const token = service.issueToolBinding(sessionId, toolName, toolInput);
    return {
      hookSpecificOutput: {
        hookEventName: outputEventName,
        updatedInput: { ...toolInput, _continuityBinding: token },
      },
    };
  }
  return {};
}

export function handleContinuityHook(input: HookInput, service: ContinuityService, host = "codex"): Record<string, unknown> {
  return handleNormalizedContinuityHook(normalizedContinuityInput(adaptHostInput(input, host)), service, host);
}

type ContinuityHookPhase = "host-entry" | "stdin" | "input" | "storage" | "workflow-store" | "handle" | "close" | "stdout";

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
export function runContinuityHook(raw: string, environment: NodeJS.ProcessEnv = process.env, host = "codex", failClosed = false): string {
  let phase: ContinuityHookPhase = "input";
  let continuity: SqliteContinuityStore | null = null;
  let workflow: SqliteWorkflowStore | null = null;
  let primary: unknown;
  let failed = false;
  let result = "";
  let cleanup: unknown;
  let cleanupFailed = false;
  try {
    const input = JSON.parse(raw) as HookInput;
    const normalized = normalizedContinuityInput(adaptHostInput(input, host));
    phase = "storage";
    const workflowDatabasePath = resolveWorkflowDatabasePath(environment);
    const continuityDatabasePath = resolveContinuityDatabasePath(environment);
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    continuity = new SqliteContinuityStore(continuityDatabasePath);
    const needsWorkflowProjection = normalized.action?.kind === "pre-compact"
      || normalized.action?.kind === "resume" || normalized.action?.kind === "compact";
    if (needsWorkflowProjection) {
      try { workflow = new SqliteWorkflowStore(workflowDatabasePath); }
      catch (cause) {
        // The projection is optional; continue without it but keep the cause visible.
        reportContinuityFailure("workflow-store", cause);
        workflow = null;
      }
    }
    phase = "handle";
    const output = handleNormalizedContinuityHook(normalized, new ContinuityService(continuity, null, workflow), host);
    result = Object.keys(output).length > 0 ? JSON.stringify(output) : "";
  } catch (cause) {
    primary = cause;
    failed = true;
    reportContinuityFailure(phase, cause);
  } finally {
    for (const resource of [workflow, continuity]) {
      try { resource?.close(); } catch (cause) {
        reportContinuityFailure("close", cause);
        if (!cleanupFailed) { cleanup = cause; cleanupFailed = true; }
        else if (cleanup instanceof Error) retainHookFailureSecondary(cleanup, cause);
      }
    }
    if (failClosed && failed && cleanupFailed && primary instanceof Error) retainHookFailureSecondary(primary, cleanup);
  }
  if (failClosed && failed) throw primary;
  if (failClosed && cleanupFailed) throw cleanup;
  return result;
}

function main(): void {
  let raw: string;
  try { raw = readFileSync(0, "utf8"); }
  catch (cause) { reportContinuityFailure("stdin", cause); return; }
  let output: string;
  try { output = runContinuityHook(raw, process.env, resolveHookHost(process.argv.slice(2), "codex")); }
  catch (cause) { reportContinuityFailure("host-entry", cause); return; }
  if (!output) return;
  try { process.stdout.write(output); } catch (cause) { reportContinuityFailure("stdout", cause); }
}

if (isHookEntry(import.meta.url, "continuity-hook")) main();
