import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { failureContext } from "./failure-diagnostics.js";
import { writeFailureDiagnostic } from "./hook-error-diagnostics.js";

/** Diagnostic entry-file observation, not attestation of all loaded dependencies. */
export function readRelayCodeDigest(entry: URL): string | null {
  try { return "sha256:" + createHash("sha256").update(readFileSync(entry)).digest("hex"); }
  catch (error) {
    try {
      writeFailureDiagnostic("[agent-governance-suite] relay-code-read-failure " + JSON.stringify({
        reason: "RELAY_CODE_READ_FAILED", context: failureContext(error),
      }) + "\n");
    } catch { /* Code freshness is advisory; even diagnostic failure cannot stop relay or board work. */ }
    return null;
  }
}

export function relayCodeDigest(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid relay code digest.");
  return value;
}
