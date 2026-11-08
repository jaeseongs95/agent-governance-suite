import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { environmentFailureKey } from "../../mcp-server/src/environment-failure.js";

// AGS3-D-0049 recurrence (2026-11-08, case 281): the runbook was not read before a run, so the run failed for a missing
// program, the agent fixed that one thing and ran again, and the next missing condition failed the next run. The rules
// reach the agent at a session start and a user message, not at the step where a run has just failed. Fix under test: the
// step after a tool result that shows a missing program, path or permission says to read the guide and set every condition.
const CUE = "[AGS run check]";
const S = "d0049-root-session";

let directory = "";
let environment: NodeJS.ProcessEnv = {};
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-d0049-"));
  environment = {
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: path.join(directory, "layers.sqlite3"),
  };
  vi.stubEnv("AGENT_GOVERNANCE_DB_PATH", environment.AGENT_GOVERNANCE_DB_PATH!);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function hookText(host: string, input: Record<string, unknown>): string {
  const output = runContinuityHook(JSON.stringify({ cwd: tmpdir(), ...input }), environment, host, true);
  if (!output) return "";
  return (JSON.parse(output) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? "";
}

const after = (tool: string, response: unknown, call = "call-1", extra: Record<string, unknown> = {}) => ({
  hook_event_name: "PostToolUse", session_id: S, turn_id: "t", tool_name: tool, tool_input: {}, tool_response: response, tool_use_id: call, ...extra,
});

// The three failures of the 2026-11-08 run, as the tools returned them, and one shape per message family.
const FAILURES = [
  ["python", "FileNotFoundError: [WinError 2] 지정된 파일을 찾을 수 없습니다"],
  ["tmux", "couldn't create directory /tmp/tmux-1001 (Permission denied)"],
  ["windows python", "Python 3 was not found; run without arguments to install"],
  ["posix shell", "bash: git-does-not-exist-xyz: command not found"],
  ["cmd", "'git' is not recognized as an internal or external command"],
  ["node", "Error: spawnSync python ENOENT"],
] as const;

describe("AGS3-D-0049 a run that failed for a missing program, path or permission", () => {
  it.each(FAILURES)("recognizes %s", (_name, failure) => {
    expect(environmentFailureKey(failure)).not.toBeNull();
  });

  it.each(["all 12 tests passed", "the fix was not found to regress", "Exit code 0", ""])("does not take %j for one", (result) => {
    expect(environmentFailureKey(result)).toBeNull();
  });

  it.each(["codex", "claude-code"] as const)("%s: the step after it carries the check, for a shell or any other tool", (host) => {
    expect(hookText(host, after("Bash", "bash: gitx: command not found"))).toContain(CUE);
    expect(hookText(host, after("mcp__remote__observe", { ok: true, stderr: "FileNotFoundError: x" }, "call-2"))).toContain(CUE);
  });

  it("a subagent's failed run gets the check too", () => {
    expect(hookText("claude-code", after("Bash", "bash: gitx: command not found", "call-1", { agent_id: "a1", agent_type: "worker" }))).toContain(CUE);
  });

  it("shows once per failure: the same failure again adds nothing and a different one shows again", () => {
    expect(hookText("codex", after("Bash", "bash: gitx: command not found"))).toContain(CUE);
    expect(hookText("codex", after("Bash", "bash: gitx: command not found", "call-2"))).not.toContain(CUE);
    expect(hookText("codex", after("Bash", "tmux: /tmp/tmux-1 (Permission denied)", "call-3"))).toContain(CUE);
  });

  it("stays silent for a successful run and for a tool that returns a file's text", () => {
    expect(hookText("codex", after("Bash", "ok"))).not.toContain(CUE);
    expect(hookText("claude-code", after("Read", { file: { content: "Python 3 was not found" } }))).not.toContain(CUE);
    expect(hookText("claude-code", after("Grep", "ENOENT in a log", "call-2"))).not.toContain(CUE);
  });

  it("reads only the tail of a large result", () => {
    expect(hookText("codex", after("Bash", `FileNotFoundError ${"x".repeat(70_000)}`))).not.toContain(CUE);
    expect(hookText("codex", after("Bash", `${"x".repeat(70_000)} FileNotFoundError`, "call-2"))).toContain(CUE);
  });

  describe("antigravity, whose hook inputs carry no tool output (agy 1.5.3 capture)", () => {
    const line = (entry: Record<string, unknown>) => `${JSON.stringify(entry)}\n`;
    const model = line({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "gitx" } }] });
    const step = (body: string) => {
      const transcript = path.join(directory, "transcript.jsonl");
      writeFileSync(transcript, body);
      return { hook_event_name: "PostInvocation", session_id: S, transcript_path: transcript };
    };

    it("takes the output after the last model call from the transcript", () => {
      expect(hookText("antigravity", step(model + line({ step_index: 2, type: "COMMAND", content: "bash: gitx: command not found" })))).toContain(CUE);
    });

    it("does not read what came before the last model call", () => {
      const earlier = line({ step_index: 0, type: "COMMAND", content: "bash: gitx: command not found" });
      expect(hookText("antigravity", step(earlier + model + line({ step_index: 2, type: "COMMAND", content: "ok" })))).not.toContain(CUE);
    });

    it("gives nothing, and no failed hook, without a readable transcript or a tool call in it", () => {
      expect(hookText("antigravity", { hook_event_name: "PostInvocation", session_id: S })).not.toContain(CUE);
      expect(hookText("antigravity", { hook_event_name: "PostInvocation", session_id: S, transcript_path: path.join(directory, "absent.jsonl") })).not.toContain(CUE);
      expect(hookText("antigravity", step(line({ type: "USER_INPUT", content: "command not found" })))).not.toContain(CUE);
    });
  });
});
