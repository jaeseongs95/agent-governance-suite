import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, expect, it} from "vitest";
import {handleSessionMessageHook} from "../../mcp-server/src/session-message-hook.js";
import {handleSessionBoardHook} from "../../mcp-server/src/session-board-hook.js";
import {adaptHostInput} from "../../mcp-server/src/host-input-adapter.js";
import {openBoard, readEntry} from "../../skills/session-board/scripts/board-store.mjs";

const owned: Array<{directory: string; board: ReturnType<typeof openBoard>}> = [];
afterEach(() => {for (const {directory, board} of owned.splice(0)) {board.close(); rmSync(directory, {recursive: true, force: true});}});
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "claude-native-main-")), board = openBoard(path.join(directory, "board.sqlite3"));
  owned.push({directory, board}); return board;
}
const prompt = (actor: Record<string, unknown> = {}) => ({
  hook_event_name: "UserPromptSubmit", session_id: "synthetic-native-main", cwd: "synthetic-workspace", prompt: "synthetic", ...actor,
});
const payload = (tool: string, tool_input: Record<string, unknown>, actor: Record<string, unknown> = {}) => ({
  hook_event_name: "PreToolUse", session_id: "synthetic-native-main", cwd: "synthetic-workspace",
  tool_name: `mcp__agent_governance_suite__${tool}`, tool_input, ...actor,
});

// Synthetic payloads exercise the agreed Claude inference rule, not native capture or R7 evidence.
// The server identifies AGS callers from host call metadata, so neither hook rewrites AGS tool inputs; the board hook
// still records the root prompt.
it.each([{}, {agent_type: "synthetic-custom-agent"}])("infers synthetic Claude root input, passes AGS tools through and records its board prompt %j", async actor => {
  const board = fixture(), message = payload("prepare_session_message", {body: "synthetic"}, actor);
  expect(adaptHostInput(message, "claude-code").observation.actor).toMatchObject({role: "root", basis: "inferred", reasonCode: "CLAUDE_NATIVE_ROOT_AGENT_ID_ABSENT"});
  expect(await handleSessionMessageHook(message, "claude-code")).toEqual({});
  expect(handleSessionBoardHook(payload("update_session_status", {summary: "synthetic native main"}, actor), board, "claude-code")).toEqual({});
  expect(readEntry(board, "claude-code", message.session_id)).toBeNull();
  handleSessionBoardHook(prompt(actor), board, "claude-code", "2026-10-28T00:00:00.000Z");
  expect(readEntry(board, "claude-code", message.session_id)).toMatchObject({cwd: "synthetic-workspace", lastPromptAt: "2026-10-28T00:00:00.000Z", summary: null});
});

it.each([
  {agent_id: "synthetic-child"}, {agent_id: "synthetic-child", agent_type: "main"},
  {agent_id: ""}, {agent_id: " "}, {agent_id: null}, {agent_id: 42}, {agent_id: false}, {agent_id: []}, {agent_id: {}}, {agent_id: undefined},
  {agent_type: null}, {agent_type: 42}, {agent_type: ""}, {agent_type: " "},
  {hook_event_name: "UnknownEvent"}, {hook_event_name: "SubagentStart"}, {hook_event_name: "SubagentStop"}, {hook_event_name: undefined}, {session_id: ""},
])("keeps malformed or explicit child synthetic input unbound through both hooks: %j", async actor => {
  const board = fixture(), input = payload("prepare_session_message", {}, actor);
  expect(adaptHostInput(input, "claude-code").observation.actor.role).not.toBe("root");
  expect((await handleSessionMessageHook(input, "claude-code")) as {hookSpecificOutput?: {updatedInput?: unknown}}).not.toHaveProperty("hookSpecificOutput.updatedInput");
  expect(handleSessionBoardHook(prompt(actor), board, "claude-code")).toEqual({});
  expect(readEntry(board, "claude-code", "synthetic-native-main")).toBeNull();
});

it.each([
  ["gemini", "GEMINI_ACTOR_OBSERVATION_UNSUPPORTED"],
])("keeps %s missing and empty actor IDs unavailable", (host, reasonCode) => {
  for (const extra of [{}, {agent_id: ""}]) {
    expect(adaptHostInput(payload("prepare_session_message", {}, extra), host!).observation.actor)
      .toMatchObject({role: "indeterminate", basis: "unavailable", reasonCode});
  }
});
