import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// AGS3-D-0028: before 3.0 the Antigravity MCP server key was `agent-governance-suite` (mcp_config.json, fade12db). agy
// names a plugin server `<plugin name>_<server key>` and writes its lazy tool schemas to
// `<home>/.gemini/antigravity{,-cli}/mcp/<server name>/<tool>.json` plus an optional `instructions.md`
// (antigravity.google/docs/mcp; docs/antigravity-migration.md). After an update to the `ags` key the old server's
// folder stayed next to the new one. This moves only that folder, and only when every entry in it is what agy writes
// there, to a same-disk backup, and reports each target with what it did. It ends no process: the old key's server is
// a child of the app session that started it and is gone once the app restarts with the new config.
export const LEGACY_SERVER_KEY = "agent-governance-suite";
const CACHE_ROOTS = [["antigravity"], ["antigravity-cli"]];
const BACKUP_DIRECTORY = "ags-legacy-server-key-backup";
const INSTRUCTIONS_FILE = "instructions.md";
const MAX_ENTRY_BYTES = 1024 * 1024;

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** Why a cache folder is not provably an agy tool-schema cache, or null when it is. */
function foreignContent(directory) {
  for (const entry of readdirSync(directory)) {
    const stats = lstatSync(path.join(directory, entry));
    if (!stats.isFile() || stats.size > MAX_ENTRY_BYTES) return { entry, reason: "UNRECOGNIZED_ENTRY" };
    if (entry === INSTRUCTIONS_FILE) continue;
    if (!entry.endsWith(".json")) return { entry, reason: "UNRECOGNIZED_ENTRY" };
    let schema;
    try { schema = readJson(path.join(directory, entry)); } catch { return { entry, reason: "UNRECOGNIZED_ENTRY" }; }
    // agy writes each tool's schema as {name, description, parameters} under the tool's own name.
    if (!schema || typeof schema !== "object" || schema.name !== entry.slice(0, -".json".length)) return { entry, reason: "UNRECOGNIZED_ENTRY" };
  }
  return null;
}

function cleanCaches(namespace, homeDir, stamp, report) {
  for (const segments of CACHE_ROOTS) {
    const root = path.join(homeDir, ".gemini", ...segments);
    const folder = path.join(root, "mcp", namespace);
    let stats;
    try { stats = lstatSync(folder); } catch (cause) {
      if (cause?.code !== "ENOENT") report.kept.push({ path: folder, reason: "UNREADABLE", code: cause?.code ?? "UNKNOWN" });
      continue;
    }
    if (!stats.isDirectory()) { report.kept.push({ path: folder, reason: "NOT_A_DIRECTORY" }); continue; }
    try {
      const foreign = foreignContent(folder);
      if (foreign) { report.kept.push({ path: folder, ...foreign }); continue; }
      const backup = path.join(root, BACKUP_DIRECTORY, `${namespace}-${stamp}`);
      mkdirSync(path.dirname(backup), { recursive: true });
      // Same parent disk as the cache: a rename, undone by renaming the backup back to `path`.
      renameSync(folder, backup);
      report.moved.push({ path: folder, backup });
    } catch (cause) {
      report.kept.push({ path: folder, reason: "MOVE_FAILED", code: cause?.code ?? "UNKNOWN" });
    }
  }
}

/**
 * Move the old server key's tool-schema caches of this plugin install to a backup. Returns a report: `moved` folders
 * (with backup) and `kept` folders (with the reason). Nothing is touched outside an agy install or while the current
 * mcp_config.json still uses the old key.
 */
export function cleanupLegacyServerKey(options = {}) {
  const pluginRoot = realpathSync(options.pluginRoot);
  const homeDir = options.homeDir ?? os.homedir();
  const report = { moved: [], kept: [] };
  // agy installs a plugin as a copy under <home>/.gemini (`agy plugin install`: ~/.gemini/config/plugins/<name>). A
  // source checkout or another host's install of the same files is not that install and touches nothing.
  let geminiHome;
  try { geminiHome = realpathSync(path.join(homeDir, ".gemini")); } catch { return { ...report, skipped: "NOT_AN_ANTIGRAVITY_INSTALL" }; }
  const relative = path.relative(geminiHome, pluginRoot);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return { ...report, skipped: "NOT_AN_ANTIGRAVITY_INSTALL" };
  const name = readJson(path.join(pluginRoot, "plugin.json")).name;
  const keys = Object.keys(readJson(path.join(pluginRoot, "mcp_config.json")).mcpServers ?? {});
  if (typeof name !== "string" || !name || keys.includes(LEGACY_SERVER_KEY)) return { ...report, skipped: "LEGACY_KEY_CURRENT" };
  const stamp = (options.now ?? new Date()).toISOString().replace(/[:.]/gu, "-");
  cleanCaches(`${name}_${LEGACY_SERVER_KEY}`, homeDir, stamp, report);
  return report;
}

/** True when the report names a moved or kept folder a person should know about. */
export function legacyCleanupActed(report) {
  return report.moved.length + report.kept.length > 0;
}
