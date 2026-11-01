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
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling drops this field
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

const CALLER_META = "agent-governance.test/caller";
let callerSequence = 0;
/** Owned test `_meta` naming a caller for metaIngress(); a fresh call ID per call. Not native host evidence. */
export function callerMeta(identity: { host: string; sessionId: string } = { host: "synthetic-root-host", sessionId: "synthetic-root-session" },
  agentKey?: string): Record<string, unknown> {
  return { [CALLER_META]: { ...identity, ...(agentKey === undefined ? {} : { agentKey }), callId: `synthetic-call-${++callerSequence}` } };
}

/**
 * Test double at the server's ingress boundary for in-memory clients: a call observes the caller its `_meta` names
 * (see callerMeta), and a call without it is unobserved, so missing-caller negative tests stay negative.
 */
export function metaIngress(): CallerIngress {
  return (_tool, meta) => {
    const named = meta?.[CALLER_META] as { host: string; sessionId: string; agentKey?: string; callId: string } | undefined;
    if (!named) return { provenance: "unavailable", reason: "TEST_CALLER_META_MISSING" };
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the rest sibling drops this field
    const { provenance: _provenance, ...observed } = named.agentKey === undefined
      ? rootCaller(named.host, named.sessionId) : childCaller(named.host, named.sessionId, named.agentKey);
    return { provenance: "host-observed", caller: { ...observed, callId: named.callId } };
  };
}
