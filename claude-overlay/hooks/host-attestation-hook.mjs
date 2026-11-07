#!/usr/bin/env node
// Claude Code launcher for the shared execution-observation hook bundle.
// SessionStart and PostModelSwitch record the session model next to the Claude plugin's
// workflow database under CLAUDE_PLUGIN_DATA. It never rewrites tool arguments: caller
// identity and execution claims in arguments are refused by the MCP server itself.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = "host-attestation-hook";

// One stderr format for every product diagnostic (AGS3-D-0023): the shared runtime writes the record; a package
// missing that module still reports the failed stage in the same one-line {component, event} format.
const diagnostics = await import("../runtime/diagnostic-record.mjs").catch(() => null);

/** Names the failed launcher stage with a bounded code; never messages, paths or input. */
function reportLauncherFailure(stage, cause, observed = {}) {
  if (diagnostics) {
    diagnostics.writeStageFailure(LAUNCHER, "launcher-failure", stage, cause, observed);
    return;
  }
  try { writeSync(2, `${JSON.stringify({ component: LAUNCHER, event: "launcher-failure", stage, reason: "DIAGNOSTIC_RUNTIME_UNAVAILABLE" })}\n`); }
  catch { /* A broken diagnostic sink cannot block the host. */ }
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
