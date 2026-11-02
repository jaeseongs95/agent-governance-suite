import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { observeClaudeExecution, readSessionModel, writeSessionModel } from "../../mcp-server/src/host-attestation-hook.js";

const sessionId = "synthetic-observation-failure";
const toolUseId = "synthetic-current-call";
const caller = {
  hook_event_name: "PreToolUse", session_id: sessionId, tool_use_id: toolUseId,
  transcript_path: "synthetic/transcript.jsonl",
  tool_name: "mcp__agent_governance_suite__plan_workflow",
  tool_input: { taskId: "synthetic-task" },
  effort: { level: "high" },
};
const session = { model: "claude-opus-5", source: "session-start" as const, observedAt: "2026-09-19T00:10:00.000Z" };
const oldLine = JSON.stringify({ type: "assistant", sessionId, timestamp: "2026-09-19T00:10:10.000Z",
  message: { model: "claude-opus-5", content: [] } });
const now = () => new Date("2026-09-19T00:11:00.000Z");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temp() {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-attestation-failure-"));
  directories.push(directory);
  return directory;
}

// Malformed-current, partial polling and genuine-absence controls are retained in
// host-attestation.test.ts (AGS-D-0179) and host-attestation-d0179-sink.test.ts.
function fixedCodeContext(reason: string) {
  return { type: "error", code: { type: "string", length: reason.length,
    prefixCodeUnits: reason.length, truncated: false, encoding: "utf16le",
    prefixSha256: createHash("sha256").update(Buffer.from(reason, "utf16le")).digest("hex") } };
}

it("propagates an unreadable transcript without consulting a fallback model", () => {
  let sessionReads = 0;
  expect(() => observeClaudeExecution({ ...caller, transcript_path: temp() }, {
    now, maxWaitMs: 0, readSessionModel: () => { sessionReads++; return session; },
  })).toThrow("TRANSCRIPT_READ_FAILED");
  expect(sessionReads).toBe(0);
});

it.each(["{not-json", "null", "[]", '{"model":"claude-opus-5"}'])(
  "does not sign from valid old history after a damaged model record: %s", (damaged) => {
    const directory = temp();
    writeSessionModel(directory, sessionId, session);
    const file = path.join(directory, readdirSync(directory)[0]!);
    writeFileSync(file, damaged, "utf8");
    expect(readSessionModel(directory, "missing")).toBeNull();
    expect(() => observeClaudeExecution(caller, {
      now, maxWaitMs: 0, readText: () => oldLine,
      readSessionModel: () => readSessionModel(directory, sessionId),
    })).toThrow("SESSION_MODEL_INVALID");
  },
);

it.each(["null", "[]", "42", '"primitive"', '{"synthetic-secret":'])(
  "contains invalid CLI input without a secondary crash or raw input diagnostic: %s", (input) => {
    const directory = temp();
    const bundle = fileURLToPath(new URL("../../mcp-server/dist/host-attestation-hook.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [bundle, "--host=synthetic-host"], {
      input, cwd: directory, encoding: "utf8", windowsHide: true, timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    const diagnostic = JSON.parse(result.stderr.trim());
    const reason = input.startsWith("{") ? "INVALID_JSON" : "INVALID_HOOK_INPUT";
    expect(diagnostic).toEqual({ component: "host-attestation-hook", phase: "input", reason,
      context: reason === "INVALID_JSON" ? { type: "syntax-error" } : fixedCodeContext(reason) });
    expect(result.stderr).not.toContain("synthetic-secret");
    expect(readdirSync(directory)).toEqual([]);
  },
);

it("preserves default-reader ENOENT as normal absence with a valid interactive session record", () => {
  const execution = observeClaudeExecution({ ...caller, transcript_path: path.join(temp(), "missing.jsonl") }, {
    now, maxWaitMs: 0, readSessionModel: () => session,
  });
  expect(execution).toMatchObject({ model: "claude-opus-5", effort: "high", provenance: "claude-code:session-start" });
});

it("does not sign from older history when the actual session cache file is unreadable", () => {
  const directory = temp();
  writeSessionModel(directory, sessionId, session);
  const file = path.join(directory, readdirSync(directory)[0]!);
  unlinkSync(file);
  mkdirSync(file);
  expect(() => observeClaudeExecution(caller, {
    now, maxWaitMs: 0, readText: () => oldLine,
    readSessionModel: () => readSessionModel(directory, sessionId),
  })).toThrow("SESSION_MODEL_READ_FAILED");
});

it("denies the call and diagnoses a real observation read failure through the packaged governance hook", () => {
  const directory = temp();
  const databasePath = path.join(directory, "state", "workflow.sqlite3");
  writeSessionModel(path.join(path.dirname(databasePath), "host-models"), sessionId, session);
  const bundle = fileURLToPath(new URL("../../mcp-server/dist/governance-hook.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [bundle, "--host=claude-code"], {
    input: JSON.stringify({ ...caller, transcript_path: directory }), cwd: directory,
    encoding: "utf8", windowsHide: true, timeout: 10_000,
    env: { ...process.env, NODE_NO_WARNINGS: "1", AGENT_GOVERNANCE_DB_PATH: databasePath },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse",
    permissionDecision: "deny", permissionDecisionReason: "TRANSCRIPT_READ_FAILED" } });
  expect(JSON.parse(result.stderr.trim())).toEqual({
    component: "governance-hook", reasonCode: "TRANSCRIPT_READ_FAILED",
    causeReason: process.platform === "win32" ? expect.stringMatching(/^E[A-Z]+$/u) : "EISDIR",
    context: { ...fixedCodeContext("TRANSCRIPT_READ_FAILED"), cause: expect.objectContaining({ type: "error" }) },
  });
  expect(result.stderr).not.toContain(directory);
  expect(result.stderr).not.toContain("synthetic-task");
});
