import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { msg, render, type SupportedLocale } from "./i18n.js";

const SKILLS_DIRECTORY = new URL("../../skills/", import.meta.url);
// The intake lives in its own reference so that invoking the orchestrator skill does not load it a second time
// (AGS3-D-0032): every host already has it from the MCP server instructions or the context-start pointer.
const INSTALLED_INTAKE = new URL("orchestrator/references/intake.md", SKILLS_DIRECTORY);

/**
 * The shared intake: the block of the installed skills/orchestrator/references/intake.md in its frame, carried by the MCP
 * server instructions. The block stays the installed file's text, so it is in the package language (docs/i18n-design.md
 * 4.2); only the frame around it follows `locale`.
 */
export function skillIntakeText(locale: SupportedLocale): string {
  return render(msg("instructions.intake.frame", { intake: installedIntakeBlock() }), locale);
}

/**
 * A short pointer to the installed intake, for hook context. Hook context is repeated at every context start, so it
 * names the installed intake file instead of carrying the whole block; it points only at a file that has the block.
 */
export function skillIntakePointer(locale: SupportedLocale): string {
  installedIntakeBlock();
  return render(msg("instructions.intake.pointer", { path: fileURLToPath(INSTALLED_INTAKE) }), locale);
}

/**
 * One line per installed skill with the targets its classification.json declares ("name: target, target"). The
 * per-message cue carries it so the purpose of each message is matched against the skills split by purpose, not only
 * against the few skills the intake names by action. Derived from the installed files, so it never lists a skill that
 * is not installed or misses one that is.
 */
export function installedSkillTargets(directory: URL = SKILLS_DIRECTORY): string {
  const lines: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const file = new URL(`${entry.name}/classification.json`, directory);
    if (!existsSync(file)) continue;
    const { targets } = JSON.parse(readFileSync(file, "utf8")) as { targets?: unknown };
    if (!Array.isArray(targets) || targets.length === 0 || !targets.every(target => typeof target === "string")) {
      throw new Error(`Skill classification has no targets: ${entry.name}`);
    }
    lines.push(`- ${entry.name}: ${targets.join(", ")}`);
  }
  if (lines.length === 0) throw new Error("No installed skill declares classification targets.");
  return lines.join("\n");
}

function installedIntakeBlock(): string {
  const intake = readFileSync(INSTALLED_INTAKE, "utf8")
    .match(/<!-- skill-intake:start -->\n([\s\S]*?)\n<!-- skill-intake:end -->/u)?.[1];
  if (!intake) throw new Error("Shared skill intake instructions are missing.");
  return intake;
}
