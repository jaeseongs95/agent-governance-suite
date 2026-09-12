#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { printJson, readJsonInput, requireObject } from "./lib.mjs";
import { finalizeRequest, formatFinalizationResponse } from "./finalizer-core.mjs";

export { finalizeRequest, formatFinalizationResponse } from "./finalizer-core.mjs";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const input = requireObject(await readJsonInput(), "request");
  const mode = input.mode === "mcp" ? "mcp" : "direct";
  printJson(formatFinalizationResponse(finalizeRequest(input), mode));
}
