#!/usr/bin/env node
// Claude Code launcher for the shared TLS session-message hook bundle.
// Messaging is optional and must never block the host, but each launcher stage failure is
// reported with its stage and a bounded code (no message, path or input) instead of vanishing.
import { readFileSync, writeSync } from "node:fs";
import { types } from "node:util";

const LAUNCHER = "session-message-hook";

function reportLauncherFailure(stage, cause) {
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
  const run = bundle.runSessionMessageHook;
  if (typeof run !== "function") throw Object.assign(new Error("Launcher export is missing."), { code: "LAUNCHER_EXPORT_MISSING" });
  stage = "run";
  const output = await run("claude-code", raw);
  stage = "stdout";
  if (output) {
    process.stdout.on("error", (cause) => reportLauncherFailure("stdout", cause));
    process.stdout.write(output);
  }
} catch (cause) {
  reportLauncherFailure(stage, cause);
}
