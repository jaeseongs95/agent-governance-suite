import { existsSync, readFileSync } from "node:fs";

// The shared contract is authoritative. A standalone copied skill carries an identical policy snapshot.
const canonical = new URL("../../../contracts/model-policy.v1.schema.json", import.meta.url);
export const modelPolicySchema = JSON.parse(readFileSync(existsSync(canonical) ? canonical
  : new URL("../references/model-routing-policy.schema.json", import.meta.url), "utf8"));
export const MODEL_CLASS = Object.freeze(modelPolicySchema.$defs.modelClass.enum);
export const REASONING_EFFORT = Object.freeze(modelPolicySchema.$defs.reasoningEffort.enum);
export const HIGH_RISK_MINIMUM = Object.freeze({
  modelClass: modelPolicySchema.$defs.highRiskModelClass.const,
  reasoningEffort: modelPolicySchema.$defs.highRiskReasoningEffort.const,
});
