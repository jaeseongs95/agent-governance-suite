import { writeSync } from "node:fs";
import { failureCode } from "./failure-diagnostics.mjs";

// The one product stderr format (AGS3-D-0023): one JSON object per line carrying `component` and `event`.
// Every hook, launcher and server diagnostic goes through this module; no other product file writes to stderr.

/** Serializes one record. Producers own reason codes and already-redacted context. */
export function diagnosticRecord(component, event, details) {
  try { return JSON.stringify({ ...details, component, event }); }
  catch {
    // A serialization failure is secondary: preserve safe producer codes, never arbitrary error text or getters.
    const retained = {};
    for (const key of ["phase", "stage", "reason", "reasonCode"]) {
      try {
        const field = Object.getOwnPropertyDescriptor(details, key);
        if (field && "value" in field && typeof field.value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(field.value)) {
          retained[key] = field.value;
        }
      } catch { /* Opaque diagnostic fields cannot replace the original product result. */ }
    }
    return JSON.stringify({ ...retained, diagnosticReason: "DIAGNOSTIC_SERIALIZATION_FAILED", component, event });
  }
}

/** True only for exactly one record line in the common format (an optional single trailing newline). */
export function isDiagnosticRecord(text) {
  if (typeof text !== "string" || !/^[^\r\n]+\n?$/u.test(text)) return false;
  try {
    const record = JSON.parse(text);
    return record !== null && typeof record === "object" && !Array.isArray(record)
      && typeof record.component === "string" && record.component !== "" && typeof record.event === "string" && record.event !== "";
  } catch { return false; }
}

/** Stream sink (console). */
export const consoleStderr = (line) => { console.error(line); };
/** Synchronous sink for processes that exit right after reporting. */
export const syncStderr = (line) => { writeSync(2, `${line}\n`); };
/** Raw stream sink for callers that inject their own writer and pass newline-terminated text. */
export const streamStderr = (text) => { process.stderr.write(text); };

/** Writes one record; a failing sink never changes the product failure, authority or cleanup. */
export function writeDiagnostic(component, event, details, writer = consoleStderr) {
  const line = diagnosticRecord(component, event, details);
  try { writer(line); }
  catch { /* A diagnostic sink cannot change product failure, authority or cleanup. */ }
}

/** A failed stage with the cause's bounded own code only: never a message, path or input. */
export function writeStageFailure(component, event, stage, cause, observed = {}, writer = syncStderr) {
  const code = failureCode(cause);
  writeDiagnostic(component, event, { stage, ...(code ? { code } : {}), ...observed }, writer);
}

/**
 * Writes already-serialized text only when it is one common-format record; anything else is replaced by a fixed
 * record, so no caller can emit another format through this sink.
 */
export function writeRecordLine(text, writer = (line) => { writeSync(2, line); }) {
  const line = isDiagnosticRecord(text)
    ? (text.endsWith("\n") ? text : `${text}\n`)
    : `${JSON.stringify({ component: "diagnostics", event: "rejected-record", reason: "NOT_COMMON_FORMAT" })}\n`;
  try { writer(line); }
  catch { /* Diagnostics never authorize a call or prevent fail-closed argument stripping. */ }
}
