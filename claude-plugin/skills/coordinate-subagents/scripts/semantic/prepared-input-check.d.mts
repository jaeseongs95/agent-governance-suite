import type { ModelSelectionRequestV2, SemanticDecisionRequestV1 } from '../../../../contracts/types.js';
import type { RoutingEnvironmentV2 } from '../model-routing-core.mjs';

/** Pure match assertion; true grants no admission or execution authority. */
export declare function assertPreparedSemanticInputV1(
  prepared: SemanticDecisionRequestV1,
  routingRequest: ModelSelectionRequestV2,
  environment: RoutingEnvironmentV2,
  evaluationTime: string,
): true;
