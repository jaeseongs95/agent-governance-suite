import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// CI runs only checks whose verdict cannot depend on runner speed. A test that
// starts real processes, worker threads or a stdio MCP server measures the
// machine as much as the code, so it belongs to the test servers (Linux and
// Windows), which run the whole suite. The split is derived from the code, not
// from a hand-kept list: a test file is a server test when it, or a local
// module it imports from tests/, scripts/ or skills/, uses one of these.
const PROCESS_BOUNDARY = /node:child_process|["']child_process["']|node:worker_threads|StdioClientTransport|client\/stdio/u;
const LOCAL_IMPORT = /(?:from\s+|import\s*\(\s*|vi\.mock\(\s*)["'](\.{1,2}\/[^"']+)["']/gu;
const FOLLOWED_ROOTS = ["tests", "scripts", "skills"];

const root = path.resolve(import.meta.dirname, "..");

function resolveLocal(fromFile, specifier) {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const stem = base.replace(/\.(?:m|c)?js$/u, "");
  for (const candidate of [base, `${stem}.ts`, `${stem}.mts`, `${stem}.mjs`, `${stem}.js`, path.join(base, "index.ts"), path.join(base, "index.mjs")]) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
  }
  return null;
}

function followed(file) {
  const relative = path.relative(root, file).split(path.sep);
  return FOLLOWED_ROOTS.includes(relative[0]);
}

const verdicts = new Map();

/** True when the file reaches a real process boundary through followed local imports. */
export function crossesProcessBoundary(file, visiting = new Set()) {
  if (verdicts.has(file)) return verdicts.get(file);
  // This module names the patterns it looks for; it starts no process itself.
  if (file === import.meta.filename) return false;
  if (visiting.has(file)) return false;
  visiting.add(file);
  const source = readFileSync(file, "utf8");
  let result = PROCESS_BOUNDARY.test(source);
  for (const match of source.matchAll(LOCAL_IMPORT)) {
    if (result) break;
    const target = resolveLocal(file, match[1]);
    if (target && followed(target)) result = crossesProcessBoundary(target, visiting);
  }
  visiting.delete(file);
  verdicts.set(file, result);
  return result;
}

// The files Vitest collects (its default include, configDefaults.include) and the node:test suites
// scripts/run-tests.mjs collects. The whole repository is searched like Vitest does, minus its default
// excludes, so a test outside tests/ is classified too (antigravity-connector/hooks has some).
const VITEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/u;
const NODE_TEST_FILE = /\.node-test\.mjs$/u;
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git"]);

function listTests(directory, pattern) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) { if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...listTests(target, pattern)); }
    else if (entry.isFile() && pattern.test(entry.name)) files.push(target);
  }
  return files.sort();
}

const relative = file => path.relative(root, file).split(path.sep).join("/");

/** Every Vitest and node:test file, relative to the repository root with "/" separators. */
export function testFiles() {
  return [...listTests(root, VITEST_FILE), ...listTests(root, NODE_TEST_FILE)].map(relative).sort();
}

/** Test files the test servers measure and CI leaves out, relative to the repository root with "/" separators. */
export function serverOnlyTests() {
  return testFiles().filter(file => crossesProcessBoundary(path.join(root, ...file.split("/"))));
}

/** AGS_TEST_SCOPE=ci selects the CI subset; anything else (test servers, local) runs everything. */
export const ciScope = process.env.AGS_TEST_SCOPE === "ci";

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const all = testFiles();
  const server = serverOnlyTests();
  console.log(JSON.stringify({ total: all.length, serverOnly: server.length, ci: all.length - server.length }));
}
