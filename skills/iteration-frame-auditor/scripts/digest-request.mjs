#!/usr/bin/env node
import { readJsonArgument, writeJson } from "./io.mjs";
import { reviewRequestDigest, validateRequest } from "./core.mjs";

try {
  const request = await readJsonArgument(process.argv.slice(2));
  validateRequest(request);
  writeJson({ schemaVersion: "1.0.0", requestArtifactDigest: reviewRequestDigest(request) });
} catch (error) {
  writeJson({
    error: {
      code: "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
      details: error?.details ?? null
    }
  });
  process.exitCode = 2;
}
