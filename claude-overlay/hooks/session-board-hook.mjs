#!/usr/bin/env node
// Claude Code launcher for the shared session board hook bundle.
// The board is shared with the other hosts on this machine (Codex), so it lives in the user state directory
// rather than CLAUDE_PLUGIN_DATA. On any failure the hook exits quietly and the tool call proceeds.
import { readFileSync } from "node:fs";

try {
  const { runSessionBoardHook } = await import("../mcp-server/dist/session-board-hook.mjs");
  const output = runSessionBoardHook("claude-code", readFileSync(0, "utf8"));
  if (output) process.stdout.write(output);
} catch {
  // Never block the session on launcher failures.
}
