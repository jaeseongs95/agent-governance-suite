#!/usr/bin/env node
// Claude Code launcher for the shared session board hook bundle.
// The board lives under CLAUDE_PLUGIN_DATA so the Codex plugin's board is never opened.
// Without that directory, or on any failure, the hook exits quietly and the tool call proceeds.
import { readFileSync } from "node:fs";
import path from "node:path";

const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (!dataDirectory) process.exit(0);

try {
  process.env.AGENT_GOVERNANCE_SESSION_BOARD_DB_PATH = path.join(dataDirectory, "session-board.sqlite3");
  const { runSessionBoardHook } = await import("../mcp-server/dist/session-board-hook.mjs");
  const output = runSessionBoardHook("claude-code", readFileSync(0, "utf8"));
  if (output) process.stdout.write(output);
} catch {
  // Never block the session on launcher failures.
}
