import type { ObservedCallerV1 } from "../../contracts/types.js";
import type { VerifiedCaller } from "./caller-identity.js";

/**
 * The one source of observed callers (lease actor, stage recorder, reviewer), taken from the server-admitted host
 * caller (docs/archive/ags30-session-binding-design.md 2.1). Binding's provenance says the caller's identity was observed;
 * here it says whose work a record is (docs/archive/ags30-gates-design.md 3.8), so two cases stay "unavailable":
 * - the root: it may record a result on behalf of an agent the host never showed, so its own work and a relay look
 *   the same (3.8 counts a root-recorded result as unobserved);
 * - a child whose chain the host did not give up to the direct parent: a delegation through a missing ancestor
 *   cannot show (gates U2).
 */
export function observedCaller(caller: VerifiedCaller): ObservedCallerV1 {
  return { actor: caller.actor.id, parentChain: [...caller.parentChain],
    provenance: caller.actor.role === "child" && caller.parentChainComplete ? "host-observed" : "unavailable" };
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
