import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, expect, it} from "vitest";
import {handleSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {handleSessionBoardHook} from "../../mcp-server/src/session-board-hook.js";
import {adaptHostInput} from "../../mcp-server/src/host-input-adapter.js";
import {listSessions, openBoard} from "../../skills/session-board/scripts/board-store.mjs";

const owned: Array<{directory: string; board: ReturnType<typeof openBoard>}> = [];
afterEach(() => {for (const {directory, board} of owned.splice(0)) {board.close(); rmSync(directory, {recursive: true, force: true});}});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-native-main-")), board = openBoard(path.join(directory, "board.sqlite3"));
  owned.push({directory, board}); return board;
}
const payload = (tool: string, tool_input: Record<string, unknown>, actor: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", session_id: "synthetic-native-main", cwd: "synthetic-workspace",
  tool_name: `mcp__agent_governance_suite__${tool}`, tool_input, ...actor,
});

// Native contract: https://code.claude.com/docs/en/hooks#common-input-fields
// agent_id identifies a subagent; agent_type can also describe a --agent main session.
it.each([{}, {agent_type: "synthetic-custom-agent"}])("binds actual Claude message and board hooks for native main %j", async actor => {
  const board = fixture(), message = payload("prepare_session_message", {body: "synthetic"}, actor);
  expect(adaptHostInput(message, "claude-code").observation.actor).toMatchObject({kind: "main", assurance: "observed", observedBy: "claude-code:hook-payload"});
  const output = await handleSessionMessageHook(message, "claude-code");
  expect(output).toMatchObject({hookSpecificOutput: {updatedInput: {body: "synthetic", _sessionBinding: {host: "claude-code", sessionId: message.session_id}}}});
  const updated = handleSessionBoardHook(payload("update_session_status", {summary: "synthetic native main"}, actor), board, "claude-code");
  expect(updated).toMatchObject({hookSpecificOutput: {updatedInput: {_sessionBinding: {host: "claude-code", sessionId: message.session_id}}}});
  expect(listSessions(board, new Date().toISOString()).map(row => row.summary)).toEqual(["synthetic native main"]);
});

it.each([
  {agent_id: "synthetic-child"}, {agent_id: "synthetic-child", agent_type: "main"},
  {agent_id: ""}, {agent_id: " "}, {agent_id: null}, {agent_id: 42}, {agent_id: false}, {agent_id: []}, {agent_id: {}}, {agent_id: undefined},
  {agent_type: null}, {agent_type: 42}, {agent_type: ""}, {agent_type: " "},
  {hook_event_name: "UnknownEvent"}, {hook_event_name: "SubagentStart"}, {hook_event_name: "SubagentStop"}, {hook_event_name: undefined}, {session_id: ""},
])("keeps invalid or explicit child input unbound through both actual hooks: %j", async actor => {
  const board = fixture(), input = payload("prepare_session_message", {}, actor);
  expect(adaptHostInput(input, "claude-code").observation.actor.kind).not.toBe("main");
  expect((await handleSessionMessageHook(input, "claude-code")) as {hookSpecificOutput?: {updatedInput?: unknown}}).not.toHaveProperty("hookSpecificOutput.updatedInput");
  expect(handleSessionBoardHook(payload("update_session_status", {summary: "must not write"}, actor), board, "claude-code")).not.toHaveProperty("hookSpecificOutput.updatedInput");
  expect(listSessions(board, new Date().toISOString())).toEqual([]);
});

it.each(["codex", "gemini"])("preserves %s missing-actor UNKNOWN and its existing explicit empty-main contract", host => {
  expect(adaptHostInput(payload("prepare_session_message", {}), host).observation.actor).toMatchObject({kind: "unknown", assurance: "unknown"});
  expect(adaptHostInput(payload("prepare_session_message", {}, {agent_id: ""}), host).observation.actor).toMatchObject({kind: "main", assurance: "observed"});
});
