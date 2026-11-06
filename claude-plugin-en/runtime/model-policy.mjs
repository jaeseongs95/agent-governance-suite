import policy from "../contracts/model-policy.v1.schema.json" with { type: "json" };

// One data definition serves standalone skill CLIs, public schemas and workflow execution.
export const modelPolicySchema = policy;
export const MODEL_CLASS = Object.freeze(modelPolicySchema.$defs.modelClass.enum);
export const REASONING_EFFORT = Object.freeze(modelPolicySchema.$defs.reasoningEffort.enum);
export const HIGH_RISK_MINIMUM = Object.freeze({
  modelClass: modelPolicySchema.$defs.highRiskModelClass.const,
  reasoningEffort: modelPolicySchema.$defs.highRiskReasoningEffort.const,
});
