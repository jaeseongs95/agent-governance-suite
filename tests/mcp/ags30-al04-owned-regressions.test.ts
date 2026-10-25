import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), prune: vi.fn(), prompt: vi.fn(), summary: vi.fn(), touch: vi.fn(), gate: vi.fn(), request: vi.fn(),
}));
vi.mock("../../skills/session-board/scripts/board-store.mjs", async original => ({
  ...await original<typeof import("../../skills/session-board/scripts/board-store.mjs")>(),
  openBoard: f.open, pruneSessions: f.prune, recordPrompt: f.prompt, setSummary: f.summary, touchSession: f.touch, gateDecision: f.gate,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {adaptHostInput, hookAttestationKind, hostDeliveryProfile, isGovernanceHookTool, registerHookHostAdapter, type HookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {handleSessionBoardHook, runSessionBoardHook} from "../../mcp-server/src/session-board-hook.js";

const board = {close: f.close} as unknown as NonNullable<Parameters<typeof handleSessionBoardHook>[1]>;
const now = "2026-10-25T00:00:00.000Z";
const tool = (name: string, actor: Record<string, unknown> = {agent_id: ""}) => ({
  hook_event_name: "PreToolUse", session_id: "AL04_PRIVATE_PARENT", ...actor,
  tool_name: name, tool_input: {summary: "AL04 회귀", _sessionBinding: {host: "forged", sessionId: "forged"}},
});
const prefix = "mcp__agent_governance_suite__";
function noWrites() {
  for (const mock of [f.prune, f.prompt, f.summary, f.touch, f.gate]) expect(mock).not.toHaveBeenCalled();
}
beforeEach(() => {
  for (const mock of Object.values(f)) mock.mockReset();
  f.open.mockReturnValue(board); f.gate.mockReturnValue("allow");
});
afterEach(() => {vi.restoreAllMocks();});

describe("AL04 board actor, namespace and host permission boundaries", () => {
  it.each(["list_session_status", "update_session_status"])("D0018 denies a subagent %s before issuing its parent binding", name => {
    const output = handleSessionBoardHook(tool(prefix + name, {agent_id: "subagent"}), board, "codex", now);
    expect(output).toMatchObject({hookSpecificOutput: {permissionDecision: "deny"}});
    expect((output.hookSpecificOutput as Record<string, unknown>).updatedInput).toBeUndefined();
    noWrites();
  });
  it.each([{}, {agent_id: null}, {agent_id: 42}])("D0019 keeps unknown actor %j from binding, writing or consuming parent wakes", async actor => {
    const output = await runSessionBoardHook("codex", JSON.stringify(tool(prefix + "list_session_status", actor)));
    expect(JSON.parse(output)).toMatchObject({hookSpecificOutput: {permissionDecision: "deny"}});
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(await runSessionBoardHook("codex", JSON.stringify({hook_event_name: event, session_id: "AL04_PRIVATE_PARENT", ...actor,
        ...(event === "SessionStart" && Object.keys(actor).length === 0 ? {agent_type: "unproven"} : {}),
        prompt: `[agent-governance-suite:wake:${"a".repeat(32)}]`}))).toBe("");
    }
    expect(f.open).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); noWrites();
  });
  it.each([
    "mcp__agent_governance_suite__", "mcp__agent-governance-suite__",
    "mcp__plugin_agent-governance-suite_agent-governance-suite__",
  ])("D0020 preserves host permission checks when attaching an owned binding through %s", namespace => {
    const output = handleSessionBoardHook(tool(namespace + "update_session_status"), board, "codex", now);
    expect(output).toEqual({hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: {
      summary: "AL04 회귀", _sessionBinding: {host: "codex", sessionId: "AL04_PRIVATE_PARENT"},
    }}});
    expect(f.summary).toHaveBeenCalledTimes(1);
  });
  it.each([
    "mcp__foreign__update_session_status", "mcp__agent_governance_suite_other__list_session_status",
    "mcp__foreign__mcp__agent_governance_suite__list_session_status", "list_session_status",
  ])("D0021 does not bind or allow a foreign tool %s", name => {
    expect(handleSessionBoardHook(tool(name), board, "codex", now)).toEqual({}); noWrites();
  });
  it("preserves denial of malformed summaries and an unmet board gate", () => {
    const input = tool(prefix + "update_session_status"); input.tool_input.summary = "둘\n줄";
    expect(handleSessionBoardHook(input, board, "codex", now)).toMatchObject({hookSpecificOutput: {permissionDecision: "deny"}});
    expect(f.summary).not.toHaveBeenCalled();
    f.gate.mockReturnValue("deny");
    expect(handleSessionBoardHook(tool("apply_patch"), board, "codex", now)).toMatchObject({hookSpecificOutput: {permissionDecision: "deny"}});
  });
});

describe("AL04 explicit host adapter contracts", () => {
  const delivery: HookHostAdapter["deliveryProfile"] = () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false});
  it("D0014 rejects an unregistered host rather than borrowing Codex delivery", () => {
    expect(() => hostDeliveryProfile("al04-unregistered", {})).toThrowError("A host delivery adapter is required.");
  });
  it("D0028 does not apply builtin event or actor fields to a delivery-only adapter", () => {
    registerHookHostAdapter("al04-delivery-only", {deliveryProfile: delivery, processPid: () => undefined});
    expect(adaptHostInput(tool(prefix + "list_session_status"), "al04-delivery-only")).toMatchObject({
      lifecycle: "none", outputEventName: "", observation: {host: "al04-delivery-only", sessionId: "", kind: "unknown", actor: {kind: "unknown", assurance: "unknown"}},
    });
    expect(isGovernanceHookTool("al04-delivery-only", prefix + "list_session_status")).toBe(false);
  });
  it("D0028 accepts another host input schema only through its explicit adapter", () => {
    const host = "al04-explicit-shape";
    registerHookHostAdapter(host, {deliveryProfile: delivery, processPid: () => undefined,
      ownsTool: name => name === "owned:board",
      adaptInput: (input, configuredHost) => ({lifecycle: "none", outputEventName: "before-call", observation: {
        host: configuredHost, sessionId: String(input.conversation), kind: "tool-boundary", boundaryPhase: "before",
        actor: {kind: "main", assurance: "observed", observedBy: "al04:configured-fixture"}, toolName: "owned:board", toolInput: {},
      }}),
    });
    expect(adaptHostInput({conversation: "explicit-session", hook_event_name: "SessionEnd", agent_id: "unrelated"}, host)).toMatchObject({
      lifecycle: "none", outputEventName: "before-call", observation: {host, sessionId: "explicit-session", kind: "tool-boundary", actor: {kind: "main"}},
    });
    expect(isGovernanceHookTool(host, "owned:board")).toBe(true);
    expect(isGovernanceHookTool(host, prefix + "list_session_status")).toBe(false);
  });
  it("D0022 carries a bounded opaque strategy ID without choosing a builtin strategy", () => {
    registerHookHostAdapter("al04-opaque-attestation", {deliveryProfile: delivery, processPid: () => undefined, attestationKind: "other.strategy:v1"});
    expect(hookAttestationKind("al04-opaque-attestation")).toBe("other.strategy:v1");
    expect(hookAttestationKind("al04-unregistered")).toBeUndefined();
  });
  it.each(["", "../strategy", "x".repeat(201)])("D0022 rejects a malformed strategy ID %s", kind => {
    expect(() => registerHookHostAdapter("al04-invalid-strategy", {
      deliveryProfile: delivery, processPid: () => undefined, attestationKind: kind,
    })).toThrowError("Invalid hook host adapter.");
  });
});
