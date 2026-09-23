import type { SemanticChoiceV1, SemanticDecisionRequestV1 } from "../../../contracts/types.js";

/** Provider output is advice input only; AGS owns admission and execution decisions. */
export type SemanticProviderResultV1 =
  | { status: "success"; choice: SemanticChoiceV1 }
  | { status: "abstained" | "timeout" | "unavailable" | "invalid" | "uncertain" };

export interface SemanticDecisionProviderPort {
  evaluate(request: Readonly<SemanticDecisionRequestV1>): Promise<SemanticProviderResultV1>;
}

/** Rejects unknown statuses and extra provider fields before a result enters AGS domain logic. */
export function parseSemanticProviderResultV1(value: unknown): SemanticProviderResultV1 {
  if (!record(value) || typeof value.status !== "string") throw new TypeError("Invalid semantic provider result.");
  if (value.status === "success") {
    const choice = value.choice;
    if (!keys(value, "status", "choice") || !record(choice) || !keys(choice, "kind", "selectedOptionIds", "confidence")
      || choice.kind !== "Choice" || !Array.isArray(choice.selectedOptionIds)
      || choice.selectedOptionIds.length < 1 || choice.selectedOptionIds.length > 256
      || !choice.selectedOptionIds.every((id) => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u.test(id))
      || new Set(choice.selectedOptionIds).size !== choice.selectedOptionIds.length
      || (choice.confidence !== null && (typeof choice.confidence !== "number"
        || !Number.isFinite(choice.confidence) || choice.confidence < 0 || choice.confidence > 1))) {
      throw new TypeError("Invalid semantic provider choice.");
    }
    return { status: "success", choice: choice as unknown as SemanticChoiceV1 };
  }
  if (keys(value, "status") && (value.status === "abstained" || value.status === "timeout"
    || value.status === "unavailable" || value.status === "invalid" || value.status === "uncertain")) {
    return { status: value.status };
  }
  throw new TypeError("Invalid semantic provider result.");
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, ...expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
