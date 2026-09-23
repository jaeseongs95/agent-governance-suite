import { type ModelRoutingDecisionV2, type ModelRoutingDecisionV3, WorkflowContractError } from "../../../contracts/types.js";
import type { ModelRoutingStore } from "../../../skills/coordinate-subagents/scripts/model-routing-store.mjs";
import { ContractValidator } from "../schema-validator.js";

type StoredEntry = NonNullable<ReturnType<ModelRoutingStore["decision"]>>;
export type ValidatedDecisionEntry = Omit<StoredEntry, "decision"> &
  ({ decision: ModelRoutingDecisionV2 } | { decision: ModelRoutingDecisionV3 });

/** Read persisted decisions without projecting v3 semantic evidence into a v2 shape. */
export function readDecision(
  store: ModelRoutingStore,
  digest: string,
  validator: ContractValidator,
): ValidatedDecisionEntry | null {
  const entry = store.decision(digest);
  if (!entry) return null;
  switch (entry.decision.schemaVersion) {
    case "2.0.0": return { ...entry, decision: validator.modelRoutingDecisionV2(entry.decision) };
    case "3.0.0": return { ...entry, decision: validator.modelRoutingDecisionV3(entry.decision) };
  }
  throw new WorkflowContractError("INVALID_INPUT", "Unsupported model routing decision version.");
}
