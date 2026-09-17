#!/usr/bin/env node
import { analyzeAcceptance, InputError } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const input = await readJsonArgument(process.argv.slice(2));
  writeJson(analyzeAcceptance(input));
} catch (error) {
  writeJson({
    ok: false,
    error: {
      code: error instanceof InputError ? "INVALID_INPUT" : "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
      details: error instanceof InputError ? error.details : null
    }
  });
  process.exitCode = 2;
}
