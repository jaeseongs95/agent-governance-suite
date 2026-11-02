import { isHookEntry } from "./hook-entry.js";
import { actorAccess, isObservedSubagent, type InputObservation } from "./input-observation.js";
import { WorkflowContractError } from "../../contracts/types.js";
import "./builtin-hook-host-adapters.js";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { types } from "node:util";

import { ContinuityService, workflowFailureCode } from "./continuity-service.js";
import { ContinuityStoreError, SqliteContinuityStore } from "./continuity-store.js";
import { hookFailureContext, hookFailureReason, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { failureReason } from "./failure-diagnostics.js";
import { adaptHostInput, hostAgentNoteRoots, isGovernanceHookTool, resolveHookHost, type AdaptedHostInput, type ContinuityAction, type ForkHostParentRead, type ForkOriginRead, type LineageRead } from "./host-input-adapter.js";
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

/** Extra exempt directories, separated by the platform path delimiter. Set by the user's environment, never a tool input. */
const EXEMPT_PATHS_VARIABLE = "AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS";

/** Edit paths compare as the platform's file system does: Windows paths without case or separator differences. */
function normalizedEditPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.replaceAll("/", "\\").toLowerCase() : resolved;
}

function realOrSelf(value: string): string[] {
  try { return [value, realpathSync(value)]; } catch { return [value]; }
}

/**
 * Non-product directories (design ags30-phase-check 7.3): the OS temporary directory (agent scratch space), the host's
 * own note directories and the user's configured list. The working directory is not a criterion.
 */
function exemptEditRoots(host: string, environment: NodeJS.ProcessEnv): string[][] {
  const configured = (environment[EXEMPT_PATHS_VARIABLE] ?? "").split(path.delimiter).map(entry => entry.trim()).filter(entry => path.isAbsolute(entry));
  return [...new Set([tmpdir(), ...hostAgentNoteRoots(host, environment), ...configured].flatMap(realOrSelf).map(normalizedEditPath))]
    .map(root => root.split(path.sep));
}

function isExemptEditPath(target: string, roots: readonly string[][]): boolean {
  const segments = target.split(path.sep);
  return roots.some(root => root.length <= segments.length && root.every((segment, index) => segment === "*" || segment === segments[index]));
}

/** The product files an edit will change; a tool whose target the adapter could not read still counts as one file. */
function productEditTargets(observation: InputObservation, host: string, environment: NodeJS.ProcessEnv): string[] {
  const targets = observation.editTargets ?? [];
  if (targets.length === 0) return [`(경로 미확인: ${observation.toolName ?? "edit"})`];
  const roots = exemptEditRoots(host, environment);
  return [...new Set(targets.map(normalizedEditPath))].filter(target => !isExemptEditPath(target, roots));
}

function deniedEdit(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function localToolName(host: string, canonicalName: string): string | null {
  if (!isGovernanceHookTool(host, canonicalName)) return null;
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1)! : canonicalName;
  return BOUND_TOOLS.has(tool) ? tool : null;
}

interface NormalizedContinuityInput {
  observation: InputObservation;
  lifecycle: AdaptedHostInput["lifecycle"];
  outputEventName: string;
  action: ContinuityAction | undefined;
  readLineage: (() => LineageRead) | undefined;
  readForkOrigin: (() => ForkOriginRead) | undefined;
  readForkHostParent: (() => ForkHostParentRead) | undefined;
}

function continuityConflict(): never {
  throw new WorkflowContractError("BINDING_INVALID", "Continuity lifecycle conflicts with the normalized host observation.", {
    reasonCode: "CONTINUITY_HOOK_OBSERVATION_CONFLICT",
  });
}

/** Snapshot and validate once, before opening stores or dispatching any state transition. */
function normalizedContinuityInput(adapted: AdaptedHostInput): NormalizedContinuityInput {
  const { observation: sourceObservation, lifecycle, outputEventName, continuityAction: sourceAction, readLineage, readForkOrigin, readForkHostParent } = adapted;
  const observation = { ...sourceObservation };
  let action: ContinuityAction | undefined;
  if (observation.kind === "tool-boundary") {
    if (lifecycle !== "none" || sourceAction !== undefined) continuityConflict();
  } else if (sourceAction !== undefined) {
    if (!sourceAction || typeof sourceAction !== "object" || Array.isArray(sourceAction)) continuityConflict();
    const kind = sourceAction.kind;
    switch (kind) {
      case "startup": case "fork": case "clear": case "resume": case "compact":
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
  return { observation, lifecycle, outputEventName, action, readLineage: typeof readLineage === "function" ? readLineage : undefined,
    readForkOrigin: typeof readForkOrigin === "function" ? readForkOrigin : undefined,
    readForkHostParent: typeof readForkHostParent === "function" ? readForkHostParent : undefined };
}

function sessionOutput(eventName: string, additionalContext: string | null): Record<string, unknown> {
  return additionalContext ? {
    hookSpecificOutput: { hookEventName: eventName, additionalContext },
  } : {};
}

/** The host's turn end (Stop); a session end (lifecycle end) is not a turn the agent can continue. */
function isTurnEnd(input: NormalizedContinuityInput): boolean {
  return input.observation.kind === "turn-end" && input.lifecycle === "none" && input.action === undefined;
}

/** Codex Stop takes only JSON and continues with `reason`; the other hosts take the canonical context. */
function stopOutput(host: string, eventName: string, cue: string | null): Record<string, unknown> {
  if (!cue) return {};
  return host === "codex" ? { decision: "block", reason: cue } : sessionOutput(eventName, cue);
}

/** A file edit before it runs: the workflow gate (design ags30-phase-check 7.2). Exempt-only edits are not recorded. */
function gateEdit(observation: InputObservation, service: ContinuityService, host: string, environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const targets = productEditTargets(observation, host, environment);
  if (targets.length === 0) return {};
  const refusal = service.gateEditForSession(observation.sessionId, targets);
  return refusal ? deniedEdit(refusal) : {};
}

function isEditBoundary(observation: InputObservation): boolean {
  return observation.kind === "tool-boundary" && observation.boundaryPhase === "before" && observation.editTargets !== undefined;
}

function handleNormalizedContinuityHook(input: NormalizedContinuityInput, service: ContinuityService, host: string,
  environment: NodeJS.ProcessEnv): Record<string, unknown> {
  const { observation, action, outputEventName, readLineage, readForkOrigin, readForkHostParent } = input;
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  // A subagent's edit counts in its parent session's window (the host names the parent in session_id). Nothing else
  // a child does pins or binds continuity state.
  if (isObservedSubagent(observation)) return isEditBoundary(observation) ? gateEdit(observation, service, host, environment) : {};
  if (!actorAccess(observation.actor).allowed) return {};
  switch (action?.kind) {
    case "startup": service.ensureSession(sessionId); return {};
    case "fork": service.startFork(sessionId, readForkOrigin, readForkHostParent); return {};
    case "clear": service.clearSession(sessionId); return {};
    case "resume": return sessionOutput(outputEventName, service.formatCandidate(service.candidateForSession(sessionId)));
    case "compact":
      if (readLineage) service.reanchorAfterCompact(sessionId, readLineage);
      return sessionOutput(outputEventName, service.compactContext(sessionId));
    case "pre-compact": service.markPreCompact(sessionId); return {};
    case "post-compact":
      service.recordPostCompact(sessionId, action.turnId, action.successful);
      if (readLineage) service.reanchorAfterCompact(sessionId, readLineage);
      return {};
  }
  // Pin a fork's parent before the model can change its own file; the cue contains no snapshot body.
  if (observation.kind === "user-input") {
    if (readLineage) service.pinForkParent(sessionId, readLineage, false);
    return observation.wakeOnly ? {} : sessionOutput(outputEventName, service.checkpointCueForSession(sessionId));
  }
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before") {
    // A host that deferred its host-process read at the fork start reads it here, before any pin below.
    if (readForkHostParent) service.readDeferredForkHostParent(sessionId, readForkHostParent);
    const toolName = localToolName(host, observation.toolName ?? "");
    if (!toolName) {
      // Write-capable host tools and every non-AGS MCP tool reach this boundary before they run: the last point the
      // fork's file is the host's. AGS tools pin through their own binding below.
      if (readLineage) service.pinForkParent(sessionId, readLineage);
      return isEditBoundary(observation) ? gateEdit(observation, service, host, environment) : {};
    }
    // AGS tools pin and bind on the server from the verified caller; the hook only did the host-process read above.
    return {};
  }
  // A turn the host already continued through its Stop hook is checked without a second continuation.
  if (isTurnEnd(input)) return stopOutput(host, outputEventName, service.phaseCheckForSession(sessionId, observation.stopHookActive === true));
  return {};
}

export function handleContinuityHook(input: HookInput, service: ContinuityService, host = "codex",
  environment: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  return handleNormalizedContinuityHook(normalizedContinuityInput(adaptHostInput(input, host)), service, host, environment);
}

type ContinuityHookPhase = "host-entry" | "stdin" | "input" | "storage" | "workflow-store" | "handle" | "close" | "stdout";

/** Bounded diagnostics only: stable reason codes and error metadata, never session IDs, inputs, SQL or paths. */
function reportContinuityFailure(phase: ContinuityHookPhase, cause: unknown): void {
  try {
    const isObject = Boolean(cause) && (typeof cause === "object" || typeof cause === "function");
    const storeError = isObject && !types.isProxy(cause) && cause instanceof ContinuityStoreError ? cause : null;
    // A workflow store failure keeps its own code and SQLite result code, distinct from a continuity store failure (D0057).
    const workflowError = isObject && !types.isProxy(cause) && cause instanceof WorkflowContractError ? cause : null;
    const sqliteErrcode = workflowError?.details?.sqliteErrcode;
    const reason = hookFailureReason(cause)
      ?? (storeError ? storeError.reason
        : workflowError ? `WORKFLOW_${workflowError.code}`
          // The shared classification keeps an OS, SQLite or JSON cause distinct instead of UNEXPECTED_FAILURE.
          : failureReason(cause).reason ?? "UNEXPECTED_FAILURE");
    console.error("[agent-governance-suite] continuity-hook-failure " + JSON.stringify({
      phase, reason, context: hookFailureContext(cause),
      ...(Number.isInteger(sqliteErrcode) ? { sqliteErrcode } : {}),
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
  let workflowFailure: string | null = null;
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
    const needsWorkflowState = normalized.action?.kind === "pre-compact"
      || normalized.action?.kind === "resume" || normalized.action?.kind === "compact"
      || normalized.action?.kind === "startup" || normalized.action?.kind === "fork" || normalized.action?.kind === "post-compact"
      || (normalized.observation.kind === "tool-boundary" && normalized.observation.boundaryPhase === "before"
        && localToolName(host, normalized.observation.toolName ?? "") !== null)
      // The edit gate reads whether the bound workflow is active; a failed open passes and is named at the next Stop.
      || isEditBoundary(normalized.observation)
      // The turn-end phase check reads the bound workflow's stages; a failed open reports and checks as unavailable.
      || isTurnEnd(normalized);
    if (needsWorkflowState) {
      try { workflow = new SqliteWorkflowStore(workflowDatabasePath); }
      catch (cause) {
        // Missing authority keeps roots bound; context remains optional and the cause visible.
        reportContinuityFailure("workflow-store", cause);
        workflow = null;
        workflowFailure = workflowFailureCode(cause);
      }
    }
    phase = "handle";
    const output = handleNormalizedContinuityHook(normalized, new ContinuityService(continuity, null, workflow, undefined, workflowFailure), host, environment);
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
