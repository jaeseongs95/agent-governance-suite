import { beforeEach, expect, it, vi } from "vitest";

const sink = vi.hoisted(() => ({ write: vi.fn((fd: number, data: unknown) => { void fd; void data; throw new Error("private diagnostic sink failure"); }) }));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(), writeSync: sink.write }));
import { HOST_ATTESTATION_FIELD } from "../../mcp-server/src/host-attestation.js";
import { handleHostAttestationHook } from "../../mcp-server/src/host-attestation-hook.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

beforeEach(() => { sink.write.mockClear(); });

it.each([
  ['{"type":"assistant","id":"d0179-current"', "CURRENT_CALL_INVALID_JSON"],
  ['{"type":"assistant","message":{"content":"d0179-current"}}', "CURRENT_CALL_INVALID_SHAPE"],
])("does not resume signing when the bounded diagnostic sink fails: %s", (transcript, reason) => {
  const store = new InMemoryWorkflowStore();
  const key = vi.spyOn(store, "getOrCreateSecret");
  const cache = vi.fn(() => ({ model: "claude-opus-5", source: "session-start" as const, observedAt: new Date().toISOString() }));
  const clean = { taskId: "d0179-sink", marker: "private-args-marker" };
  try {
    const output = handleHostAttestationHook({ hook_event_name: "PreToolUse", session_id: "private-session-marker",
      tool_use_id: "d0179-current", transcript_path: "synthetic-only/transcript.jsonl",
      tool_name: "mcp__agent_governance_suite__plan_workflow", effort: { level: "high" },
      tool_input: { ...clean, [HOST_ATTESTATION_FIELD]: "aghs1.private.forged" } },
      store, { maxWaitMs: 0, sleep: () => {}, readText: () => transcript, readSessionModel: cache });
    expect(output).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: clean } });
    expect(cache).not.toHaveBeenCalled(); expect(key).not.toHaveBeenCalled();
    expect(sink.write).toHaveBeenCalledTimes(1);
    const diagnostic = String(sink.write.mock.calls[0]?.[1]);
    for (const marker of ["private-session-marker", "private-args-marker", "aghs1.private.forged", "synthetic-only", transcript])
      expect(diagnostic).not.toContain(marker);
    expect(diagnostic).toContain('"phase":"fallback"');
    expect(JSON.parse(diagnostic)).toMatchObject({ component: "host-attestation-hook", phase: "fallback", reason });
  } finally { key.mockRestore(); }
});
