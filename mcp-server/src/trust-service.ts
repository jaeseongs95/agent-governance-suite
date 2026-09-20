import { CONTRACT_VERSION, type ApiResultV1 } from "../../contracts/types.js";
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
}
