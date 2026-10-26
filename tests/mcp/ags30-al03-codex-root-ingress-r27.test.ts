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

// Synthetic actor-free input; it is not a native capture or R7 evidence.
const wire = (event: string) => ({ session_id: "root-ingress-fixture", transcript_path: null,
  cwd: "/synthetic", hook_event_name: event,
  ...(event === "SessionStart" ? { model: "synthetic", permission_mode: "default", source: "startup" } : { reason: "other" }),
});

beforeEach(() => {
  vi.clearAllMocks();
  f.request.mockReset().mockResolvedValue({ messages: [] });
  f.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
});

describe("Codex actor observation remains unavailable pending native capture", () => {
  it.each(["SessionStart", "SessionEnd"])("does not authorize actor-free synthetic %s lifecycle input", async event => {
    const input = wire(event);
    expect(adaptHostInput(input, "codex").observation.actor).toEqual({
      role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED",
    });
    expect(await runSessionMessageHook("codex", JSON.stringify(input), 4242)).toBe("");
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["SessionStart", "SessionEnd"])("rejects explicit child, malformed or conflicting %s actor evidence before message I/O", async event => {
    for (const actor of [{ agent_id: "child" }, { agent_id: null }, { agent_id: 42 },
      { agent_type: "main" }, { agent_id: "", agent_type: "main" }]) {
      const input = { ...wire(event), ...actor };
      expect(adaptHostInput(input, "codex").observation.actor).toEqual({ role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" });
      expect(await runSessionMessageHook("codex", JSON.stringify(input), 4242)).toBe("");
    }
    expect(f.request).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it.each(["UserPromptSubmit", "PostToolUse", "PreToolUse", "Stop"])("keeps actor omission indeterminate for %s", event => {
    expect(adaptHostInput({ ...wire(event), role: "main", host: "codex" }, "codex").observation.actor)
      .toMatchObject({ role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_CAPTURE_REQUIRED" });
  });

  it("does not extend Codex root semantics to an opaque delivery-only adapter", () => {
    const host = "al03-root-ingress-opaque";
    registerHookHostAdapter(host, { processPid: () => 4242, deliveryProfile: () => ({
      transport: "claude-inbox", capabilities: { supportedInjection: [], idleWake: "none" }, blocksEmptyWakePrompt: false,
    }) });
    expect(adaptHostInput({ ...wire("SessionStart"), host: "codex", role: "main", agent_id: "" }, host).observation.actor)
      .toMatchObject({ role: "indeterminate", basis: "unavailable", reasonCode: "HOST_ACTOR_OBSERVATION_UNAVAILABLE" });
    expect(() => adaptHostInput(wire("SessionStart"), "al03-root-ingress-unregistered")).toThrow();
  });
});
