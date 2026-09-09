#!/usr/bin/env node
import { analyzeDiagnosis, InputError } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  writeJson(analyzeDiagnosis(await readJsonArgument(process.argv.slice(2))));
} catch (error) {
  writeJson({ ok: false, error: { code: "INVALID_INPUT", message: error instanceof Error ? error.message : String(error), details: error instanceof InputError ? error.details : null } });
  process.exitCode = 2;
}
