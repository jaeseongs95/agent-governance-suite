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

function plannedCapabilities(capabilities: string[]): Array<{ capability: string; order: number; skillId: string }> {
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
  return planned.data!.stages.map((stage) => ({ capability: stage.requiredCapability, order: stage.order, skillId: stage.skillId }));
}

describe("ponytail at the implementation step", () => {
  it("routes minimal-implementation to ponytail after the scope baseline and before the pre-mutation gate and scope verification", () => {
    const stages = plannedCapabilities(["change-scope-assurance", "minimal-implementation", "mutation-risk-preflight", "change-scope-baseline-capture"]);
    expect(stages.map((stage) => stage.capability)).toEqual([
      "change-scope-baseline-capture",
      "minimal-implementation",
      "mutation-risk-preflight",
      "change-scope-assurance",
    ]);
    expect(stages.find((stage) => stage.capability === "minimal-implementation")?.skillId).toBe("ponytail");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as { skills: Array<{ skillId: string; providers: Array<{ capabilities: string[]; phase: string; phaseOrder: number }> }> };
    const provider = registry.skills.find((skill) => skill.skillId === "ponytail")!.providers[0]!;
    expect(provider).toMatchObject({ capabilities: ["minimal-implementation"], phase: "implementation", phaseOrder: 44 });
  });

  it("keeps the implementation-stage boundaries in the shared and Claude orchestrator copies", () => {
    for (const copy of ["skills/orchestrator/SKILL.md", "claude-plugin/skills/orchestrator/SKILL.md"]) {
      const text = readFileSync(`${root}${copy}`, "utf8");
      expect(text).toContain("이 단계는 변경 전 기준선 뒤, 위험한 상태 변경의 사전 점검과 범위·수용 근거 확인 전에 실행된다.");
      expect(text).toContain("배포·push·태그처럼 사전 점검 대상인 작업은 사전 점검 뒤에 실행하고");
      expect(text).toContain("범위와 수용 기준은 명시적 요청으로 보고 줄이지 않으며");
      expect(text).toContain("작업 계약이 없으면 사용자 요청이 정한 범위를 같은 기준으로 삼는다.");
    }
  });

  it("limits the skill body to code-writing turns and yields to repository instructions on both hosts", () => {
    for (const copy of ["skills/ponytail/SKILL.md", "claude-plugin/skills/ponytail/SKILL.md"]) {
      const text = readFileSync(`${root}${copy}`, "utf8").replace(/\s+/gu, " ");
      expect(text).toContain("ACTIVE EVERY RESPONSE THAT WRITES OR CHANGES CODE.");
      expect(text).not.toContain("ACTIVE EVERY RESPONSE. ");
      expect(text).toContain("It does not apply to reviews, audits, verification, completion reports, or non-coding answers.");
      expect(text).toContain("override the Output and test rules above.");
      expect(text).toContain("Requested behavior and acceptance criteria are never cut; offer cuts as suggestions.");
      expect(text).not.toMatch(/Caveman/u);
    }
    for (const agent of ["independent-auditor", "deliberation-reviewer"]) {
      expect(readFileSync(`${root}claude-plugin/agents/${agent}.md`, "utf8")).toMatch(/\ndisallowedTools: Write, Edit, NotebookEdit, Agent, Skill\r?\n/u);
    }
  });

  it("adds no ponytail stage when the plan does not ask for minimal-implementation", () => {
    const stages = plannedCapabilities(["change-scope-baseline-capture", "change-scope-assurance"]);
    expect(stages.map((stage) => stage.capability)).not.toContain("minimal-implementation");
  });

  it("integrates only the pinned skill instructions, without the upstream always-on hooks", () => {
    expect(readdirSync(`${root}skills/ponytail`).sort()).toEqual(["LICENSE", "SKILL.md", "VERSION", "agents"]);
    expect(readFileSync(`${root}skills/ponytail/VERSION`, "utf8").trim()).toBe("4.10.0");
    const skill = readFileSync(`${root}skills/ponytail/SKILL.md`, "utf8");
    expect(skill).toMatch(/^---\r?\nname: ponytail\r?\n/u);
    expect(skill).toMatch(/\nlicense: MIT\r?\n/u);
    // The Codex skill validator rejects argument-hint; only the Claude copy carries it.
    expect(skill).not.toMatch(/\nargument-hint:/u);
    expect(skill).toMatch(/Do NOT use for code review, audits, verification, or\s+completion checks\./u);
    expect(skill).not.toMatch(/fixing, reviewing/u);
    expect(readFileSync(`${root}claude-plugin/skills/ponytail/SKILL.md`, "utf8")).toMatch(/\nargument-hint: "\[lite\|full\|ultra\]"\r?\n/u);
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
    expect(readFileSync(`${root}claude-overlay/hooks/skill-trigger-hook.mjs`, "utf8")).not.toMatch(/ponytail/iu);
    expect((lock.sources.find((source) => source.skillId === "ponytail")!.downstreamModifications as string[]).length).toBe(5);
  });
});
