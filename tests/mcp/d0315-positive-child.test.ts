import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { actorAccess } from "../../mcp-server/src/input-observation.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { SessionActorProofs } from "../../mcp-server/src/session-actor-proof.js";
import { handleSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { listSessions, openBoard } from "../../skills/session-board/scripts/board-store.mjs";

// Source-derived contract inputs, NOT native capture or complete host child-isolation evidence.
const wire = (event: string, extra: Record<string, unknown> = {}) => ({
  hook_event_name: event, session_id: "parent-session", tool_use_id: "owned-call",
  ...extra,
});
const toolWire = (tool: string, extra: Record<string, unknown> = {}) => ({ ...wire("PreToolUse"),
  tool_name: `mcp__agent_governance_suite__${tool}`, tool_input: { summary: "unchanged parent" }, ...extra,
});
const events = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "PreCompact", "PostCompact"];
const tools = ["list_session_status", "update_session_status", "prepare_session_message", "send_session_message",
  "acknowledge_session_messages", "get_session_message_status", "validate_collaboration_decision"];
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each(events)("denies a positive native child marker on %s even with parent session ID", event => {
  const { observation } = adaptHostInput(wire(event, { agent_id: "native-child", role: "root", basis: "observed" }), "codex");
  expect(observation.actor).toEqual({ role: "child", basis: "observed", reasonCode: "CODEX_NATIVE_CHILD_AGENT_ID" });
  expect(actorAccess(observation.actor).allowed).toBe(false);
});

it.each(["", " \t", null, 42, {}, []])("does not infer root from malformed child marker %j", agent_id => {
  const { observation } = adaptHostInput(toolWire("list_session_status", { agent_id }), "codex");
  expect(observation.actor).toEqual({ role: "indeterminate", basis: "unavailable", reasonCode: "CODEX_NATIVE_AGENT_ID_INVALID" });
  expect(actorAccess(observation.actor).allowed).toBe(false);
});

it.each(events)("preserves marker-free normal root inference on %s", event => {
  expect(adaptHostInput(wire(event), "codex").observation.actor).toEqual({
    role: "root", basis: "inferred", reasonCode: "CODEX_ROOT_INFERRED_CHILD_GATE_DEFERRED",
  });
});

it("does not register, prompt-update or overwrite the parent board row from a child", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "d0315-positive-child-"));
  directories.push(directory);
  const board = openBoard(path.join(directory, "board.sqlite3"));
  const now = "2026-10-28T00:00:00.000Z";
  try {
    for (const event of ["SessionStart", "UserPromptSubmit"]) {
      handleSessionBoardHook(wire(event, { agent_id: "child" }), board, "codex", now);
    }
    expect(listSessions(board, now)).toEqual([]);
    handleSessionBoardHook(toolWire("update_session_status"), board, "codex", now);
    const before = listSessions(board, now);
    expect(before).toHaveLength(1);
    for (const tool of ["update_session_status", "list_session_status"]) {
      expect(handleSessionBoardHook(toolWire(tool, { agent_id: "child" }), board, "codex", now)).toMatchObject({
        hookSpecificOutput: { permissionDecision: "deny" },
      });
    }
    expect(listSessions(board, now)).toEqual(before);
  } finally { board.close(); }
});

it.each(tools)("issues no governance proof or domain binding to child tool %s", async tool => {
  const input = toolWire(tool, { agent_id: "child" });
  const result = await runGovernanceHook("codex", JSON.stringify(input));
  expect(result.ok).toBe(true);
  const output = JSON.parse(result.output);
  expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "CODEX_NATIVE_CHILD_AGENT_ID" } });
  expect(output.hookSpecificOutput.updatedInput).toBeUndefined();
  const proofs = new SessionActorProofs(new InMemoryWorkflowStore());
  expect(() => proofs.issue(adaptHostInput(input, "codex").observation, tool, input.tool_input)).toThrow();
  expect(() => proofs.verify(tool, input.tool_input)).toThrow();
});

it.each(tools.slice(2))("denies independent child PEER/trust binding for %s", async tool => {
  const output = await handleSessionMessageHook(toolWire(tool, { agent_id: "child" }), "codex");
  expect(output).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  expect((output.hookSpecificOutput as Record<string, unknown>).updatedInput).toBeUndefined();
});

it("does not claim parent inbox activity from a child prompt", async () => {
  expect(await handleSessionMessageHook(wire("UserPromptSubmit", { agent_id: "child", prompt: "child input" }), "codex")).toEqual({});
});
