import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";

import {
  type ApiResultV1,
  type SkillDescriptorV1,
  type StageResultV1,
  type TaskEnvelopeV1,
  type WorkflowPlanV1,
  type WorkflowReceiptV1,
  WorkflowContractError,
} from "../../contracts/types.js";

type JsonSchema = Record<string, unknown>;

function loadSchema(fileName: string): JsonSchema {
  const path = new URL(`../../contracts/${fileName}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

function loadSkillSchema(relativePath: string): JsonSchema {
  const path = new URL(`../../skills/${relativePath}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as JsonSchema;
}

/** The wire schemas are loaded from contracts/ so MCP and direct callers share one definition. */
export const contractSchemas = {
  apiResult: loadSchema("api-result.v1.schema.json"),
  taskEnvelope: loadSchema("task-envelope.v1.schema.json"),
  skillDescriptor: loadSchema("skill-descriptor.v1.schema.json"),
  workflowPlan: loadSchema("workflow-plan.v1.schema.json"),
  stageResult: loadSchema("stage-result.v1.schema.json"),
  workflowReceipt: loadSchema("workflow-receipt.v1.schema.json"),
  decisionRecord: loadSkillSchema("independent-deliberation-panel/contracts/decision-record.v1.schema.json"),
};

function errorText(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ");
}

export class ContractValidator {
  private readonly validators: Record<string, ValidateFunction>;

  constructor() {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    for (const schema of Object.values(contractSchemas)) {
      ajv.addSchema(schema);
    }
    this.validators = {
      apiResult: ajv.getSchema("https://skill-suite.local/contracts/api-result.v1.schema.json")!,
      taskEnvelope: ajv.getSchema("https://skill-suite.local/contracts/task-envelope.v1.schema.json")!,
      skillDescriptor: ajv.getSchema("https://skill-suite.local/contracts/skill-descriptor.v1.schema.json")!,
      workflowPlan: ajv.getSchema("https://skill-suite.local/contracts/workflow-plan.v1.schema.json")!,
      stageResult: ajv.getSchema("https://skill-suite.local/contracts/stage-result.v1.schema.json")!,
      workflowReceipt: ajv.getSchema("https://skill-suite.local/contracts/workflow-receipt.v1.schema.json")!,
      decisionRecord: ajv.compile(contractSchemas.decisionRecord),
    };
  }

  private assert<T>(name: keyof ContractValidator["validators"], value: unknown): T {
    const validate = this.validators[name];
    if (!validate) {
      throw new WorkflowContractError("INVALID_INPUT", `Validator '${name}' is not registered.`);
    }
    if (!validate(value)) {
      throw new WorkflowContractError("INVALID_INPUT", `${name} does not match its v1 contract.`, {
        validationErrors: errorText(validate.errors),
      });
    }
    return value as T;
  }

  taskEnvelope(value: unknown): TaskEnvelopeV1 {
    return this.assert<TaskEnvelopeV1>("taskEnvelope", value);
  }

  skillDescriptor(value: unknown): SkillDescriptorV1 {
    return this.assert<SkillDescriptorV1>("skillDescriptor", value);
  }

  stageResult(value: unknown): StageResultV1 {
    return this.assert<StageResultV1>("stageResult", value);
  }

  workflowPlan(value: unknown): WorkflowPlanV1 {
    return this.assert<WorkflowPlanV1>("workflowPlan", value);
  }

  workflowReceipt(value: unknown): WorkflowReceiptV1 {
    return this.assert<WorkflowReceiptV1>("workflowReceipt", value);
  }

  decisionRecord(value: unknown): Record<string, unknown> {
    return this.assert<Record<string, unknown>>("decisionRecord", value);
  }

  apiResult<T>(value: unknown): ApiResultV1<T> {
    return this.assert<ApiResultV1<T>>("apiResult", value);
  }
}
