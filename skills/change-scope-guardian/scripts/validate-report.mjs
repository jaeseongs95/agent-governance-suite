#!/usr/bin/env node
import { readJsonInput, validateBaseline, validateReport, writeJson } from "./lib.mjs";

try {
  const input = await readJsonInput(process.argv[2]);
  if (!input || typeof input !== "object" || Array.isArray(input) || !input.artifact || typeof input.expectedArtifactDigest !== "string") {
    throw new Error("artifact and externally frozen expectedArtifactDigest are required");
  }
  const value = input.artifact;
  const validated = Array.isArray(value?.entries) && value?.manifestSha256
    ? validateBaseline(value)
    : validateReport(value, input.expectedArtifactDigest);
  if (validated.manifestSha256 && validated.manifestSha256 !== input.expectedArtifactDigest) throw new Error("baseline artifact digest does not match the frozen digest");
  writeJson({ valid: true, kind: validated.manifestSha256 ? "workspace-baseline" : "change-scope-report" });
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
