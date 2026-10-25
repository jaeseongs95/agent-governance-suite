import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/process-identity.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: () => "fixture-start-token",
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));

import { registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import type { ActorObservation, InputObservationKind } from "../../mcp-server/src/input-observation.js";
import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

const actors: ReadonlyArray<readonly [string, ActorObservation]> = [
  ["main", { kind: "main", assurance: "observed", observedBy: "p1:explicit-fixture" }],
  ["subagent", { kind: "subagent", assurance: "observed", observedBy: "p1:explicit-fixture" }],
  ["unknown", { kind: "unknown", assurance: "unknown", observedBy: "p1:explicit-fixture" }],
  ["asserted-main", { kind: "main", assurance: "self-asserted", observedBy: "p1:explicit-fixture" }],
  ["unobserved-main", { kind: "main", assurance: "unknown", observedBy: "p1:explicit-fixture" }],
  ["unobserved-subagent", { kind: "subagent", assurance: "unknown", observedBy: "p1:explicit-fixture" }],
];
const hostFor = (actor: string) => "p1-message-1026-a-" + actor;
for (const [name, actor] of actors) {
  registerHookHostAdapter(hostFor(name), {
    ownsTool: tool => tool.startsWith("owned__"), processPid: () => 4242,
    deliveryProfile: () => ({ transport: "claude-inbox", capabilities: {
      supportedInjection: ["user-input", "tool-boundary", "turn-end", "peer-wake"], idleWake: "none",
    }, blocksEmptyWakePrompt: false }),
    adaptInput: (input, host) => ({
      lifecycle: input.lifecycle === "start" || input.lifecycle === "end" ? input.lifecycle : "none",
      outputEventName: String(input.hook_event_name), observation: {
        host, sessionId: "p1-parent-session", actor,
        kind: input.kind as InputObservationKind,
        ...(input.boundaryPhase === "before" || input.boundaryPhase === "after" ? { boundaryPhase: input.boundaryPhase } : {}),
        toolName: String(input.tool_name ?? ""), toolInput: (input.tool_input ?? {}) as Record<string, unknown>,
      },
    }),
  });
}
const input = (event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event, agent_id: "payload-must-not-override-adapter", session_id: "forged-payload-session",
  kind: "unknown", ...extra,
});
const tool = (name: string) => input("PreToolUse", { kind: "tool-boundary", boundaryPhase: "before",
  tool_name: "owned__" + name, tool_input: { _sessionBinding: { host: "forged", sessionId: "forged" } } });
const messageInputs = [
  input("SessionStart", { lifecycle: "start" }), input("SessionEnd", { lifecycle: "end" }),
  input("UserPromptSubmit", { kind: "user-input" }),
  input("PostToolUse", { kind: "tool-boundary", boundaryPhase: "after" }),
  input("Stop", { kind: "turn-end" }),
];

beforeEach(() => {
  vi.clearAllMocks();
  f.request.mockReset().mockResolvedValue({ messages: [] });
  f.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("P1-ACTOR-1026-A message-only caller boundary", () => {
  it.each(actors.slice(1))("rejects %s before parent message presence, cleanup or automatic claims", async name => {
    for (const event of messageInputs) expect(await runSessionMessageHook(hostFor(name), JSON.stringify(event))).toBe("");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each([
    [0, "presence-start"], [1, "clear-deferred"], [2, "observe-native-input"], [3, "claim-deferred"], [4, "claim-turn-end"],
  ] as const)("keeps observed-main message operation %s/%s", async (index, operation) => {
    expect(await runSessionMessageHook(hostFor("main"), JSON.stringify(messageInputs[index]))).toBe("");
    expect(f.request).toHaveBeenCalledWith(operation, expect.objectContaining({ target: {
      host: hostFor("main"), sessionId: "p1-parent-session",
    } }), undefined, expect.any(Object));
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.spawn).toHaveBeenCalledTimes(index === 0 ? 1 : 0);
  });

  it.each(actors.slice(1))("keeps the existing main-tool denial for %s without issuing a parent binding", async name => {
    for (const operation of ["prepare_session_message", "send_session_message", "acknowledge_session_messages", "get_session_message_status"]) {
      const output = JSON.parse(await runSessionMessageHook(hostFor(name), JSON.stringify(tool(operation))));
      expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
      expect(output.hookSpecificOutput).not.toHaveProperty("updatedInput");
    }
    expect(f.request).not.toHaveBeenCalled();
  });

  it("binds observed-main identity while leaving host approval undecided", async () => {
    const host = hostFor("main");
    const output = JSON.parse(await runSessionMessageHook(host, JSON.stringify(tool("send_session_message"))));
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.hookSpecificOutput.updatedInput._sessionBinding).toEqual({ host, sessionId: "p1-parent-session" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it("keeps collaboration-validator actor provenance distinct from parent message authority", async () => {
    const host = hostFor("subagent");
    const output = JSON.parse(await runSessionMessageHook(host, JSON.stringify(tool("validate_collaboration_decision"))));
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.hookSpecificOutput.updatedInput._sessionBinding).toEqual({ host, sessionId: "p1-parent-session",
      actorKind: "subagent", observedBy: "p1:explicit-fixture", assurance: "observed" });
    expect(f.request).not.toHaveBeenCalled();
  });
});
