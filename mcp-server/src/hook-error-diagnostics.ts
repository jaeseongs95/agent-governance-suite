import { writeSync } from "node:fs";

/** Compatibility exports for hook consumers; the private diagnostic state is package-owned. */
export {
  producerFailure as hookFailure, tagProducerFailure as tagHookFailure,
  producerFailureReason as hookFailureReason, failureContext as hookFailureContext,
  retainFailureCause as retainHookFailureCause, retainFailureSecondary as retainHookFailureSecondary,
} from "./failure-diagnostics.js";

const defaultSyncStderr = (serialized: string): void => { writeSync(2, serialized); };

/** Keep each producer's serialization and observer; sink failure cannot change hook authority. */
export function writeFailureDiagnostic(
  serialized: string,
  writer: (serialized: string) => void = defaultSyncStderr,
): void {
  try { writer(serialized); }
  catch { /* Diagnostics never authorize a call or prevent fail-closed argument stripping. */ }
}
