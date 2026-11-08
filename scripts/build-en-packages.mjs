#!/usr/bin/env node
// Generates the English-only packages (docs/contributing/i18n.md 8):
//   claude-plugin-en/  the committed claude-plugin/ tree
//   codex-plugin-en/   the tracked files the Codex plugin reads
// Both differ from their source in runtime/locale.json, which makes AGS speak English; the Codex
// package also renames its manifest (see codexManifest).
// Skill text stays in its source language until skills are translated (i18n design 7.1).
//
// Usage: node scripts/build-en-packages.mjs [--check | --drift]
//   --check  fail when a committed package differs from a fresh render
//   --drift  report the difference without failing (CI; a release runs --check)
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ROOT } from "./lib.mjs";

export const LOCALE_FILE = "runtime/locale.json";
export const EN_LOCALE = Buffer.from(`${JSON.stringify({ locale: "en" }, null, 2)}\n`);
// What the Codex plugin reads: manifest, MCP server and hooks, the runtime and skills, and the
// adaptation files runtime/engineering-practices/CONTENT_LOCK.json pins (same as the agy package).
export const CODEX_PATHS = Object.freeze([
  ".codex-plugin/",
  ".mcp.json",
  "hooks/",
  "contracts/",
  "mcp-server/dist/",
  "runtime/",
  "skills/",
  "claude-overlay/adaptations/code-review.json",
  "claude-overlay/adaptations/test-engineering.json",
  "release/version.json",
  "LICENSE",
]);
export const PACKAGES = Object.freeze({
  "claude-plugin-en": (file) => file.startsWith("claude-plugin/") ? file.slice("claude-plugin/".length) : null,
  "codex-plugin-en": (file) => {
    if (file === "README.en.md") return "README.md";
    return CODEX_PATHS.some((entry) => entry.endsWith("/") ? file.startsWith(entry) : file === entry) ? file : null;
  },
});

export const CODEX_MANIFEST = ".codex-plugin/plugin.json";
export const CODEX_EN_NAME = "agent-governance-suite-en";

// Codex refuses a marketplace entry whose name differs from the manifest name (codex-cli 0.166.0:
// "plugin.json name `agent-governance-suite` does not match marketplace plugin name"), so the
// English Codex package carries its entry name. Claude Code allows the two names to differ and
// keeps the manifest name, so Claude skill names do not change.
function codexManifest(content) {
  const manifest = JSON.parse(content.toString("utf8"));
  manifest.id = CODEX_EN_NAME;
  manifest.name = CODEX_EN_NAME;
  manifest.interface = {
    ...manifest.interface,
    displayName: `${manifest.interface.displayName} (English)`,
    shortDescription: "Coordinates specialist skills and audit flows",
    longDescription: "A governance plugin that classifies requests and links execution order and evidence while keeping each specialist skill's responsibility. AGS messages are in English; skill text stays in its source language.",
  };
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}
`);
}

function trackedFiles(root) {
  return execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
}

/** Paths git would not add (tracked files never count as ignored). */
function ignoredPaths(root, files) {
  const result = spawnSync("git", ["-C", root, "check-ignore", "--stdin", "-z"], { input: files.join("\0"), encoding: "utf8" });
  if (result.status !== 0 && result.status !== 1) throw new Error(`git check-ignore failed: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

/** Rendered files of a package that .gitignore would keep out of a commit. */
export async function ignoredPackageFiles(name, root = ROOT) {
  return ignoredPaths(root, [...(await renderEnPackage(name, root)).keys()].map((file) => `${name}/${file}`));
}

/** Renders one package as relative path -> bytes. */
export async function renderEnPackage(name, root = ROOT) {
  const select = PACKAGES[name];
  if (!select) throw new Error(`unknown package: ${name}`);
  const files = new Map();
  for (const file of trackedFiles(root)) {
    const target = select(file);
    if (target !== null) files.set(target, await readFile(path.join(root, file)));
  }
  if (!files.has(LOCALE_FILE)) throw new Error(`${name}: ${LOCALE_FILE} is missing from the source`);
  files.set(LOCALE_FILE, EN_LOCALE);
  if (name === "codex-plugin-en") files.set(CODEX_MANIFEST, codexManifest(files.get(CODEX_MANIFEST)));
  return files;
}

/** Lists how the committed package differs from a fresh render. */
export async function checkEnPackage(name, root = ROOT) {
  const expected = await renderEnPackage(name, root);
  const directory = path.join(root, name);
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [`${name}/ is missing; run pnpm en:build`];
    throw error;
  }
  const actual = new Set(entries.filter((entry) => entry.isFile())
    .map((entry) => path.relative(directory, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")));
  const problems = [];
  for (const file of actual) if (!expected.has(file)) problems.push(`unexpected file ${name}/${file}`);
  // A file .gitignore drops never reaches the published package even though it is on disk.
  for (const file of ignoredPaths(root, [...expected.keys()].map((file) => `${name}/${file}`))) problems.push(`ignored by .gitignore ${file}; add an exception so it is committed`);
  for (const [file, content] of expected) {
    if (!actual.has(file)) { problems.push(`missing file ${name}/${file}`); continue; }
    if (!(await readFile(path.join(root, name, file))).equals(content)) problems.push(`stale file ${name}/${file}`);
  }
  return problems;
}

async function writePackage(name, files, root = ROOT) {
  const directory = path.join(root, name);
  await rm(directory, { recursive: true, force: true });
  for (const [file, content] of files) {
    const destination = path.join(directory, ...file.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content);
  }
}

async function main() {
  const mode = process.argv.includes("--check") ? "check" : process.argv.includes("--drift") ? "drift" : "write";
  let failed = false;
  for (const name of Object.keys(PACKAGES)) {
    if (mode === "write") {
      const files = await renderEnPackage(name);
      await writePackage(name, files);
      console.log(`${name}: wrote ${files.size} files`);
      continue;
    }
    const problems = await checkEnPackage(name);
    if (problems.length === 0) { console.log(`${name}: fresh`); continue; }
    const prefix = mode === "drift" && process.env.GITHUB_ACTIONS === "true" ? "::warning title=English package drift::" : "";
    console.log(`${prefix}${name}/ differs from its source (${problems.length} item(s)); run pnpm en:build after claude:build.`);
    for (const problem of problems.slice(0, 20)) console.log(`- ${problem}`);
    if (mode === "check") failed = true;
  }
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
