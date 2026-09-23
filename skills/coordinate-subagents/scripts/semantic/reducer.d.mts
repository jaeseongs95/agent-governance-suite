import type {
  ModelRoutingDecisionV2, ModelRoutingDecisionV3, SemanticDecisionAdviceV1, SemanticDecisionRequestV1,
} from '../../../../contracts/types.js';
import type { EligibleCandidateV2 } from '../model-routing-core.mjs';
import type { SemanticAdoptionAssessmentV1 } from './adoption-guard.mjs';

/** Internal pure reduction after fresh input validation and service evidence admission. */
export declare function reduceSemanticDecisionV1(input: {
  prepared: SemanticDecisionRequestV1;
  advice: SemanticDecisionAdviceV1;
  adoption: Extract<SemanticAdoptionAssessmentV1, { status: 'eligible' }>;
  baselineDecision: ModelRoutingDecisionV2;
  candidates: readonly EligibleCandidateV2[];
}): ModelRoutingDecisionV3;
