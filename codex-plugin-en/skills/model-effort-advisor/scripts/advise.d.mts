import type { ModelSelectionResultV1 } from "../../coordinate-subagents/scripts/model-routing.mjs";

export interface SubagentModelAdviceV1 {
  schemaVersion: "1.0.0";
  status: "READY" | "INHERIT_UNVERIFIED" | "BLOCKED";
  authorityEffect: "none";
  assignment: {
    role: "discovery" | "general-implementation" | "complex-reasoning" | "independent-audit";
    difficulty: "routine" | "substantial" | "complex" | "frontier";
    riskLevel: "low" | "medium" | "high" | "critical";
    verification: "direct" | "indirect" | "limited";
    signals: string[];
  };
  profile: "economy" | "balanced" | "quality";
  capabilitySource: { hostId: string; reference: string };
  routingOptions: Record<string, unknown>;
  selectionPlan: ModelSelectionResultV1;
}

export function adviseSubagentModel(input: unknown, customPresets?: unknown): SubagentModelAdviceV1;
