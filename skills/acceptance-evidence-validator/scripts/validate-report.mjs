#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateReport } from "./core.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  const requestIndex = args.indexOf("--request");
  const artifactIndex = args.indexOf("--request-artifact");
  let validation;
  if (reportIndex >= 0 || requestIndex >= 0 || artifactIndex >= 0) {
    if (reportIndex < 0 || !args[reportIndex + 1]) throw new Error("--report requires a file path.");
    if (requestIndex < 0 || !args[requestIndex + 1]) throw new Error("--request requires a file path.");
    if (artifactIndex < 0 || !args[artifactIndex + 1]) throw new Error("--request-artifact requires a file path.");
    validation = {
      schemaVersion: "1.0.0",
      report: JSON.parse(await readFile(args[reportIndex + 1], "utf8")),
      request: JSON.parse(await readFile(args[requestIndex + 1], "utf8")),
      requestArtifact: JSON.parse(await readFile(args[artifactIndex + 1], "utf8")),
    };
  } else {
    validation = await readJsonArgument(args);
  }
  const errors = validateReport(validation);
  writeJson({ valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  writeJson({ valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
