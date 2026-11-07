import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { cleanupLegacyServerKey, LEGACY_SERVER_KEY } from "./legacy-server-key-cleanup.mjs";

// AGS3-D-0028: a fake home directory per case. The layout is the one agy writes (test server observation 2026-11-07:
// ~/.gemini/antigravity-cli/mcp/agent-governance-suite_agent-governance-suite/ held 31 <tool>.json files with
// {name, description, parameters} and an instructions.md; antigravity.google/docs/mcp names the same two kinds).
const homes = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const LEGACY = `agent-governance-suite_${LEGACY_SERVER_KEY}`;
function fakeHome({ serverKey = "ags" } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "ags-d28-home-"));
  homes.push(home);
  const pluginRoot = path.join(home, ".gemini", "config", "plugins", "agent-governance-suite");
  mkdirSync(pluginRoot, { recursive: true });
  writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "agent-governance-suite", version: "3.9.0" }));
  writeFileSync(path.join(pluginRoot, "mcp_config.json"), JSON.stringify({ mcpServers: { [serverKey]: { command: "node" } } }));
  return { home, pluginRoot };
}
function schemaFolder(home, root, namespace, tools = ["abort_workflow", "get_skill_inventory"], instructions = true) {
  const folder = path.join(home, ".gemini", root, "mcp", namespace);
  mkdirSync(folder, { recursive: true });
  for (const tool of tools) writeFileSync(path.join(folder, `${tool}.json`), JSON.stringify({ name: tool, description: "d", parameters: {} }));
  if (instructions) writeFileSync(path.join(folder, "instructions.md"), "agent-governance-suite intake\n");
  return folder;
}
const digest = folder => createHash("sha256").update(JSON.stringify(readdirSync(folder).sort()
  .map(entry => [entry, readFileSync(path.join(folder, entry), "utf8")]))).digest("hex");
const run = (pluginRoot, home, extra = {}) => cleanupLegacyServerKey({ pluginRoot, homeDir: home, ...extra });

describe("AGS3-D-0028 legacy server key cache cleanup", () => {
  it("LK01: moves the old namespace's schema caches of both agy roots to a backup and touches no other server", () => {
    const { home, pluginRoot } = fakeHome();
    const legacy = ["antigravity", "antigravity-cli"].map(root => schemaFolder(home, root, LEGACY));
    const legacyDigests = legacy.map(digest);
    const others = [
      schemaFolder(home, "antigravity-cli", "agent-governance-suite_ags"),
      schemaFolder(home, "antigravity-cli", LEGACY_SERVER_KEY), // a global (non-plugin) server under the bare old key
      schemaFolder(home, "antigravity-cli", `other-plugin_${LEGACY_SERVER_KEY}`),
      schemaFolder(home, "antigravity", "ledger-test", ["ledger_whoami"]),
    ];
    const otherDigests = others.map(digest);
    const report = run(pluginRoot, home, { now: new Date("2026-11-07T00:00:00Z") });
    expect(report.moved.map(item => item.path)).toEqual(legacy);
    expect(report.kept).toEqual([]);
    for (const [index, folder] of legacy.entries()) {
      expect(existsSync(folder)).toBe(false);
      expect(digest(report.moved[index].backup)).toBe(legacyDigests[index]);
      expect(path.dirname(path.dirname(report.moved[index].backup))).toBe(path.dirname(path.dirname(folder)));
    }
    expect(others.map(digest)).toEqual(otherDigests);
    // Restore is the reverse rename the report names.
    renameSync(report.moved[0].backup, report.moved[0].path);
    expect(digest(legacy[0])).toBe(legacyDigests[0]);
  });

  it("LK02: keeps a folder holding anything that is not an agy tool schema and reports why", () => {
    const { home, pluginRoot } = fakeHome();
    const folder = schemaFolder(home, "antigravity-cli", LEGACY);
    writeFileSync(path.join(folder, "notes.txt"), "user file");
    const mismatched = schemaFolder(home, "antigravity", LEGACY, [], false);
    writeFileSync(path.join(mismatched, "a.json"), JSON.stringify({ name: "b" }));
    const before = [digest(folder), digest(mismatched)];
    const report = run(pluginRoot, home);
    expect(report.moved).toEqual([]);
    expect(report.kept).toEqual([
      { path: mismatched, entry: "a.json", reason: "UNRECOGNIZED_ENTRY" },
      { path: folder, entry: "notes.txt", reason: "UNRECOGNIZED_ENTRY" },
    ]);
    expect([digest(folder), digest(mismatched)]).toEqual(before);
  });

  it.skipIf(process.platform === "win32")("LK03: keeps a symbolic link in place of the namespace folder", () => {
    const { home, pluginRoot } = fakeHome();
    const target = schemaFolder(home, "elsewhere", "x");
    const link = path.join(home, ".gemini", "antigravity-cli", "mcp", LEGACY);
    mkdirSync(path.dirname(link), { recursive: true });
    symlinkSync(target, link);
    expect(run(pluginRoot, home).kept).toEqual([{ path: link, reason: "NOT_A_DIRECTORY" }]);
    expect(existsSync(path.join(target, "abort_workflow.json"))).toBe(true);
  });

  it("LK04: does nothing while the current config still uses the old key, or outside an agy install", () => {
    const current = fakeHome({ serverKey: LEGACY_SERVER_KEY });
    const folder = schemaFolder(current.home, "antigravity-cli", LEGACY);
    expect(run(current.pluginRoot, current.home)).toMatchObject({ moved: [], kept: [], skipped: "LEGACY_KEY_CURRENT" });
    expect(existsSync(folder)).toBe(true);
    const other = fakeHome();
    const otherFolder = schemaFolder(other.home, "antigravity-cli", LEGACY);
    // The same files run from a checkout outside <home>/.gemini (a source tree, another host's install).
    const checkout = mkdtempSync(path.join(os.tmpdir(), "ags-d28-checkout-"));
    homes.push(checkout);
    writeFileSync(path.join(checkout, "plugin.json"), JSON.stringify({ name: "agent-governance-suite" }));
    writeFileSync(path.join(checkout, "mcp_config.json"), JSON.stringify({ mcpServers: { ags: {} } }));
    expect(run(checkout, other.home)).toMatchObject({ moved: [], skipped: "NOT_AN_ANTIGRAVITY_INSTALL" });
    expect(existsSync(otherFolder)).toBe(true);
  });

  it("LK05: a second run finds nothing more to do", () => {
    const { home, pluginRoot } = fakeHome();
    schemaFolder(home, "antigravity-cli", LEGACY);
    expect(run(pluginRoot, home).moved).toHaveLength(1);
    expect(run(pluginRoot, home)).toEqual({ moved: [], kept: [] });
  });

  it("LK06: keeps a folder whose instructions.md is not a regular file", () => {
    const { home, pluginRoot } = fakeHome();
    const folder = schemaFolder(home, "antigravity-cli", LEGACY, ["abort_workflow"], false);
    mkdirSync(path.join(folder, "instructions.md"));
    expect(run(pluginRoot, home)).toEqual({ moved: [], kept: [{ path: folder, entry: "instructions.md", reason: "UNRECOGNIZED_ENTRY" }] });
    expect(existsSync(path.join(folder, "abort_workflow.json"))).toBe(true);
  });
});
