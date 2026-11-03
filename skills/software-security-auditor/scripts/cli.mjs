#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { snapshot, validateReport } from "./validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!["--input", "--report", "--target-root", "--evidence-root"].includes(key) || !args.length || options[key]) throw new Error(`INVALID_INPUT: ${hostText("skillScripts.securityAuditor.invalidOption")}`);
    options[key] = args.shift();
  }
  if (!["snapshot", "validate"].includes(mode) || !options["--input"] || !options["--target-root"]) throw new Error(`INVALID_INPUT: ${hostText("skillScripts.securityAuditor.usage")}`);
  const request = JSON.parse(readFileSync(options["--input"], "utf8"));
  if (mode === "snapshot") console.log(JSON.stringify(snapshot(request, options["--target-root"])));
  else {
    if (!options["--report"] || !options["--evidence-root"]) throw new Error(`INVALID_INPUT: ${hostText("skillScripts.securityAuditor.missingReportOrRoot")}`);
    const errors = validateReport(request, JSON.parse(readFileSync(options["--report"], "utf8")), { targetRoot: options["--target-root"], evidenceRoot: options["--evidence-root"] });
    console.log(JSON.stringify({ valid: errors.length === 0, errors }));
    process.exitCode = errors.length ? 1 : 0;
  }
} catch (error) {
  const ioCode = !(error instanceof SyntaxError) && typeof error?.code === "string" && /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : null;
  console.log(JSON.stringify({
    valid: false,
    code: ioCode ?? "INVALID_INPUT",
    details: ioCode ? { causeCategory: "io", causeCode: ioCode } : null,
    errors: [error instanceof Error ? error.message : String(error)]
  }));
  process.exitCode = 2;
}
