#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import path from "node:path";

import { validateHandoff } from "./core.mjs";
import { readJsonInput, writeJson } from "./io.mjs";

export async function main() {
  const input = await readJsonInput();
  const errors = validateHandoff(input.request, input.handoff, input.requestArtifactDigest);
  writeJson({ valid: errors.length === 0, errors });
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
