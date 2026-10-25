#!/usr/bin/env node
// Claude Code launcher for the shared TLS session-message hook bundle.
// Messaging is optional and must never block the host, but each launcher stage failure is
// reported with its stage and a bounded code (no message, path or input) instead of vanishing.
import { readFileSync, writeSync } from "node:fs";
import { types } from "node:util";

const LAUNCHER = "session-message-hook";
// Non-blocking failure status: the host continues, but a failed hook stays distinct from an empty success.
const FAILURE_EXIT_CODE = 1;

function reportLauncherFailure(stage, cause) {
  process.exitCode = FAILURE_EXIT_CODE;
  try {
    let code;
    if (cause && (typeof cause === "object" || typeof cause === "function") && !types.isProxy(cause)) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(descriptor.value)) code = descriptor.value;
    }
    writeSync(2, `[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: LAUNCHER, stage, ...(code ? { code } : {}) })}\n`);
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}

let stage = "stdin";
try {
  const raw = readFileSync(0, "utf8");
  stage = "import";
  const bundle = await import("../mcp-server/dist/session-message-hook.mjs");
  stage = "export";
  const run = bundle.runSessionMessageHookOutcome;
  if (typeof run !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const outcome = await run("claude-code", raw);
  stage = "outcome";
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean" || typeof outcome.output !== "string") {
    throw Object.assign(new Error("Launcher outcome is invalid."), { code: "LAUNCHER_OUTCOME_INVALID" });
  }
  // The bundle already reported the failed phase and reason; the launcher carries the failure into the exit status.
  if (!outcome.ok) process.exitCode = FAILURE_EXIT_CODE;
  else if (outcome.output) {
    stage = "stdout";
    process.stdout.on("error", (cause) => reportLauncherFailure("stdout", cause));
    process.stdout.write(outcome.output);
  }
} catch (cause) {
  reportLauncherFailure(stage, cause);
}
