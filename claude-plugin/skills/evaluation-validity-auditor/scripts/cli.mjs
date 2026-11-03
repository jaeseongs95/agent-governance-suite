#!/usr/bin/env node
import { analyzeEvaluation, hostText, InputError } from "./core.mjs";
import { argumentValue, readJsonInput, renderReportKo, writeJson } from "./io.mjs";

let format = "json";
try {
  const args = process.argv.slice(2);
  format = argumentValue(args, "--format") ?? "json";
  if (!["json", "human-ko"].includes(format)) throw new InputError(hostText("skillReports.evaluationValidityAuditor.formatInvalid"));
  const input = await readJsonInput(args);
  const artifactRoot = argumentValue(args, "--artifact-root");
  if (!artifactRoot) throw new InputError(hostText("skillReports.evaluationValidityAuditor.artifactRootRequired"));
  const report = await analyzeEvaluation(input, { artifactRoot });
  if (format === "human-ko") process.stdout.write(renderReportKo(report));
  else writeJson(report);
} catch (error) {
  const ioCode = !(error instanceof InputError) && !(error instanceof SyntaxError) && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
  if (format === "human-ko") {
    process.stdout.write(`${ioCode
      ? hostText("skillReportsKo.evaluationValidityAuditor.cliIoError", { code: ioCode })
      : hostText("skillReportsKo.evaluationValidityAuditor.cliInvalidInput")}\n`);
  } else {
    writeJson({
      schemaVersion: "1.0.0",
      ok: false,
      error: {
        code: ioCode ?? "INVALID_INPUT",
        message: error instanceof Error ? error.message : String(error),
        details: ioCode ? { causeCategory: "io", causeCode: ioCode } : (error instanceof InputError ? error.details : null),
      },
    });
  }
  process.exitCode = 2;
}
