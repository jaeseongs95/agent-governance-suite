/** Compatibility exports for hook consumers; the private diagnostic state is package-owned. */
export {
  producerFailure as hookFailure, tagProducerFailure as tagHookFailure,
  producerFailureReason as hookFailureReason, failureContext as hookFailureContext,
  retainFailureCause as retainHookFailureCause, retainFailureSecondary as retainHookFailureSecondary,
} from "./failure-diagnostics.js";
