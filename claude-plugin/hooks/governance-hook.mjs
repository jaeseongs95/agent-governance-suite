#!/usr/bin/env node
// Claude Code PreToolUse entry for every AGS tool. Other events use their existing launchers.
import { mkdirSync, readFileSync, writeSync } from "node:fs";
import path from "node:path";
import { types } from "node:util";

function reportLauncherFailure(stage, cause) {
  try {
    let code;
    if (cause && (typeof cause === "object" || typeof cause === "function") && !types.isProxy(cause)) {
      const descriptor = Object.getOwnPropertyDescriptor(cause, "code");
      if (descriptor && "value" in descriptor && typeof descriptor.value === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(descriptor.value)) code = descriptor.value;
    }
    writeSync(2, `[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: "governance-hook", stage, ...(code ? { code } : {}) })}\n`);
  } catch { /* Diagnostic failure cannot change the nonzero verdict. */ }
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
  };
  stage = "import";
  const bundle = await import("../mcp-server/dist/governance-hook.mjs");
  stage = "export";
  if (typeof bundle.runGovernanceHook !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const outcome = await bundle.runGovernanceHook("claude-code", raw, environment);
  stage = "outcome";
  if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean" || typeof outcome.output !== "string" || !outcome.output.trim()) {
    throw Object.assign(new Error("Launcher outcome is invalid."), { code: "LAUNCHER_OUTCOME_INVALID" });
  }
  if (!outcome.ok) process.exitCode = 2;
  stage = "stdout";
  writeSync(1, outcome.output);
} catch (cause) {
  process.exitCode = 2;
  reportLauncherFailure(stage, cause);
}
