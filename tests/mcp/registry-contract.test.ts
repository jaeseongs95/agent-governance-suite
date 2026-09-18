import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FileSkillRegistry, selectSkillByCapability } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const sourceLockPath = fileURLToPath(new URL("../../skills/source-lock.json", import.meta.url));
const koreanSkillRoot = new URL("../../skills/korean-prose-editor/", import.meta.url);

describe("bundled skill registry", () => {
  it("conforms to SkillDescriptor.v2 and exposes all specialist capabilities", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const skills = registry.read();
    const capabilities = new Set(skills.flatMap((skill) => skill.capabilities));

    expect(capabilities.has("subagent-coordination")).toBe(true);
    expect(capabilities.has("independent-deliberation")).toBe(true);
    expect(capabilities.has("independent-audit")).toBe(true);
    // Versions come from the source lock so that a skill update does not need an edit here.
    const lockedVersions = new Map<string, string>(
      (JSON.parse(readFileSync(sourceLockPath, "utf8")) as { sources: Array<{ skillId: string; version: string }> })
        .sources.map((source) => [source.skillId, source.version]),
    );
    const registeredVersions = new Map(skills.map((skill) => [skill.skillId, skill.version]));
    for (const skillId of [
      "coordinate-subagents",
      "independent-deliberation-panel",
      "independent-audit-gate",
      "instruction-scope-resolver",
      "task-contract",
      "change-scope-guardian",
      "acceptance-evidence-validator",
      "blocker-diagnostician",
      "recovery-strategy-selector",
      "workspace-convention-profiler",
      "mutation-risk-preflight",
      "model-effort-advisor",
      "iteration-frame-auditor",
      "evaluation-validity-auditor",
    ]) {
      expect(lockedVersions.get(skillId), `${skillId} is missing from skills/source-lock.json`).toMatch(/^\d+\.\d+\.\d+$/u);
      expect(registeredVersions.get(skillId), `${skillId} registry version`).toBe(lockedVersions.get(skillId));
    }
    expect(skills.find((skill) => skill.skillId === "independent-deliberation-panel")?.producedArtifacts)
      .toContain("decision-record");
    expect(skills.filter((skill) => skill.skillId === "change-scope-guardian")).toHaveLength(2);
    expect([...capabilities]).toEqual(expect.arrayContaining([
      "instruction-scope-resolution",
      "task-contract-definition",
      "change-scope-baseline-capture",
      "change-scope-assurance",
      "acceptance-evidence-validation",
      "blocker-diagnosis",
      "recovery-strategy-selection",
      "workspace-convention-profiling",
      "mutation-risk-preflight",
      "model-effort-fit-assessment",
      "iteration-frame-audit",
      "evaluation-validity-audit",
    ]));
  });

  it("bundles and enables the Korean prose workflow for runtime selection", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const providers = registry.read();
    const koreanProviders = providers.filter((provider) => provider.skillId === "korean-prose-editor");

    expect(koreanProviders).toHaveLength(4);
    expect(koreanProviders.every((provider) => provider.enabled === true)).toBe(true);
    for (const capability of [
      "korean-prose-selection",
      "korean-prose-editing",
      "korean-prose-verification",
      "korean-prose-finalization",
    ]) {
      expect(selectSkillByCapability(providers, capability)?.skillId).toBe("korean-prose-editor");
    }

    const directDescriptor = JSON.parse(readFileSync(new URL("integration/skill-descriptor.json", koreanSkillRoot), "utf8")) as { enabled?: unknown };
    const openAiConfig = readFileSync(new URL("agents/openai.yaml", koreanSkillRoot), "utf8");
    const skillInstructions = readFileSync(new URL("SKILL.md", koreanSkillRoot), "utf8");
    expect(directDescriptor.enabled).toBe(true);
    expect(openAiConfig).toMatch(/^\s*allow_implicit_invocation:\s*true\s*$/m);
    expect(skillInstructions).not.toContain("TEMPORARILY_DISABLED");
  });
});
