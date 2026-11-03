#!/usr/bin/env node
// Claude Code launcher for the shared continuity hook bundle.
// State always lives under CLAUDE_PLUGIN_DATA so the Codex plugin's per-user
// databases are never opened. Without that directory the hook exits quietly.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const LAUNCHER = "continuity-hook";

/** Names the failed launcher stage with a bounded code; never messages, paths or input. */
function reportLauncherFailure(stage, cause, observed = {}) {
  try {
    let code;
    if (cause && (typeof cause === "object" || typeof cause === "function") && !types.isProxy(cause)) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(descriptor.value)) code = descriptor.value;
    }
    writeSync(2, `[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: LAUNCHER, stage, ...(code ? { code } : {}), ...observed })}\n`);
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}

const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (!dataDirectory) process.exit(0);

try {
  mkdirSync(dataDirectory, { recursive: true });
} catch (cause) {
  reportLauncherFailure("data-directory", cause);
  process.exit(0);
}

const hookPath = fileURLToPath(new URL("../mcp-server/dist/continuity-hook.mjs", import.meta.url));
const result = spawnSync(process.execPath, [hookPath, "--host=claude-code"], {
  stdio: "inherit",
  timeout: 9000,
  env: {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(dataDirectory, "continuity.sqlite3"),
  },
});
const signal = typeof result.signal === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.signal) ? { signal: result.signal } : {};
if (result.error) reportLauncherFailure("spawn", result.error, signal);
else if (result.status !== 0) reportLauncherFailure("hook-exit", null, { status: Number.isInteger(result.status) ? result.status : null, ...signal });
// Continuity is optional: never block the session on launcher failures.
process.exit(0);
