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

let metaSequence = 0;
/**
 * tools/call `_meta` as Codex 0.166 writes it (docs/ags30-session-binding-design.md 1.5), for servers that run the
 * real codex ingress (AGENT_GOVERNANCE_HOST_ATTESTATION=codex). `thread`/`parent` make a child; a fresh callId per call.
 */
export function codexCallMeta(sessionId = "test-session", options: {
  thread?: string; parent?: string; model?: string | null; effort?: string | null; callId?: string;
} = {}): Record<string, unknown> {
  const thread = options.thread ?? sessionId;
  return {
    callId: options.callId ?? `test-call-${++metaSequence}`, sessionId, threadId: thread,
    "x-codex-turn-metadata": {
      session_id: sessionId, thread_id: thread, turn_id: "test-turn",
      ...(options.model === null ? {} : { model: options.model ?? "gpt-6-astra" }),
      ...(options.effort === null ? {} : { reasoning_effort: options.effort ?? "high" }),
      ...(options.parent === undefined ? {} : { parent_thread_id: options.parent, subagent_kind: "thread_spawn" }),
    },
  };
}
