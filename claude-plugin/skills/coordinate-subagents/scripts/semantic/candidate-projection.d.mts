import type { SemanticEligibleCandidateV1, SemanticModelOptionV1 } from '../../../../contracts/types.js';
import type { BaselineCandidateMetadataV2, EligibleCandidateV2 } from '../model-routing-core.mjs';

/** Pure projection only; null leaves an empty pool to the existing v2 blocked path. */
export declare function projectSemanticCandidatesV1(
  candidates: readonly EligibleCandidateV2[],
  metadata: readonly BaselineCandidateMetadataV2[],
): { eligibleSet: SemanticEligibleCandidateV1[]; options: SemanticModelOptionV1[] } | null;
