import { types as utilTypes } from "node:util";

export type ActorRole = "root" | "child" | "indeterminate";
export type ObservationBasis = "observed" | "inferred" | "unavailable";
/** `subagent-start`: the host started a subagent and lets a hook add context before its first prompt. */
export type InputObservationKind = "user-input" | "peer-wake" | "tool-boundary" | "turn-end" | "subagent-start" | "unknown";

export interface ActorObservation {
  role: ActorRole;
  basis: ObservationBasis;
  reasonCode: string;
}

export interface InputObservation {
  host: string;
  sessionId: string;
  callId?: string;
  kind: InputObservationKind;
  actor: ActorObservation;
  boundaryPhase?: "before" | "after";
  toolName?: string;
  toolInput?: Record<string, unknown>;
  /** File-edit tool boundary only: the absolute paths the host tool will change, as its adapter reads them from the
   * tool input. An empty list is an edit tool whose target the adapter could not read. Absent: not a file edit. */
  editTargets?: string[];
  /** Turn end only: the host reports that this turn was already continued by its Stop hook. */
  stopHookActive?: boolean;
  wakeCandidates?: string[];
  wakeOnly?: boolean;
  workspaceId?: string;
  collaborationId?: string;
  role?: string;
}

export interface DeliveryCapabilities {
  supportedInjection: InputObservationKind[];
  idleWake: "silent" | "user-message" | "none";
}

export function supportsInjection(capabilities: DeliveryCapabilities, kind: InputObservationKind): boolean {
  return capabilities.supportedInjection.includes(kind);
}

/** One shared role decision; host adapters own the observation and its reason. */
export function actorAccess(actor: unknown): { allowed: boolean; reasonCode: string } {
  const invalid = { allowed: false, reasonCode: "ACTOR_OBSERVATION_INVALID" };
  if (!actor || typeof actor !== "object" || utilTypes.isProxy(actor) || Array.isArray(actor)) return invalid;
  try {
    const role: unknown = Object.getOwnPropertyDescriptor(actor, "role")?.value;
    const basis: unknown = Object.getOwnPropertyDescriptor(actor, "basis")?.value;
    const reasonCode: unknown = Object.getOwnPropertyDescriptor(actor, "reasonCode")?.value;
    if ((role !== "root" && role !== "child" && role !== "indeterminate")
      || (basis !== "observed" && basis !== "inferred" && basis !== "unavailable")
      || typeof reasonCode !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(reasonCode)) return invalid;
    return { allowed: role === "root" && (basis === "observed" || basis === "inferred"), reasonCode };
  } catch { return invalid; }
}

/** Read like actorAccess: a missing or malformed actor is not an observed child. */
export function isObservedSubagent(observation: InputObservation): boolean {
  const actor: unknown = observation.actor;
  if (!actor || typeof actor !== "object" || utilTypes.isProxy(actor) || Array.isArray(actor)) return false;
  try {
    return Object.getOwnPropertyDescriptor(actor, "role")?.value === "child"
      && Object.getOwnPropertyDescriptor(actor, "basis")?.value === "observed";
  } catch { return false; }
}
