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

  it("exposes mcp_config.json with short 'ags' server key so all 31 MCP tool names stay within Antigravity's 64-char limit (AGS-D-0322)", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "plugin.json"), "utf8"));
    const mcpConfigPath = path.join(ROOT, "mcp_config.json");
    expect(existsSync(mcpConfigPath)).toBe(true);
    const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
    expect(Object.keys(mcpConfig.mcpServers ?? {})).toEqual(["ags"]);
    expect(mcpConfig.mcpServers?.ags?.command).toBe("node");
    expect(mcpConfig.mcpServers?.ags?.env?.AGENT_GOVERNANCE_HOST_ATTESTATION).toBe("gemini");
    expect(existsSync(path.join(ROOT, "skills"))).toBe(true);

    // Codex and Claude manifests keep their own server key and hook matchers unchanged.
    const codexMcp = JSON.parse(readFileSync(path.join(ROOT, ".mcp.json"), "utf8"));
    expect(Object.keys(codexMcp.mcpServers ?? {})).toEqual(["agent-governance-suite"]);
    const claudePlugin = JSON.parse(readFileSync(path.join(ROOT, "claude-overlay", ".claude-plugin", "plugin.json"), "utf8"));
    expect(Object.keys(claudePlugin.mcpServers ?? {})).toEqual(["agent-governance-suite"]);

    const serverSource = readFileSync(path.join(ROOT, "mcp-server", "src", "server.ts"), "utf8");
    const advertiseBlock = serverSource.split("const tools = advertise([")[1]?.split("diagnostics?.registerMethods")[0] ?? "";
    const toolNames = [...advertiseBlock.matchAll(/^\s*name:\s*"([^"]+)"/gmu)].map((m) => m[1]);
    expect(toolNames.length).toBe(31);
    expect(toolNames).toContain("validate_collaboration_decision");

    const serverKey = Object.keys(mcpConfig.mcpServers)[0];
    const legacyOverflowTools = [];
    for (const toolName of toolNames) {
      const combinedName = `mcp_${manifest.name}_${serverKey}_${toolName}`;
      expect(combinedName.length, `${combinedName} exceeds 64 chars`).toBeLessThanOrEqual(64);
      expect(combinedName).toMatch(/^[a-zA-Z0-9_-]{1,64}$/u);

      const legacyName = `mcp_${manifest.name}_agent-governance-suite_${toolName}`;
      if (legacyName.length > 64) legacyOverflowTools.push(toolName);

      const wrapped = normalizeAntigravityToolCall({
        toolCall: {
          name: "default_api:call_mcp_tool",
          args: {
            ServerName: `${manifest.name}_${serverKey}`,
            ToolName: toolName,
            Arguments: { schemaVersion: "2.0.0" },
          },
        },
      });
      expect(wrapped.canonicalName).toBe(`mcp__agent-governance-suite__${toolName}`);
      expect(wrapped.isMcpWrapperCall).toBe(true);

      const direct = normalizeAntigravityToolCall({
        toolCall: {
          name: `default_api:${combinedName}`,
          args: { schemaVersion: "2.0.0" },
        },
      });
      expect(direct.canonicalName).toBe(`mcp__agent-governance-suite__${toolName}`);
      expect(direct.isMcpWrapperCall).toBe(false);
    }
    // Red-to-green proof: with the legacy 22-char server key, 27 of the 31 tools exceeded 64 chars.
    expect(legacyOverflowTools.length).toBe(27);

    // Backward compatibility for legacy long server names.
    const legacyWrapped = normalizeAntigravityToolCall({
      toolCall: {
        name: "default_api:call_mcp_tool",
        args: {
          ServerName: "agent-governance-suite_agent-governance-suite",
          ToolName: "get_skill_inventory",
          Arguments: { schemaVersion: "2.0.0" },
        },
      },
    });
    expect(legacyWrapped.canonicalName).toBe("mcp__agent-governance-suite__get_skill_inventory");
    expect(legacyWrapped.isMcpWrapperCall).toBe(true);

    const legacyDirect = normalizeAntigravityToolCall({
      toolCall: {
        name: "default_api:mcp_agent-governance-suite_agent-governance-suite_get_skill_inventory",
        args: { schemaVersion: "2.0.0" },
      },
    });
    expect(legacyDirect.canonicalName).toBe("mcp__agent-governance-suite__get_skill_inventory");
  });
});
