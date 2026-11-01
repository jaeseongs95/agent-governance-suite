import { WorkflowContractError } from "../../contracts/types.js";
import { failureContext, failureReason, retainFailureCause } from "../../runtime/failure-diagnostics.mjs";

export { tagProducerFailure, retainFailureCause, retainFailureSecondary, producerFailure, producerFailureReason, failureContext,
  retainCleanupFailure, failureCode, failureReason } from "../../runtime/failure-diagnostics.mjs";

/**
 * The one public-boundary mapping. A contract error keeps its own code and details. Any other failure is a server
 * failure (MCP_UNAVAILABLE), never the caller's invalid input: a fixed message, a fixed-vocabulary reason and a
 * redacted cause. The original error stays a private cause link, never public text.
 */
export function contractFailure(error: unknown): WorkflowContractError {
  if (error instanceof WorkflowContractError) return error;
  const failure = new WorkflowContractError("MCP_UNAVAILABLE", "The server could not complete the request.", {
    reason: failureReason(error).reason ?? "INTERNAL_FAILURE",
    cause: failureContext(error),
  });
  return retainFailureCause(failure, error);
}
