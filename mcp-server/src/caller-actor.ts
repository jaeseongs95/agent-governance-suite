import type { ObservedCallerV1 } from "../../contracts/types.js";
import { hostActorId } from "./host-attestation.js";

/** The server-verified session of one tool call: today the root hook proof. */
export interface VerifiedCallerRef {
  host: string;
  sessionId: string;
}

/**
 * The one source of observed callers (lease actor, stage recorder, reviewer). The session proof identifies the
 * bound session, not which agent in it called, so provenance is "unavailable". The session-binding redesign
 * replaces this source with its host-observed `caller`.
 */
export function observedCaller(caller: VerifiedCallerRef | null | undefined): ObservedCallerV1 | null {
  return caller ? { actor: hostActorId(caller.host, caller.sessionId), parentChain: [], provenance: "unavailable" } : null;
}

export type Independence = "verified" | "violated" | "unobserved";

/**
 * Whether `checked` (an auditor or reviewer) is independent of `implementers`, judged only by provenance so a new
 * host needs no change here. Violated: a host-observed implementer is `checked` itself or in its parent chain
 * (the implementer delegated the check). Verified: every side is host-observed and none violates.
 */
export function independence(
  checked: ObservedCallerV1 | null | undefined,
  implementers: Array<ObservedCallerV1 | null | undefined>,
): Independence {
  if (checked?.provenance !== "host-observed") return "unobserved";
  const observed = implementers.filter((item): item is ObservedCallerV1 => item?.provenance === "host-observed");
  if (observed.some((item) => item.actor === checked.actor || checked.parentChain.includes(item.actor))) return "violated";
  return implementers.length > 0 && observed.length === implementers.length ? "verified" : "unobserved";
}
