#!/usr/bin/env node
// Claude transport for the shared intake. Selection stays in the shared skill.
import { readFileSync, writeSync } from "node:fs";

const LAUNCHER = "skill-trigger-hook";

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
  stage = "input";
  const input = JSON.parse(raw);
  if (input.hook_event_name === "SessionStart") {
    // Reuse the shared context-start pointer and targets; only Claude invocation syntax belongs in this adapter.
    // The plugin's runtime/ and mcp-server/dist/ sit beside hooks/.
    stage = "import";
    const { msg, render, resolveHostLocale } = await import("../runtime/i18n.mjs");
    const { intakeHookOutput } = await import("../mcp-server/dist/intake-hook.mjs");
    stage = "run";
    const { locale } = resolveHostLocale();
    const output = intakeHookOutput(input, "claude-code", locale);
    output.hookSpecificOutput.additionalContext = `${render(msg("hooks.skillTrigger.invocation", {}), locale)}\n${output.hookSpecificOutput.additionalContext}`;
    stage = "stdout";
    process.stdout.write(JSON.stringify(output));
  }
} catch (cause) {
  // Optional host context must not block the session, but the failure stays visible (no message, path or input).
  reportLauncherFailure(stage, cause, cause instanceof SyntaxError ? { code: "INVALID_JSON" } : {});
}
