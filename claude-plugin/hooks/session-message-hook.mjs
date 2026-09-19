#!/usr/bin/env node
// Claude Code launcher for the shared TLS session-message hook bundle.
import { readFileSync } from "node:fs";

try {
  const { runSessionMessageHook } = await import("../mcp-server/dist/session-message-hook.mjs");
  const output = await runSessionMessageHook("claude-code", readFileSync(0, "utf8"));
  if (output) process.stdout.write(output);
} catch {
  // Messaging is optional and must never block the host.
}
