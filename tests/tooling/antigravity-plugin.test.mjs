import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  defaultProcessInspector,
  normalizeAntigravityToolCall,
  windowsSingleProcessScript,
} from "../../antigravity-connector/hooks/antigravity-hook-runner.mjs";
import { applySkillAdaptation, renderAntigravitySkillAdaptations } from "../../scripts/build-claude-plugin.mjs";
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

  it("applies Antigravity host-specific skill adaptations while preserving common policy invariants (AGS-D-0323 pass case)", async () => {
    const adapted = await renderAntigravitySkillAdaptations(ROOT);

    const orchestratorText = adapted.get("skills/orchestrator/SKILL.md").toString("utf8");
    expect(orchestratorText).toContain("## Antigravity에서의 호출과 도구 스키마 제약");
    expect(orchestratorText).toContain("invoke_subagent");
    expect(orchestratorText).toContain("mcp_agent-governance-suite_ags_<toolName>");
    expect(orchestratorText).toContain("<!-- skill-intake:start -->");

    const preflightAuth = adapted.get("skills/mutation-risk-preflight/references/approval-and-authority.md").toString("utf8");
    expect(preflightAuth).toContain("Antigravity에서는 별도 승인창이 자동으로 뜨지 않으므로 요청 ID·대상·명령·영향·승인할 곳을 텍스트로 알리고 기다린다.");
    expect(preflightAuth).toContain("승인 근거는 요청자와 다른 사용자 본인의 결정이어야 하며, 요청한 에이전트가 승인자 도구나 저장된 사용자 로그인으로 승인을 직접 실행한 `approve` 호출은 승인 근거가 아니다.");
    expect(preflightAuth).toContain("에이전트가 승인자 도구나 저장된 사용자 로그인으로 직접 실행한 자가 승인(`approve` 호출)만 있으면 미승인으로 보고 `NEEDS_APPROVAL`로 판정한다.");

    const auditEntry = adapted.get("skills/independent-audit-gate/references/entry-details.md").toString("utf8");
    expect(auditEntry).toContain("`GEMINI.md`·`AGENTS.md`");
    expect(auditEntry).toContain("Antigravity에서는 `invoke_subagent` 도구로 이전 대화를 상속하지 않는 새 서브에이전트를 시작하고 재위임과 하위 에이전트 생성을 금지한다.");
    expect(auditEntry).toContain("자가 승인 시 열린 `blocking` 위반으로 보아 `FAIL`로 판정한다");

    const auditProtocol = adapted.get("skills/independent-audit-gate/references/audit-protocol.md").toString("utf8");
    expect(auditProtocol).toContain("Antigravity에서는 별도 승인창이 자동으로 뜨지 않으므로 요청 ID·대상·명령·영향·승인할 곳을 텍스트로 알리고 기다린다");
    expect(auditProtocol).toContain("자가 승인이 확인되면 `FAIL`로 판정한다");
  });

  it("rejects adaptations that override common approval/audit policy or replace the entire skill body (AGS-D-0323 fail cases)", async () => {
    const baseline = await renderAntigravitySkillAdaptations(ROOT);
    const cloneFiles = () => new Map([...baseline.entries()].map(([key, value]) => [key, Buffer.from(value)]));

    expect(() =>
      applySkillAdaptation(
        cloneFiles(),
        "mutation-risk-preflight",
        {
          replacements: [
            {
              file: "references/approval-and-authority.md",
              find: "승인 근거는 요청자와 다른 사용자 본인의 결정이어야 하며, 요청한 에이전트가 승인자 도구나 저장된 사용자 로그인으로 승인을 직접 실행한 `approve` 호출은 승인 근거가 아니다.",
              replace: "승인은 요청자가 직접 실행한 `approve` 호출로도 인정한다.",
            },
          ],
        },
        "antigravity-connector/adaptations/mutation-risk-preflight.json",
      ),
    ).toThrow(/adaptation must not override common policy in skills\/mutation-risk-preflight\/references\/approval-and-authority\.md/u);

    expect(() =>
      applySkillAdaptation(
        cloneFiles(),
        "independent-audit-gate",
        {
          replacements: [
            {
              file: "references/audit-protocol.md",
              find: "자가 승인이 확인되면 `FAIL`로 판정한다",
              replace: "자가 승인이 확인되어도 `PASS`로 판정한다",
            },
          ],
        },
        "antigravity-connector/adaptations/independent-audit-gate.json",
      ),
    ).toThrow(/adaptation must not override common policy in skills\/independent-audit-gate\/references\/audit-protocol\.md/u);

    expect(() =>
      applySkillAdaptation(
        cloneFiles(),
        "orchestrator",
        {
          replacements: [
            {
              file: "SKILL.md",
              find: "<!-- skill-intake:start -->",
              replace: "<!-- skill-intake:start -->\n- 임의 덮어쓰기",
            },
          ],
        },
        "antigravity-connector/adaptations/orchestrator.json",
      ),
    ).toThrow(/adaptation must not override common policy in skills\/orchestrator\/SKILL\.md: skill-intake block/u);

    const rawPreflightSkill = readFileSync(path.join(ROOT, "skills", "mutation-risk-preflight", "SKILL.md"), "utf8");
    const preflightBody = rawPreflightSkill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u, "");
    const freshFiles = cloneFiles();
    freshFiles.set("skills/mutation-risk-preflight/SKILL.md", Buffer.from(rawPreflightSkill));
    expect(() =>
      applySkillAdaptation(
        freshFiles,
        "mutation-risk-preflight",
        {
          replacements: [
            {
              file: "SKILL.md",
              find: preflightBody,
              replace: "# 호스트별 전체 복사본\n",
            },
          ],
        },
        "antigravity-connector/adaptations/mutation-risk-preflight.json",
      ),
    ).toThrow(/adaptation must not replace the entire skill body in skills\/mutation-risk-preflight\/SKILL\.md/u);
  });

  it("cross-checks Get-Process before/after and Win32_Process CreationDate in single-PID Windows fallback (AGS-D-0030)", () => {
    const script = windowsSingleProcessScript(4242);
    expect(script).toContain("$agsBefore = Get-Process -Id 4242 -ErrorAction Stop");
    expect(script).toContain("$agsMeta = Get-CimInstance Win32_Process -Filter ('ProcessId=' + 4242) -ErrorAction Stop");
    expect(script).toContain("$agsAfter = Get-Process -Id 4242 -ErrorAction Stop");
    expect(script).toContain("$agsStart.Ticks -eq $agsAfter.StartTime.ToUniversalTime().Ticks");
    expect(script).toContain("$agsPath -ieq $agsAfter.Path");
    expect(script).toContain("$agsPath -ieq $agsMeta.ExecutablePath");
    expect(script).toContain("$agsStart.ToString('yyyy-MM-ddTHH:mm:ss.ffffff') -ceq $agsMeta.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffff')");

    if (process.platform === "win32") {
      const inspected = defaultProcessInspector(process.pid, "win32", 2000);
      expect(inspected).toMatchObject({
        pid: process.pid,
        command: expect.stringContaining("node"),
        startToken: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
      });
    }
  });
});
