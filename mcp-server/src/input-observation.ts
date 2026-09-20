export type ActorKind = "main" | "subagent" | "unknown";
export type ObservationAssurance = "observed" | "self-asserted" | "unknown";
export type InputObservationKind = "user-input" | "peer-wake" | "tool-boundary" | "turn-end" | "unknown";

export interface ActorObservation {
  kind: ActorKind;
  observedBy: string;
  assurance: ObservationAssurance;
}

export interface InputObservation {
  host: string;
  sessionId: string;
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

export function isObservedSubagent(observation: InputObservation): boolean {
  return observation.actor.kind === "subagent" && observation.actor.assurance === "observed";
}
