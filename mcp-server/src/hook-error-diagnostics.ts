import { writeRecordLine } from "../../runtime/diagnostic-record.mjs";

/** Compatibility exports for hook consumers; the private diagnostic state is package-owned. */
export {
  producerFailure as hookFailure, tagProducerFailure as tagHookFailure,
  producerFailureReason as hookFailureReason, failureContext as hookFailureContext,
  retainFailureCause as retainHookFailureCause, retainFailureSecondary as retainHookFailureSecondary,
} from "./failure-diagnostics.js";

/** Product stderr is one JSON record per line, written only through the shared runtime module (AGS3-D-0023). */
export { writeDiagnostic, syncStderr } from "../../runtime/diagnostic-record.mjs";

/** Synchronous sink for an already-serialized record; text in any other format is replaced, never passed through. */
export function writeFailureDiagnostic(serialized: string, writer?: (serialized: string) => void): void {
  writeRecordLine(serialized, writer);
}
