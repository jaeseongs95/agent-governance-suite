import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAntigravityToolCall } from "../../antigravity-connector/hooks/antigravity-hook-runner.mjs";
import { ROOT } from "../../scripts/lib.mjs";

const ALLOWED_ANTIGRAVITY_MANIFEST_KEYS = new Set([
  "name",
  "displayName",
  "description",
  "version",
  "suggestedPrompts",
  "logo",
  "disabled",
]);

describe("Antigravity native plugin layout (AGS-D-0321)", () => {
  it("provides standard root plugin.json and .gemini-plugin/plugin.json manifests without non-standard fields", () => {
    const release = JSON.parse(readFileSync(path.join(ROOT, "release", "version.json"), "utf8"));
    const rootManifestPath = path.join(ROOT, "plugin.json");
    const geminiManifestPath = path.join(ROOT, ".gemini-plugin", "plugin.json");

    expect(existsSync(rootManifestPath)).toBe(true);
    expect(existsSync(geminiManifestPath)).toBe(true);

    for (const manifestPath of [rootManifestPath, geminiManifestPath]) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      expect(manifest.name).toBe("agent-governance-suite");
      expect(manifest.displayName).toBe("Agent Governance Suite");
      expect(manifest.version).toBe(release.version);
      expect(typeof manifest.description).toBe("string");
      expect(manifest.description.length).toBeGreaterThan(0);

      for (const key of Object.keys(manifest)) {
        expect(
          ALLOWED_ANTIGRAVITY_MANIFEST_KEYS.has(key),
          `${path.relative(ROOT, manifestPath)} has non-standard field "${key}"`,
        ).toBe(true);
      }

      if (manifest.suggestedPrompts !== undefined) {
        expect(Array.isArray(manifest.suggestedPrompts)).toBe(true);
        expect(manifest.suggestedPrompts.length).toBeLessThanOrEqual(3);
      }
    }
  });

  it("places Antigravity lifecycle hooks.json at the plugin root with valid named hook groups and commands", () => {
    const rootHooksPath = path.join(ROOT, "hooks.json");
    expect(existsSync(rootHooksPath)).toBe(true);

    const hooks = JSON.parse(readFileSync(rootHooksPath, "utf8"));
    expect(hooks.hooks).toBeUndefined();

    const lifecycle = hooks["ags-session-lifecycle"];
    expect(lifecycle).toBeDefined();
    expect(lifecycle.enabled).toBe(true);
    for (const eventName of ["SessionStart", "PreInvocation", "PostInvocation", "Stop"]) {
      expect(Array.isArray(lifecycle[eventName])).toBe(true);
      expect(lifecycle[eventName].length).toBeGreaterThan(0);
      for (const handler of lifecycle[eventName]) {
        expect(handler.type).toBe("command");
        expect(handler.command).toContain("./antigravity-connector/hooks/antigravity-hook-runner.mjs");
        expect(handler.command).toContain(`--event=${eventName}`);
      }
    }

    const toolBoundary = hooks["ags-tool-boundary"];
    expect(toolBoundary).toBeDefined();
    expect(toolBoundary.enabled).toBe(true);
    for (const eventName of ["PreToolUse", "PostToolUse"]) {
      expect(Array.isArray(toolBoundary[eventName])).toBe(true);
      expect(toolBoundary[eventName].length).toBeGreaterThan(0);
      for (const group of toolBoundary[eventName]) {
        expect(typeof group.matcher).toBe("string");
        expect(Array.isArray(group.hooks)).toBe(true);
        expect(group.hooks.length).toBeGreaterThan(0);
        for (const handler of group.hooks) {
          expect(handler.type).toBe("command");
          expect(handler.command).toContain("./antigravity-connector/hooks/antigravity-hook-runner.mjs");
          expect(handler.command).toContain(`--event=${eventName}`);
        }
      }
    }
  });

  it("exposes mcp_config.json and skills directory at the plugin root and normalizes plugin-namespaced MCP server calls", () => {
    const mcpConfigPath = path.join(ROOT, "mcp_config.json");
    expect(existsSync(mcpConfigPath)).toBe(true);
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(mcpConfig.mcpServers?.["agent-governance-suite"]?.command).toBe("node");
    expect(existsSync(path.join(ROOT, "skills"))).toBe(true);

    const wrapped = normalizeAntigravityToolCall({
      toolCall: {
        name: "default_api:call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite_agent-governance-suite",
          ToolName: "get_skill_inventory",
          Arguments: { schemaVersion: "2.0.0" },
        },
      },
    });
    expect(wrapped.canonicalName).toBe("mcp__agent-governance-suite__get_skill_inventory");
    expect(wrapped.isMcpWrapperCall).toBe(true);

    const direct = normalizeAntigravityToolCall({
      toolCall: {
        name: "default_api:mcp_agent-governance-suite_agent-governance-suite_get_skill_inventory",
        args: { schemaVersion: "2.0.0" },
      },
    });
    expect(direct.canonicalName).toBe("mcp__agent-governance-suite__get_skill_inventory");
  });
});
