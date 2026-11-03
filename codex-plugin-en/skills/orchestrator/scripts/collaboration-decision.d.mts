import type { CollaborationDecisionV1 } from "../../../contracts/types.js";

export function deriveCollaborationRoute(decision: CollaborationDecisionV1): CollaborationDecisionV1["route"];
export function validateCollaborationDecision(decision: unknown): string[];
export function collaborationDecisionStructuralDiagnostic(decision: unknown): {
  scope: "structural-only";
  valid: boolean;
  errors: string[];
  diagnostic: string;
};
