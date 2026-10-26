import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: f.spawn,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));

import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { adaptHostInput, isGovernanceHookTool, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

// Explicit fake core adapter, not native Codex identity evidence.
const syntheticHost = "synthetic-al03-owned-root";
registerHookHostAdapter(syntheticHost, {
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  processPid: () => undefined,
  ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {
    const mapped = adaptHostInput(payload, "codex");
    return { ...mapped, observation: { ...mapped.observation, host,
      actor: { role: "root", basis: "observed", reasonCode: "SYNTHETIC_AL03_ROOT" } } };
  },
});

registerHookHostAdapter("al03-delivery-only", {
  deliveryProfile: () => ({ transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false }),
  processPid: () => undefined,
});

beforeEach(() => {
  f.request.mockReset(); f.spawn.mockReset();
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("AGS-D-0019/0020/0021 adapter-owned message tool boundary", () => {
  const toolInput = { schemaVersion: "1.0.0", marker: "preserve", _sessionBinding: {host: "forged", sessionId: "forged"} };
  const pre = {hook_event_name: "PreToolUse", session_id: "al03-tool-session", tool_input: toolInput};
  it.each(["send_session_message", "mcp__unrelated__send_session_message"])("does not bind an unowned tool %s", async (tool_name) => {
    expect(await runSessionMessageHook("codex", JSON.stringify({...pre, tool_name, agent_id: ""}))).toBe("");
    expect(f.request).not.toHaveBeenCalled();
  });
  it.each([undefined, "child"])("denies a main-session operation for an unknown or subagent actor: %s", async (agentId) => {
    const payload = {...pre, tool_name: "mcp__agent_governance_suite__send_session_message", ...(agentId === undefined ? {} : {agent_id: agentId})};
    const output = JSON.parse(await runSessionMessageHook("codex", JSON.stringify(payload)));
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined(); expect(f.request).not.toHaveBeenCalled();
  });
  it("binds an explicit synthetic root without skipping the host permission decision", async () => {
    const output = JSON.parse(await runSessionMessageHook(syntheticHost, JSON.stringify({...pre,
      tool_name: "mcp__agent_governance_suite__send_session_message"})));
    expect(output.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(output.hookSpecificOutput.updatedInput).toEqual({...toolInput, _sessionBinding: {host: syntheticHost, sessionId: "al03-tool-session"}});
    expect(f.request).not.toHaveBeenCalled();
  });
  it("keeps native Codex empty agent_id denied while capture is required", async () => {
    const output = JSON.parse(await runSessionMessageHook("codex", JSON.stringify({...pre,
      tool_name: "mcp__agent_governance_suite__send_session_message", agent_id: ""})));
    expect(output.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
    expect(f.request).not.toHaveBeenCalled();
  });
  it("requires an explicit input adapter before a delivery-only host can issue a binding", async () => {
    expect(await runSessionMessageHook("al03-delivery-only", JSON.stringify({...pre,
      tool_name: "mcp__agent_governance_suite__send_session_message", agent_id: ""}))).toBe("");
    expect(f.request).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
});
