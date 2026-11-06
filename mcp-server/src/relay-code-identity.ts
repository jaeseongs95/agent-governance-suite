import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { failureContext } from "./failure-diagnostics.js";
import { writeDiagnostic, writeFailureDiagnostic } from "./hook-error-diagnostics.js";
import { msg } from "./i18n.js";
import { SessionMessageError } from "./session-message-protocol.js";

/** Diagnostic entry-file observation, not attestation of all loaded dependencies. */
export function readRelayCodeDigest(entry: URL): string | null {
  try { return "sha256:" + createHash("sha256").update(readFileSync(entry)).digest("hex"); }
  catch (error) {
    try {
      writeDiagnostic("relay-code-identity", "relay-code-read-failure", {
        reason: "RELAY_CODE_READ_FAILED", context: failureContext(error),
      }, line => writeFailureDiagnostic(line + "\n"));
    } catch { /* Code freshness is advisory; even diagnostic failure cannot stop relay or board work. */ }
    return null;
  }
}

export function relayCodeDigest(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new SessionMessageError(msg("services.sessionMessage.relay.codeDigestInvalid", {}));
  return value;
}
