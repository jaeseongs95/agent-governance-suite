import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));

function plannedCapabilities(capabilities: string[]): Array<{ capability: string; order: number }> {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, new InMemoryWorkflowStore());
  const task: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0",
    taskId: "ponytail-routing",
    objective: "Change code with the smallest correct implementation.",
    scope: { included: ["src/**"], excluded: [] },
    acceptanceCriteria: ["The change works."],
    riskLevel: "low",
    workUnits: [{ id: "unit-1", objective: "Implement.", dependencies: [], writeTargets: ["src/index.ts"] }],
    requiredCapabilities: capabilities,
    constraints: [],
    authorization: { allowedActions: ["edit"], prohibitedActions: [], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false },
    orchestration: { requested: false, mcpAvailable: true },
  };
  const planned = service.planWorkflow(task);
  expect(planned.error).toBeNull();
  return planned.data!.stages.map((stage) => ({ capability: stage.requiredCapability, order: stage.order }));
}

describe("ponytail at the implementation step", () => {
  it("routes minimal-implementation to ponytail after the pre-mutation gate and before scope verification", () => {
    const stages = plannedCapabilities(["change-scope-assurance", "minimal-implementation", "mutation-risk-preflight", "change-scope-baseline-capture"]);
    expect(stages.map((stage) => stage.capability)).toEqual([
      "change-scope-baseline-capture",
      "mutation-risk-preflight",
      "minimal-implementation",
      "change-scope-assurance",
    ]);
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { skills: Array<{ skillId: string; providers: Array<{ capabilities: string[]; phase: string; phaseOrder: number }> }> };
    const provider = registry.skills.find((skill) => skill.skillId === "ponytail")!.providers[0]!;
    expect(provider).toMatchObject({ capabilities: ["minimal-implementation"], phase: "implementation", phaseOrder: 50 });
  });

  it("adds no ponytail stage when the plan does not ask for minimal-implementation", () => {
    const stages = plannedCapabilities(["change-scope-baseline-capture", "change-scope-assurance"]);
    expect(stages.map((stage) => stage.capability)).not.toContain("minimal-implementation");
  });

  it("integrates only the pinned skill instructions, without the upstream always-on hooks", () => {
    expect(readdirSync(`${root}skills/ponytail`).sort()).toEqual(["SKILL.md", "VERSION"]);
    expect(readFileSync(`${root}skills/ponytail/VERSION`, "utf8").trim()).toBe("4.10.0");
    const skill = readFileSync(`${root}skills/ponytail/SKILL.md`, "utf8");
    expect(skill).toMatch(/^---\r?\nname: ponytail\r?\n/u);
    expect(skill).toMatch(/\nlicense: MIT\r?\n/u);
    const lock = JSON.parse(readFileSync(`${root}skills/source-lock.json`, "utf8")) as { sources: Array<Record<string, unknown>> };
    expect(lock.sources.find((source) => source.skillId === "ponytail")).toMatchObject({
      source: "https://github.com/jaeseongs95/ponytail.git",
      sourcePath: "skills/ponytail",
      version: "4.10.0",
      ref: { kind: "commit", commit: "83b2cbc3bc50df3030c49d1dfe598ccefe850a85" },
      updatePolicy: "notify-only",
    });
    const hooks = readFileSync(`${root}hooks/hooks.json`, "utf8") + readFileSync(`${root}claude-overlay/hooks/hooks.json`, "utf8");
    expect(hooks).not.toMatch(/ponytail/iu);
  });
});
