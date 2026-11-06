// Build the full-cue control in an exported source COPY, preserving every other current repair.
// Root builds both variants from the same candidate after this exact, three-file transformation.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

const copy = realpathSync(process.argv[2] ?? "");
if (existsSync(path.join(copy, ".git"))) throw new Error("Refusing a Git checkout/worktree; use a fresh git-archive copy for arm A");
const receipt = path.join(copy, "cue-phase3-control.json");
if (existsSync(receipt)) throw new Error("Control already transformed; never apply twice");
const edits = [
  ["mcp-server/src/continuity-service.ts", 'msg("hooks.checkpointCue.skills", {})', 'msg("instructions.intake.skills", { targets: installedSkillTargets() })'],
  ["mcp-server/src/intake-hook.ts", 'additionalContext: `${skillIntakePointer(locale)}\\n${skillTargetsContext(locale)}`', 'additionalContext: skillIntakePointer(locale)'],
  ["claude-overlay/hooks/skill-trigger-hook.mjs", 'additionalContext: `${render(msg("hooks.skillTrigger.invocation", {}), locale)}\\n${skillTargetsContext(locale)}`', 'additionalContext: render(msg("hooks.skillTrigger.invocation", {}), locale)'],
];
const digest = value => createHash("sha256").update(value).digest("hex");
const replacements = edits.map(([relative, before, after]) => {
  const file = path.join(copy, relative), bytes = readFileSync(file), source = bytes.toString("utf8");
  if (source.split(before).length !== 2) throw new Error(`Expected exactly one current phase3 anchor: ${relative}`);
  let updated = source.replace(before, after);
  if (relative.startsWith("claude-overlay/")) {
    const importLine = '    const { skillTargetsContext } = await import("../mcp-server/dist/intake-hook.mjs");';
    if (updated.split(importLine).length !== 2) throw new Error("Expected one Claude targets import");
    updated = updated.replace(importLine + (updated.includes("\r\n") ? "\r\n" : "\n"), "");
  }
  return { file, relative, bytes, updated };
});
// Validate all anchors before the first write. On an I/O failure, retain the trial copy for inspection.
for (const item of replacements) writeFileSync(item.file, item.updated);
writeFileSync(receipt, JSON.stringify({ factor: "D32 phase3 delivery location and per-message cue length only",
  commonIntakeAndOtherRepairs: "preserved", builtArtifacts: "NOT_BUILT",
  files: replacements.map(item => ({ path: item.relative, beforeSha256: digest(item.bytes), afterSha256: digest(Buffer.from(item.updated)) })) }, null, 2));
console.log(JSON.stringify({ state: "CONTROL_SOURCE_PREPARED_NOT_BUILT", copy, changedSourceFiles: replacements.length }));
