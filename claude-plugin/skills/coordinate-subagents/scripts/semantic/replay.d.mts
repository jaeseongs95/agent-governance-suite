import type {
  ModelRoutingDecisionV3, ModelSelectionRequestV2,
  SemanticDecisionAdviceV1, SemanticDecisionRequestV1,
} from '../../../../contracts/types.js';
import type { RoutingEnvironmentV2 } from '../model-routing-core.mjs';
import type { SemanticAdoptionAssessmentV1 } from './adoption-guard.mjs';

export declare const SEMANTIC_REDUCER_VERSION_V1: 'semantic-reducer-v1';
/** Historical reproduction only; the result is not current-state admission or dispatch authority. */
export declare function replaySemanticDecisionV1(input: {
  routingRequest: ModelSelectionRequestV2;
  environment: RoutingEnvironmentV2;
  prepared: SemanticDecisionRequestV1;
  advice: SemanticDecisionAdviceV1;
  adoption: Extract<SemanticAdoptionAssessmentV1, { status: 'eligible' }>;
  decisionTime: string;
  reducerVersion: typeof SEMANTIC_REDUCER_VERSION_V1;
}): ModelRoutingDecisionV3;
