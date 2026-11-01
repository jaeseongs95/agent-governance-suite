import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: f.spawn,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));

import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";

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
  // The server identifies the caller from host call metadata, so the hook neither rewrites nor decides AGS tool calls.
  it("passes a marker-free native Codex AGS tool call through unchanged without a broker request", async () => {
    expect(await runSessionMessageHook("codex", JSON.stringify({...pre,
      tool_name: "mcp__agent_governance_suite__send_session_message"}))).toBe("");
    expect(f.request).not.toHaveBeenCalled();
  });
  it("requires an explicit input adapter before a delivery-only host can issue a binding", async () => {
    expect(await runSessionMessageHook("al03-delivery-only", JSON.stringify({...pre,
      tool_name: "mcp__agent_governance_suite__send_session_message", agent_id: ""}))).toBe("");
    expect(f.request).not.toHaveBeenCalled(); expect(f.spawn).not.toHaveBeenCalled();
  });
});
