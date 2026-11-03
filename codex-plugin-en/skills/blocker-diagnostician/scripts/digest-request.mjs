#!/usr/bin/env node
import { requestArtifactDigest, validateInput } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const request = await readJsonArgument(process.argv.slice(2));
  validateInput(request);
  writeJson({ requestArtifactDigest: requestArtifactDigest(request) });
} catch (error) {
  writeJson({ ok: false, error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error) } });
  process.exitCode = 2;
}
