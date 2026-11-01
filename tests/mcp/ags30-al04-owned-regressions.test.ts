import {afterEach, beforeEach, describe, expect, it, vi} from "vitest";

const f = vi.hoisted(() => ({
  open: vi.fn(), close: vi.fn(), prune: vi.fn(), input: vi.fn(), summary: vi.fn(), request: vi.fn(),
}));
vi.mock("../../skills/session-board/scripts/board-store.mjs", async original => ({
  ...await original<typeof import("../../skills/session-board/scripts/board-store.mjs")>(),
  openBoard: f.open, pruneBoard: f.prune, recordInput: f.input, setSummary: f.summary,
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import {adaptHostInput, hookAttestationKind, hostDeliveryProfile, isGovernanceHookTool, registerHookHostAdapter, type HookHostAdapter} from "../../mcp-server/src/host-input-adapter.js";
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
const prompt = (actor: Record<string, unknown> = {syntheticActor: syntheticRoot}) => ({
  hook_event_name: "UserPromptSubmit", session_id: "AL04_PRIVATE_PARENT", cwd: "/al04/work", prompt: "AL04 비밀 요청", ...actor,
});
const prefix = "mcp__agent_governance_suite__";
function noWrites() {
  for (const mock of [f.prune, f.input, f.summary]) expect(mock).not.toHaveBeenCalled();
}
beforeEach(() => {
  for (const mock of Object.values(f)) mock.mockReset();
  f.open.mockReturnValue(board);
});
afterEach(() => {vi.restoreAllMocks();});

describe("AL04 board actor, namespace and host permission boundaries", () => {
  it.each([{}, {agent_id: null}, {agent_id: 42}])("D0019 keeps unknown actor %j from writing or consuming parent wakes", async actor => {
    expect(await runSessionBoardHook("gemini", JSON.stringify(tool(prefix + "list_session_status", actor)))).toBe("");
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      expect(await runSessionBoardHook("gemini", JSON.stringify({hook_event_name: event, session_id: "AL04_PRIVATE_PARENT", ...actor,
        ...(event === "SessionStart" && Object.keys(actor).length === 0 ? {agent_type: "unproven"} : {}),
        prompt: `[agent-governance-suite:wake:${"a".repeat(32)}]`}))).toBe("");
    }
    expect(f.open).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled(); noWrites();
  });
  it("D0018 never writes the parent row from a subagent prompt", () => {
    expect(handleSessionBoardHook(prompt({syntheticActor: {role: "child", basis: "observed", reasonCode: "SYNTHETIC_BOARD_CHILD"}}), board, syntheticHost, now)).toEqual({});
    noWrites();
  });
  it.each([
    "mcp__agent_governance_suite__update_session_status", "mcp__agent-governance-suite__list_session_status",
    "mcp__plugin_agent-governance-suite_agent-governance-suite__update_session_status",
    "mcp__foreign__update_session_status", "list_session_status", "apply_patch",
  ])("D0020/D0021 the board hook neither binds, decides nor writes for tool %s (the governance hook owns binding)", name => {
    expect(handleSessionBoardHook(tool(name), board, syntheticHost, now)).toEqual({}); noWrites();
  });
  it("records only the prompt time and working directory of a root prompt", () => {
    expect(handleSessionBoardHook(prompt(), board, syntheticHost, now)).toEqual({});
    expect(f.input).toHaveBeenCalledWith(board, {host: syntheticHost, sessionId: "AL04_PRIVATE_PARENT", cwd: "/al04/work", now}, {prompt: true});
    expect(JSON.stringify(f.input.mock.calls)).not.toContain("AL04 비밀 요청");
    expect(f.summary).not.toHaveBeenCalled();
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
