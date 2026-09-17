import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyReplacements,
  checkClaudePlugin,
  DUAL_HOST_FILES,
  EXCLUDED_SKILLS,
  findCodexOnlyWording,
  OUTPUT_DIRECTORY,
} from "../../scripts/build-claude-plugin.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const pluginRoot = path.join(root, OUTPUT_DIRECTORY);
const toolPrefix = "mcp__plugin_agent-governance-suite_agent-governance-suite__";
const continuityTools = [
  "open_convergence_root",
  "checkpoint_context",
  "inspect_context",
  "load_context",
  "suppress_context_restore",
  "purge_direct_context",
];
const temporaryDirectories = [];

async function readJson(...segments) {
  return JSON.parse(await readFile(path.join(...segments), "utf8"));
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("generated Claude plugin", () => {
  it("matches a fresh render of the shared sources and overlay", async () => {
    expect(await checkClaudePlugin(root)).toEqual([]);
  });

  it("uses the release version and plugin-scoped runtime paths", async () => {
    const release = await readJson(root, "release", "version.json");
    const manifest = await readJson(pluginRoot, ".claude-plugin", "plugin.json");
    expect(manifest.name).toBe("agent-governance-suite");
    expect(manifest.version).toBe(release.version);
    const server = manifest.mcpServers["agent-governance-suite"];
    expect(server.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/server.mjs"]);
    expect(server.env.AGENT_GOVERNANCE_DB_PATH).toBe("${CLAUDE_PLUGIN_DATA}/workflows.sqlite3");
    expect(server.env.AGENT_GOVERNANCE_CONTINUITY_DB_PATH).toBe("${CLAUDE_PLUGIN_DATA}/continuity.sqlite3");
  });

  it("publishes a separate marketplace that points only at the generated tree", async () => {
    const claudeMarketplace = await readJson(root, ".claude-plugin", "marketplace.json");
    const codexMarketplace = await readJson(root, ".agents", "plugins", "marketplace.json");
    expect(claudeMarketplace.name).not.toBe(codexMarketplace.name);
    expect(claudeMarketplace.plugins).toEqual([
      expect.objectContaining({ name: "agent-governance-suite", source: `./${OUTPUT_DIRECTORY}` }),
    ]);
    const codexManifest = await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8");
    expect(codexManifest).not.toContain(OUTPUT_DIRECTORY);
  });

  it("omits Codex-only skills from files, registry, and source lock", async () => {
    const skillDirectories = await readdir(path.join(pluginRoot, "skills"));
    const registry = await readJson(pluginRoot, "skills", "registry.json");
    const sourceLock = await readJson(pluginRoot, "skills", "source-lock.json");
    for (const skill of EXCLUDED_SKILLS) {
      expect(skillDirectories).not.toContain(skill);
      expect(registry.skills.map((entry) => entry.skillId)).not.toContain(skill);
      expect(sourceLock.sources.map((entry) => entry.skillId)).not.toContain(skill);
    }
  });

  it("registers exec-form hooks for the same lifecycle events as the Codex plugin", async () => {
    const claudeHooks = await readJson(pluginRoot, "hooks", "hooks.json");
    const codexHooks = await readJson(root, "hooks", "hooks.json");
    expect(Object.keys(claudeHooks.hooks).sort()).toEqual(Object.keys(codexHooks.hooks).sort());
    for (const groups of Object.values(claudeHooks.hooks)) {
      for (const hook of groups.flatMap((group) => group.hooks)) {
        expect(hook).toMatchObject({ type: "command", command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/hooks/continuity-hook.mjs"] });
      }
    }
    const matcher = new RegExp(claudeHooks.hooks.PreToolUse[0].matcher, "u");
    for (const tool of continuityTools) {
      expect(matcher.test(`${toolPrefix}${tool}`)).toBe(true);
      expect(matcher.test(`mcp__agent-governance-suite__${tool}`)).toBe(false);
    }
    expect(matcher.test(`${toolPrefix}plan_workflow`)).toBe(false);
  });

  it("exits quietly without touching shared state when plugin data is unavailable", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "claude-plugin-hook-"));
    temporaryDirectories.push(home);
    const environment = { ...process.env, HOME: home, USERPROFILE: home, XDG_STATE_HOME: path.join(home, "state"), LOCALAPPDATA: path.join(home, "local") };
    delete environment.CLAUDE_PLUGIN_DATA;
    delete environment.AGENT_GOVERNANCE_DB_PATH;
    delete environment.AGENT_GOVERNANCE_CONTINUITY_DB_PATH;
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "continuity-hook.mjs")], {
      encoding: "utf8",
      env: environment,
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "test-session" }),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(await readdir(home)).toEqual([]);
  });

  it("stores continuity state under the plugin data directory", async () => {
    const data = await mkdtemp(path.join(tmpdir(), "claude-plugin-data-"));
    temporaryDirectories.push(data);
    const result = spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "continuity-hook.mjs")], {
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data },
      input: JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "test-session" }),
    });
    expect(result.status).toBe(0);
    expect(await readdir(data)).toContain("continuity.sqlite3");
  });
});

describe("Claude overlay safeguards", () => {
  it("reports Codex-only wording in model-visible files except dual-host documents", () => {
    const files = new Map([
      ["skills/example/SKILL.md", Buffer.from("Use `fork_turns:none` for reviewers.\n")],
      ["skills/example/references/guide.md", Buffer.from("Call $example-skill directly.\n")],
      ["skills/example/README.md", Buffer.from("Install with Codex.\n")],
      [DUAL_HOST_FILES[0], Buffer.from("Coordinate subagents in Codex and Claude Code.\n")],
    ]);
    expect(findCodexOnlyWording(files)).toEqual([
      `Codex-only wording in ${OUTPUT_DIRECTORY}/skills/example/SKILL.md:1`,
      `Codex-only wording in ${OUTPUT_DIRECTORY}/skills/example/references/guide.md:1`,
    ]);
  });

  it("applies each replacement exactly once and rejects missing or ambiguous text", () => {
    const files = new Map([["skills/example/SKILL.md", Buffer.from("alpha beta alpha")]]);
    applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "beta", replace: "gamma" }]);
    expect(files.get("skills/example/SKILL.md").toString("utf8")).toBe("alpha gamma alpha");
    expect(() => applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "beta", replace: "x" }])).toThrow(/not found/u);
    expect(() => applyReplacements(files, [{ file: "skills/example/SKILL.md", find: "alpha", replace: "x" }])).toThrow(/ambiguous/u);
    expect(() => applyReplacements(files, [{ file: "skills/missing/SKILL.md", find: "a", replace: "b" }])).toThrow(/not generated/u);
  });
});
