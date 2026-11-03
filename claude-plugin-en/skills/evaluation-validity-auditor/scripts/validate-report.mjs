#!/usr/bin/env node
import { argumentValue, readJsonFile, readJsonInput, renderReportKo, writeJson } from "./io.mjs";
import { hostText, validateReport } from "./core.mjs";

let format = "json";
try {
  const args = process.argv.slice(2);
  format = argumentValue(args, "--format") ?? "json";
  if (!["json", "human-ko"].includes(format)) throw new Error(hostText("skillReports.evaluationValidityAuditor.formatInvalid"));
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new Error(hostText("skillReports.evaluationValidityAuditor.artifactRootRequired"));
  const explicit = args.some((arg) => ["--request", "--request-artifact", "--report"].includes(arg));
  const validation = explicit
    ? {
      schemaVersion: "1.0.0",
      request: await readJsonFile(args, "--request"),
      requestArtifact: await readJsonFile(args, "--request-artifact"),
      report: await readJsonFile(args, "--report"),
    }
    : await readJsonInput(args);
  const errors = await validateReport(validation, { artifactRoot });
  if (format === "human-ko") {
    process.stdout.write(errors.length === 0
      ? `${hostText("skillReportsKo.evaluationValidityAuditor.validatePassed")}\n${renderReportKo(validation.report)}`
      : `${hostText("skillReportsKo.evaluationValidityAuditor.validateFailed", { count: errors.length })}\n`);
  } else writeJson({ schemaVersion: "1.0.0", valid: errors.length === 0, errors });
  if (errors.length > 0) process.exitCode = 1;
} catch (error) {
  if (format === "human-ko") process.stdout.write(`${hostText("skillReportsKo.evaluationValidityAuditor.validateInputError")}\n`);
  else writeJson({ schemaVersion: "1.0.0", valid: false, errors: [error instanceof Error ? error.message : String(error)] });
  process.exitCode = 2;
}
