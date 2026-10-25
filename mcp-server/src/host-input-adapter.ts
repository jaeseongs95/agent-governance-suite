import { types as utilTypes } from "node:util";
import { hookFailure, hookFailureContext, hookFailureReason } from "./hook-error-diagnostics.js";
import { parseWakeMessages } from "./session-message-client.js";
import type { DeliveryCapabilities, InputObservation, InputObservationKind } from "./input-observation.js";
import type { SessionMessageTransport } from "./session-message-relay.js";

const hostFailures = {
  selection: ["INVALID_HOOK_HOST_SELECTION", "Invalid or ambiguous hook host."],
  adapter: ["INVALID_HOOK_HOST_ADAPTER", "Invalid hook host adapter."],
  duplicate: ["HOOK_HOST_ADAPTER_DUPLICATE", "Hook host adapter is already registered."],
  unavailable: ["HOST_ADAPTER_UNAVAILABLE", "A host delivery adapter is required."],
} as const;
function hookHostFailure(kind: keyof typeof hostFailures): Error {
  const [reason, message] = hostFailures[kind];
  return hookFailure(reason, message);
}

/** Host identifiers are opaque; missing adapter capabilities are handled separately. */
export type SupportedHookHost = string;
export type HostLifecycle = "start" | "end" | "none";

/** Explicit CLI host selection; payloads and environment cannot change an entry point default. */
export function resolveHookHost(arguments_: readonly string[], fallback: SupportedHookHost): SupportedHookHost {
  const selected: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === "--host") selected.push(arguments_[++index] ?? "");
    else if (argument.startsWith("--host=")) selected.push(argument.slice(7));
  }
  if (selected.length === 0) return fallback;
  if (selected.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(selected[0]!)) throw hookHostFailure("selection");
  return selected[0]!;
}


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

export interface HostDeliveryProfile {
  transport: SessionMessageTransport;
  capabilities: DeliveryCapabilities;
  /** The host's prompt hook can stop a wake-only prompt before a model request (a verified empty or retired wake). */
  blocksEmptyWakePrompt: boolean;
}

export type NativePeerWaitObservation = { targets: Array<{ host: string; sessionId: string }>; timeoutMs: number; queryRevision: string };

/** Producer-owned diagnostic state. The common sink validates and displays it without inferring resource state. */
export interface HookSettingsDiagnostic {
  readonly phase: string;
  readonly cleanup: "not-acquired" | "closed" | "unknown";
  readonly failure: unknown;
}

export interface HookHostAdapter {
  /** Call-local setting default; adapters without a configurable queue default ignore it. */
  deliveryProfile(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: unknown) => void, defaultQueueWake?: boolean): HostDeliveryProfile;
  processPid(explicitHostPid?: number, hostProcess?: Readonly<{ pid: number; startToken: string }>): number | undefined;
  /** A configured observation strategy, never inferred from an opaque host name. */
  attestationKind?: "codex-rollout" | "claude-hook";
  peerWait?: (observation: InputObservation) => NativePeerWaitObservation | null;
}

// A host entry registers trusted adapter code in the same module namespace it consumes.
const hookHostAdapters = new Map<string, Readonly<HookHostAdapter>>();

export function registerHookHostAdapter(host: string, adapter: HookHostAdapter): void {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host)
    || !adapter || typeof adapter.deliveryProfile !== "function" || typeof adapter.processPid !== "function"
    || (adapter.attestationKind !== undefined && !["codex-rollout", "claude-hook"].includes(adapter.attestationKind))) throw hookHostFailure("adapter");
  if (hookHostAdapters.has(host)) throw hookHostFailure("duplicate");
  hookHostAdapters.set(host, Object.freeze({ ...adapter }));
}

export function hookAttestationKind(host: string): HookHostAdapter["attestationKind"] {
  return hookHostAdapters.get(host)?.attestationKind;
}

export function resolveHookProcessPid(host: string, explicitHostPid?: number, hostProcess?: Readonly<{ pid: number; startToken: string }>): number | undefined {
  const pid = hookHostAdapters.get(host)?.processPid(explicitHostPid, hostProcess);
  if (hostProcess && hostProcess.pid !== pid) return undefined;
  return pid;
}

export function hostDeliveryProfile(host: string, environment: NodeJS.ProcessEnv = process.env,
  diagnose: (reason: string, observation?: unknown) => void = (reason, observation) => {
    const prefix = `[agent-governance-suite] ${host} queue settings: ${reason}.`;
    let detail: Record<string, unknown> | null = null;
    try {
      if (observation && typeof observation === "object" && !utilTypes.isProxy(observation)) {
        const phase: unknown = Object.getOwnPropertyDescriptor(observation, "phase")?.value;
        const cleanup: unknown = Object.getOwnPropertyDescriptor(observation, "cleanup")?.value;
        const failure: unknown = Object.getOwnPropertyDescriptor(observation, "failure")?.value;
        const ownedReason = hookFailureReason(failure);
        if (ownedReason && typeof phase === "string" && /^[a-z][a-z0-9-]{0,63}$/u.test(phase)
          && (cleanup === "not-acquired" || cleanup === "closed" || cleanup === "unknown")) {
          detail = {phase, reason: ownedReason, cleanup, context: hookFailureContext(failure)};
        }
      }
    } catch { /* Opaque observations cannot supply producer diagnostics. */ }
    console.error(prefix + (detail ? " " + JSON.stringify(detail) : ""));
  }, defaultQueueWake = false): HostDeliveryProfile {
  const adapter = hookHostAdapters.get(host);
  if (!adapter) throw hookHostFailure("unavailable");
  return adapter.deliveryProfile(environment, diagnose, defaultQueueWake);
}

export function nativePeerWait(observation: InputObservation): NativePeerWaitObservation | null {
  return hookHostAdapters.get(observation.host)?.peerWait?.(observation) ?? null;
}
