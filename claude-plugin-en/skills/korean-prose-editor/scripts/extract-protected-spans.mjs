#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { printJson, readJsonInput, requireObject } from "./lib.mjs";
import { extractProtectedSpans } from "./protected-spans.mjs";

export { extractProtectedSpans } from "./protected-spans.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = requireObject(await readJsonInput(), "input");
  printJson(extractProtectedSpans(input.source, input.protectedStrings));
}
