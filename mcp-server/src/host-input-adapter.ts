import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { parseWakeMessages } from "./session-message-client.js";
import { normalizePeerWaitTargets } from "./peer-wait-policy.js";
import type { DeliveryCapabilities, InputObservation, InputObservationKind } from "./input-observation.js";
import { transportDeliveryCapabilities, type SessionMessageTransport } from "./session-message-relay.js";

export type SupportedHookHost = "codex" | "claude-code";
export type HostLifecycle = "start" | "end" | "none";

export interface AdaptedHostInput {
  observation: InputObservation;
  lifecycle: HostLifecycle;
  outputEventName: string;
}

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
export function adaptHostInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
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

function codexQueueEnabled(environment: NodeJS.ProcessEnv, diagnose: (reason: string) => void): boolean {
  const disabled = (reason: string) => { diagnose(reason); return false; };
  const explicit = environment.AGENT_GOVERNANCE_CODEX_QUEUE_WAKE;
  if (explicit !== undefined) {
    if (explicit === "1") return true;
    return explicit === "0" ? false : disabled("invalid-environment");
  }
  const directory = environment.PLUGIN_DATA;
  if (directory === undefined) return false;
  // Windows root-relative paths still depend on the current drive.
  if (!path.isAbsolute(directory) || (process.platform === "win32" && ["\\", "/"].includes(path.parse(directory).root))) {
    return disabled("invalid-plugin-data");
  }
  try {
    if (!statSync(directory).isDirectory()) return disabled("invalid-plugin-data");
    const descriptor = openSync(path.join(directory, "session-messaging.json"), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(descriptor);
      if (!stat.isFile()) return disabled("invalid-file-type");
      if (stat.size > 4096) return disabled("too-large");
      // One extra byte detects growth after fstat; short reads cannot bypass the limit.
      const bytes = Buffer.alloc(4097);
      let length = 0;
      while (length < bytes.length) {
        const count = readSync(descriptor, bytes, length, bytes.length - length, null);
        if (count === 0) break;
        length += count;
      }
      if (length > 4096) return disabled("too-large");
      let settings: Record<string, unknown>;
      try { settings = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))); }
      catch { return disabled("invalid-settings"); }
      const codex = record(settings.codex);
      if (settings.schemaVersion !== "1.0.0" || typeof codex.queueWake !== "boolean") return disabled("invalid-settings");
      return codex.queueWake;
    } finally { closeSync(descriptor); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : disabled("read-failed");
  }
}

export interface HostDeliveryProfile {
  transport: SessionMessageTransport;
  capabilities: DeliveryCapabilities;
  /** The host's prompt hook can stop a wake-only prompt before a model request (a verified empty or retired wake). */
  blocksEmptyWakePrompt: boolean;
}

export function hostDeliveryProfile(host: SupportedHookHost, environment: NodeJS.ProcessEnv = process.env,
  diagnose: (reason: string) => void = (reason) => { console.error(`[agent-governance-suite] Codex queue settings: ${reason}; using codex-deferred.`); }): HostDeliveryProfile {
  const transport: SessionMessageTransport = host === "claude-code"
    ? "claude-inbox"
    : codexQueueEnabled(environment, diagnose) ? "codex-queue" : "codex-deferred";
  return { transport, capabilities: transportDeliveryCapabilities(transport), blocksEmptyWakePrompt: host === "codex" };
}

/** Only the observed, local Codex app wait surface is recognized here. */
export function nativePeerWait(observation: InputObservation): { targets: Array<{ host: string; sessionId: string }>; timeoutMs: number; queryRevision: string } | null {
  if (observation.host !== "codex" || observation.toolName !== "mcp__codex_app__wait_threads") return null;
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
