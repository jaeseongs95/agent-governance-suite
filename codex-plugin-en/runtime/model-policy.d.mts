export const MODEL_CLASS: readonly ["lightweight", "general", "deep", "frontier"];
export const REASONING_EFFORT: readonly ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
export const HIGH_RISK_MINIMUM: Readonly<{ modelClass: "general"; reasoningEffort: "high" }>;
export const modelPolicySchema: Record<string, unknown>;
