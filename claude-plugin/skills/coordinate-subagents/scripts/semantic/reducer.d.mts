import type {
  ModelRoutingDecisionV2, ModelRoutingDecisionV3, ModelSelectionRequestV2,
  SemanticDecisionAdviceV1, SemanticDecisionPolicyV1, SemanticDecisionRequestV1,
} from '../../../../contracts/types.js';
import type { EligibleCandidateV2 } from '../model-routing-core.mjs';
import type { SemanticAdoptionAssessmentV1 } from './adoption-guard.mjs';

export type SemanticNonAdoptionReasonCodeV1 =
  | 'ABSTAINED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE'
  | 'HIGH_RISK_EXCLUDED' | 'INDEPENDENT_AUDIT_EXCLUDED' | 'SCOPE_NOT_PRESERVED'
  | 'ADOPTION_UNVALIDATED' | 'PROVIDER_NOT_ALLOWED' | 'CONFIDENCE_UNKNOWN'
  | 'CONFIDENCE_BELOW_MINIMUM';
export type SemanticNonAdoptionV1 = {
  status: 'non-adoption';
  reasonCode: SemanticNonAdoptionReasonCodeV1;
  baselineDecision: ModelRoutingDecisionV2;
};

/** Off/shadow and v2 fallback remain byte-identical; only adopted assist produces v3. */
export declare function reduceSemanticDecisionOutcomeV1(input: {
  policy: SemanticDecisionPolicyV1;
  routingRequest: ModelSelectionRequestV2;
  baselineDecision: ModelRoutingDecisionV2;
  prepared?: SemanticDecisionRequestV1 | null;
  advice?: SemanticDecisionAdviceV1 | null;
  adoption?: SemanticAdoptionAssessmentV1 | null;
  candidates?: readonly EligibleCandidateV2[];
  nonAdoption?: 'ABSTAINED' | 'PROVIDER_TIMEOUT' | 'PROVIDER_UNAVAILABLE' | null;
}): ModelRoutingDecisionV2 | ModelRoutingDecisionV3 | SemanticNonAdoptionV1;

/** Internal pure reduction after fresh input validation and service evidence admission. */
export declare function reduceSemanticDecisionV1(input: {
  prepared: SemanticDecisionRequestV1;
  advice: SemanticDecisionAdviceV1;
  adoption: Extract<SemanticAdoptionAssessmentV1, { status: 'eligible' }>;
  baselineDecision: ModelRoutingDecisionV2;
  candidates: readonly EligibleCandidateV2[];
}): ModelRoutingDecisionV3;
