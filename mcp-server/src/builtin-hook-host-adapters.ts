import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { hookFailure, retainHookFailureCause, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { registerHookHostAdapter, type HookHostAdapter, type HostDeliveryProfile, type NativePeerWaitObservation, type HookSettingsDiagnostic, type AdaptedHostInput, type HostLifecycle } from "./host-input-adapter.js";
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

function actorObservation(input: Record<string, unknown>, host: string): InputObservation["actor"] {
  if (!Object.hasOwn(input, "agent_id")) return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  if (typeof input.agent_id !== "string") return { kind: "unknown", observedBy: `${host}:hook-payload`, assurance: "unknown" };
  return {
    kind: text(input.agent_id) ? "subagent" : "main",
    observedBy: `${host}:hook-payload`,
    assurance: "observed",
  };
}

/** Keeps vendor event names and actor fields at the host adapter boundary. */
function adaptBuiltinHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const event = text(input.hook_event_name);
  let kind: InputObservationKind = "unknown";
  let lifecycle: HostLifecycle = "none";
  let boundaryPhase: "before" | "after" | undefined;
  if (event === "SessionStart") lifecycle = "start";
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

  const wake = kind === "user-input" ? parseWakeMessages(input.prompt) : { nonces: [], wakeOnly: false };
  const workspaceId = text(input.workspace_id) || text(input.cwd);
  const collaborationId = text(input.collaboration_id);
  const role = text(input.role);
  return {
    lifecycle,
    outputEventName: event,
    observation: {
      host,
      sessionId: text(input.session_id),
      kind,
      actor: actorObservation(input, host),
      ...(boundaryPhase === undefined ? {} : { boundaryPhase }),
      ...(kind === "tool-boundary" ? { toolName: text(input.tool_name), toolInput: record(input.tool_input) } : {}),
      ...(kind === "user-input" ? { wakeCandidates: wake.nonces, wakeOnly: wake.wakeOnly } : {}),
      ...(workspaceId ? { workspaceId } : {}),
      ...(collaborationId ? { collaborationId } : {}),
      ...(role ? { role } : {}),
    },
  };
}

/** Codex 0.163 dispatches these lifecycle events only for root threads. Its
 * native wire schema omits actor fields; the registered strategy owns that fact.
 * Other events still need their own actor evidence. */
function adaptCodexHookInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapted = adaptBuiltinHookInput(input, host);
  if (adapted.lifecycle === "none") return adapted;
  if (Object.hasOwn(input, "agent_type")) {
    adapted.observation.actor = { kind: "unknown", observedBy: `${host}:root-lifecycle-conflict`, assurance: "unknown" };
  } else if (!Object.hasOwn(input, "agent_id")) {
    adapted.observation.actor = { kind: "main", observedBy: `${host}:native-root-lifecycle`, assurance: "observed" };
  }
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

function queueEnabled(host: string, explicit: string | undefined, environment: NodeJS.ProcessEnv,
  diagnose: (reason: string, observation?: unknown) => void, defaultEnabled = false): boolean {
  const disabled = (reason: string, observation?: HookSettingsDiagnostic) => {
    if (observation) diagnose(reason, Object.freeze(observation)); else diagnose(reason);
    return false;
  };
  const failed = (phase: "directory-stat" | "open" | "read" | "close", cause: unknown) => retainHookFailureCause(
    hookFailure(phase === "directory-stat" ? "QUEUE_SETTINGS_DIRECTORY_STAT_FAILED" : phase === "open" ? "QUEUE_SETTINGS_OPEN_FAILED" : phase === "read" ? "QUEUE_SETTINGS_READ_FAILED" : "QUEUE_SETTINGS_CLOSE_FAILED",
      "Queue settings I/O failed."), cause);
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

function codexQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: unknown) => void): boolean {
  return queueEnabled("codex", environment.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE, environment, diagnose);
}

function geminiQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: unknown) => void, defaultQueueWake?: boolean): boolean {
  // Adapter-owned defaults are settings provenance, never actor, liveness or execution authority.
  const defaultEnabled = defaultQueueWake === true || Boolean(environment.ANTIGRAVITY_AGENTAPI_EXE
    || environment.ANTIGRAVITY_CONVERSATION_ID || environment.ANTIGRAVITY_AGENT);
  return queueEnabled("gemini", environment.AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE, environment, diagnose, defaultEnabled);
}

// Builtin wiring belongs to this composition module; core registration has no vendor list.
const builtinHookHostAdapters = new Map<string, Readonly<HookHostAdapter>>([
  ["codex", {
    adaptInput: adaptCodexHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", true),
    processPid: (pid) => pid, attestationKind: "codex-rollout", peerWait: codexNativePeerWait,
  }],
  ["claude-code", {
    adaptInput: adaptBuiltinHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: () => deliveryProfile("claude-inbox", false),
    processPid: () => process.ppid, attestationKind: "claude-hook",
  }],
  ["gemini", {
    adaptInput: adaptBuiltinHookInput, ownsTool: ownsGovernanceTool,
    deliveryProfile: (environment, diagnose, defaultQueueWake) => deliveryProfile(geminiQueueEnabled(environment, diagnose, defaultQueueWake) ? "gemini-queue" : "codex-deferred", false),
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
