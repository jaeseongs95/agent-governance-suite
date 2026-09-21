#!/usr/bin/env node
// Generates the isolated Claude Code plugin tree in claude-plugin/.
// Shared sources are copied from the repository root; Claude-only files come
// from claude-overlay/, and per-skill Claude adaptations from
// claude-overlay/adaptations/<skill>.json. The Codex plugin files are read,
// never written.
// Usage: node scripts/build-claude-plugin.mjs [--check | --drift]
//   --check  fail when claude-plugin/ differs from a fresh render
//   --drift  report the same differences as warnings and exit 0
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";

export const OUTPUT_DIRECTORY = "claude-plugin";
export const OVERLAY_DIRECTORY = "claude-overlay";
export const ADAPTATIONS_DIRECTORY = "adaptations";
export const PLUGIN_NAME = "agent-governance-suite";
export const EXCLUDED_SKILLS = Object.freeze(["codex-token-usage-analyzer"]);
const SHARED_ROOTS = Object.freeze(["skills/", "runtime/", "contracts/"]);
const SHARED_FILES = Object.freeze([
  "LICENSE",
  "mcp-server/dist/server.mjs",
  "mcp-server/dist/continuity-hook.mjs",
  "mcp-server/dist/host-attestation-hook.mjs",
  "mcp-server/dist/model-routing-host-hook.mjs",
  "mcp-server/dist/session-board-hook.mjs",
  "mcp-server/dist/session-message-broker.mjs",
  "mcp-server/dist/session-message-relay.mjs",
  "mcp-server/dist/session-message-hook.mjs",
  "mcp-server/dist/session-message-cli.mjs",
]);
const ADAPTATION_KEYS = Object.freeze(["description", "replacements"]);
// Codex-only wording that must not reach model-visible Claude files.
export const CODEX_ONLY_PATTERNS = Object.freeze([
  /\b(?:spawn_agent|wait_agent|send_input|fork_turns|reasoning_effort|CODEX_HOME)\b/u,
  /\.codex-plugin|agents\/openai\.yaml/u,
  /\bgpt-\d/u,
  /\bCodex\b/u,
  /(?<![\w$])\$[a-z][a-z0-9]*(?:-[a-z0-9]+)+\b/u,
]);
// Files that intentionally document both hosts side by side.
export const DUAL_HOST_FILES = Object.freeze([
  "skills/coordinate-subagents/SKILL.md",
  "skills/coordinate-subagents/references/model-routing.md",
]);

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function isExcludedSkillPath(relativePath) {
  return EXCLUDED_SKILLS.some((skill) => relativePath.startsWith(`skills/${skill}/`));
}

function isCodexOnlySkillPath(relativePath) {
  return /^skills\/[^/]+\/agents\/openai\.yaml$/u.test(relativePath);
}

function isModelVisible(relativePath) {
  return /^skills\/[^/]+\/SKILL\.md$/u.test(relativePath)
    || /^skills\/[^/]+\/references\/.+\.md$/u.test(relativePath)
    || /^agents\/[^/]+\.md$/u.test(relativePath);
}

/** Lists model-visible generated files that still carry Codex-only wording. */
export function findCodexOnlyWording(files) {
  const problems = [];
  for (const [relativePath, content] of files) {
    if (!isModelVisible(relativePath) || DUAL_HOST_FILES.includes(relativePath)) continue;
    const lines = content.toString("utf8").split("\n");
    lines.forEach((line, index) => {
      if (CODEX_ONLY_PATTERNS.some((pattern) => pattern.test(line))) {
        problems.push(`Codex-only wording in ${OUTPUT_DIRECTORY}/${relativePath}:${index + 1}`);
      }
    });
  }
  return problems;
}

export function applyReplacements(files, replacements) {
  for (const { file, find, replace } of replacements) {
    const content = files.get(file);
    if (!content) throw new Error(`replacement target is not generated: ${file}`);
    const text = content.toString("utf8");
    const first = text.indexOf(find);
    if (first < 0) throw new Error(`replacement text not found in ${file}: ${find.slice(0, 60)}`);
    if (text.indexOf(find, first + find.length) >= 0) throw new Error(`replacement text is ambiguous in ${file}: ${find.slice(0, 60)}`);
    files.set(file, Buffer.from(text.slice(0, first) + replace + text.slice(first + find.length)));
  }
}

/**
 * Replaces the frontmatter description of a SKILL.md as a whole field, so the
 * Claude description never depends on the wording of the shared description.
 */
export function replaceFrontmatterDescription(text, description) {
  const lines = text.split("\n");
  const bare = (line) => line.replace(/\r$/u, "");
  if (bare(lines[0] ?? "") !== "---") throw new Error("SKILL.md has no frontmatter");
  const end = lines.findIndex((line, index) => index > 0 && bare(line) === "---");
  if (end < 0) throw new Error("SKILL.md frontmatter is not closed");
  const start = lines.findIndex((line, index) => index > 0 && index < end && /^description:/u.test(line));
  if (start < 0) throw new Error("SKILL.md frontmatter has no description");
  let stop = start + 1;
  while (stop < end && /^[ \t]/u.test(lines[stop])) stop += 1;
  const lineEnding = lines[start].endsWith("\r") ? "\r" : "";
  lines.splice(start, stop - start, `description: ${description}${lineEnding}`);
  return lines.join("\n");
}

/**
 * Rewrites Codex skill invocations such as `$task-contract` into the Claude
 * Code form for the skills that the Claude plugin ships.
 */
export function mapSkillInvocations(files, skillIds) {
  if (skillIds.length === 0) return;
  const alternatives = [...skillIds]
    .sort((left, right) => right.length - left.length)
    .map((skillId) => skillId.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const pattern = new RegExp(`(?<![\\w$])\\$(${alternatives.join("|")})(?![\\w-])`, "gu");
  for (const [relativePath, content] of files) {
    if (!isModelVisible(relativePath) || DUAL_HOST_FILES.includes(relativePath)) continue;
    const text = content.toString("utf8");
    const mapped = text.replace(pattern, `/${PLUGIN_NAME}:$1`);
    if (mapped !== text) files.set(relativePath, Buffer.from(mapped));
  }
}

function assertAdaptation(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must contain a JSON object`);
  const unknown = Object.keys(value).filter((key) => !ADAPTATION_KEYS.includes(key));
  if (unknown.length > 0) throw new Error(`${source} has unknown keys: ${unknown.join(", ")}`);
  const { description } = value;
  if (description !== undefined && (typeof description !== "string" || description.trim() === "" || /[\r\n]/u.test(description))) {
    throw new Error(`${source} description must be a non-empty single line`);
  }
  const replacements = value.replacements ?? [];
  if (!Array.isArray(replacements)) throw new Error(`${source} replacements must be an array`);
  for (const entry of replacements) {
    const valid = entry && typeof entry === "object" && !Array.isArray(entry)
      && Object.keys(entry).sort().join(",") === "file,find,replace"
      && ["file", "find", "replace"].every((key) => typeof entry[key] === "string")
      && entry.find !== ""
      && !entry.file.startsWith("/")
      && !entry.file.split("/").includes("..");
    if (!valid) throw new Error(`${source} has an invalid replacement entry`);
  }
  return { description, replacements };
}

/**
 * Applies one claude-overlay/adaptations/<skill>.json to the generated files.
 * The description replaces the whole frontmatter field; replacements use
 * paths relative to the skill directory and must match exactly once.
 */
export function applySkillAdaptation(files, skillId, adaptation, source = `${skillId}.json`) {
  const { description, replacements } = assertAdaptation(adaptation, source);
  const skillFile = `skills/${skillId}/SKILL.md`;
  if (!files.has(skillFile)) throw new Error(`${source}: skill is not generated: ${skillId}`);
  try {
    if (description !== undefined) {
      files.set(skillFile, Buffer.from(replaceFrontmatterDescription(files.get(skillFile).toString("utf8"), description)));
    }
    applyReplacements(files, replacements.map((entry) => ({ ...entry, file: `skills/${skillId}/${entry.file}` })));
  } catch (error) {
    throw new Error(`${source}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return output.split("\0").filter(Boolean);
}

async function walk(directory, base = directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(fullPath, base));
    else files.push(toPosix(path.relative(base, fullPath)));
  }
  return files;
}

function withoutExcludedSkills(json, key) {
  return {
    ...json,
    [key]: json[key].filter((entry) => !EXCLUDED_SKILLS.includes(entry.skillId)),
  };
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Returns the generated tree as a map of POSIX relative path to Buffer. */
export async function renderClaudePlugin(root = ROOT) {
  const files = new Map();
  const tracked = trackedFiles(root);
  const version = JSON.parse(await readFile(path.join(root, "release/version.json"), "utf8")).version;
  let registry = null;

  for (const relativePath of tracked) {
    const shared = SHARED_FILES.includes(relativePath) || SHARED_ROOTS.some((prefix) => relativePath.startsWith(prefix));
    if (!shared || isExcludedSkillPath(relativePath) || isCodexOnlySkillPath(relativePath)) continue;
    let content = await readFile(path.join(root, relativePath));
    if (relativePath === "skills/registry.json") {
      registry = withoutExcludedSkills(JSON.parse(content.toString("utf8")), "skills");
      content = Buffer.from(formatJson(registry));
    } else if (relativePath === "skills/source-lock.json") {
      content = Buffer.from(formatJson(withoutExcludedSkills(JSON.parse(content.toString("utf8")), "sources")));
    }
    files.set(relativePath, content);
  }

  const overlayRoot = path.join(root, OVERLAY_DIRECTORY);
  const overlayFiles = await walk(overlayRoot);
  const adaptationPrefix = `${ADAPTATIONS_DIRECTORY}/`;
  for (const relativePath of overlayFiles) {
    if (relativePath.startsWith(adaptationPrefix)) continue;
    if (files.has(relativePath)) throw new Error(`overlay must not replace a shared file wholesale: ${relativePath}`);
    let content = await readFile(path.join(overlayRoot, relativePath));
    if (relativePath === ".claude-plugin/plugin.json") {
      const manifest = JSON.parse(content.toString("utf8"));
      manifest.version = version;
      content = Buffer.from(formatJson(manifest));
    }
    files.set(relativePath, content);
  }
  for (const relativePath of overlayFiles.filter((file) => file.startsWith(adaptationPrefix)).sort()) {
    const source = `${OVERLAY_DIRECTORY}/${relativePath}`;
    const match = /^adaptations\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/u.exec(relativePath);
    if (!match) throw new Error(`unexpected adaptation file: ${source}`);
    applySkillAdaptation(files, match[1], JSON.parse(await readFile(path.join(overlayRoot, relativePath), "utf8")), source);
  }
  mapSkillInvocations(files, (registry?.skills ?? []).map((entry) => entry.skillId));
  const wording = findCodexOnlyWording(files);
  if (wording.length > 0) throw new Error(`Claude overlay is incomplete:\n${wording.map((problem) => `- ${problem}`).join("\n")}`);
  return files;
}

async function writeTree(directory, files) {
  await rm(directory, { recursive: true, force: true });
  for (const [relativePath, content] of files) {
    const destination = path.join(directory, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

/** Compares the committed claude-plugin/ tree with a fresh render. */
export async function checkClaudePlugin(root = ROOT) {
  const expected = await renderClaudePlugin(root);
  const outputRoot = path.join(root, OUTPUT_DIRECTORY);
  let actualPaths;
  try {
    actualPaths = await walk(outputRoot);
  } catch {
    return [`${OUTPUT_DIRECTORY}/ is missing; run pnpm claude:build`];
  }
  const problems = [];
  for (const relativePath of actualPaths) {
    if (!expected.has(relativePath)) problems.push(`unexpected file ${OUTPUT_DIRECTORY}/${relativePath}`);
  }
  for (const [relativePath, content] of expected) {
    let actual;
    try {
      actual = await readFile(path.join(outputRoot, ...relativePath.split("/")));
    } catch {
      problems.push(`missing file ${OUTPUT_DIRECTORY}/${relativePath}`);
      continue;
    }
    if (!actual.equals(content)) problems.push(`stale file ${OUTPUT_DIRECTORY}/${relativePath}`);
  }
  problems.push(...await findHookEventDrift(root));
  return problems;
}

/** Lists Codex hook events that the committed Claude plugin does not register. */
export async function findHookEventDrift(root = ROOT) {
  const events = async (relativePath) => Object.keys(JSON.parse(await readFile(path.join(root, relativePath), "utf8")).hooks ?? {});
  const claudeEvents = new Set(await events(`${OUTPUT_DIRECTORY}/hooks/hooks.json`));
  return (await events("hooks/hooks.json"))
    .filter((event) => !claudeEvents.has(event))
    .map((event) => `Codex hook event ${event} is not registered in ${OUTPUT_DIRECTORY}/hooks/hooks.json; add it to ${OVERLAY_DIRECTORY}/hooks/hooks.json`);
}

/**
 * Reports how the committed claude-plugin/ differs from the current sources
 * without failing. Shared-source changes do not have to regenerate the Claude
 * plugin, so a failed render is reported as drift as well. Hook event drift
 * does not depend on the render, so a failed render does not hide it.
 */
export async function reportClaudePluginDrift(root = ROOT) {
  try {
    return await checkClaudePlugin(root);
  } catch (error) {
    const problems = [`render failed: ${error instanceof Error ? error.message : String(error)}`];
    try {
      problems.push(...await findHookEventDrift(root));
    } catch {
      // The hook files are unreadable as well; the render failure already says why.
    }
    return problems;
  }
}

async function main() {
  if (process.argv.includes("--drift")) {
    const problems = await reportClaudePluginDrift();
    if (problems.length === 0) {
      console.log(`${OUTPUT_DIRECTORY}: fresh`);
      return;
    }
    const prefix = process.env.GITHUB_ACTIONS === "true" ? "::warning title=Claude plugin drift::" : "warning: ";
    console.log(`${prefix}${OUTPUT_DIRECTORY}/ differs from the current sources (${problems.length} item(s)). This does not block shared-source changes; run pnpm claude:build for a release or Claude-side work.`);
    for (const problem of problems.slice(0, 20)) console.log(`- ${problem}`);
    if (problems.length > 20) console.log(`- ... ${problems.length - 20} more`);
    return;
  }
  if (process.argv.includes("--check")) {
    const problems = await checkClaudePlugin();
    if (problems.length > 0) {
      console.error(problems.map((problem) => `- ${problem}`).join("\n"));
      console.error("Fix the listed claude-overlay files if any, then run pnpm claude:build and commit the result.");
      process.exitCode = 1;
      return;
    }
    console.log(`${OUTPUT_DIRECTORY}: fresh`);
    return;
  }
  const files = await renderClaudePlugin();
  await writeTree(path.join(ROOT, OUTPUT_DIRECTORY), files);
  console.log(`${OUTPUT_DIRECTORY}: wrote ${files.size} files`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
