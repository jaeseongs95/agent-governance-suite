#!/usr/bin/env node
// Claude Code launcher for the shared continuity hook bundle.
// State always lives under CLAUDE_PLUGIN_DATA so the Codex plugin's per-user
// databases are never opened. Without that directory the hook exits quietly.
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

const hookPath = fileURLToPath(new URL("../mcp-server/dist/continuity-hook.mjs", import.meta.url));
spawnSync(process.execPath, [hookPath], {
  stdio: "inherit",
  timeout: 9000,
  env: {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(dataDirectory, "continuity.sqlite3"),
  },
});
// Continuity is optional: never block the session on launcher failures.
process.exit(0);
