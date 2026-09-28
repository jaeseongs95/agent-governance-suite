import type { ApiResultV1, CheckpointContextRequestV1, ContinuitySnapshotV1 } from "../../../contracts/types.js";
import type { ContinuityGateway } from "../continuity-service.js";

/** Store an already-bound direct checkpoint; this does not admit or complete a transition. */
export function checkpointTransitionContext(
  gateway: Pick<ContinuityGateway, "checkpointContext">,
  request: CheckpointContextRequestV1,
): ApiResultV1<ContinuitySnapshotV1> {
  return gateway.checkpointContext(request);
}
