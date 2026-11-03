#!/usr/bin/env node
import { compareScope, readJsonInput, validateRequest, writeJson } from "./lib.mjs";

try {
  const request = await readJsonInput(process.argv[2]);
  validateRequest(request, "verify");
  writeJson(compareScope(request));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
