import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Diagnostic entry-file observation, not attestation of all loaded dependencies. */
export function readRelayCodeDigest(entry: URL): string | null {
  try { return "sha256:" + createHash("sha256").update(readFileSync(entry)).digest("hex"); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

export function relayCodeDigest(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error("Invalid relay code digest.");
  return value;
}
