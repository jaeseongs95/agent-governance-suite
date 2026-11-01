#!/usr/bin/env node
// Claude Code launcher for the shared execution-observation hook bundle.
// SessionStart and PostModelSwitch record the session model next to the Claude plugin's
// workflow database under CLAUDE_PLUGIN_DATA. It never rewrites tool arguments: caller
// identity and execution claims in arguments are refused by the MCP server itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";

const LAUNCHER = "host-attestation-hook";

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

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch (cause) {
  reportLauncherFailure("stdin", cause);
  process.exit(0);
}

function finish(output) {
  if (output) process.stdout.write(output);
  // A missing session model leaves execution unobserved, which the server refuses: never block the host here.
  process.exit(0);
}

const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
if (!dataDirectory) finish("");

try {
  mkdirSync(dataDirectory, { recursive: true });
} catch (cause) {
  reportLauncherFailure("data-directory", cause);
  finish("");
}

const hookPath = fileURLToPath(new URL("../mcp-server/dist/host-attestation-hook.mjs", import.meta.url));
const result = spawnSync(process.execPath, [hookPath], {
  input: raw,
  encoding: "utf8",
  stdio: ["pipe", "pipe", "inherit"],
  timeout: 9000,
  env: {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
  },
});
const signal = typeof result.signal === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(result.signal) ? { signal: result.signal } : {};
if (result.error) reportLauncherFailure("spawn", result.error, signal);
else if (result.status !== 0) reportLauncherFailure("hook-exit", null, { status: Number.isInteger(result.status) ? result.status : null, ...signal });
const output = result.status === 0 && !result.error && typeof result.stdout === "string" ? result.stdout : "";
finish(output);
