import "./builtin-hook-host-adapters.js";
import { readFileSync } from "node:fs";

import { failureReason } from "./failure-diagnostics.js";
import { hookFailureReason, writeDiagnostic } from "./hook-error-diagnostics.js";
import { isHookEntry } from "./hook-entry.js";
import { adaptHostInput, resolveHookHost } from "./host-input-adapter.js";
import { resolveHostLocale, type SupportedLocale } from "./i18n.js";
import { skillIntakePointer, skillTargetsContext } from "./skill-intake.js";

export { skillTargetsContext };

/**
 * Context-start transport for the shared intake. The MCP server instructions carry the whole text, but a host may not
 * show them to its model (agy 1.4.12 lists the AGS tools without the instructions, 2026-11-04), and a compaction may
 * drop hook context injected earlier (agy 1.5.0, 2026-11-04). So every context start carries a short pointer to the
 * installed intake instead of the whole block, with the installed skill targets the per-message cue points at. The
 * host adapter decides what a context start is (a session start of any source, or for a host without a compaction
 * event each turn's first model call) and names the output event; nothing here depends on which host it is.
 */
export function intakeHookOutput(input: Record<string, unknown>, host: string,
  locale: SupportedLocale = resolveHostLocale().locale): Record<string, unknown> {
  const adapted = adaptHostInput(input, host);
  if (adapted.lifecycle !== "start" || !adapted.outputEventName) return {};
  return { hookSpecificOutput: { hookEventName: adapted.outputEventName, additionalContext: `${skillIntakePointer(locale)}\n${skillTargetsContext(locale)}` } };
}

/** Bounded diagnostics only: the stage and a stable reason, never input, paths or text. */
function reportIntakeFailure(stage: string, cause: unknown): void {
  try {
    writeDiagnostic("intake-hook", "intake-hook-failure", { stage, reason: hookFailureReason(cause) ?? failureReason(cause).reason ?? "UNEXPECTED_FAILURE" });
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
