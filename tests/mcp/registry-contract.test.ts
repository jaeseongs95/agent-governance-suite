import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

describe("bundled skill registry", () => {
  it("conforms to SkillDescriptor.v2 and exposes all specialist capabilities", () => {
    const registry = new FileSkillRegistry(registryPath, new ContractValidator());
    const skills = registry.read();
    const capabilities = new Set(skills.flatMap((skill) => skill.capabilities));

    expect(capabilities.has("subagent-coordination")).toBe(true);
    expect(capabilities.has("independent-deliberation")).toBe(true);
    expect(capabilities.has("independent-audit")).toBe(true);
    expect(Object.fromEntries(skills.map((skill) => [skill.skillId, skill.version]))).toMatchObject({
      "coordinate-subagents": "0.1.2",
      "independent-deliberation-panel": "1.0.0",
      "independent-audit-gate": "0.1.1",
      "instruction-scope-resolver": "0.1.0",
      "task-contract": "0.1.0",
      "change-scope-guardian": "0.1.1",
      "acceptance-evidence-validator": "0.1.0",
      "blocker-diagnostician": "0.1.0",
      "workspace-convention-profiler": "0.1.1",
      "mutation-risk-preflight": "0.1.1",
    });
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
      "workspace-convention-profiling",
      "mutation-risk-preflight",
    ]));
  });
});
