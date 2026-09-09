#!/usr/bin/env node
import { captureBaseline, readJsonInput, validateRequest, writeJson } from "./lib.mjs";

try {
  const request = await readJsonInput(process.argv[2]);
  validateRequest(request, "capture");
  writeJson(captureBaseline(request));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
