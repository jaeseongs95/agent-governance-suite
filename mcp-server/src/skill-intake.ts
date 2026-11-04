import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { msg, render, type SupportedLocale } from "./i18n.js";

const INSTALLED_SKILL = new URL("../../skills/orchestrator/SKILL.md", import.meta.url);

/**
 * The shared intake: the block of the installed skills/orchestrator/SKILL.md in its frame, carried by the MCP server
 * instructions. The block stays the installed SKILL.md text, so it is in the package language (docs/i18n-design.md
 * 4.2); only the frame around it follows `locale`.
 */
export function skillIntakeText(locale: SupportedLocale): string {
  return render(msg("instructions.intake.frame", { intake: installedIntakeBlock() }), locale);
}

/**
 * A short pointer to the installed intake, for hook context. Hook context is repeated at every context start, so it
 * names the installed SKILL.md instead of carrying the whole block; it points only at a file that has the block.
 */
export function skillIntakePointer(locale: SupportedLocale): string {
  installedIntakeBlock();
  return render(msg("instructions.intake.pointer", { path: fileURLToPath(INSTALLED_SKILL) }), locale);
}

function installedIntakeBlock(): string {
  const intake = readFileSync(INSTALLED_SKILL, "utf8")
    .match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)?.[1];
  if (!intake) throw new Error("Shared skill intake instructions are missing.");
  return intake;
}
