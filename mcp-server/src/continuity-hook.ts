import { isHookEntry } from "./hook-entry.js";
import { actorAccess, isObservedSubagent, type InputObservation } from "./input-observation.js";
import { WorkflowContractError } from "../../contracts/types.js";
import "./builtin-hook-host-adapters.js";
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { types } from "node:util";

import { ContinuityService, minimalWorkflowStartExample, renderHookText, subagentStartCue, workflowFailureCode } from "./continuity-service.js";
import { editExemptPaths } from "./admin-settings.js";
import { ContextLayerService } from "./context-layer-service.js";
import { ContextLayerStore } from "./context-layer-store.js";
import { ContinuityStoreError, SqliteContinuityStore } from "./continuity-store.js";
import { hookFailureContext, hookFailureReason, retainHookFailureSecondary, writeDiagnostic } from "./hook-error-diagnostics.js";
import { failureReason } from "./failure-diagnostics.js";
import { adaptHostInput, hostAgentNoteRoots, isGovernanceHookTool, resolveHookHost, turnEndContinuation, type AdaptedHostInput, type ContinuityAction, type ForkHostParentRead, type ForkOriginRead, type LineageRead } from "./host-input-adapter.js";
import {
  assertDistinctDatabasePaths,
  resolveContextLayerDatabasePath,
  resolveAdminPageUrl,
  resolveContinuityDatabasePath,
  resolveWorkflowDatabasePath,
} from "./runtime-config.js";
import { SqliteWorkflowStore } from "./sqlite-workflow-store.js";
import { msg, render, resolveHostLocale, type SupportedLocale } from "./i18n.js";
import { hostActorId } from "./host-attestation.js";

type HookInput = Record<string, unknown>;

const BOUND_TOOLS = new Set([
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context",
]);

const PROGRESS_TOOLS = new Set(["start_workflow", "start_guarded_workflow", "record_stage_result",
  "finalize_workflow", "abort_workflow", "release_convergence_root"]);

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
 * own note directories and the user's list: AGENT_GOVERNANCE_PHASE_EXEMPT_PATHS when set, else the list signed on the admin
 * page (verified on each read, admin-settings.ts). Never a tool input. The working directory is not a criterion.
 */
function exemptEditRoots(host: string, environment: NodeJS.ProcessEnv): string[][] {
  const configured = editExemptPaths(environment);
  return [...new Set([tmpdir(), ...hostAgentNoteRoots(host, environment), ...configured].flatMap(realOrSelf).map(normalizedEditPath))]
    .map(root => root.split(path.sep));
}

function isExemptEditPath(target: string, roots: readonly string[][]): boolean {
  const segments = target.split(path.sep);
  return roots.some(root => root.length <= segments.length && root.every((segment, index) => segment === "*" || segment === segments[index]));
}

/** A `.git` directory, or the `.git` file of a worktree or submodule, and the other version controls' roots. */
const VCS_MARKERS = [".git", ".hg", ".svn", ".jj"];

/**
 * A product file is under version control (design ags30-phase-check 7.3): notes, inquiry documents and reports outside
 * any checkout are not counted. Missing parents of a new file are walked past. A parent the hook cannot read counts the
 * file, so a read failure never opens the gate.
 */
export function underVersionControl(target: string): boolean {
  for (let directory = path.dirname(path.resolve(target)); ; directory = path.dirname(directory)) {
    try {
      if (VCS_MARKERS.some(marker => statSync(path.join(directory, marker), { throwIfNoEntry: false }))) return true;
    } catch {
      return true;
    }
    if (path.dirname(directory) === directory) return false;
  }
}

/**
 * The product files an edit will change; a tool whose target the adapter could not read still counts as one file.
 * `product` is keyed by the normalized path; the value is the path as the tool gave it (resolved), which the refusal
 * shows. `unversioned` holds the non-exempt paths outside version control: they are not counted (7.3), but a gated
 * root's write surface still covers them.
 */
function productEditTargets(observation: InputObservation, host: string, environment: NodeJS.ProcessEnv,
  locale: SupportedLocale): { product: Map<string, string>; unversioned: string[] } {
  const targets = observation.editTargets ?? [];
  // Each unread target is its own file: one shared key would let unread edits repeat without ever reaching the limit.
  const unread = (): [string, string] => {
    const unknown = render(msg("hooks.editGate.unknownPath", { tool: observation.toolName ?? "edit" }), locale);
    return [`${unknown}#${observation.callId ?? randomUUID()}`, unknown];
  };
  if (targets.length === 0) return { product: new Map([unread()]), unversioned: [] };
  const roots = exemptEditRoots(host, environment);
  const product = new Map<string, string>();
  const unversioned = new Map<string, string>();
  for (const target of targets) {
    const key = normalizedEditPath(target);
    if (product.has(key) || unversioned.has(key) || isExemptEditPath(key, roots)) continue;
    (underVersionControl(target) ? product : unversioned).set(key, path.resolve(target));
  }
  if (observation.editTargetsIncomplete) product.set(...unread());
  return { product, unversioned: [...unversioned.values()] };
}

function deniedEdit(reason: string): Record<string, unknown> {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
}

function localToolName(host: string, canonicalName: string, tools: ReadonlySet<string> = BOUND_TOOLS): string | null {
  if (!isGovernanceHookTool(host, canonicalName)) return null;
  const tool = canonicalName.includes("__") ? canonicalName.split("__").at(-1)! : canonicalName;
  return tools.has(tool) ? tool : null;
}

interface NormalizedContinuityInput {
  observation: InputObservation;
  lifecycle: AdaptedHostInput["lifecycle"];
  outputEventName: string;
  action: ContinuityAction | undefined;
  restoreCurrentAtTurnStart: boolean;
  readLineage: (() => LineageRead) | undefined;
  readForkOrigin: (() => ForkOriginRead) | undefined;
  readForkHostParent: (() => ForkHostParentRead) | undefined;
}

function continuityConflict(): never {
  throw new WorkflowContractError("BINDING_INVALID", msg("continuity.hook.observationConflict", {}), {
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
  return { observation, lifecycle, outputEventName, action, restoreCurrentAtTurnStart: adapted.restoreCurrentAtTurnStart === true, readLineage: typeof readLineage === "function" ? readLineage : undefined,
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

/** The adapter names the form its host's turn-end hook continues a turn with (decision/reason or context). */
function stopOutput(host: string, eventName: string, cue: string | null): Record<string, unknown> {
  return cue ? turnEndContinuation(host, eventName, cue) : {};
}

/** A file edit before it runs: the workflow gate (design ags30-phase-check 7.2). Exempt-only edits are not recorded. */
function gateEdit(observation: InputObservation, service: ContinuityService, host: string, environment: NodeJS.ProcessEnv,
  locale: SupportedLocale, actor: string | null = null): Record<string, unknown> {
  const { product: targets, unversioned } = productEditTargets(observation, host, environment, locale);
  if (targets.size === 0 && unversioned.length === 0) return {};
  const refusal = service.gateEditForSession(observation.sessionId, [...targets.keys()], [...targets.values()],
    minimalWorkflowStartExample(locale), unversioned, actor);
  return refusal ? deniedEdit(render(refusal, locale)) : {};
}

/** A subagent's start: the host adds this context before the subagent's first prompt. It reads no continuity state. */
function isSubagentStart(input: NormalizedContinuityInput): boolean {
  return input.observation.kind === "subagent-start" && input.lifecycle === "none" && input.action === undefined;
}

function subagentStartOutput(input: NormalizedContinuityInput, locale: SupportedLocale): Record<string, unknown> {
  return sessionOutput(input.outputEventName, renderHookText(subagentStartCue(), locale));
}

function isEditBoundary(observation: InputObservation): boolean {
  return observation.kind === "tool-boundary" && observation.boundaryPhase === "before" && observation.editTargets !== undefined;
}

function handleNormalizedContinuityHook(input: NormalizedContinuityInput, service: ContinuityService, host: string,
  environment: NodeJS.ProcessEnv, locale: SupportedLocale): Record<string, unknown> {
  const { observation, action, outputEventName, readLineage, readForkOrigin, readForkHostParent } = input;
  // Every host adapter that observes a subagent start maps it here; the cue does not depend on the host or the session.
  if (isSubagentStart(input)) return subagentStartOutput(input, locale);
  const sessionId = observation.sessionId;
  if (!sessionId) return {};
  // A subagent's hooks name its parent in session_id and itself in agentKey. Its edits are gated in the session and
  // arm only its own phase check, which runs at its own turn end (Claude Code and Codex SubagentStop) over the
  // workflows it started: never at the parent's Stop (AGS3-D-0060, AGS3-D-0061). Nothing else a child does pins or
  // binds continuity.
  if (isObservedSubagent(observation)) {
    // Every adapter that observes a child sets its agentKey; the fallback still keeps the edit off the parent's window.
    const actor = hostActorId(host, sessionId, observation.agentKey ?? "unidentified-child");
    if (isEditBoundary(observation)) return gateEdit(observation, service, host, environment, locale, actor);
    return isTurnEnd(input) ? stopOutput(host, outputEventName,
      renderHookText(service.phaseCheckForSession(sessionId, observation.stopHookActive === true, actor), locale)) : {};
  }
  if (!actorAccess(observation.actor).allowed) return {};
  switch (action?.kind) {
    case "startup": service.ensureSession(sessionId); return {};
    case "fork": service.startFork(sessionId, readForkOrigin, readForkHostParent); return {};
    case "clear": service.clearSession(sessionId); return {};
    case "resume": return sessionOutput(outputEventName, renderHookText(
      service.restoreCurrentForSession(sessionId) ?? service.formatCandidate(service.candidateForSession(sessionId)), locale));
    case "compact":
      if (readLineage) service.reanchorAfterCompact(sessionId, readLineage);
      return sessionOutput(outputEventName, renderHookText(service.compactContext(sessionId), locale));
    case "pre-compact": service.markPreCompact(sessionId); return {};
    case "post-compact":
      service.recordPostCompact(sessionId, action.turnId, action.successful);
      if (readLineage) service.reanchorAfterCompact(sessionId, readLineage);
      return {};
  }
  // Pin a fork's parent before the model can change its own file; the cue contains no snapshot body.
  if (observation.kind === "user-input") {
    if (readLineage) service.pinForkParent(sessionId, readLineage, false);
    if (observation.wakeOnly) return {};
    const restored = input.restoreCurrentAtTurnStart ? service.restoreCurrentForSession(sessionId) : null;
    const cue = service.checkpointCueForSession(sessionId);
    return sessionOutput(outputEventName, renderHookText([...(restored ?? []), ...(cue ?? [])], locale));
  }
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "after") {
    if (!localToolName(host, observation.toolName ?? "", PROGRESS_TOOLS)) return {};
    return sessionOutput(outputEventName, renderHookText(
      service.checkpointCueAfterProgressForSession(sessionId, observation.callId ?? null), locale));
  }
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before") {
    // A host that deferred its host-process read at the fork start reads it here, before any pin below.
    if (readForkHostParent) service.readDeferredForkHostParent(sessionId, readForkHostParent);
    const toolName = localToolName(host, observation.toolName ?? "");
    if (!toolName) {
      // Write-capable host tools and every non-AGS MCP tool reach this boundary before they run: the last point the
      // fork's file is the host's. AGS tools pin through their own binding below.
      if (readLineage) service.pinForkParent(sessionId, readLineage);
      return isEditBoundary(observation) ? gateEdit(observation, service, host, environment, locale) : {};
    }
    // AGS tools pin and bind on the server from the verified caller; the hook only did the host-process read above.
    return {};
  }
  // A turn the host already continued through its Stop hook is checked without a second continuation.
  if (isTurnEnd(input)) {
    return stopOutput(host, outputEventName, renderHookText(service.phaseCheckForSession(sessionId, observation.stopHookActive === true), locale));
  }
  return {};
}

/** The host locale is read once per hook call (docs/contributing/i18n.md 4.1 ①); a test may pin it. */
export function handleContinuityHook(input: HookInput, service: ContinuityService, host = "codex",
  environment: NodeJS.ProcessEnv = process.env, locale: SupportedLocale = resolveHostLocale({ environment }).locale): Record<string, unknown> {
  return handleNormalizedContinuityHook(normalizedContinuityInput(adaptHostInput(input, host)), service, host, environment, locale);
}

type ContinuityHookPhase = "host-entry" | "stdin" | "input" | "storage" | "workflow-store" | "handle" | "close" | "stdout"
  | "context-layers" | "subagent-situation";

const CONTEXT_START_ACTIONS: ReadonlySet<string> = new Set(["startup", "fork", "clear", "resume", "compact"]);

/**
 * The actor a boundary belongs to, keyed by the same hostActorId the server and the phase checks use. `own`: the
 * session's own actor, which saves and restores the session's situational context itself.
 */
function boundaryActor(input: NormalizedContinuityInput, host: string): { sessionId: string; actorId: string; own: boolean } | null {
  const { observation } = input;
  const sessionId = observation.sessionId;
  if (!sessionId) return null;
  const child = isSubagentStart(input) || isObservedSubagent(observation);
  if (!child && !actorAccess(observation.actor).allowed) return null;
  return { sessionId, actorId: hostActorId(host, sessionId, child ? observation.agentKey ?? "unidentified-child" : null), own: !child };
}

/**
 * Which actor gets the shared context layers at this boundary, and whether in full (a context start: session start,
 * resume, compaction, a subagent's start, or a turn start the adapter marks as a context start) or only the layers that
 * changed since that actor last received them (a later user prompt, the boundary after an AGS progress tool, or the
 * step boundary the adapter marks; a subagent gets these two too). A subagent whose hooks learn their root session only
 * mid-turn gets its layers at the first step after that.
 */
function contextLayerTarget(input: NormalizedContinuityInput, host: string): { sessionId: string; actorId: string; full: boolean } | null {
  const { observation, action } = input;
  const actor = boundaryActor(input, host);
  if (!actor) return null;
  const { sessionId, actorId, own } = actor;
  if (isSubagentStart(input)) return { sessionId, actorId, full: true };
  if (own && action && CONTEXT_START_ACTIONS.has(action.kind)) return { sessionId, actorId, full: true };
  if (own && observation.kind === "user-input" && !observation.wakeOnly) return { sessionId, actorId, full: input.restoreCurrentAtTurnStart };
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "after" && localToolName(host, observation.toolName ?? "", PROGRESS_TOOLS)) {
    return { sessionId, actorId, full: false };
  }
  if (observation.step === true) return { sessionId, actorId, full: false };
  return null;
}

/** The shared layers for this boundary; a missing shared file gives none, and a failure is reported, never thrown. */
function contextLayerText(input: NormalizedContinuityInput, host: string, environment: NodeJS.ProcessEnv, locale: SupportedLocale): string | null {
  try {
    const target = contextLayerTarget(input, host);
    if (!target) return null;
    const databasePath = resolveContextLayerDatabasePath(environment);
    let adminUrl: string | null = null;
    try { adminUrl = resolveAdminPageUrl(environment); } catch { adminUrl = null; }
    const service = new ContextLayerService(create => ContextLayerStore.open(databasePath, create), undefined, adminUrl);
    return renderHookText(service.hookText(host, target.sessionId, target.actorId, target.full), locale);
  } catch (cause) {
    reportContinuityFailure("context-layers", cause);
    return null;
  }
}

/** Appends hook text to an output that adds context (or has none yet); deny and turn-continuation outputs stay as they are. */
function withAddedContext(output: Record<string, unknown>, eventName: string, text: string | null): Record<string, unknown> {
  if (!text) return output;
  if (Object.keys(output).length === 0) return sessionOutput(eventName, text);
  const specific = output.hookSpecificOutput as { additionalContext?: unknown; permissionDecision?: unknown } | undefined;
  if (!specific || specific.permissionDecision !== undefined || (specific.additionalContext !== undefined && typeof specific.additionalContext !== "string")) return output;
  return { ...output, hookSpecificOutput: { ...specific, additionalContext: specific.additionalContext ? `${specific.additionalContext}\n\n${text}` : text } };
}

/**
 * The session's situational context for an actor other than the session's own, at its start or a later step, once per
 * state token (AGS3-D-0065). Read best-effort: a failure is reported and takes only this text away.
 */
function situationText(input: NormalizedContinuityInput, host: string, store: SqliteContinuityStore, locale: SupportedLocale): string | null {
  try {
    const actor = boundaryActor(input, host);
    if (!actor || actor.own || !(isSubagentStart(input) || input.observation.step === true)) return null;
    return renderHookText(new ContinuityService(store, null).situationForActor(actor.sessionId, actor.actorId), locale);
  } catch (cause) {
    reportContinuityFailure("subagent-situation", cause);
    return null;
  }
}

/** The subagent start path opens the continuity store only for its situational context. */
function subagentSituation(input: NormalizedContinuityInput, host: string, environment: NodeJS.ProcessEnv, locale: SupportedLocale): string | null {
  let store: SqliteContinuityStore | null = null;
  try {
    const workflowDatabasePath = resolveWorkflowDatabasePath(environment);
    const continuityDatabasePath = resolveContinuityDatabasePath(environment);
    assertDistinctDatabasePaths(workflowDatabasePath, continuityDatabasePath);
    store = new SqliteContinuityStore(continuityDatabasePath);
    return situationText(input, host, store, locale);
  } catch (cause) {
    reportContinuityFailure("subagent-situation", cause);
    return null;
  } finally {
    try { store?.close(); } catch (cause) { reportContinuityFailure("close", cause); }
  }
}

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
    writeDiagnostic("continuity-hook", "continuity-hook-failure", {
      phase, reason, context: hookFailureContext(cause),
      ...(Number.isInteger(sqliteErrcode) ? { sqliteErrcode } : {}),
      ...(storeError && storeError.causeValue !== undefined ? { storeCause: hookFailureContext(storeError.causeValue) } : {}),
    });
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
  let normalizedInput: NormalizedContinuityInput | null = null;
  try {
    const input = JSON.parse(raw) as HookInput;
    const normalized = normalizedContinuityInput(adaptHostInput(input, host));
    normalizedInput = normalized;
    if (isSubagentStart(normalized)) {
      // The cue reads no state; the shared layers and the session's situational context are read best-effort, so a
      // storage failure takes only them away, never the cue.
      phase = "handle";
      const locale = resolveHostLocale({ environment }).locale;
      const added = [contextLayerText(normalized, host, environment, locale), subagentSituation(normalized, host, environment, locale)]
        .filter((text): text is string => Boolean(text)).join("\n\n");
      result = JSON.stringify(withAddedContext(subagentStartOutput(normalized, locale), normalized.outputEventName, added || null));
      return result;
    }
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
    const locale = resolveHostLocale({ environment }).locale;
    const handled = handleNormalizedContinuityHook(normalized, new ContinuityService(continuity, null, workflow, undefined, workflowFailure), host, environment,
      locale);
    const added = [contextLayerText(normalized, host, environment, locale), situationText(normalized, host, continuity, locale)]
      .filter((text): text is string => Boolean(text)).join("\n\n");
    const output = withAddedContext(handled, normalized.outputEventName, added || null);
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
  // The shared layers do not live in the continuity store: its failure (reported above) takes only its own context.
  if (failed && normalizedInput) {
    const output = withAddedContext({}, normalizedInput.outputEventName,
      contextLayerText(normalizedInput, host, environment, resolveHostLocale({ environment }).locale));
    if (Object.keys(output).length > 0) return JSON.stringify(output);
  }
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
