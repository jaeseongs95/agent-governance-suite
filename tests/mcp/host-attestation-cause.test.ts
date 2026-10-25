import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { hookFailureContext } from "../../mcp-server/src/hook-error-diagnostics.js";
import { HOST_ATTESTATION_FIELD, hostIdentityDigest } from "../../mcp-server/src/host-attestation.js";
import { handleHostAttestationHook, readSessionModel, writeSessionModel } from "../../mcp-server/src/host-attestation-hook.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const sessionId = "synthetic-cause-session";
const modelFile = `${hostIdentityDigest(sessionId)}.json`;
const stored = { model: "claude-opus-5", source: "session-start" as const, observedAt: "2026-09-19T00:10:00.000Z" };
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-attestation-cause-"));
  directories.push(directory);
  return directory;
}
function thrown(action: () => unknown): Error {
  try { action(); } catch (cause) { return cause as Error; }
  throw new Error("expected failure");
}

it("keeps the actual transcript read error as the cause of TRANSCRIPT_READ_FAILED", () => {
  let sessionReads = 0;
  const error = thrown(() => handleHostAttestationHook({
    hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: "synthetic-call", transcript_path: temp(),
    tool_name: "mcp__agent_governance_suite__plan_workflow",
    tool_input: { taskId: "synthetic-task", [HOST_ATTESTATION_FIELD]: "caller-forged" }, effort: { level: "high" },
  }, new InMemoryWorkflowStore(), { maxWaitMs: 0, readSessionModel: () => { sessionReads++; return stored; } }));
  expect(error.message).toBe("TRANSCRIPT_READ_FAILED");
  expect(sessionReads).toBe(0);
  expect(hookFailureContext(error)).toMatchObject({ type: "error", code: { type: "string" },
    cause: { type: "error", code: { type: "string" } } });
});

it("keeps the actual session model read and parse errors as causes", () => {
  const unreadable = temp();
  mkdirSync(path.join(unreadable, modelFile));
  const read = thrown(() => readSessionModel(unreadable, sessionId));
  expect(read.message).toBe("SESSION_MODEL_READ_FAILED");
  expect(hookFailureContext(read)).toMatchObject({ cause: { type: "error", code: { type: "string" } } });
  const damaged = temp();
  writeFileSync(path.join(damaged, modelFile), "{not-json", "utf8");
  const parsed = thrown(() => readSessionModel(damaged, sessionId));
  expect(parsed.message).toBe("SESSION_MODEL_INVALID");
  expect(hookFailureContext(parsed)).toMatchObject({ cause: { type: "syntax-error" } });
});

it("reports a session model directory failure as SESSION_MODEL_WRITE_FAILED with its cause", () => {
  const blocker = path.join(temp(), "blocker");
  writeFileSync(blocker, "", "utf8");
  const error = thrown(() => writeSessionModel(path.join(blocker, "host-models"), sessionId, stored));
  expect(error.message).toBe("SESSION_MODEL_WRITE_FAILED");
  expect(hookFailureContext(error)).toMatchObject({ code: { type: "string" }, cause: { type: "error", code: { type: "string" } } });
});

it("reports a failed final rename and leaves no temporary model record", () => {
  const directory = temp();
  mkdirSync(path.join(directory, modelFile, "occupied"), { recursive: true });
  const error = thrown(() => writeSessionModel(directory, sessionId, stored));
  expect(error.message).toBe("SESSION_MODEL_WRITE_FAILED");
  expect(hookFailureContext(error)).toMatchObject({ cause: { type: "error" } });
  expect(readdirSync(directory)).toEqual([modelFile]);
});
