#!/usr/bin/env node
import { readJsonArgument, writeJson } from "./io.mjs";
import { reviewRequestDigest, validateRequest } from "./core.mjs";

try {
  const request = await readJsonArgument(process.argv.slice(2));
  validateRequest(request);
  writeJson({ schemaVersion: "1.0.0", requestArtifactDigest: reviewRequestDigest(request) });
} catch (error) {
  const ioCode = !(error instanceof SyntaxError) && !error?.details && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
  writeJson({
    error: {
      code: ioCode ?? "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
      details: ioCode ? { causeCategory: "io", causeCode: ioCode } : (error?.details ?? null)
    }
  });
  process.exitCode = 2;
}
