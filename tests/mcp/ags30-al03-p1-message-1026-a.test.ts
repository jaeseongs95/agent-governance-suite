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

// Explicit synthetic adapter contract cases; not native captures.
const actors: ReadonlyArray<readonly [string, ActorObservation]> = [
  ["root-observed", { role: "root", basis: "observed", reasonCode: "SYNTHETIC_ROOT_OBSERVED" }],
  ["root-inferred", { role: "root", basis: "inferred", reasonCode: "SYNTHETIC_ROOT_INFERRED" }],
  ["child-observed", { role: "child", basis: "observed", reasonCode: "SYNTHETIC_CHILD_OBSERVED" }],
  ["child-inferred", { role: "child", basis: "inferred", reasonCode: "SYNTHETIC_CHILD_INFERRED" }],
  ["indeterminate", { role: "indeterminate", basis: "unavailable", reasonCode: "SYNTHETIC_INDETERMINATE" }],
  ["root-unavailable", { role: "root", basis: "unavailable", reasonCode: "SYNTHETIC_ROOT_UNAVAILABLE" }],
];
const acceptedActors = actors.slice(0, 2);
const rejectedActors = actors.slice(2);
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
        host, sessionId: "p1-parent-session", callId: "synthetic-p1-call", actor,
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
  it.each(rejectedActors)("rejects %s before parent message presence, cleanup or automatic claims", async name => {
    for (const event of messageInputs) expect(await runSessionMessageHook(hostFor(name), JSON.stringify(event))).toBe("");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(acceptedActors)("keeps accepted synthetic %s message operations", async name => {
    for (const [index, operation] of [
    [0, "presence-start"], [1, "clear-deferred"], [2, "observe-native-input"], [3, "claim-deferred"], [4, "claim-turn-end"],
    ] as const) {
      f.request.mockClear(); f.spawn.mockClear();
      expect(await runSessionMessageHook(hostFor(name), JSON.stringify(messageInputs[index]))).toBe("");
      expect(f.request).toHaveBeenCalledWith(operation, expect.objectContaining({ target: {
        host: hostFor(name), sessionId: "p1-parent-session",
      } }), undefined, expect.any(Object));
      expect(f.request).toHaveBeenCalledTimes(1);
      expect(f.spawn).toHaveBeenCalledTimes(index === 0 ? 1 : 0);
    }
  });

  it.each(rejectedActors)("keeps the existing main-tool denial for %s without issuing a parent binding", async name => {
    for (const operation of ["prepare_session_message", "send_session_message", "acknowledge_session_messages", "get_session_message_status"]) {
      const output = JSON.parse(await runSessionMessageHook(hostFor(name), JSON.stringify(tool(operation))));
      expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
      expect(output.hookSpecificOutput).not.toHaveProperty("updatedInput");
    }
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(acceptedActors)("binds accepted synthetic %s identity while leaving host approval undecided", async name => {
    const host = hostFor(name);
    const output = JSON.parse(await runSessionMessageHook(host, JSON.stringify(tool("send_session_message"))));
    expect(output.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(output.hookSpecificOutput.updatedInput._sessionBinding).toMatchObject({ host, sessionId: "p1-parent-session" });
    expect(f.request).not.toHaveBeenCalled();
  });

  it.each(rejectedActors)("denies collaboration validation for synthetic %s before issuing a binding", async name => {
    const output = JSON.parse(await runSessionMessageHook(hostFor(name), JSON.stringify(tool("validate_collaboration_decision"))));
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(output.hookSpecificOutput).not.toHaveProperty("updatedInput");
    expect(f.request).not.toHaveBeenCalled();
  });
});
