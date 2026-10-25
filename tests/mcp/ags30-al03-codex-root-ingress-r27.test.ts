import { beforeEach, describe, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async original => ({ ...await original<typeof import("node:child_process")>(), spawn: f.spawn }));
vi.mock("../../mcp-server/src/process-identity.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/process-identity.js")>(), processStartToken: () => "fixture-start-token",
}));
vi.mock("../../mcp-server/src/session-message-client.js", async original => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput, registerHookHostAdapter } from "../../mcp-server/src/host-input-adapter.js";
import { runSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";

// Codex rust-v0.163.0 / 83086188: schema.rs 499-523 contains no actor fields.
const wire = (event: string) => ({ session_id: "root-ingress-fixture", transcript_path: null,
  cwd: "/synthetic", hook_event_name: event,
  ...(event === "SessionStart" ? { model: "synthetic", permission_mode: "default", source: "startup" } : { reason: "other" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  f.request.mockReset().mockResolvedValue({ messages: [] });
  f.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
});

describe("Codex native root lifecycle ingress contract", () => {
  it.each([["SessionStart", "presence-start"], ["SessionEnd", "clear-deferred"]])("accepts the official actor-free %s wire at its registered adapter", async (event, operation) => {
    const input = wire(event!);
    expect(input).not.toHaveProperty("agent_id");
    expect(input).not.toHaveProperty("agent_type");
    expect(adaptHostInput(input, "codex").observation.actor).toEqual({
      kind: "main", assurance: "observed", observedBy: "codex:native-root-lifecycle",
    });
    expect(await runSessionMessageHook("codex", JSON.stringify(input), 4242)).toBe("");
    expect(f.request).toHaveBeenCalledWith(operation, expect.objectContaining({ target: {
      host: "codex", sessionId: "root-ingress-fixture",
    } }), undefined, expect.any(Object));
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it.each(["SessionStart", "SessionEnd"])("rejects explicit child, malformed or conflicting %s actor evidence before message I/O", async event => {
    for (const actor of [{ agent_id: "child" }, { agent_id: null }, { agent_id: 42 },
      { agent_type: "main" }, { agent_id: "", agent_type: "main" }]) {
      const input = { ...wire(event), ...actor };
      expect(adaptHostInput(input, "codex").observation.actor.kind).not.toBe("main");
      expect(await runSessionMessageHook("codex", JSON.stringify(input), 4242)).toBe("");
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["UserPromptSubmit", "PostToolUse", "PreToolUse", "Stop"])("keeps actor omission UNKNOWN for %s", event => {
    expect(adaptHostInput({ ...wire(event), role: "main", host: "codex" }, "codex").observation.actor)
      .toMatchObject({ kind: "unknown", assurance: "unknown" });
  });

  it("does not extend Codex root semantics to an opaque delivery-only adapter", () => {
    const host = "al03-root-ingress-opaque";
    registerHookHostAdapter(host, { processPid: () => 4242, deliveryProfile: () => ({
      transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false,
    }) });
    expect(adaptHostInput({ ...wire("SessionStart"), host: "codex", role: "main", agent_id: "" }, host).observation.actor)
      .toMatchObject({ kind: "unknown", assurance: "unknown" });
    expect(() => adaptHostInput(wire("SessionStart"), "al03-root-ingress-unregistered")).toThrow();
  });
});
