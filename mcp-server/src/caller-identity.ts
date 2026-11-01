import { WorkflowContractError } from "../../contracts/types.js";
import type { LineageRead } from "./host-input-adapter.js";

/** Vendor-neutral caller contract. Host specifics live only in ingress adapters (builtin-caller-ingress.ts). */
export interface CallerActor {
  /** hostActorId(host, sessionId, agentKey); root has no agent key. */
  id: string;
  role: "root" | "child";
}

export type CallerExecution =
  | { model: string; effort: string; turnId: string | null; provenance: string }
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
}

export type ObservedCaller = Omit<VerifiedCaller, "provenance">;
export type IngressResult =
  | { provenance: "host-observed"; caller: ObservedCaller }
  | { provenance: "unavailable"; reason: string };

/** One adapter per host. Contradictions (malformed, mismatched, already consumed) throw WorkflowContractError. */
export type CallerIngress = (tool: string, meta: Record<string, unknown> | undefined) => IngressResult;

export const MAX_PARENT_CHAIN = 16;
export const RESERVED_CALLER_KEYS = ["_sessionBinding", "_continuityBinding", "_hostAttestation", "_sessionProof"] as const;

function invalid(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_INVALID", "The host caller observation is inconsistent.", { reasonCode });
}

/** Core invariants every adapter result passes; no vendor field is read here. */
export function admitCaller(result: IngressResult, rootActorId: (host: string, sessionId: string) => string): VerifiedCaller {
  if (result.provenance !== "host-observed") {
    throw new WorkflowContractError("BINDING_REQUIRED", "The host did not observe this caller; it is not presumed to be a root.", {
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
