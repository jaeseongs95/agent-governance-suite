import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";

import "../../mcp-server/src/builtin-hook-host-adapters.js";
import { claudeAdmissionIngress } from "../../mcp-server/src/builtin-caller-ingress.js";
import { adaptHostInput } from "../../mcp-server/src/host-input-adapter.js";
import { hostActorId } from "../../mcp-server/src/host-attestation.js";
import { actorAccess } from "../../mcp-server/src/input-observation.js";
import { runGovernanceHook } from "../../mcp-server/src/governance-hook.js";
import { handleSessionBoardHook } from "../../mcp-server/src/session-board-hook.js";
import { handleSessionMessageHook } from "../../mcp-server/src/session-message-hook.js";
import { SqliteWorkflowStore } from "../../mcp-server/src/sqlite-workflow-store.js";
import { openBoard, readEntry } from "../../skills/session-board/scripts/board-store.mjs";

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
function governanceFixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "d0315-governance-"));
  directories.push(directory);
  const environment = { ...process.env, AGENT_GOVERNANCE_DB_PATH: path.join(directory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(directory, "continuity.sqlite3") };
  return { environment, store: () => new SqliteWorkflowStore(environment.AGENT_GOVERNANCE_DB_PATH) };
}

it.each(events)("denies a positive native child marker on %s even with parent session ID", event => {
  const { observation } = adaptHostInput(wire(event, { agent_id: "native-child", role: "root", basis: "observed" }), "codex");
  expect(observation.actor).toEqual({ role: "child", basis: "observed", reasonCode: "CODEX_NATIVE_CHILD_AGENT_ID" });
  expect(actorAccess(observation.actor).allowed).toBe(false);
});

it.each([
  { agent_id: "" },
  { agent_id: " \t" },
  { agent_id: null },
  { agent_id: 42 },
  { agent_id: {} },
  { agent_id: [] },
  { agent_id: undefined },
])("does not infer root from malformed child marker $agent_id", ({ agent_id }) => {
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
    for (const event of events) handleSessionBoardHook(wire(event, { agent_id: "child", prompt: "child" }), board, "codex", now);
    expect(readEntry(board, "codex", "parent-session")).toBeNull();
    handleSessionBoardHook(wire("UserPromptSubmit", { prompt: "parent", cwd: "/work/parent" }), board, "codex", now);
    const before = readEntry(board, "codex", "parent-session");
    expect(before).toMatchObject({ cwd: "/work/parent", lastPromptAt: now });
    handleSessionBoardHook(wire("UserPromptSubmit", { agent_id: "child", prompt: "child", cwd: "/work/child" }), board, "codex", "2026-10-28T00:01:00.000Z");
    // The board hook does not handle AGS tools; the server writes the summary after caller verification.
    for (const tool of ["update_session_status", "list_session_status"]) {
      expect(handleSessionBoardHook(toolWire(tool, { agent_id: "child" }), board, "codex", now)).toEqual({});
    }
    expect(readEntry(board, "codex", "parent-session")).toEqual(before);
  } finally { board.close(); }
});

it.each(tools)("admits child tool %s as a child caller of the parent session, never as its root", async tool => {
  const { environment, store } = governanceFixture();
  const result = await runGovernanceHook("claude-code", JSON.stringify(toolWire(tool, { agent_id: "child" })), environment);
  expect(result).toEqual({ ok: true, output: "" });
  const admissions = store();
  try {
    const ingress = claudeAdmissionIngress(admissions);
    expect(ingress(tool, { "claudecode/toolUseId": "owned-call" })).toMatchObject({ provenance: "host-observed", caller: {
      sessionId: "parent-session", actor: { id: hostActorId("claude-code", "parent-session", "child"), role: "child" },
      parentChain: [hostActorId("claude-code", "parent-session")],
    } });
  } finally { admissions.close(); }
});

it.each([
  { agent_id: "" },
  { agent_id: " 	" },
  { agent_id: null },
  { agent_id: 42 },
  { agent_id: {} },
  { agent_id: [] },
])("denies a present but malformed child marker $agent_id and records no row", async ({ agent_id }) => {
  const { environment, store } = governanceFixture();
  const result = await runGovernanceHook("claude-code", JSON.stringify(toolWire("list_session_status", { agent_id })), environment);
  expect(result.ok).toBe(false);
  expect(JSON.parse(result.output)).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "HOOK_AGENT_ID_INVALID" } });
  const admissions = store();
  try { expect(admissions.claimCallAdmission("claude-code", "owned-call")).toBeNull(); }
  finally { admissions.close(); }
});

it("does not claim parent inbox activity from a child prompt", async () => {
  expect(await handleSessionMessageHook(wire("UserPromptSubmit", { agent_id: "child", prompt: "child input" }), "codex")).toEqual({});
});
