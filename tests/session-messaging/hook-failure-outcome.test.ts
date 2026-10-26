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
  vi.stubEnv("AGENT_GOVERNANCE_GEMINI_QUEUE_WAKE", "0");
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("reports a normal empty claim as a successful outcome with no diagnostic", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  expect(await runSessionMessageHookOutcome("claude-code", stop)).toEqual({ ok: true, output: "" });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(f.request.mock.calls[0]![0]).toBe("claim-turn-end");
  expect(diagnostic).not.toHaveBeenCalled();
});

it("reports a broker claim failure with its failed step and producer reason instead of an empty success", async () => {
  const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {});
  f.request.mockRejectedValueOnce(hookFailure("BROKER_DEADLINE_EXPIRED", "The session message request deadline expired."));
  expect(await runSessionMessageHookOutcome("claude-code", stop)).toEqual({ ok: false, output: "",
    failure: { phase: "handle", reason: "BROKER_DEADLINE_EXPIRED", reasonBasis: "producer", producerReason: "BROKER_DEADLINE_EXPIRED" } });
  expect(f.request).toHaveBeenCalledTimes(1);
  expect(diagnostic).toHaveBeenCalledTimes(1);
  expect(diagnostic.mock.calls[0]![0]).toContain('"phase":"handle","reason":"BROKER_DEADLINE_EXPIRED"');
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
