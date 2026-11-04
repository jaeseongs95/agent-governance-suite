import { readFileSync } from "node:fs";

import { msg, render, type SupportedLocale } from "./i18n.js";

/**
 * The shared intake: the block of the installed skills/orchestrator/SKILL.md in its frame. One source for the MCP server
 * instructions and the session-start hook context, because a host may not show a server's instructions to its model
 * (agy 1.4.12 lists the AGS tools but not the instructions, 2026-11-04). The block stays the installed SKILL.md text, so
 * it is in the package language (docs/i18n-design.md 4.2); only the frame around it follows `locale`.
 */
export function skillIntakeText(locale: SupportedLocale): string {
  const intake = readFileSync(new URL("../../skills/orchestrator/SKILL.md", import.meta.url), "utf8")
    .match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)?.[1];
  if (!intake) throw new Error("Shared skill intake instructions are missing.");
  return render(msg("instructions.intake.frame", { intake }), locale);
}
