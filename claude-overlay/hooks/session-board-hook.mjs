#!/usr/bin/env node
// Claude Code launcher for the shared session board hook bundle.
// The board is shared with the other hosts on this machine (Codex), so it lives in the user state directory
// rather than CLAUDE_PLUGIN_DATA. On any failure the tool call proceeds; the failed launcher stage is
// reported on stderr with a bounded code (no message, path or input).
import { readFileSync, writeSync } from "node:fs";

const LAUNCHER = "session-board-hook";

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
  stage = "import";
  const bundle = await import("../mcp-server/dist/session-board-hook.mjs");
  stage = "export";
  const run = bundle.runSessionBoardHook;
  if (typeof run !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const output = await run("claude-code", raw);
  stage = "stdout";
  if (output) {
    process.stdout.on("error", (cause) => reportLauncherFailure("stdout", cause));
    process.stdout.write(output);
  }
} catch (cause) {
  // Never block the session on launcher failures, but name the failed stage.
  reportLauncherFailure(stage, cause);
}
