#!/usr/bin/env node
// Claude transport for the shared intake. Selection stays in the shared skill.
import { readFileSync } from "node:fs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "SessionStart") {
    // Reuse the shared context-start pointer and targets; only Claude invocation syntax belongs in this adapter.
    // The plugin's runtime/ and mcp-server/dist/ sit beside hooks/.
    const { msg, render, resolveHostLocale } = await import("../runtime/i18n.mjs");
    const { intakeHookOutput } = await import("../mcp-server/dist/intake-hook.mjs");
    const { locale } = resolveHostLocale();
    const output = intakeHookOutput(input, "claude-code", locale);
    output.hookSpecificOutput.additionalContext = `${render(msg("hooks.skillTrigger.invocation", {}), locale)}\n${output.hookSpecificOutput.additionalContext}`;
    process.stdout.write(JSON.stringify(output));
  }
} catch (cause) {
  // Optional host context must not block the session, but the failure stays visible (no message, path or input).
  try {
    process.stderr.write(`[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: "skill-trigger-hook",
      ...(cause instanceof SyntaxError ? { code: "INVALID_JSON" } : typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(cause.code) ? { code: cause.code } : {}) })}\n`);
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}
