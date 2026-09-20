import {
  CONTRACT_VERSION,
  type ApiResultV1,
  type CollaborationDecisionV1,
  type CollaborationDecisionValidationV1,
  type ValidateCollaborationDecisionRequestV1,
} from "../../contracts/types.js";
import { validateCollaborationDecision as validateStructure } from "../../skills/orchestrator/scripts/collaboration-decision.mjs";
import { TrustStore } from "./trust-store.js";

export interface TrustCapabilitiesV1 {
  schemaVersion: typeof CONTRACT_VERSION;
  provenanceRecording: true;
  directUserInputAttestation: false;
  authorityIssuance: false;
  scopedDelegation: false;
  acceptedOrigins: Array<"peer" | "system" | "developer" | "project" | "artifact">;
  acceptedAuthorityEffects: Array<"none" | "restrict-only">;
}

export class TrustService {
  constructor(readonly store: TrustStore) {}

  capabilities(): ApiResultV1<TrustCapabilitiesV1> {
    return {
      schemaVersion: CONTRACT_VERSION,
      ok: true,
      data: {
        schemaVersion: CONTRACT_VERSION,
        provenanceRecording: true,
        directUserInputAttestation: false,
        authorityIssuance: false,
        scopedDelegation: false,
        acceptedOrigins: ["peer", "system", "developer", "project", "artifact"],
        acceptedAuthorityEffects: ["none", "restrict-only"],
      },
      error: null,
    };
  }

  validateCollaborationDecision(
    input: ValidateCollaborationDecisionRequestV1,
    now: Date = new Date(),
  ): ApiResultV1<CollaborationDecisionValidationV1> {
    const structuralErrors = validateStructure(input.decision) as string[];
    const binding = input._sessionBinding ? structuredClone(input._sessionBinding) : null;
    const base = {
      structuralValidity: structuralErrors.length === 0 ? "valid" as const : "invalid" as const,
      structuralErrors,
      receiptFound: false,
      receiptIntegrity: null,
      receiptBoundToCaller: null,
      receiptFreshness: null,
      sourceClaimMatch: binding?.actorKind === "subagent" && input.decision.sourceOriginKind === "user-turn" ? false : null,
      callerObservation: binding,
      callerBindingAssurance: binding ? "observational" as const : null,
      authorityCapabilities: {
        directUserInputAttestation: false as const,
        authorityIssuance: false as const,
        scopedDelegation: false as const,
      },
    };
    if (structuralErrors.length > 0) return { schemaVersion: CONTRACT_VERSION, ok: true, data: base, error: null };

    const decision = input.decision as CollaborationDecisionV1;
    if (decision.sourceReceiptId === null) return { schemaVersion: CONTRACT_VERSION, ok: true, data: base, error: null };
    const receipt = this.store.getInputSource(decision.sourceReceiptId);
    if (!receipt) return { schemaVersion: CONTRACT_VERSION, ok: true, data: base, error: null };
    const integrityValid = this.store.verify(receipt);
    return {
      schemaVersion: CONTRACT_VERSION,
      ok: true,
      data: {
        ...base,
        receiptFound: true,
        receiptIntegrity: integrityValid ? "valid" : "invalid",
        receiptBoundToCaller: integrityValid && binding
          ? receipt.host === binding.host && receipt.sessionId === binding.sessionId
          : null,
        receiptFreshness: integrityValid
          ? Date.parse(receipt.expiresAt) > now.getTime() ? "fresh" : "stale"
          : null,
        sourceClaimMatch: integrityValid ? receipt.originKind === decision.sourceOriginKind : null,
      },
      error: null,
    };
  }
}
