import { writeSync } from "node:fs";

/** Compatibility exports for hook consumers; the private diagnostic state is package-owned. */
export {
  producerFailure as hookFailure, tagProducerFailure as tagHookFailure,
  producerFailureReason as hookFailureReason, failureContext as hookFailureContext,
  retainFailureCause as retainHookFailureCause, retainFailureSecondary as retainHookFailureSecondary,
} from "./failure-diagnostics.js";

const defaultSyncStderr = (serialized: string): void => { writeSync(2, serialized); };

/** Product stderr is one JSON record per line. Producers own reason codes and already-redacted context. */
export function writeDiagnostic(
  component: string,
  event: string,
  details: Readonly<Record<string, unknown>>,
  writer: (line: string) => void = line => console.error(line),
): void {
  let serialized: string;
  try { serialized = JSON.stringify({ ...details, component, event }); }
  catch {
    // A serialization failure is secondary: preserve safe producer codes, never arbitrary error text or getters.
    const retained: Record<string, string> = {};
    for (const key of ["phase", "stage", "reason", "reasonCode"]) {
      try {
        const field = Object.getOwnPropertyDescriptor(details, key);
        if (field && "value" in field && typeof field.value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(field.value)) {
          retained[key] = field.value;
        }
      } catch { /* Opaque diagnostic fields cannot replace the original product result. */ }
    }
    serialized = JSON.stringify({ ...retained, diagnosticReason: "DIAGNOSTIC_SERIALIZATION_FAILED", component, event });
  }
  try { writer(serialized); }
  catch { /* A diagnostic sink cannot change product failure, authority or cleanup. */ }
}

/** Keep each producer's serialization and observer; sink failure cannot change hook authority. */
export function writeFailureDiagnostic(
  serialized: string,
  writer: (serialized: string) => void = defaultSyncStderr,
): void {
  try { writer(serialized); }
  catch { /* Diagnostics never authorize a call or prevent fail-closed argument stripping. */ }
}
