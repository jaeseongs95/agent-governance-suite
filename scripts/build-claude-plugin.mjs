#!/usr/bin/env node
// Generates the isolated Claude Code plugin tree in claude-plugin/.
// Shared sources are copied from the repository root; Claude-only files come
// from claude-overlay/. The Codex plugin files are read, never written.
// Usage: node scripts/build-claude-plugin.mjs [--check]
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./lib.mjs";

export const OUTPUT_DIRECTORY = "claude-plugin";
export const OVERLAY_DIRECTORY = "claude-overlay";
export const EXCLUDED_SKILLS = Object.freeze(["codex-token-usage-analyzer"]);
const SHARED_ROOTS = Object.freeze(["skills/", "runtime/", "contracts/"]);
const SHARED_FILES = Object.freeze(["LICENSE", "mcp-server/dist/server.mjs", "mcp-server/dist/continuity-hook.mjs"]);
const REPLACEMENTS_FILE = "replacements.json";
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

function applyReplacements(files, replacements) {
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

function trackedFiles(root) {
  const output = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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

  for (const relativePath of tracked) {
    const shared = SHARED_FILES.includes(relativePath) || SHARED_ROOTS.some((prefix) => relativePath.startsWith(prefix));
    if (!shared || isExcludedSkillPath(relativePath)) continue;
    let content = await readFile(path.join(root, relativePath));
    if (relativePath === "skills/registry.json") {
      content = Buffer.from(formatJson(withoutExcludedSkills(JSON.parse(content.toString("utf8")), "skills")));
    } else if (relativePath === "skills/source-lock.json") {
      content = Buffer.from(formatJson(withoutExcludedSkills(JSON.parse(content.toString("utf8")), "sources")));
    }
    files.set(relativePath, content);
  }

  const overlayRoot = path.join(root, OVERLAY_DIRECTORY);
  const overlayFiles = await walk(overlayRoot);
  for (const relativePath of overlayFiles) {
    if (relativePath === REPLACEMENTS_FILE) continue;
    if (files.has(relativePath)) throw new Error(`overlay must not replace a shared file wholesale: ${relativePath}`);
    let content = await readFile(path.join(overlayRoot, relativePath));
    if (relativePath === ".claude-plugin/plugin.json") {
      const manifest = JSON.parse(content.toString("utf8"));
      manifest.version = version;
      content = Buffer.from(formatJson(manifest));
    }
    files.set(relativePath, content);
  }
  if (overlayFiles.includes(REPLACEMENTS_FILE)) {
    const { replacements } = JSON.parse(await readFile(path.join(overlayRoot, REPLACEMENTS_FILE), "utf8"));
    applyReplacements(files, replacements);
  }
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
  let actualPaths = [];
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
  return problems;
}

async function main() {
  if (process.argv.includes("--check")) {
    const problems = await checkClaudePlugin();
    if (problems.length > 0) {
      console.error(problems.map((problem) => `- ${problem}`).join("\n"));
      console.error("Run pnpm claude:build and commit the result.");
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
