import { WorkflowContractError } from "../../contracts/types.js";
import type { LineageRead } from "./host-input-adapter.js";
import { msg } from "./i18n.js";

/** Vendor-neutral caller contract. Host specifics live only in ingress adapters (builtin-caller-ingress.ts). */
export interface CallerActor {
  /** hostActorId(host, sessionId, agentKey); root has no agent key. */
  id: string;
  role: "root" | "child";
}

export type CallerExecution =
  | { model: string; effort: string | null; turnId: string | null; provenance: string }
  | { unavailable: string };

export interface VerifiedCaller {
  host: string;
  /** Root session: the address unit for messages, the board and continuity. */
  sessionId: string;
  /** Host call ID; null when the host gives none. */
  callId: string | null;
  actor: CallerActor;
  /** Actor IDs from the root to the direct parent; empty for a root. */
  parentChain: string[];
  /** True when the host named every link up to the direct parent. */
  parentChainComplete: boolean;
  provenance: "host-observed";
  execution: CallerExecution;
  /** Reads the caller's host-written lineage for continuity anchors, when the adapter can; absent otherwise. */
  readLineage?: () => LineageRead;
  /** The session ID this actor's own hooks carry when it is not `sessionId` (agy: a subagent's hooks name its own
   * conversation and no child marker). Absent: its hooks carry `sessionId`, plus the agent ID for a child. */
  hookSessionId?: string;
}

export type ObservedCaller = Omit<VerifiedCaller, "provenance">;
export type IngressResult =
  | { provenance: "host-observed"; caller: ObservedCaller }
  | { provenance: "unavailable"; reason: string };

/**
 * One adapter per host. Contradictions (malformed or mismatched metadata) throw BINDING_INVALID with a reasonCode; a
 * missing or already claimed admission is unavailable (claiming deletes it). A host call observed again is refused
 * later, when its execution observation is claimed (EXECUTION_OBSERVATION_CONSUMED).
 */
export type CallerIngress = (tool: string, meta: Record<string, unknown> | undefined, args?: unknown) => IngressResult;

export const MAX_PARENT_CHAIN = 16;
export const RESERVED_CALLER_KEYS = ["_sessionBinding", "_continuityBinding", "_hostAttestation", "_sessionProof"] as const;

function invalid(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_INVALID", msg("services.caller.observationInconsistent", {}), { reasonCode });
}

/** Core invariants every adapter result passes; no vendor field is read here. */
export function admitCaller(result: IngressResult, rootActorId: (host: string, sessionId: string) => string): VerifiedCaller {
  if (result.provenance !== "host-observed") {
    throw new WorkflowContractError("BINDING_REQUIRED", msg("services.caller.notObserved", {}), {
      reasonCode: "CALLER_PROVENANCE_UNAVAILABLE", ingressReason: result.reason,
    });
  }
  const { caller } = result;
  const chain = caller.parentChain;
  if (!caller.host || !caller.sessionId || !caller.actor?.id) invalid("CALLER_CHAIN_INCONSISTENT");
  if (caller.actor.role === "root") {
    if (chain.length !== 0 || !caller.parentChainComplete || caller.actor.id !== rootActorId(caller.host, caller.sessionId)) {
      invalid("CALLER_CHAIN_INCONSISTENT");
    }
  } else if (caller.actor.role !== "child" || chain[0] !== rootActorId(caller.host, caller.sessionId)) {
    invalid("CALLER_CHAIN_INCONSISTENT");
  }
  if (chain.length > MAX_PARENT_CHAIN) invalid("CALLER_CHAIN_TOO_DEEP");
  if (new Set(chain).size !== chain.length || chain.includes(caller.actor.id)) invalid("CALLER_CHAIN_CYCLE");
  return { ...caller, parentChain: [...chain], provenance: "host-observed" };
}
