import type { CallerIngress, ObservedCaller, VerifiedCaller } from "../../mcp-server/src/caller-identity.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";

/** A host-observed root caller, as an ingress adapter would report it. */
export function rootCaller(host = "codex", sessionId = "test-session", overrides: Partial<ObservedCaller> = {}): VerifiedCaller {
  return {
    host, sessionId, callId: "test-call", actor: { id: hostActorId(host, sessionId), role: "root" },
    parentChain: [], parentChainComplete: true, provenance: "host-observed",
    execution: { unavailable: "TEST_EXECUTION_UNOBSERVED" }, ...overrides,
  };
}

/** A direct child of the root session, as Codex or agy report it. */
export function childCaller(host = "codex", sessionId = "test-session", agentKey = "test-agent", overrides: Partial<ObservedCaller> = {}): VerifiedCaller {
  return rootCaller(host, sessionId, {
    actor: { id: hostActorId(host, sessionId, agentKey), role: "child" }, parentChain: [hostActorId(host, sessionId)], ...overrides,
  });
}

/** Test double at the server's ingress boundary: every call is observed as `caller`, or a fresh call ID per call. */
export function fixedIngress(caller: VerifiedCaller | (() => VerifiedCaller) = rootCaller()): CallerIngress & { calls: Array<{ tool: string; meta: unknown }> } {
  const calls: Array<{ tool: string; meta: unknown }> = [];
  let sequence = 0;
  const ingress = ((tool, meta) => {
    calls.push({ tool, meta });
    const value = typeof caller === "function" ? caller() : caller;
    const { provenance: _provenance, ...observed } = value;
    return { provenance: "host-observed", caller: { ...observed, callId: value.callId === null ? null : `${value.callId}-${++sequence}` } };
  }) as CallerIngress & { calls: Array<{ tool: string; meta: unknown }> };
  ingress.calls = calls;
  return ingress;
}
