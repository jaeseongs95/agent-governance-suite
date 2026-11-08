import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { builtinCallerIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { runContinuityHook } from "../../mcp-server/src/continuity-hook.js";
import { ContinuityService } from "../../mcp-server/src/continuity-service.js";
import { SqliteContinuityStore } from "../../mcp-server/src/continuity-store.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { childCaller, rootCaller } from "../helpers/caller.js";

// AGS3-D-0065 (Claude Code, AGS 3.8.2, 2026-11-07): two of four subagents whose brief named skills ended with no Skill
// call. The main agent is asked to match skills again at every user message ([AGS turn check]); a subagent has no user
// message, so it got the skill targets once at its start and never again, and the parent's saved state (situational
// context) never reached an agy subagent, whose hooks learn their root only after its first AGS call.
// Fix under test (D-0065, kept): an actor other than the session's own gets the session's situational context at the
// first step after it changed (the adapter names the step: Claude Code and Codex PostToolUse, agy PostInvocation).
const repository = fileURLToPath(new URL("../../", import.meta.url));
const STEP_KO = "[AGS 단계 확인]";
const STEP_EN = "[AGS step check]";
const S = "d0065-root-session";

let directory = "";
let environment: NodeJS.ProcessEnv = {};
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), "ags-d0065-"));
  environment = {
    AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3"),
    AGENT_GOVERNANCE_CONTEXT_LAYER_DB_PATH: path.join(directory, "layers.sqlite3"),
    AGENT_GOVERNANCE_LOCALE: "ko",
  };
  // The agy adapter finds a subagent's recorded root next to the workflow database of the process environment.
  vi.stubEnv("AGENT_GOVERNANCE_DB_PATH", environment.AGENT_GOVERNANCE_DB_PATH!);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function hook(host: string, input: Record<string, unknown>, env = environment): { event: string | undefined; text: string } {
  const output = runContinuityHook(JSON.stringify({ cwd: tmpdir(), ...input }), env, host, true);
  if (!output) return { event: undefined, text: "" };
  const specific = (JSON.parse(output) as { hookSpecificOutput?: { hookEventName?: string; additionalContext?: string } }).hookSpecificOutput;
  return { event: specific?.hookEventName, text: specific?.additionalContext ?? "" };
}

function occurrences(text: string, marker: string): number {
  return text.split(marker).length - 1;
}

function checkpoint(objective: string, caller = rootCaller("codex", S)): void {
  const store = new SqliteContinuityStore(environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH!);
  try {
    const continuity = new ContinuityService(store, new ContractValidator());
    const loaded = continuity.loadContext({ schemaVersion: "1.0.0" }, caller).data as { stateToken?: string } | null;
    const result = continuity.checkpointContext({ schemaVersion: "1.0.0", requestId: `req-${objective}`, expectedStateToken: loaded?.stateToken ?? null,
      status: "active", core: { objective, completionCriteria: [], constraints: [], decisions: [], progress: [], blockers: [], nextActions: [] },
      evidenceRefs: [] }, caller);
    expect(result.error).toBeNull();
  } finally { store.close(); }
}

/** The agy server records a subagent's root from its first AGS call's `_meta` (AGS3-D-0068). */
function agyFirstAgsCall(conversation: string): void {
  const result = builtinCallerIngress("antigravity", new InMemoryWorkflowStore())!("list_session_status", {
    "antigravity.google/conversation_id": conversation, "antigravity.google/root_conversation_id": S,
    "antigravity.google/parent_conversation_id": S, progressToken: 1,
  }, {});
  expect(result.provenance).toBe("host-observed");
}

const claudeStep = (agent?: string, call = "call-1") => ({ hook_event_name: "PostToolUse", session_id: S, tool_name: "Read",
  tool_input: { file_path: path.join(tmpdir(), "x.txt") }, tool_response: {}, tool_use_id: call, ...(agent ? { agent_id: agent, agent_type: "general-purpose" } : {}) });
const codexStep = (agent?: string, call = "call-1") => ({ hook_event_name: "PostToolUse", session_id: S, turn_id: "t", tool_name: "Bash",
  tool_input: { command: "ls" }, tool_response: "", tool_use_id: call, ...(agent ? { agent_id: agent, agent_type: "worker" } : {}) });
const agyStep = (conversation: string) => ({ hook_event_name: "PostInvocation", session_id: conversation });

// AGS3-D-0077 (2026-11-08): the step check was added after every tool call of every actor, so the same line piled up in
// the context and the transcript (agy shows it as a persistent system message). The skill check belongs where the work
// changes: the user's message ([AGS turn check]), an actor's start, and a workflow change (the server's
// server.workflowChange.skills in the AGS tool response). An ordinary step adds no check.
describe("AGS3-D-0077 an ordinary step adds no skill check", () => {
  it.each([
    ["claude-code", claudeStep(), claudeStep("agent-d0065")],
    ["codex", codexStep(), codexStep("agent-d0065")],
  ] as const)("%s: neither the session's own actor nor a subagent gets the step check after an ordinary tool", (host, own, child) => {
    for (const step of [hook(host, own), hook(host, child), hook(host, child, { ...environment, AGENT_GOVERNANCE_LOCALE: "en" })]) {
      expect(step.text).not.toContain(STEP_KO);
      expect(step.text).not.toContain(STEP_EN);
    }
  });

  it("antigravity: the step after a model call gives neither the root conversation nor a subagent the step check", () => {
    expect(hook("antigravity", agyStep(S)).text).not.toContain(STEP_KO);
    expect(hook("antigravity", agyStep("agy-child-d0065")).text).not.toContain(STEP_KO);
    agyFirstAgsCall("agy-child-d0065");
    expect(hook("antigravity", agyStep("agy-child-d0065")).text).not.toContain(STEP_KO);
  });

  it("keeps the turn check an AGS progress tool already carries", () => {
    checkpoint("PROGRESS-D0065");
    const progress = hook("codex", { ...codexStep(), tool_name: "mcp__agent_governance_suite__record_stage_result", tool_input: {} });
    // The turn check is model-only text in MODEL_LOCALE (English, 4.0.0), even with AGENT_GOVERNANCE_LOCALE=ko here.
    expect(occurrences(progress.text, "[AGS turn check]")).toBe(1);
    expect(progress.text).not.toContain(STEP_KO);
    expect(progress.text).not.toContain(STEP_EN);
  });
});

describe("AGS3-D-0065 the situational context reaches a subagent at the step after it changes", () => {
  it.each([
    ["claude-code", (call: string) => claudeStep("agent-d0065", call), claudeStep()],
    ["codex", (call: string) => codexStep("agent-d0065", call), codexStep()],
  ] as const)("%s: a subagent gets the parent's new state once; the session's own actor never gets its own state back", (host, childStep, ownStep) => {
    checkpoint("SITUATION-ONE-D0065");
    expect(hook(host, { hook_event_name: "SubagentStart", session_id: S, agent_id: "agent-d0065", agent_type: "worker", turn_id: "t" }).text)
      .toContain("SITUATION-ONE-D0065");
    // Already given at the start: not repeated at the step.
    expect(hook(host, childStep("call-1")).text).not.toContain("SITUATION-ONE-D0065");
    checkpoint("SITUATION-TWO-D0065");
    expect(hook(host, childStep("call-2")).text).toContain("SITUATION-TWO-D0065");
    expect(hook(host, childStep("call-3")).text).not.toContain("SITUATION-TWO-D0065");
    expect(hook(host, ownStep).text).not.toContain("SITUATION-TWO-D0065");
  });

  it("antigravity: a subagent whose start had no root gets the parent's state at the first step after its first AGS call", () => {
    checkpoint("SITUATION-AGY-D0065");
    expect(hook("antigravity", agyStep("agy-child-d0065")).text).not.toContain("SITUATION-AGY-D0065");
    agyFirstAgsCall("agy-child-d0065");
    expect(hook("antigravity", agyStep("agy-child-d0065")).text).toContain("SITUATION-AGY-D0065");
    expect(hook("antigravity", agyStep("agy-child-d0065")).text).not.toContain("SITUATION-AGY-D0065");
    expect(hook("antigravity", agyStep(S)).text).not.toContain("SITUATION-AGY-D0065");
  });

  it("does not give a subagent back the state it saved itself", () => {
    hook("codex", { hook_event_name: "SubagentStart", session_id: S, agent_id: "agent-d0065", agent_type: "worker", turn_id: "t" });
    checkpoint("SAVED-BY-CHILD-D0065", childCaller("codex", S, "agent-d0065"));
    expect(hook("codex", codexStep("agent-d0065", "call-9")).text).not.toContain("SAVED-BY-CHILD-D0065");
    expect(hook("codex", codexStep("agent-other", "call-9")).text).toContain("SAVED-BY-CHILD-D0065");
  });
});

describe("AGS3-D-0065 hook registration", () => {
  // Claude Code and Codex run the continuity hook at PostToolUse of every tool, so each step reaches it once.
  it("registers the continuity hook once for every tool's PostToolUse on Claude Code and Codex", () => {
    const matches = (matcher: string | undefined, tool: string) => matcher === undefined || matcher === "*" || new RegExp(matcher, "u").test(tool);
    const claude = JSON.parse(readFileSync(path.join(repository, "claude-overlay/hooks/hooks.json"), "utf8")) as
      { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ args?: string[] }> }>> };
    const codex = JSON.parse(readFileSync(path.join(repository, "hooks/hooks.json"), "utf8")) as
      { hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>> };
    for (const tool of ["Read", "Bash", "Skill", "mcp__plugin_agent-governance-suite_agent-governance-suite__record_stage_result", "mcp__agent_governance_suite__record_stage_result"]) {
      const claudeRuns = claude.hooks.PostToolUse!.filter(group => matches(group.matcher, tool))
        .flatMap(group => group.hooks).filter(entry => entry.args?.some(arg => arg.endsWith("/hooks/continuity-hook.mjs")));
      const codexRuns = codex.hooks.PostToolUse!.filter(group => matches(group.matcher, tool))
        .flatMap(group => group.hooks).filter(entry => entry.command.includes("continuity-hook.mjs"));
      expect(claudeRuns, tool).toHaveLength(1);
      expect(codexRuns, tool).toHaveLength(1);
    }
  });

  it("adds nothing at an ordinary step when no context changed", () => {
    expect(hook("codex", codexStep()).text).toBe("");
    expect(hook("codex", codexStep(), { ...environment, AGENT_GOVERNANCE_LOCALE: "en" }).text).toBe("");
  });
});
