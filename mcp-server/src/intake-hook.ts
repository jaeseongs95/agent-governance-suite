import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";

import { failureReason } from "./failure-diagnostics.js";
import { hookFailureReason } from "./hook-error-diagnostics.js";
import { isHookEntry } from "./hook-entry.js";
import { adaptHostInput, resolveHookHost } from "./host-input-adapter.js";
import { resolveHostLocale, type SupportedLocale } from "./i18n.js";
import { skillIntakeText } from "./skill-intake.js";

/**
 * Session-start transport for the shared intake. The MCP server instructions carry the same text, but a host may not
 * show them to its model (agy 1.4.12 lists the AGS tools without the instructions, 2026-11-04), so every session start
 * (new, fork, clear, resume, compact) also carries it as hook context. The host adapter decides what a session start is
 * and names the output event; nothing here depends on which host it is. A host that shows the instructions reads the
 * same text twice.
 */
export function intakeHookOutput(input: Record<string, unknown>, host: string,
  locale: SupportedLocale = resolveHostLocale().locale): Record<string, unknown> {
  const adapted = adaptHostInput(input, host);
  if (adapted.lifecycle !== "start" || !adapted.outputEventName) return {};
  return { hookSpecificOutput: { hookEventName: adapted.outputEventName, additionalContext: skillIntakeText(locale) } };
}

/** Bounded diagnostics only: the stage and a stable reason, never input, paths or text. */
function reportIntakeFailure(stage: string, cause: unknown): void {
  try {
    console.error("[agent-governance-suite] intake-hook-failure " + JSON.stringify({ stage, reason: hookFailureReason(cause) ?? failureReason(cause).reason ?? "UNEXPECTED_FAILURE" }));
  } catch { /* A broken diagnostic sink cannot block the host. */ }
}

function main(): void {
  let output: Record<string, unknown>;
  try {
    output = intakeHookOutput(JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>, resolveHookHost(process.argv.slice(2), "codex"));
  } catch (cause) { reportIntakeFailure("handle", cause); return; }
  if (Object.keys(output).length === 0) return;
  try { process.stdout.write(JSON.stringify(output)); } catch (cause) { reportIntakeFailure("stdout", cause); }
}

if (isHookEntry(import.meta.url, "intake-hook")) main();
