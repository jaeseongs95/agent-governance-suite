#!/usr/bin/env node
import { analyzeDiagnosis, InputError } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  writeJson(analyzeDiagnosis(await readJsonArgument(process.argv.slice(2))));
} catch (error) {
  const ioCode = !(error instanceof InputError) && !(error instanceof SyntaxError) && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
  writeJson({
    ok: false,
    error: {
      code: ioCode ?? "INVALID_INPUT",
      message: error instanceof Error ? error.message : String(error),
      details: ioCode ? { causeCategory: "io", causeCode: ioCode } : (error instanceof InputError ? error.details : null),
    },
  });
  process.exitCode = 2;
}
