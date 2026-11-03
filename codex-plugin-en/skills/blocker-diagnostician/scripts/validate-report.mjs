#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { validateReport } from "./core.mjs";
import { hostText } from "../../../runtime/i18n.mjs";
import { readJsonArgument, writeJson } from "./io.mjs";

try {
  const args = process.argv.slice(2);
  const reportIndex = args.indexOf("--report");
  const requestIndex = args.indexOf("--request");
  const digestIndex = args.indexOf("--request-digest");
  let report;
  let request = null;
  let requestArtifactDigest = null;
  if (reportIndex >= 0) {
    if (!args[reportIndex + 1]) throw new Error(hostText("skillScripts.blockerDiagnostician.requiresFilePath", { name: "--report" }));
    if (requestIndex < 0 || !args[requestIndex + 1]) throw new Error(hostText("skillScripts.blockerDiagnostician.requiresFilePath", { name: "--request" }));
    if (digestIndex < 0 || !args[digestIndex + 1]) throw new Error(hostText("skillScripts.blockerDiagnostician.requestDigestRequired"));
    report = JSON.parse(await readFile(args[reportIndex + 1], "utf8"));
    request = JSON.parse(await readFile(args[requestIndex + 1], "utf8"));
    requestArtifactDigest = args[digestIndex + 1];
  } else {
    const input = await readJsonArgument(args);
    if (!input?.report) throw new Error(hostText("skillScripts.blockerDiagnostician.stdinMustContain"));
    ({ report, request = null, requestArtifactDigest = null } = input);
  }
  const errors = validateReport(report, request, requestArtifactDigest);
  writeJson({ valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  writeJson({ valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
