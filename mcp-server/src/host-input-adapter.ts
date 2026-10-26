import { AsyncLocalStorage } from "node:async_hooks";
import { WorkflowContractError } from "../../contracts/types.js";
import { types as utilTypes } from "node:util";
import { hookFailure, hookFailureContext, hookFailureReason } from "./hook-error-diagnostics.js";
import { actorAccess, type DeliveryCapabilities, type InputObservation } from "./input-observation.js";
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

/** Adapter-owned continuity semantics; common hooks never decode native lifecycle labels. */
export type ContinuityAction =
  | Readonly<{ kind: "startup" | "clear" | "resume" | "compact" | "pre-compact" }>
  | Readonly<{ kind: "post-compact"; turnId: string | null; successful: boolean }>;

/** Explicit CLI host selection; payloads and environment cannot change an entry point default. */
export function resolveHookHost(arguments_: readonly string[], fallback?: SupportedHookHost): SupportedHookHost {
  const selected: string[] = [];
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]!;
    if (argument === "--host") selected.push(arguments_[++index] ?? "");
    else if (argument.startsWith("--host=")) selected.push(argument.slice(7));
  }
  if (selected.length === 0) {
    if (fallback !== undefined) return fallback;
    throw hookHostFailure("selection");
  }
  if (selected.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(selected[0]!)) throw hookHostFailure("selection");
  return selected[0]!;
}


export interface AdaptedHostInput {
  observation: InputObservation;
  lifecycle: HostLifecycle;
  outputEventName: string;
  continuityAction?: ContinuityAction;
}

/** No host payload schema or actor convention is assumed by the common hook layer. */
export function adaptHostInput(input: Record<string, unknown>, host: string): AdaptedHostInput {
  const adapter = selectedHookHostAdapter(host);
  if (!adapter) throw hookHostFailure("unavailable");
  const call = callHostAdapter.getStore();
  if (call?.adapted) {
    // Only the core supplies this own canonical record after the one host-schema translation.
    const toolInput: unknown = Object.getOwnPropertyDescriptor(input, "tool_input")?.value;
    if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) {
      throw new WorkflowContractError("BINDING_REQUIRED", "Canonical hook arguments unavailable.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
    }
    return { ...call.adapted, observation: { ...call.adapted.observation, toolInput: toolInput as Record<string, unknown> } };
  }
  const adapted = adapter.adaptInput?.(input, host) ?? {
    lifecycle: "none", outputEventName: "",
    observation: { host, sessionId: "", kind: "unknown",
      actor: { role: "indeterminate", basis: "unavailable", reasonCode: "HOST_ACTOR_OBSERVATION_UNAVAILABLE" } },
  } satisfies AdaptedHostInput;
  if (!call) return adapted;
  const { observation: sourceObservation, ...snapshot } = adapted;
  const observation = { ...sourceObservation };
  if (observation.host !== host) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Host observation differs from its selected composition.", { reasonCode: "HOST_HOOK_OBSERVATION_MISMATCH" });
  }
  const actor = observation.actor;
  // Never turn rejected getter/proxy actor fields into accepted plain data while snapshotting.
  const snapshotActor = actorAccess(actor).allowed
    ? Object.freeze({ role: actor.role, basis: actor.basis, reasonCode: actor.reasonCode }) : actor;
  call.adapted = Object.freeze({ ...snapshot, observation: Object.freeze({ ...observation, actor: snapshotActor }) });
  return call.adapted;
}

/** Tool ownership is configured at the adapter boundary, never inferred from a local suffix. */
export function isGovernanceHookTool(host: string, toolName: string): boolean {
  return selectedHookHostAdapter(host)?.ownsTool?.(toolName) === true;
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
  /** Explicit input schema and actor observation strategy. Missing strategies issue no identity. */
  adaptInput?: (input: Record<string, unknown>, host: string) => AdaptedHostInput;
  /** Exact namespaces owned by this plugin in the host tool surface. */
  ownsTool?: (toolName: string) => boolean;
  /** Call-local setting default; adapters without a configurable queue default ignore it. */
  deliveryProfile(environment: NodeJS.ProcessEnv, diagnose: (reason: string, observation?: unknown) => void, defaultQueueWake?: boolean): HostDeliveryProfile;
  processPid(explicitHostPid?: number, hostProcess?: Readonly<{ pid: number; startToken: string }>): number | undefined;
  /** Opaque trusted strategy identifier; the attestation entry owns registration and dispatch. */
  attestationKind?: string;
  peerWait?: (observation: InputObservation) => NativePeerWaitObservation | null;
}

// A host entry registers trusted adapter code in the same module namespace it consumes.
const hookHostAdapters = new Map<string, Readonly<HookHostAdapter>>();

export function registerHookHostAdapter(host: string, adapter: HookHostAdapter): void {
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host)
    || !adapter || typeof adapter.deliveryProfile !== "function" || typeof adapter.processPid !== "function"
    || (adapter.adaptInput !== undefined && typeof adapter.adaptInput !== "function")
    || (adapter.ownsTool !== undefined && typeof adapter.ownsTool !== "function")
    || (adapter.attestationKind !== undefined && (typeof adapter.attestationKind !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(adapter.attestationKind)))) throw hookHostFailure("adapter");
  if (hookHostAdapters.has(host)) throw hookHostFailure("duplicate");
  hookHostAdapters.set(host, Object.freeze({ ...adapter }));
}

function snapshotHookHostAdapter(host: string, adapter: HookHostAdapter): Readonly<HookHostAdapter> {
  const { adaptInput, ownsTool, deliveryProfile, processPid, attestationKind, peerWait } = adapter ?? {};
  if (typeof host !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(host)
    || typeof deliveryProfile !== "function" || typeof processPid !== "function"
    || (adaptInput !== undefined && typeof adaptInput !== "function")
    || (ownsTool !== undefined && typeof ownsTool !== "function")
    || (peerWait !== undefined && typeof peerWait !== "function")
    || (attestationKind !== undefined && (typeof attestationKind !== "string"
      || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(attestationKind)))) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Host hook composition unavailable.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
  }
  // Freeze selection, not producer state; prototype/private-state methods retain their original receiver.
  return Object.freeze({ deliveryProfile: deliveryProfile.bind(adapter), processPid: processPid.bind(adapter),
    ...(adaptInput ? { adaptInput: adaptInput.bind(adapter) } : {}), ...(ownsTool ? { ownsTool: ownsTool.bind(adapter) } : {}),
    ...(attestationKind === undefined ? {} : { attestationKind }), ...(peerWait ? { peerWait: peerWait.bind(adapter) } : {}) });
}

const callHostAdapter = new AsyncLocalStorage<{ host: string; adapter: Readonly<HookHostAdapter>; active: boolean; adapted?: AdaptedHostInput }>();

function selectedHookHostAdapter(host: string): Readonly<HookHostAdapter> | undefined {
  const call = callHostAdapter.getStore();
  if (!call) return hookHostAdapters.get(host);
  if (!call.active || call.host !== host) {
    throw new WorkflowContractError("BINDING_REQUIRED", "Host hook composition is inactive or has a different host.", { reasonCode: "HOST_HOOK_COMPOSITION_UNAVAILABLE" });
  }
  return call.adapter;
}

/** One governance call/event only; nested domain hooks reuse its translation and cleaned canonical arguments. */
export async function withHookHostAdapter<T>(host: string, adapter: HookHostAdapter,
  run: (snapshot: Readonly<HookHostAdapter>) => Promise<T>): Promise<T> {
  const call = { host, adapter: snapshotHookHostAdapter(host, adapter), active: true };
  return callHostAdapter.run(call, async () => {
    try { return await run(call.adapter); }
    finally { call.active = false; }
  });
}

export function hookAttestationKind(host: string): HookHostAdapter["attestationKind"] {
  return selectedHookHostAdapter(host)?.attestationKind;
}

export function resolveHookProcessPid(host: string, explicitHostPid?: number, hostProcess?: Readonly<{ pid: number; startToken: string }>): number | undefined {
  const pid = selectedHookHostAdapter(host)?.processPid(explicitHostPid, hostProcess);
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
  const adapter = selectedHookHostAdapter(host);
  if (!adapter) throw hookHostFailure("unavailable");
  return adapter.deliveryProfile(environment, diagnose, defaultQueueWake);
}

export function nativePeerWait(observation: InputObservation): NativePeerWaitObservation | null {
  return selectedHookHostAdapter(observation.host)?.peerWait?.(observation) ?? null;
}
