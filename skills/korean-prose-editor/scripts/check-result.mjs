#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { printJson, readJsonInput, requireObject } from "./lib.mjs";
import { checkResult } from "./result-checker.mjs";

export { checkResult } from "./result-checker.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = requireObject(await readJsonInput(), "input");
  printJson(checkResult(input.source, input.candidate, input.manifest));
}
