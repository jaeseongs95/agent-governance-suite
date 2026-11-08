import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import { handleContinuityHook, runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// AGS3-D-0001: the skill targets reached only the main agent at its user prompts (UserPromptSubmit); a subagent got
// nothing, because no subagent-start hook was registered and the continuity hook answered every child event with {}
// apart from the edit gate. Claude Code and Codex (0.166) both start a subagent with a SubagentStart hook whose
// additionalContext goes into the subagent's context. Antigravity (agy) documents no such event, so it is not covered.
const root = fileURLToPath(new URL("../../", import.meta.url));
const parent = "d0001-parent-session";
const stores = new Set<SqliteContinuityStore>();
const directories: string[] = [];
afterEach(() => {
  for (const store of stores) store.close();
  stores.clear();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function service() {
  const store = new SqliteContinuityStore(":memory:");
  stores.add(store);
  return new ContinuityService(store, null, new InMemoryWorkflowStore(), () => new Date("2026-11-06T00:00:00.000Z"));
}

// Host input shapes from the official hook references: Claude Code SubagentStart (session_id, agent_id, agent_type) and
// Codex SubagentStart (the parent's session_id, turn_id, agent_id, agent_type, permission_mode).
const claudeStart = { hook_event_name: "SubagentStart", session_id: parent, transcript_path: "", cwd: root, agent_id: "agent-d0001", agent_type: "Explore" };
const codexStart = { hook_event_name: "SubagentStart", session_id: parent, turn_id: "turn-d0001", cwd: root, agent_id: "agent-d0001",
  agent_type: "worker", permission_mode: "default", model: "synthetic-model" };

function context(output: Record<string, unknown>): string {
  const specific = (output as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }).hookSpecificOutput;
  expect(specific?.hookEventName).toBe("SubagentStart");
  return specific?.additionalContext ?? "";
}

describe("subagent start cue", () => {
  it.each([["claude-code", claudeStart], ["codex", codexStart]] as const)("%s: a subagent start gets the skill targets and its brief's scope", (host, input) => {
    // Model-only text: the same English whatever the host locale (MODEL_LOCALE, 4.0.0).
    for (const environment of [{}, { AGENT_GOVERNANCE_LOCALE: "ko" }, { AGENT_GOVERNANCE_LOCALE: "en" }]) {
      const cue = context(handleContinuityHook(input, service(), host, environment));
      expect(cue).toContain("[AGS subagent start check]");
      expect(cue).toContain("Match each judgment and action of your assignment (investigation and checks included) against the skill targets below");
      // Expected lines written from skills/*/classification.json by hand, not by the function under test.
      expect(cue).toContain("- test-engineering: tests, regression-tests");
      expect(cue).toContain("- minimal-implementation: deliverables, documents, data, configuration, procedures, dependencies");
      expect(cue).toContain("Stay within your brief's goal, scope, forbidden areas and write ownership.");
      expect(cue).not.toMatch(/[\uac00-\ud7a3]/u);
      // The main agent's per-message duties (save the user's words, restore after compaction) are not the subagent's.
      expect(cue).not.toContain("checkpoint_context");
      expect(cue).not.toContain("inspect_context");
    }
  });

  it("observes the subagent as a child, never as the root, so it cannot bind the parent's continuity state", () => {
    for (const [host, input] of [["claude-code", claudeStart], ["codex", codexStart]] as const) {
      expect(adaptHostInput(input, host).observation).toMatchObject({ kind: "subagent-start", actor: { role: "child", basis: "observed" } });
      // A start without an agent ID is still not the root.
      const withoutAgent: Record<string, unknown> = { ...input };
      delete withoutAgent.agent_id;
      expect(adaptHostInput(withoutAgent, host).observation.actor.role).not.toBe("root");
    }
  });

  it("gives the cue without opening a state store, so a broken store cannot take it away", () => {
    const directory = mkdtempSync(join(tmpdir(), "ags-d0001-"));
    directories.push(directory);
    // A file stands where each database's parent directory should be: opening either store would fail.
    const blocked = join(directory, "not-a-directory");
    writeFileSync(blocked, "synthetic file");
    const environment = { AGENT_GOVERNANCE_CONTINUITY_DB_PATH: join(blocked, "c.sqlite3"), AGENT_GOVERNANCE_DB_PATH: join(blocked, "w.sqlite3"), AGENT_GOVERNANCE_SHARED_STATE_DIR: join(directory, "shared") };
    // Positive control: any other event opens the store here and fails closed.
    expect(() => runContinuityHook(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: parent, prompt: "x" }), environment, "codex", true)).toThrow();
    const output = JSON.parse(runContinuityHook(JSON.stringify(codexStart), environment, "codex", true)) as Record<string, unknown>;
    expect(context(output)).toContain("[AGS subagent start check]");
  });

  it("registers SubagentStart for the continuity hook in the Claude Code and Codex hook configurations", () => {
    const claude = JSON.parse(readFileSync(join(root, "claude-overlay/hooks/hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { args?: string[] }[] }[]> };
    expect(claude.hooks.SubagentStart?.flatMap(group => group.hooks).some(hook => hook.args?.some(arg => arg.endsWith("/hooks/continuity-hook.mjs")))).toBe(true);
    const codex = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")) as
      { hooks: Record<string, { hooks: { command: string; additionalContextLimit?: number }[] }[]> };
    const codexHooks = codex.hooks.SubagentStart?.flatMap(group => group.hooks) ?? [];
    const hook = codexHooks.find(entry => entry.command.includes("mcp-server/dist/continuity-hook.mjs"));
    expect(hook).toBeDefined();
    // Codex replaces additionalContext over the limit with a head-and-tail preview; the cue must fit whole.
    const cue = context(handleContinuityHook(codexStart, service(), "codex", {}));
    expect(hook!.additionalContextLimit ?? 0).toBeGreaterThanOrEqual(cue.length);
  });

  // AGS3-D-0061: a subagent's own end is SubagentStop on both hosts (Codex sends no subagent Stop).
  it("registers SubagentStop for the continuity hook in the Claude Code and Codex hook configurations", () => {
    const claude = JSON.parse(readFileSync(join(root, "claude-overlay/hooks/hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { args?: string[] }[] }[]> };
    expect(claude.hooks.SubagentStop?.flatMap(group => group.hooks).some(hook => hook.args?.some(arg => arg.endsWith("/hooks/continuity-hook.mjs")))).toBe(true);
    const codex = JSON.parse(readFileSync(join(root, "hooks/hooks.json"), "utf8")) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
    expect(codex.hooks.SubagentStop?.flatMap(group => group.hooks).some(hook => hook.command.includes("mcp-server/dist/continuity-hook.mjs"))).toBe(true);
  });
});
