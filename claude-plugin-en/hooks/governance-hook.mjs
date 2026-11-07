#!/usr/bin/env node
// Claude Code PreToolUse entry for every AGS tool. Other events use their existing launchers.
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

const LAUNCHER = "governance-hook";

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

let stage = "stdin";
try {
  const raw = readFileSync(0, "utf8");
  stage = "data-directory";
  const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
  if (!dataDirectory) throw Object.assign(new Error("Plugin data directory is unavailable."), { code: "LAUNCHER_DATA_REQUIRED" });
  mkdirSync(dataDirectory, { recursive: true });
  const environment = {
    ...process.env,
    AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
    AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(dataDirectory, "continuity.sqlite3"),
  };
  stage = "import";
  const bundle = await import("../mcp-server/dist/governance-hook.mjs");
  stage = "export";
  if (typeof bundle.runGovernanceHook !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const outcome = await bundle.runGovernanceHook("claude-code", raw, environment);
  stage = "outcome";
  // An admitted call prints nothing; a refusal must carry its deny output.
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean" || typeof outcome.output !== "string"
    || (!outcome.ok && !outcome.output.trim())) {
    throw Object.assign(new Error("Launcher outcome is invalid."), { code: "LAUNCHER_OUTCOME_INVALID" });
  }
  if (!outcome.ok) process.exitCode = 2;
  stage = "stdout";
  if (outcome.output) writeSync(1, outcome.output);
} catch (cause) {
  process.exitCode = 2;
  reportLauncherFailure(stage, cause);
}
