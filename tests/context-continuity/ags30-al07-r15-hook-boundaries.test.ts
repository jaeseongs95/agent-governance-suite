import { beforeEach, describe, expect, it } from "vitest";
import type { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { handleContinuityHook as handleNativeContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter, type HookHostAdapter, type LineageRead } from "../../mcp-server/src/host-input-adapter.js";

import type { ActorObservation } from "../../mcp-server/src/input-observation.js";

// Records every continuity service call the hook makes; AGS tools are bound on the server, so the hook makes none.
const calls: Array<[method: string, args: unknown[]]> = [];
const service = new Proxy({}, {
  get: (_target, method) => (...args: unknown[]) => { calls.push([String(method), args]); },
}) as unknown as ContinuityService;
const input = { schemaVersion: "1.0.0", marker: "retained", _continuityBinding: "forged" };
const owned = "mcp__agent_governance_suite__inspect_context";
const lineage = (): LineageRead => ({ ids: [], at: [] });
// Explicit synthetic adapter for mocked core behavior; not native capture.
const syntheticHost = "synthetic-al07-continuity";
const syntheticRoot: ActorObservation = { role: "root", basis: "observed", reasonCode: "SYNTHETIC_CONTINUITY_ROOT" };
registerHookHostAdapter(syntheticHost, {
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  processPid: () => undefined, ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    // A lineage reader makes the host-tool pin observable, the positive control for the cases that must stay silent.
    return { ...mapped, readLineage: lineage, observation: { ...mapped.observation, host, actor: payload.syntheticActor as ActorObservation } };
  },
});
const handleContinuityHook = (payload: Record<string, unknown>, value: ContinuityService, host = syntheticHost) => handleNativeContinuityHook(payload, value, host);

function event(toolName = owned, actor: Record<string, unknown> = { syntheticActor: syntheticRoot }) {
  return { hook_event_name: "PreToolUse", session_id: "observed-session", tool_name: toolName, tool_input: input, ...actor };
}
beforeEach(() => { calls.length = 0; });

describe("AGS-D-0020/0021 continuity tool authority boundaries", () => {
  it.each([
    "mcp__agent_governance_suite__", "mcp__agent-governance-suite__",
    "mcp__plugin_agent-governance-suite_agent-governance-suite__",
  ])("leaves owned %s calls unchanged: no rewritten input, binding, permission decision or service call", namespace => {
    for (const toolName of ["open_convergence_root", "checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"]) {
      expect(handleContinuityHook(event(namespace + toolName), service)).toEqual({});
      expect(input._continuityBinding).toBe("forged");
    }
    expect(calls).toEqual([]);
  });
  it.each([
    "mcp__foreign__inspect_context", "mcp__agent_governance_suite_other__inspect_context",
    "mcp__foreign__mcp__agent_governance_suite__inspect_context", "inspect_context",
    "mcp__agent_governance_suite__inspect_context__foreign", "mcp__agent_governance_suite__Bash",
  ])("treats foreign/unbound %s as a host tool boundary: pins from lineage, issues no authority or permission", toolName => {
    expect(handleContinuityHook(event(toolName), service)).toEqual({});
    expect(calls).toEqual([["pinForkParent", ["observed-session", lineage]]]);
  });
  it.each([{}, { agent_id: null }, { agent_id: 42 }, { agent_id: "subagent" }, { role: "main" }, { agent_id: "subagent", role: "main" }])(
    "does not infer an observed main actor from %j", actor => {
      expect(handleContinuityHook(event(owned, actor), service)).toEqual({});
      expect(handleContinuityHook(event("Bash", actor), service)).toEqual({});
      expect(calls).toEqual([]);
    });
  it("does not act after a tool or without an observed session", () => {
    for (const toolName of [owned, "Bash"]) {
      expect(handleContinuityHook({ ...event(toolName), hook_event_name: "PostToolUse" }, service)).toEqual({});
      expect(handleContinuityHook({ ...event(toolName), session_id: "" }, service)).toEqual({});
    }
    expect(calls).toEqual([]);
  });
  const delivery: HookHostAdapter["deliveryProfile"] = () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false });
  it("uses the explicitly selected adapter's schema and ownership, and never its payload's actor or host claims", () => {
    const host = "al07-r15-explicit";
    registerHookHostAdapter(host, { deliveryProfile: delivery, processPid: () => undefined,
      ownsTool: name => name === "configured__inspect_context",
      adaptInput: payload => ({ lifecycle: "none", outputEventName: "BeforeInvocation", readLineage: lineage, observation: {
        host, sessionId: String(payload.conversation), kind: "tool-boundary", boundaryPhase: "before",
        actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_CONFIGURED_CONTINUITY_ROOT" },
        toolName: String(payload.tool), toolInput: input,
      } }),
    });
    const payload = { conversation: "adapter-session", agent_id: "payload-subagent", host: "untrusted" };
    // Owned by the adapter's own rule: left to the server, no service call.
    expect(handleContinuityHook({ ...payload, tool: "configured__inspect_context" }, service, host)).toEqual({});
    expect(calls).toEqual([]);
    // The same name under another prefix is not owned by this adapter, so it is a host tool boundary of the adapter's session.
    expect(handleContinuityHook({ ...payload, tool: owned }, service, host)).toEqual({});
    expect(calls).toEqual([["pinForkParent", ["adapter-session", lineage]]]);
  });
  it("does not authorize an adapter root claim with unavailable basis", () => {
    const host = "al07-r15-unobserved";
    registerHookHostAdapter(host, { deliveryProfile: delivery, processPid: () => undefined, ownsTool: () => false,
      adaptInput: () => ({ lifecycle: "none", outputEventName: "PreToolUse", readLineage: lineage, observation: {
        host, sessionId: "adapter-session", kind: "tool-boundary", boundaryPhase: "before",
        actor: { role: "root", basis: "unavailable", reasonCode: "SYNTHETIC_CONTINUITY_UNAVAILABLE" }, toolName: "Bash", toolInput: input,
      } }),
    });
    expect(handleContinuityHook(event(), service, host)).toEqual({}); expect(calls).toEqual([]);
  });
});
