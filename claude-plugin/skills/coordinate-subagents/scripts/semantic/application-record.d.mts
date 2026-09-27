import type {
  ModelApplicationRecordV3, ModelApplicationRequestV3,
  ModelRoutingDecisionV3, ModelSelectionRequestV2,
} from '../../../../contracts/types.js';
import type { RoutingEnvironmentV2 } from '../model-routing-core.mjs';

/** Pure diagnostic record; the caller must supply an already admitted host observation. */
export declare function recordSemanticApplicationV3(
  input: ModelApplicationRequestV3,
  context: {
    request: ModelSelectionRequestV2;
    decision: ModelRoutingDecisionV3;
    catalog: RoutingEnvironmentV2['catalog'];
    policy: RoutingEnvironmentV2['policy'];
    now: string;
    admittedObservation?: ModelApplicationRequestV3['observation'] | null;
  },
): ModelApplicationRecordV3;
