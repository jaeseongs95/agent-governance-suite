#!/usr/bin/env node
// Claude transport for the shared intake. Selection stays in the shared skill.
import { readFileSync } from "node:fs";

try {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.hook_event_name === "SessionStart") {
    // The MCP initialization already carries the current shared policy. This adapter adds host invocation syntax and the
    // installed skill targets the per-message cue points at, in the host locale (docs/i18n-design.md 4.1 ①). The
    // plugin's runtime/ and mcp-server/dist/ sit beside hooks/.
    const { msg, render, resolveHostLocale } = await import("../runtime/i18n.mjs");
    const { skillTargetsContext } = await import("../mcp-server/dist/intake-hook.mjs");
    const { locale } = resolveHostLocale();
    process.stdout.write(JSON.stringify({ hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `${render(msg("hooks.skillTrigger.invocation", {}), locale)}\n${skillTargetsContext(locale)}`,
    } }));
  }
} catch (cause) {
  // Optional host context must not block the session, but the failure stays visible (no message, path or input).
  try {
    process.stderr.write(`[agent-governance-suite] launcher-failure ${JSON.stringify({ launcher: "skill-trigger-hook",
      ...(cause instanceof SyntaxError ? { code: "INVALID_JSON" } : typeof cause?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/u.test(cause.code) ? { code: cause.code } : {}) })}\n`);
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}
