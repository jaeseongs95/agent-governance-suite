import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { handleContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { registerHookHostAdapter, type HookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

const issue = vi.fn(() => "opaque-binding");
const service = { issueToolBinding: issue } as unknown as ContinuityService;
const input = { schemaVersion: "1.0.0", marker: "retained", _continuityBinding: "forged" };
const owned = "mcp__agent_governance_suite__inspect_context";
function event(toolName = owned, actor: Record<string, unknown> = { agent_id: "" }) {
  return { hook_event_name: "PreToolUse", session_id: "observed-session", tool_name: toolName, tool_input: input, ...actor };
}
beforeEach(() => { issue.mockClear(); });

describe("AGS-D-0020/0021 continuity tool authority boundaries", () => {
  it.each([
    "mcp__agent_governance_suite__", "mcp__agent-governance-suite__",
    "mcp__plugin_agent-governance-suite_agent-governance-suite__",
  ])("attaches an owned binding through %s without deciding host permission", namespace => {
    for (const toolName of ["open_convergence_root", "checkpoint_context", "inspect_context", "load_context", "suppress_context_restore", "purge_direct_context"]) {
      const output = handleContinuityHook(event(namespace + toolName), service);
      expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { ...input, _continuityBinding: "opaque-binding" } } });
      expect(issue).toHaveBeenLastCalledWith("observed-session", toolName, input);
      expect(input._continuityBinding).toBe("forged");
    }
    expect(issue).toHaveBeenCalledTimes(6);
  });
  it.each([
    "mcp__foreign__inspect_context", "mcp__agent_governance_suite_other__inspect_context",
    "mcp__foreign__mcp__agent_governance_suite__inspect_context", "inspect_context",
    "mcp__agent_governance_suite__inspect_context__foreign", "mcp__agent_governance_suite__Bash",
  ])("issues no continuity authority or permission for foreign/unbound %s", toolName => {
    expect(handleContinuityHook(event(toolName), service)).toEqual({});
    expect(issue).not.toHaveBeenCalled();
  });
  it.each([{}, { agent_id: null }, { agent_id: 42 }, { agent_id: "subagent" }, { role: "main" }, { agent_id: "subagent", role: "main" }])(
    "does not infer an observed main actor from %j", actor => {
      expect(handleContinuityHook(event(owned, actor), service)).toEqual({});
      expect(issue).not.toHaveBeenCalled();
    });
  it("does not bind after a tool or without an observed session", () => {
    expect(handleContinuityHook({ ...event(), hook_event_name: "PostToolUse" }, service)).toEqual({});
    expect(handleContinuityHook({ ...event(), session_id: "" }, service)).toEqual({});
    expect(issue).not.toHaveBeenCalled();
  });
  const delivery: HookHostAdapter["deliveryProfile"] = () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false });
  it("uses the explicitly selected adapter's schema, ownership and output event", () => {
    const host = "al07-r15-explicit";
    registerHookHostAdapter(host, { deliveryProfile: delivery, processPid: () => undefined,
      ownsTool: name => name === "configured__inspect_context",
      adaptInput: payload => ({ lifecycle: "none", outputEventName: "BeforeInvocation", observation: {
        host, sessionId: String(payload.conversation), kind: "tool-boundary", boundaryPhase: "before",
        actor: { kind: "main", assurance: "observed", observedBy: "al07:configured-adapter" },
        toolName: "configured__inspect_context", toolInput: input,
      } }),
    });
    expect(handleContinuityHook({ conversation: "adapter-session", agent_id: "payload-subagent", host: "untrusted" }, service, host))
      .toEqual({ hookSpecificOutput: { hookEventName: "BeforeInvocation", updatedInput: { ...input, _continuityBinding: "opaque-binding" } } });
    expect(issue).toHaveBeenCalledWith("adapter-session", "inspect_context", input);
  });
  it("does not treat an adapter's unobserved main claim as observed", () => {
    const host = "al07-r15-unobserved";
    registerHookHostAdapter(host, { deliveryProfile: delivery, processPid: () => undefined, ownsTool: () => true,
      adaptInput: () => ({ lifecycle: "none", outputEventName: "PreToolUse", observation: {
        host, sessionId: "adapter-session", kind: "tool-boundary", boundaryPhase: "before",
        actor: { kind: "main", assurance: "unknown", observedBy: "al07:unobserved" }, toolName: owned, toolInput: input,
      } }),
    });
    expect(handleContinuityHook(event(), service, host)).toEqual({}); expect(issue).not.toHaveBeenCalled();
  });
});
