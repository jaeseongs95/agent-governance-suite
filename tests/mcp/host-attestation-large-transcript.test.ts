import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import * as diagnostics from "../../mcp-server/src/hook-error-diagnostics.js";
import {
  CLAUDE_TRANSCRIPT_LINE_MAX_BYTES,
  findToolUseObservation,
  observeClaudeExecution,
  probeIssuingMessage,
  type SessionModelRecord,
} from "../../mcp-server/src/host-attestation-hook.js";

// A live Claude Code session transcript reached 490 MB, and an 8 MiB whole-file limit refused every attested call
// with an anonymous GOVERNANCE_HOOK_FAILED. These fixtures are synthetic; no real transcript is read.
const SESSION = "large-transcript-session";
const CALL = "toolu_large_transcript_current";
const MODEL = "large-transcript-model";
const MiB = 1024 * 1024;
const now = () => new Date("2026-11-02T00:10:00.000Z");
const session: SessionModelRecord = { model: "large-transcript-session-model", source: "session-start", observedAt: "2026-11-02T00:00:00.000Z" };
const input = (transcript: string) => ({
  hook_event_name: "PreToolUse", session_id: SESSION, tool_use_id: CALL, transcript_path: transcript,
  tool_name: "mcp__agent_governance_suite__plan_workflow", tool_input: { taskId: "large-transcript-task" },
  effort: { level: "high" },
});

function issuing(fields: Record<string, unknown> = {}, id = CALL): string {
  return JSON.stringify({ type: "assistant", sessionId: SESSION, timestamp: "2026-11-02T00:09:00.000Z", effort: "high", ...fields,
    message: { model: MODEL, content: [{ type: "tool_use", id, name: "plan_workflow", input: {} }] } });
}

/** Unrelated history rows, mixed sizes (one longer than the read window), together at least `bytes` long. */
function history(bytes: number): string {
  const rows: string[] = [];
  let total = 0;
  for (let index = 0; total < bytes; index += 1) {
    const size = index % 50 === 7 ? MiB + 4099 : 512 + (index * 37) % 4000;
    const row = JSON.stringify({ type: "user", sessionId: SESSION, uuid: `history-${index}`,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_history_${index}`, content: "가".repeat(size / 3 | 0) }] } });
    rows.push(row);
    total += Buffer.byteLength(row) + 1;
  }
  return rows.join("\n");
}

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function file(content: string): string {
  const directory = mkdtempSync(path.join(tmpdir(), "ags-large-transcript-"));
  directories.push(directory);
  const transcript = path.join(directory, "transcript.jsonl");
  writeFileSync(transcript, content, "utf8");
  return transcript;
}
const older = history(9 * MiB);

describe("Claude transcript observation is independent of the file size", () => {
  it("(a) observes the issuing message at the end of a transcript over 8 MiB", () => {
    const transcript = file(older + "\n" + issuing() + "\n");
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toEqual({ model: MODEL, effort: "high", turnId: null, provenance: "claude-code:transcript-tool-use" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("(a) finds an issuing row that straddles a read window and is followed by later rows", () => {
    const row = issuing();
    // The newest 1 MiB window holds the later row and the second half of the issuing row; its first half is in the next one.
    const later = " ".repeat(MiB - Math.floor(row.length / 2) - 1);
    const content = older + "\n" + row + "\n" + later;
    const transcript = file(content);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now }))
      .toMatchObject({ model: MODEL, provenance: "claude-code:transcript-tool-use" });
    expect(findToolUseObservation(content, CALL, SESSION, null)).toMatchObject({ model: MODEL });
  });

  it("(b) falls back to the session model when a large transcript does not yet hold the issuing message", () => {
    const transcript = file(older + "\n" + issuing({}, "toolu_previous_call") + "\n");
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toEqual({ model: session.model, effort: "high", turnId: null, provenance: "claude-code:session-start" });
    expect(cache).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another session", { sessionId: "another-session" }],
    ["a sidechain", { isSidechain: true }],
  ])("(c) rejects an issuing message from %s instead of falling back", (_label, fields) => {
    const transcript = file(older + "\n" + issuing(fields) + "\n");
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("(c) reads the whole history: a rejected issuer far before the tail still blocks the fallback", () => {
    const transcript = file(issuing({ isSidechain: true }) + "\n" + older + "\n");
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toEqual({ unavailable: "CLAUDE_ISSUING_MESSAGE_REJECTED" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("(c) keeps an incomplete current issuer far before the tail indeterminate", () => {
    const damaged = issuing().slice(0, issuing().indexOf(CALL) + 5);
    const content = damaged + "\n" + older + "\n";
    const transcript = file(content);
    expect(probeIssuingMessage(content, CALL)).toEqual({ state: "indeterminate", reason: "CURRENT_CALL_INCOMPLETE" });
    const cache = vi.fn(() => session);
    expect(observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toEqual({ unavailable: "CURRENT_CALL_INCOMPLETE" });
    expect(cache).not.toHaveBeenCalled();
  });

  it("refuses one line over the line bound instead of truncating it, before any fallback", () => {
    const transcript = file(older + "\n" + " ".repeat(CLAUDE_TRANSCRIPT_LINE_MAX_BYTES + 1) + "\n" + issuing({}, "toolu_previous_call"));
    const cache = vi.fn(() => session);
    expect(() => observeClaudeExecution(input(transcript), { maxWaitMs: 0, now, readSessionModel: cache }))
      .toThrow("TRANSCRIPT_LINE_LIMIT_EXCEEDED");
    expect(cache).not.toHaveBeenCalled();
  });
});

describe("(d) the governance hook denial names the actual observation failure", () => {
  function hookEnvironment(): NodeJS.ProcessEnv {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-large-transcript-hook-"));
    directories.push(directory);
    return { ...process.env, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "state", "workflow.sqlite3") };
  }
  function captured() {
    const reported: Array<Record<string, unknown>> = [];
    vi.spyOn(diagnostics, "writeFailureDiagnostic").mockImplementation(serialized => { reported.push(JSON.parse(serialized)); });
    return reported;
  }

  it.each([
    ["an oversized line", () => file(" ".repeat(CLAUDE_TRANSCRIPT_LINE_MAX_BYTES + 1)), "TRANSCRIPT_LINE_LIMIT_EXCEEDED", undefined],
    ["an unreadable transcript", () => path.dirname(file("")), "TRANSCRIPT_READ_FAILED",
      process.platform === "win32" ? expect.stringMatching(/^E[A-Z]+$/u) : "EISDIR"],
  ])("denies %s with its own code", async (_label, transcript, reasonCode, causeReason) => {
    const reported = captured();
    const outcome = await runGovernanceHook("claude-code", JSON.stringify(input(transcript())), hookEnvironment());
    expect(outcome.ok).toBe(false);
    expect(JSON.parse(outcome.output)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse",
      permissionDecision: "deny", permissionDecisionReason: reasonCode } });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ component: "governance-hook", reasonCode, ...(causeReason ? { causeReason } : {}) });
  });

  it("admits a call over a large transcript that holds its issuing message", async () => {
    const reported = captured();
    const outcome = await runGovernanceHook("claude-code", JSON.stringify(input(file(older + "\n" + issuing() + "\n"))), hookEnvironment());
    expect(outcome).toEqual({ ok: true, output: "" });
    expect(reported).toEqual([]);
  });
});
