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
});
