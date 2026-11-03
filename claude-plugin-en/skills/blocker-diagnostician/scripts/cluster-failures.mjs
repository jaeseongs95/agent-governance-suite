#!/usr/bin/env node
import { clusterFailures, InputError } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const clusters = clusterFailures(await readJsonArgument(process.argv.slice(2)));
  writeJson({ schemaVersion: "1.0.0", failureClusters: clusters });
} catch (error) {
  writeJson({ ok: false, error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error), details: error instanceof InputError ? error.details : null } });
  process.exitCode = 2;
}
