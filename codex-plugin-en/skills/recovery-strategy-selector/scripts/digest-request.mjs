#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";

import { selectionRequestDigest, validateRequest } from "./core.mjs";
import { readJsonInput, writeJson } from "./io.mjs";

export async function main() {
  const request = validateRequest(await readJsonInput());
  writeJson({ requestArtifactDigest: selectionRequestDigest(request) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
