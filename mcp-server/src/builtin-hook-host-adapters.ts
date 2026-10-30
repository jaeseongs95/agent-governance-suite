import { createHash, randomUUID } from "node:crypto";
import { types as utilTypes } from "node:util";
import { hookFailure, retainHookFailureCause, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { registerHookHostAdapter, type HookHostAdapter, type HostDeliveryProfile, type NativePeerWaitObservation, type HookSettingsDiagnostic, type AdaptedHostInput, type HostLifecycle, type ContinuityAction } from "./host-input-adapter.js";
import { parseWakeMessages } from "./session-message-client.js";
import type { InputObservation, InputObservationKind } from "./input-observation.js";
import { normalizePeerWaitTargets } from "./peer-wait-policy.js";
import { transportDeliveryCapabilities, type SessionMessageTransport } from "./session-message-relay.js";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Keeps vendor event names and actor fields at the host adapter boundary. */
function adaptBuiltinHookInput(input: Record<string, unknown>, host: string, actor: InputObservation["actor"]): AdaptedHostInput {
  const event = text(input.hook_event_name);
  let kind: InputObservationKind = "unknown";
  let lifecycle: HostLifecycle = "none";
  let continuityAction: ContinuityAction | undefined;
  let boundaryPhase: "before" | "after" | undefined;
  if (event === "SessionStart") {
    lifecycle = "start";
    const source = input.source;
    if (source === "startup" || source === "clear" || source === "resume" || source === "compact") continuityAction = { kind: source };
  }
  else if (event === "SessionEnd") {
    kind = "turn-end";
    lifecycle = "end";
  } else if (event === "UserPromptSubmit") kind = "user-input";
  else if (event === "PreToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "before";
  } else if (event === "PostToolUse") {
    kind = "tool-boundary";
    boundaryPhase = "after";
  } else if (event === "Stop") kind = "turn-end";
  if (event === "PreCompact") continuityAction = { kind: "pre-compact" };
  else if (event === "PostCompact") {
    const turnId = input.turn_id, error = input.error;
    continuityAction = { kind: "post-compact", turnId: typeof turnId === "string" ? turnId : null, successful: error === undefined || error === null };
  }

  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const callId = text(input.tool_use_id).trim();
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    ...(continuityAction ? { continuityAction } : {}),
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor,
      ...(callId ? { callId } : {}),
      ...(boundaryPhase === undefined ? {} : { boundaryPhase }),
      ...(kind === "tool-boundary" ? { toolName: text(input.tool_name), toolInput: record(input.tool_input) } : {}),
      ...(kind === "user-input" ? { wakeCandidates: wake.nonces, wakeOnly: wake.wakeOnly } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(collaborationId ? { collaborationId } : {}),
      ...(role ? { role } : {}),
    },
  };
}

/** 3.0 fallback for marker-free recognized events. Host adapters reject supported child markers;
 * a child without such evidence can still inherit the parent session ID under the deferred gate. */
function adaptInferredRootHookInput(input: Record<string, unknown>, host: string, prefix: "CODEX" | "ANTIGRAVITY"): AdaptedHostInput {
  const actor: InputObservation["actor"] = {
    role: "indeterminate", basis: "unavailable", reasonCode: `${prefix}_NATIVE_EVENT_UNRECOGNIZED`,
  };
  const adapted = adaptBuiltinHookInput(input, host, actor);
  if (adapted.lifecycle === "none" && adapted.observation.kind === "unknown" && adapted.continuityAction === undefined) return adapted;
  if (!adapted.observation.sessionId.trim()) actor.reasonCode = `${prefix}_NATIVE_SESSION_ID_INVALID`;
  else Object.assign(actor, { role: "root", basis: "inferred", reasonCode: `${prefix}_ROOT_INFERRED_CHILD_GATE_DEFERRED` });
  return adapted;
}

function adaptCodexHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapted = adaptInferredRootHookInput(input, host, "CODEX");
  if (adapted.observation.actor.role !== "root" || !Object.hasOwn(input, "agent_id")) return adapted;
  // Codex's native subagent hook context serializes agent_id even though session_id names the parent.
  // Missing markers retain the 3.0 stopgap; a positive or malformed marker must never inherit it.
  adapted.observation.actor = typeof input.agent_id === "string" && input.agent_id.trim()
    ? { role: "child", basis: "observed", reasonCode: "CODEX_NATIVE_CHILD_AGENT_ID" }
    : { role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_AGENT_ID_INVALID" };
  return adapted;
}

/** Claude's supported native hook schema omits agent_id for root calls.
 * Absence supports inference only; an explicit empty or malformed ID never does. */
function adaptClaudeHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const actor: InputObservation["actor"] = {
    role: "indeterminate", basis: "unavailable", reasonCode: "CLAUDE_NATIVE_EVENT_UNRECOGNIZED",
  };
  const adapted = adaptBuiltinHookInput(input, host, actor);
  const knownEvent = adapted.lifecycle !== "none" || adapted.observation.kind !== "unknown" || adapted.continuityAction !== undefined;
  if (!knownEvent) return adapted;
  if (!adapted.observation.sessionId.trim()) actor.reasonCode = "CLAUDE_NATIVE_SESSION_ID_INVALID";
  else if (Object.hasOwn(input, "agent_type") && (typeof input.agent_type !== "string" || !input.agent_type.trim())) {
    actor.reasonCode = "CLAUDE_NATIVE_AGENT_TYPE_INVALID";
  } else if (Object.hasOwn(input, "agent_id")) {
    if (typeof input.agent_id !== "string" || !input.agent_id.trim()) actor.reasonCode = "CLAUDE_NATIVE_AGENT_ID_INVALID";
    else Object.assign(actor, { role: "child", basis: "observed", reasonCode: "CLAUDE_NATIVE_CHILD_AGENT_ID" });
  } else Object.assign(actor, { role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT" });
  return adapted;
}

function adaptGeminiHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  return adaptBuiltinHookInput(input, host, {
    role: "indeterminate", basis: "unavailable", reasonCode: "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED",
  });
}

/** ponytail: Antigravity PreToolUse carries no tool call ID (agy hooks.md), so each hook run
 * draws a random one to keep the root proof one-use. Bind the native ID once Antigravity sends one. */
function adaptAntigravityHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapted = adaptInferredRootHookInput(input, host, "ANTIGRAVITY");
  const { observation } = adapted;
  if (observation.kind === "tool-boundary" && observation.boundaryPhase === "before" && !observation.callId) observation.callId = randomUUID();
  return adapted;
}

const GOVERNANCE_TOOL_PREFIXES = new Set([
  "mcp__agent_governance_suite__", "mcp__agent-governance-suite__",
  "mcp__plugin_agent-governance-suite_agent-governance-suite__",
]);
function ownsGovernanceTool(toolName: string): boolean {
  const separator = toolName.lastIndexOf("__");
  return separator > 0 && GOVERNANCE_TOOL_PREFIXES.has(toolName.slice(0, separator + 2));
}

const queueSettingsFailureReasons = {
  "directory-stat": "QUEUE_SETTINGS_DIRECTORY_STAT_FAILED",
  open: "QUEUE_SETTINGS_OPEN_FAILED",
  read: "QUEUE_SETTINGS_READ_FAILED",
  close: "QUEUE_SETTINGS_CLOSE_FAILED",
} as const;

function queueEnabled(host: string, explicit: string | undefined, environment: NodeJS.ProcessEnv,
  diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void, defaultEnabled = false): boolean {
  const disabled = (reason: string, observation?: HookSettingsDiagnostic) => {
    if (observation) diagnose(reason, Object.freeze(observation)); else diagnose(reason);
    return false;
  };
  const failed = (phase: keyof typeof queueSettingsFailureReasons, cause: unknown) =>
    retainHookFailureCause(hookFailure(queueSettingsFailureReasons[phase], "Queue settings I/O failed."), cause);
  const absent = (error: unknown): boolean => {
    if (!error || typeof error !== "object" || utilTypes.isProxy(error)) return false;
    try { return Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT"; }
    catch { return false; }
  };
  if (explicit !== undefined) {
    if (explicit === "1") return true;
    return explicit === "0" ? false : disabled("invalid-environment");
  }
  const directory = environment.PLUGIN_DATA;
  if (directory === undefined) return defaultEnabled;
  // Windows root-relative paths still depend on the current drive.
  if (!path.isAbsolute(directory) || (process.platform === "win32" && ["\\", "/"].includes(path.parse(directory).root))) {
    return disabled("invalid-plugin-data");
  }
  let descriptor = -1;
  let validDirectory: boolean;
  let acquisitionPhase: "directory-stat" | "open" = "directory-stat";
  try {
    validDirectory = statSync(directory).isDirectory();
    if (validDirectory) {
      acquisitionPhase = "open";
      descriptor = openSync(path.join(directory, "session-messaging.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    }
  } catch (cause) {
    return absent(cause) ? defaultEnabled : disabled("read-failed", {phase: acquisitionPhase, cleanup: "not-acquired", failure: failed(acquisitionPhase, cause)});
  }
  // Diagnose validation outside the I/O catch: an observer failure is not an open failure.
  if (!validDirectory) return disabled("invalid-plugin-data");
  let enabled = false;
  let issue: string | undefined;
  let primary: Error | undefined;
  let primaryPhase: "read" | "close" = "read";
  let missingRead = false;
  let closeFailed = false;
  const rejected = (reason: string) => { issue = reason; return false; };
  try {
    enabled = (() => {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return rejected("invalid-file-type");
      if (stat.size > 4096) return rejected("too-large");
      // One extra byte detects growth after fstat; short reads cannot bypass the limit.
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) return rejected("too-large");
      let settings: Record<string, unknown>;
      try { settings = record(JSON.parse(new TextDecoder("utf-8", {fatal: true}).decode(bytes.subarray(0, length)))); }
      catch { return rejected("invalid-settings"); }
      const hostSettings = record(settings[host]);
      if (settings.schemaVersion !== "1.0.0" || typeof hostSettings.queueWake !== "boolean") return rejected("invalid-settings");
      return hostSettings.queueWake;
    })();
  } catch (cause) {
    missingRead = absent(cause);
    primary = failed("read", cause);
  } finally {
    // A throwing close has unknown completion. Never retry a possibly reused descriptor.
    try { closeSync(descriptor); }
    catch (cause) {
      closeFailed = true;
      const closeFailure = failed("close", cause);
      if (primary) retainHookFailureSecondary(primary, closeFailure);
      else { primary = closeFailure; primaryPhase = "close"; }
    }
  }
  // Preserve the legacy absence/default decision only when cleanup completed normally.
  if (missingRead && !closeFailed) return defaultEnabled;
  if (primary) return disabled(issue ?? (primaryPhase === "close" ? "close-failed" : "read-failed"),
    {phase: primaryPhase, cleanup: closeFailed ? "unknown" : "closed", failure: primary});
  return issue === undefined ? enabled : disabled(issue);
}

function codexQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void): boolean {
  return queueEnabled("codex", environment.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE, environment, diagnose);
}

function geminiQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: HookSettingsDiagnostic) => void, defaultQueueWake?: boolean): boolean {
  // Adapter-owned defaults are settings provenance, never actor, liveness or execution authority.
  const defaultEnabled = defaultQueueWake === true || Boolean(environment.ANTIGRAVITY_AGENTAPI_EXE
    || environment.ANTIGRAVITY_CONVERSATION_ID || environment.ANTIGRAVITY_AGENT);
  return queueEnabled("gemini", environment.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE, environment, diagnose, defaultEnabled);
}

// Builtin wiring belongs to this composition module; core registration has no vendor list.
const builtinHookHostAdapters = new Map<string, Readonly<HookHostAdapter>>([
  ["codex", {
    adaptInput: adaptCodexHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", false),
    processPid: (pid) => pid, attestationKind: "codex-rollout", peerWait: codexNativePeerWait,
    // Codex ignores updatedInput unless permissionDecision is "allow" (hooks output_parser, 0.164.0).
    rewriteDecision: "allow",
  }],
  ["claude-code", {
    adaptInput: adaptClaudeHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: () => deliveryProfile("claude-inbox", false),
    processPid: () => process.ppid, attestationKind: "claude-hook",
  }],
  ["gemini", {
    adaptInput: adaptGeminiHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(geminiQueueEnabled(environment, diagnose, defaultQueueWake) ? "gemini-queue" : "gemini-deferred", false),
    processPid: (pid, observation) => observation ? pid : undefined,
  }],
  ["antigravity", {
    adaptInput: adaptAntigravityHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(geminiQueueEnabled(environment, diagnose, defaultQueueWake) ? "gemini-queue" : "gemini-deferred", false),
    processPid: (pid, observation) => observation ? pid : undefined,
  }],
]);

function deliveryProfile(transport: SessionMessageTransport, blocksEmptyWakePrompt: boolean): HostDeliveryProfile {
  return { transport, capabilities: transportDeliveryCapabilities(transport), blocksEmptyWakePrompt };
}

/** Only the observed, local Codex app wait surface is recognized here. */
function codexNativePeerWait(observation: InputObservation): NativePeerWaitObservation | null {
  if (observation.toolName !== "mcp__codex_app__wait_threads") return null;
  const input = observation.toolInput ?? {};
  const timeoutMs = input.timeoutMs === undefined ? 120_000 : input.timeoutMs;
  if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 3_600_000) return null;
  if (!Array.isArray(input.targets) || input.targets.length < 1 || input.targets.length > 8) return null;
  const targets: Array<{ host: string; sessionId: string }> = [];
  const cursors = new Set<string>();
  for (const value of input.targets) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const target = value as Record<string, unknown>;
    if (typeof target.threadId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.threadId)) return null;
    if (target.hostId !== undefined && target.hostId !== "local") return null;
    if (target.afterCursor !== undefined && typeof target.afterCursor !== "string") return null;
    targets.push({ host: "codex", sessionId: target.threadId });
    // Keep every distinct cursor for an identity; conflicting cursors are not collapsed.
    cursors.add(JSON.stringify([target.threadId, target.afterCursor ?? null]));
  }
  return { targets: normalizePeerWaitTargets(targets), timeoutMs,
    queryRevision: createHash("sha256").update(JSON.stringify([...cursors].sort())).digest("hex") };
}

// Static composition executes once per bundled module instance.
for (const [host, adapter] of builtinHookHostAdapters) registerHookHostAdapter(host, adapter);
