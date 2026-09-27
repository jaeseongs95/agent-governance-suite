/** Opt-in fixture observations; never print payloads, paths, credentials or raw errors. */
export function failureDiagnosticsEnabled(): boolean {
  return process.env.AGS_TEST_FAILURE_DIAGNOSTICS === "1";
}

export function failureDiagnostic(area: string, event: string, fields: Record<string, unknown>): void {
  if (failureDiagnosticsEnabled()) {
    console.info("AGS test diagnostics", JSON.stringify({ area, event, at: new Date().toISOString(), ...fields }));
  }
}

export function diagnosticError(error: unknown): Record<string, string> {
  const message = error instanceof Error ? error.message : "";
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const knownCodes = ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOENT", "EPIPE", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED"];
  return {
    errorType: error instanceof Error ? (error instanceof TypeError ? "TypeError" : "Error") : "non-error",
    errorCode: typeof code === "string" && knownCodes.includes(code) ? code : "other-or-absent",
    errorKind: /timed out|deadline/iu.test(message) ? "deadline"
      : /certificate|TLS/iu.test(message) ? "tls"
      : /JSON|response|page|cursor/iu.test(message) ? "response"
      : /presence|expired/iu.test(message) ? "presence-or-expiry" : "other",
  };
}
