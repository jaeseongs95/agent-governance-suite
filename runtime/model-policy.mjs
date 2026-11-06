import { readFileSync } from "node:fs";

// One data definition serves standalone skill CLIs, public schemas and workflow execution.
export const modelPolicySchema = JSON.parse(readFileSync(new URL("../contracts/model-policy.v1.schema.json", import.meta.url), "utf8"));
export const MODEL_CLASS = Object.freeze(modelPolicySchema.$defs.modelClass.enum);
export const REASONING_EFFORT = Object.freeze(modelPolicySchema.$defs.reasoningEffort.enum);
export const HIGH_RISK_MINIMUM = Object.freeze({
  modelClass: modelPolicySchema.$defs.highRiskModelClass.const,
  reasoningEffort: modelPolicySchema.$defs.highRiskReasoningEffort.const,
});
