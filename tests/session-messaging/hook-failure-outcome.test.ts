import { afterEach, beforeEach, expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../../mcp-server/src/session-message-client.js", async (original) => ({
  ...await original<typeof import("../../mcp-server/src/session-message-client.js")>(), sessionMessageRequest: f.request,
}));

import { runSessionMessageHook, runSessionMessageHookOutcome } from "../../mcp-server/src/session-message-hook.js";
import { hookFailure } from "../../mcp-server/src/hook-error-diagnostics.js";

const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "outcome-target" });

beforeEach(() => {
  f.request.mockReset();
  f.request.mockResolvedValue({ messages: [] });
  vi.stubEnv("AGENT_GOVERNANCE_CODEX_QUEUE_WAKE", "0");
  vi.stubEnv("AGENT_GOVERNANCE_ANTIGRAVITY_QUEUE_WAKE", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reports a normal empty claim as a successful outcome with no diagnostic", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runSessionMessageHookOutcome("claude-code", stop)).toEqual({ ok: true, output: "" });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("claim-turn-end");
  expect(diagnostic).not.toHaveBeenCalled();
});

it.each(["BROKER_DEADLINE_EXPIRED", "MESSAGING_BUSY"])("reports a messaging claim failure %s with its failed step and producer reason instead of an empty success", async (reason) => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockRejectedValueOnce(hookFailure(reason, "The session message operation did not run."));
  expect(await runSessionMessageHookOutcome("claude-code", stop)).toEqual({ ok: false, output: "",
    failure: { phase: "handle", reason, reasonBasis: "producer", producerReason: reason, step: "claim-turn-end" } });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(diagnostic.mock.calls[0]![0]).toContain('"phase":"handle","reason":"' + reason + '"');
  // 3.6.0: the failure names the broker operation that was in progress.
  expect(diagnostic.mock.calls[0]![0]).toContain('"step":"claim-turn-end"');
});

it("reports an input parse failure with its failed step", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runSessionMessageHookOutcome("codex", "{")).toEqual({ ok: false, output: "",
    failure: { phase: "input", reason: "INVALID_JSON", reasonBasis: "unverified-observation" } });
  expect(f.request).not.toHaveBeenCalled();
});

it("keeps the fail-open string API unchanged for both outcomes", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runSessionMessageHook("claude-code", stop)).toBe("");
  f.request.mockRejectedValueOnce(hookFailure("BROKER_DEADLINE_EXPIRED", "expired"));
  expect(await runSessionMessageHook("claude-code", stop)).toBe("");
  expect(await runSessionMessageHook("codex", "{")).toBe("");
});
