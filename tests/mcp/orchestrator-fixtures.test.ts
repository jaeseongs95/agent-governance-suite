import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { TaskEnvelopeV1 } from "../../contracts/types.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

interface BehaviorCase {
  id: string;
  input: TaskEnvelopeV1;
  expected: {
    executionMode: "direct" | "orchestrated";
    workflowState: string;
    skillsInOrder?: string[];
    requiredCapabilitiesInOrder?: string[];
    errorCode?: string;
  };
}

const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
const fixturePath = fileURLToPath(new URL("../orchestrator/behavior-cases.json", import.meta.url));
const orchestratorInstructions = ["SKILL.md", "references/entry-details.md"]
  .map((file) => readFileSync(new URL(`../../skills/orchestrator/${file}`, import.meta.url), "utf8"))
  .join("\n");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { cases: BehaviorCase[] };

describe("orchestrator behavior fixtures", () => {
  const validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator);

  for (const behaviorCase of fixture.cases) {
    it(behaviorCase.id, () => {
      const result = service.planWorkflow(behaviorCase.input);
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        executionMode: behaviorCase.expected.executionMode,
        state: behaviorCase.expected.workflowState
      });
      if (behaviorCase.expected.skillsInOrder) {
        expect(result.data?.stages.map((stage) => stage.skillId)).toEqual(behaviorCase.expected.skillsInOrder);
      }
      if (behaviorCase.expected.requiredCapabilitiesInOrder) {
        expect(result.data?.stages.map((stage) => stage.requiredCapability))
          .toEqual(behaviorCase.expected.requiredCapabilitiesInOrder);
      }
      if (behaviorCase.expected.errorCode) {
        expect(result.data?.errors[0]?.code).toBe(behaviorCase.expected.errorCode);
      }
    });
  }

  it("keeps trusted execution attestation on the server-side MCP boundary", () => {
    expect(orchestratorInstructions).toContain("서버 측 `TrustedExecutionContextProvider`");
    expect(orchestratorInstructions).toContain("caller는 `plan_workflow` 인자에 `executionContext`를 넣지 않는다");
    expect(orchestratorInstructions).toContain("caller는 `StageResult.v1`이나 `record_stage_result` 인자에 `executionContext`를 넣지 않는다");
    expect(orchestratorInstructions).not.toContain("wrapper의 `executionContext`에 전달한다");
    expect(orchestratorInstructions).not.toContain("`StageResult.v1.executionContext`로 제출한다");
  });
});
