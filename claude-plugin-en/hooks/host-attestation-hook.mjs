#!/usr/bin/env node
// Claude Code launcher for the shared execution-observation hook bundle.
// SessionStart and PostModelSwitch record the session model next to the Claude plugin's
// workflow database under CLAUDE_PLUGIN_DATA. It never rewrites tool arguments: caller
// identity and execution claims in arguments are refused by the MCP server itself.
// The bundle runs in this process (AGS3-D-0079): a second node process doubled every hook's start-up cost.
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";

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

// A missing session model leaves execution unobserved, which the server refuses: never block the host here.
// The hook prints nothing, so no stage failure changes the host's view of this hook.
let stage = "stdin";
try {
  const raw = readFileSync(0, "utf8");
  stage = "data-directory";
  const dataDirectory = process.env.CLAUDE_PLUGIN_DATA?.trim();
  if (dataDirectory) {
    mkdirSync(dataDirectory, { recursive: true });
    const environment = { ...process.env, AGENT_GOVERNANCE_DB_PATH: path.join(dataDirectory, "workflows.sqlite3") };
    stage = "import";
    const bundle = await import("../mcp-server/dist/host-attestation-hook.mjs");
    stage = "export";
    if (typeof bundle.runHostAttestationHook !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
    stage = "run";
    // The bundle reports its own phase failures (stdin is already read here).
    await bundle.runHostAttestationHook(raw, environment, "claude-code");
  }
} catch (cause) {
  reportLauncherFailure(stage, cause);
}
