import { createHash } from "node:crypto";
import { types as utilTypes } from "node:util";
import { hookFailure, retainHookFailureCause, retainHookFailureSecondary } from "./hook-error-diagnostics.js";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { registerHookHostAdapter, type HookHostAdapter, type HostDeliveryProfile, type NativePeerWaitObservation, type HookSettingsDiagnostic } from "./host-input-adapter.js";
import type { InputObservation } from "./input-observation.js";
import { normalizePeerWaitTargets } from "./peer-wait-policy.js";
import { transportDeliveryCapabilities, type SessionMessageTransport } from "./session-message-relay.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
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
    deliveryProfile: (environment, diagnose) => deliveryProfile(codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred", true),
    processPid: (pid) => pid, attestationKind: "codex-rollout", peerWait: codexNativePeerWait,
  }],
  ["claude-code", {
    deliveryProfile: () => deliveryProfile("claude-inbox", false),
    processPid: () => process.ppid, attestationKind: "claude-hook",
  }],
  ["gemini", {
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
