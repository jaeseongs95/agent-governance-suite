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
import {adaptHostInput, hostDeliveryProfile, isGovernanceHookTool, registerHookHostAdapter, type HookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
import {handleSessionBoardHook, runSessionBoardHook} from "../../mcp-server/src/session-board-hook.js";

import type {ActorObservation} from "../../mcp-server/src/input-observation.js";

const board = {close: f.close} as unknown as NonNullable<Parameters<typeof handleSessionBoardHook>[1]>;
const now = "2026-10-25T00:00:00.000Z";
// Explicit synthetic adapter for mocked board-core cases; not native evidence.
const syntheticHost = "synthetic-al04-board";
const syntheticRoot: ActorObservation = {role: "root", basis: "observed", reasonCode: "SYNTHETIC_BOARD_ROOT"};
registerHookHostAdapter(syntheticHost, {
  deliveryProfile: () => ({transport: "claude-inbox", capabilities: {supportedInjection: [], idleWake: "none"}, blocksEmptyWakePrompt: false}),
  processPid: () => undefined, ownsTool: name => isGovernanceHookTool("codex", name),
  adaptInput: (payload, host) => {const mapped = adaptHostInput(payload, "codex"); return {...mapped, observation: {...mapped.observation, host,
    actor: payload.syntheticActor as ActorObservation}};},
});

const tool = (name: string, actor: Record<string, unknown> = {syntheticActor: syntheticRoot}) => ({
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

// The board hook no longer handles AGS tools: the server writes the summary after verifying the caller.
describe("AL04 board actor, namespace and host permission boundaries", () => {
  it.each(["list_session_status", "update_session_status"])("D0018 passes a subagent %s through without writing its parent row", name => {
    const output = handleSessionBoardHook(tool(prefix + name, {syntheticActor: {role: "child", basis: "observed", reasonCode: "SYNTHETIC_BOARD_CHILD"}}), board, syntheticHost, now);
    expect(output).toEqual({});
    noWrites();
  });
  it.each([{}, {agent_id: null}, {agent_id: 42}])("D0019 keeps unknown actor %j from binding, writing or consuming parent wakes", async actor => {
    const output = await runSessionBoardHook("gemini", JSON.stringify(tool(prefix + "list_session_status", actor)));
    expect(output).toBe("");
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(await runSessionBoardHook("gemini", JSON.stringify({hook_event_name: event, session_id: "AL04_PRIVATE_PARENT", ...actor,
        ...(event === "SessionStart" && Object.keys(actor).length === 0 ? {agent_type: "unproven"} : {}),
        prompt: `[agent-governance-suite:wake:${"a".repeat(32)}]`}))).toBe("");
    }
    expect(f.open).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); noWrites();
  });
  it.each([
    "mcp__foreign__update_session_status", "mcp__agent_governance_suite_other__list_session_status",
    "mcp__foreign__mcp__agent_governance_suite__list_session_status", "list_session_status",
  ])("D0021 does not bind or allow a foreign tool %s", name => {
    expect(handleSessionBoardHook(tool(name), board, syntheticHost, now)).toEqual({}); noWrites();
  });
  it("does not turn coordination into an ordinary-tool gate", () => {
    f.gate.mockReturnValue("deny");
    expect(handleSessionBoardHook(tool("apply_patch"), board, syntheticHost, now)).toEqual({});
    expect(f.gate).not.toHaveBeenCalled();
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
      lifecycle: "none", outputEventName: "", observation: {host: "al04-delivery-only", sessionId: "", kind: "unknown", actor: {role: "indeterminate", basis: "unavailable", reasonCode: "HOST_ACTOR_OBSERVATION_UNAVAILABLE"}},
    });
    expect(isGovernanceHookTool("al04-delivery-only", prefix + "list_session_status")).toBe(false);
  });
  it("D0028 accepts another host input schema only through its explicit adapter", () => {
    const host = "al04-explicit-shape";
    registerHookHostAdapter(host, {deliveryProfile: delivery, processPid: () => undefined,
      ownsTool: name => name === "owned:board",
      adaptInput: (input, configuredHost) => ({lifecycle: "none", outputEventName: "before-call", observation: {
        host: configuredHost, sessionId: String(input.conversation), kind: "tool-boundary", boundaryPhase: "before",
        actor: {role: "root", basis: "observed", reasonCode: "SYNTHETIC_CONFIGURED_BOARD_ROOT"}, toolName: "owned:board", toolInput: {},
      }}),
    });
    expect(adaptHostInput({conversation: "explicit-session", hook_event_name: "SessionEnd", agent_id: "unrelated"}, host)).toMatchObject({
      lifecycle: "none", outputEventName: "before-call", observation: {host, sessionId: "explicit-session", kind: "tool-boundary", actor: {role: "root", basis: "observed"}},
    });
    expect(isGovernanceHookTool(host, "owned:board")).toBe(true);
    expect(isGovernanceHookTool(host, prefix + "list_session_status")).toBe(false);
  });
});
