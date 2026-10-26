import { types as utilTypes } from "node:util";

export type ActorRole = "root" | "child" | "indeterminate";
export type ObservationBasis = "observed" | "inferred" | "unavailable";
export type InputObservationKind = "user-input" | "peer-wake" | "tool-boundary" | "turn-end" | "unknown";

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

export function isObservedSubagent(observation: InputObservation): boolean {
  return observation.actor.role === "child" && observation.actor.basis === "observed";
}
