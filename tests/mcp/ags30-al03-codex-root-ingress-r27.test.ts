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

// Synthetic actor-free input; it is not a native capture or R7 evidence.
const wire = (event: string) => ({ session_id: "root-ingress-fixture", transcript_path: null,
  cwd: "/synthetic", hook_event_name: event,
  ...(event === "SessionStart" ? { model: "synthetic", permission_mode: "default", source: "startup" } : { reason: "other" }),
});
const inferredRoot = { role: "root", basis: "inferred", reasonCode: "CODEX_ROOT_INFERRED_CHILD_GATE_DEFERRED" };

beforeEach(() => {
  vi.clearAllMocks();
  f.request.mockReset().mockResolvedValue({ messages: [] });
  f.spawn.mockReturnValue({ once: vi.fn(), unref: vi.fn() });
});

// Missing native child markers retain the 3.0 stopgap; positive markers are handled separately.
describe("Codex actor observation preserves the marker-free root stopgap", () => {
  it.each(["SessionStart", "SessionEnd", "UserPromptSubmit", "PostToolUse", "PreToolUse", "Stop"])("infers root for %s", event => {
    expect(adaptHostInput(wire(event), "codex").observation.actor).toEqual(inferredRoot);
  });

  it.each(["SessionStart", "SessionEnd"])("does not let generic actor claims change the %s decision", event => {
    for (const actor of [{ agent_type: "main" }, { role: "child", basis: "observed" }]) {
      expect(adaptHostInput({ ...wire(event), ...actor }, "codex").observation.actor).toEqual(inferredRoot);
    }
  });

  it("keeps an empty Codex session ID indeterminate", () => {
    expect(adaptHostInput({ ...wire("PreToolUse"), session_id: "" }, "codex").observation.actor)
      .toEqual({ role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_SESSION_ID_INVALID" });
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
