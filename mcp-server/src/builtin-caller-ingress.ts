import { WorkflowContractError } from "../../contracts/types.js";
import type { CallerIngress, IngressResult, ObservedCaller } from "./caller-identity.js";
import { antigravityCallKey, readClaudeLineage } from "./builtin-hook-host-adapters.js";
import { HOST_ATTESTATION_TOOLS, hostActorId } from "./host-attestation.js";
import type { WorkflowStore } from "./workflow-store.js";

// Host fact sources: tests/real-host/binding-capture (2026-11-01) and docs/ags30-session-binding-design.md 1.5.

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function unavailable(reason: string): IngressResult {
  return { provenance: "unavailable", reason };
}

function invalid(reasonCode: string): never {
  throw new WorkflowContractError("BINDING_INVALID", "The host caller metadata is inconsistent.", { reasonCode });
}

/** Root, or a child of `parent` under the root session `sessionId`. Hosts here name only the direct parent. */
function observed(host: string, sessionId: string, agentKey: string | null, parent: string | null,
  callId: string | null, execution: ObservedCaller["execution"]): IngressResult {
  const root = hostActorId(host, sessionId);
  const chain = agentKey === null ? [] : parent === null || parent === sessionId ? [root] : [root, hostActorId(host, sessionId, parent)];
  return { provenance: "host-observed", caller: {
    host, sessionId, callId, execution,
    actor: agentKey === null ? { id: root, role: "root" } : { id: hostActorId(host, sessionId, agentKey), role: "child" },
    parentChain: chain,
    // Only a direct child of the root has its whole chain in one call; deeper links are not in this call's metadata.
    parentChainComplete: agentKey === null || parent === sessionId,
  } };
}

/** Codex writes sessionId (root), threadId (the calling agent) and the turn metadata into every tools/call _meta. */
export function codexMetaIngress(host = "codex"): CallerIngress {
  return (_tool, meta) => {
    const sessionId = text(meta?.sessionId), threadId = text(meta?.threadId), callId = text(meta?.callId);
    const turn = record(meta?.["x-codex-turn-metadata"]);
    if (!sessionId || !threadId || !callId || !turn) return unavailable("CODEX_CALL_META_MISSING");
    if (turn.session_id !== sessionId || turn.thread_id !== threadId) invalid("CODEX_CALL_META_INVALID");
    // A model without a reported effort is still observed; the effort stays unknown rather than refusing the call.
    const model = text(turn.model);
    const execution = model
      ? { model, effort: text(turn.reasoning_effort), turnId: text(turn.turn_id), provenance: `${host}:mcp-meta` }
      : { unavailable: "CODEX_EXECUTION_META_MISSING" };
    if (turn.parent_thread_id === undefined || turn.parent_thread_id === null) {
      if (turn.subagent_kind !== undefined && turn.subagent_kind !== null) invalid("CODEX_CALL_META_INVALID");
      if (threadId !== sessionId) invalid("CODEX_ROOT_THREAD_MISMATCH");
      return observed(host, sessionId, null, null, callId, execution);
    }
    const parent = text(turn.parent_thread_id);
    if (!parent || threadId === sessionId || parent === threadId) invalid("CODEX_CALL_META_INVALID");
    return observed(host, sessionId, threadId, parent, callId, execution);
  };
}

const AGY = "antigravity.google/";

/**
 * agy 1.4.12 writes the calling conversation, its root and (for a subagent) its direct parent; no call ID or model.
 * The caller comes from `_meta` alone. The model and effort come from the PreToolUse hook's row, keyed by what the
 * host writes on both sides: this conversation, the tool and the arguments. Without a store nothing is observed.
 */
export function antigravityMetaIngress(store: WorkflowStore | null = null, host = "antigravity"): CallerIngress {
  return (tool, meta, args) => {
    const conversation = text(meta?.[`${AGY}conversation_id`]), root = text(meta?.[`${AGY}root_conversation_id`]);
    if (!conversation || !root) return unavailable("ANTIGRAVITY_CALL_META_MISSING");
    let callId: string | null = null;
    let execution: ObservedCaller["execution"] = { unavailable: "ANTIGRAVITY_EXECUTION_UNOBSERVED" };
    if (store && HOST_ATTESTATION_TOOLS.has(tool)) {
      const key = antigravityCallKey(conversation, tool, args);
      const { admission, callerRows } = store.claimLatestCallAdmission(host, `${key.call}:`, `${key.caller}:`);
      if (admission) ({ callId, execution } = admission);
      // Rows for this conversation and tool with other arguments mean the hook ran but the arguments differ.
      else execution = { unavailable: callerRows > 0 ? "ANTIGRAVITY_OBSERVATION_UNMATCHED" : "ANTIGRAVITY_OBSERVATION_MISSING" };
    }
    const rawParent = meta?.[`${AGY}parent_conversation_id`];
    if (rawParent === undefined || rawParent === null) {
      if (conversation !== root) invalid("ANTIGRAVITY_ROOT_CONVERSATION_MISMATCH");
      return observed(host, root, null, null, callId, execution);
    }
    const parent = text(rawParent);
    if (!parent || conversation === root || parent === conversation) invalid("ANTIGRAVITY_CALL_META_INVALID");
    return observed(host, root, conversation, parent, callId, execution);
  };
}

/** Claude's _meta carries only the tool-use ID; the PreToolUse hook recorded the rest under that ID. One claim per row. */
export function claudeAdmissionIngress(store: WorkflowStore, host = "claude-code"): CallerIngress {
  return (tool, meta) => {
    const callId = text(meta?.["claudecode/toolUseId"]);
    if (!callId) return unavailable("CLAUDE_TOOL_USE_ID_MISSING");
    const row = store.claimCallAdmission(host, callId);
    if (!row) return unavailable("CALL_ADMISSION_MISSING");
    if (row.tool !== tool) invalid("CALL_ADMISSION_TOOL_MISMATCH");
    // The hook names the calling agent but not its parent agent, so a child's chain stops at the root.
    const result = observed(host, row.sessionId, row.agentId, null, callId, row.execution);
    const transcriptPath = row.transcriptPath;
    if (result.provenance === "host-observed" && transcriptPath) result.caller.readLineage = () => readClaudeLineage(transcriptPath, row.sessionId);
    return result;
  };
}

/** Installation selects one ingress by AGENT_GOVERNANCE_HOST_ATTESTATION; an unknown host has none. */
export function builtinCallerIngress(host: string | undefined, store: WorkflowStore): CallerIngress | null {
  if (host === "codex") return codexMetaIngress();
  if (host === "antigravity") return antigravityMetaIngress(store);
  if (host === "claude-code") return claudeAdmissionIngress(store);
  return null;
}
