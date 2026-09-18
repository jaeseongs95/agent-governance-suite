#!/usr/bin/env node
// Claude Code launcher for the shared host attestation hook bundle.
// The token is signed with a key in the Claude plugin's workflow database under
// CLAUDE_PLUGIN_DATA, the same database the MCP server opens. Without that
// directory the hook emits nothing and strict orchestration stays BINDING_REQUIRED.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (!dataDirectory) process.exit(0);

try {
  mkdirSync(dataDirectory, { recursive: true });
} catch {
  process.exit(0);
}

const hookPath = fileURLToPath(new URL("../mcp-server/dist/host-attestation-hook.mjs", import.meta.url));
spawnSync(process.execPath, [hookPath], {
  stdio: "inherit",
  timeout: 9000,
  env: {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
  },
});
// Attestation is fail-closed on the server: never block the tool call on launcher failures.
process.exit(0);
