#!/usr/bin/env node
// Claude Code launcher for the shared continuity hook bundle.
// State always lives under CLAUDE_PLUGIN_DATA so the Codex plugin's per-user
// databases are never opened. Without that directory the hook exits quietly.
// The bundle runs in this process (AGS3-D-0079): a second node process doubled every hook's start-up cost.
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

const LAUNCHER = "continuity-hook";

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

// Continuity is optional: no stage failure blocks the session, and each one is reported under its stage.
let stage = "data-directory";
try {
  const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
  if (dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true });
    const environment = {
      ...process.env,
      AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3"),
      AGENT_GOVERNANCE_CONTINUITY_DB_PATH: path.join(dataDirectory, "continuity.sqlite3"),
    };
    stage = "stdin";
    const raw = readFileSync(0, "utf8");
    stage = "import";
    const bundle = await import("../mcp-server/dist/continuity-hook.mjs");
    stage = "export";
    if (typeof bundle.runContinuityHook !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
    stage = "run";
    // The bundle reports its own phase failures and returns the hook output, empty when there is none.
    const output = await bundle.runContinuityHook(raw, environment, "claude-code");
    stage = "outcome";
    if (typeof output !== "string") throw Object.assign(new Error("Launcher outcome is invalid."), { code: "LAUNCHER_OUTCOME_INVALID" });
    if (output) {
      // The process exits on its own after the write drains; an asynchronous pipe error is still reported.
      stage = "stdout";
      process.stdout.on("error", (cause) => reportLauncherFailure("stdout", cause));
      process.stdout.write(output);
    }
  }
} catch (cause) {
  reportLauncherFailure(stage, cause);
}
