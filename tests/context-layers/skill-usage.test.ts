import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { recordSkillCall, resolveSkillUsageDatabasePath, SKILL_USAGE_RETAIN_DAYS, skillUsageSummary } from "../../mcp-server/src/skill-usage-store.js";
import { skillFilesNamed, skillFilesReadByCommand } from "../../mcp-server/src/skill-file-read.js";

// The admin page's skill statistics (4.1.0): each host loads a skill its own way, so its adapter recognizes the call; the
// hook records it; the page reads the totals. These cases drive the real hook entry with each host's own input shape.
const SKILL_FILE = fileURLToPath(new URL("../../skills/code-review/SKILL.md", import.meta.url));

let directory = "";
let environment: NodeJS.ProcessEnv = {};
let usageFile = "";
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-skill-usage-"));
  environment = {
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: path.join(directory, "layers.sqlite3"),
  };
  usageFile = resolveSkillUsageDatabasePath(environment);
  vi.stubEnv("AGENT_GOVERNANCE_DB_PATH", environment.AGENT_GOVERNANCE_DB_PATH!);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

const after = (tool: string, toolInput: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  hook_event_name: "PostToolUse", session_id: "s1", turn_id: "t", cwd: tmpdir(), tool_name: tool, tool_input: toolInput, tool_response: "ok", tool_use_id: "call-1", ...extra,
});
const rows = () => skillUsageSummary(usageFile, 1).rows;

describe("a host's skill call reaches the statistics through its own adapter", () => {
  it("Claude Code: the Skill tool, AGS skills only", () => {
    runContinuityHook(after("Skill", { skill: "agent-governance-suite:code-review" }), environment, "claude-code", true);
    runContinuityHook(after("Skill", { skill: "code-review" }, { tool_use_id: "call-2" }), environment, "claude-code", true);
    runContinuityHook(after("Skill", { skill: "other-plugin:code-review" }, { tool_use_id: "call-3" }), environment, "claude-code", true);
    expect(rows()).toMatchObject([{ skillId: "code-review", host: "claude-code", basis: "skill-tool", subagent: false, calls: 1 }]);
  });

  it("marks a subagent's call", () => {
    runContinuityHook(after("Skill", { skill: "agent-governance-suite:code-review" }, { agent_id: "a1", agent_type: "worker" }), environment, "claude-code", true);
    expect(rows()).toMatchObject([{ subagent: true, calls: 1 }]);
  });

  it("Codex: a shell command that reads the skill file", () => {
    runContinuityHook(after("Bash", { command: `sed -n '1,80p' ${SKILL_FILE}` }), environment, "codex", true);
    expect(rows()).toMatchObject([{ skillId: "code-review", host: "codex", basis: "skill-file-read", calls: 1 }]);
  });

  it("Codex: a command that only names the file, a failed read and a tool without a command are not calls", () => {
    runContinuityHook(after("Bash", { command: `ls ${SKILL_FILE}` }), environment, "codex", true);
    runContinuityHook(after("Bash", { command: `cat ${SKILL_FILE}` }, { tool_use_id: "call-2", tool_response: { exit_code: 1, stderr: "denied" } }), environment, "codex", true);
    runContinuityHook(after("view_image", { path: SKILL_FILE }, { tool_use_id: "call-3" }), environment, "codex", true);
    expect(existsSync(usageFile)).toBe(false);
  });

  it("antigravity: its file tool and its shell tool", () => {
    runContinuityHook(after("read_file", { Path: SKILL_FILE }, { tool_use_id: undefined }), environment, "antigravity", true);
    runContinuityHook(after("Bash", { CommandLine: `cat ${SKILL_FILE}` }, { tool_use_id: undefined }), environment, "antigravity", true);
    expect(rows()).toMatchObject([{ skillId: "code-review", host: "antigravity", basis: "skill-file-read", calls: 2 }]);
  });

  it("a redelivered hook adds nothing; one command reading two skills counts both", () => {
    const second = SKILL_FILE.replace("code-review", "test-engineering");
    runContinuityHook(after("Bash", { command: `cat ${SKILL_FILE} ${second}` }), environment, "codex", true);
    runContinuityHook(after("Bash", { command: `cat ${SKILL_FILE} ${second}` }), environment, "codex", true);
    expect(rows().map(row => [row.skillId, row.calls])).toEqual([["code-review", 1], ["test-engineering", 1]]);
  });

  it("a statistics failure leaves the hook's own result alone", () => {
    writeFileSync(path.join(directory, "skill-usage.sqlite3"), "not a database");
    const output = runContinuityHook(after("Skill", { skill: "agent-governance-suite:code-review" }), environment, "claude-code", true);
    expect(typeof output).toBe("string");
  });
});

describe("recognizing a skill file", () => {
  const root = path.resolve(tmpdir(), "plugin");
  const posixRoot = "/home/me/.codex/plugins/cache/x/agent-governance-suite/4.1.0";

  it("takes this package's copy only: a checkout of the same repository is not a skill in use", () => {
    expect(skillFilesNamed(`${posixRoot}/skills/ponytail/SKILL.md`, posixRoot)).toEqual(["ponytail"]);
    expect(skillFilesNamed("/work/ags/skills/ponytail/SKILL.md", posixRoot)).toEqual([]);
    expect(skillFilesNamed(`${posixRoot}/skills/ponytail/references/x.md`, posixRoot)).toEqual([]);
  });

  it.runIf(process.platform === "win32")("reads a Windows path in any case and slash form", () => {
    expect(skillFilesNamed(String.raw`c:\users\me\plugin\skills\a-b\SKILL.md`, String.raw`C:\Users\me\plugin`)).toEqual(["a-b"]);
  });

  it.each([
    [`cat ${posixRoot}/skills/a/SKILL.md`, ["a"]],
    [`/bin/bash -lc "sed -n '1,80p' ${posixRoot}/skills/a/SKILL.md"`, ["a"]],
    [`Get-Content ${posixRoot}/skills/a/SKILL.md -Raw`, ["a"]],
    [["bash", "-lc", `head -n 5 ${posixRoot}/skills/a/SKILL.md`], ["a"]],
    [`ls ${posixRoot}/skills/a/SKILL.md`, []],
    [`test -f ${posixRoot}/skills/a/SKILL.md`, []],
    [12, []],
  ])("command %j", (command, expected) => {
    expect(skillFilesReadByCommand(command, posixRoot)).toEqual(expected);
  });

  it("stays silent for a path outside any root", () => {
    expect(skillFilesNamed(path.join(root, "x.md"), root)).toEqual([]);
  });
});

describe("the statistics store", () => {
  const call = (at: Date, skillId = "a", host = "h", callId?: string) => ({ host, sessionId: "s", skillId, basis: "skill-tool", subagent: false, at, ...(callId ? { callId } : {}) });
  const now = new Date("2026-11-08T12:00:00Z");
  const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 3600_000);

  it("reads nothing and creates nothing before the first call", () => {
    expect(skillUsageSummary(usageFile, 30, now)).toEqual({ rows: [], hosts: [] });
    expect(existsSync(usageFile)).toBe(false);
  });

  it("counts by period and still names a host whose calls are all older", () => {
    recordSkillCall(usageFile, call(daysAgo(0.5)));
    recordSkillCall(usageFile, call(daysAgo(3)));
    recordSkillCall(usageFile, call(daysAgo(20), "b", "older-host"));
    expect(skillUsageSummary(usageFile, 1, now).rows).toMatchObject([{ skillId: "a", host: "h", calls: 1 }]);
    expect(skillUsageSummary(usageFile, 7, now).rows).toMatchObject([{ skillId: "a", calls: 2 }]);
    expect(skillUsageSummary(usageFile, 1, now).hosts.map(host => host.host)).toEqual(["h", "older-host"]);
  });

  it("keeps a new host's name as given: nothing here lists hosts", () => {
    recordSkillCall(usageFile, call(daysAgo(0), "a", "a-host-from-next-year"));
    expect(skillUsageSummary(usageFile, 1, now).rows[0]!.host).toBe("a-host-from-next-year");
  });

  it("drops calls older than the retention on the next write", () => {
    recordSkillCall(usageFile, call(daysAgo(SKILL_USAGE_RETAIN_DAYS + 1)));
    recordSkillCall(usageFile, call(daysAgo(0)));
    const database = new DatabaseSync(usageFile);
    try { expect((database.prepare("SELECT COUNT(*) AS n FROM skill_calls").get() as { n: number }).n).toBe(1); } finally { database.close(); }
  });

  it("a file of its own: the shared context file does not gain a table", () => {
    expect(path.basename(usageFile)).toBe("skill-usage.sqlite3");
    expect(path.dirname(usageFile)).toBe(path.dirname(environment.AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH!));
  });
});
