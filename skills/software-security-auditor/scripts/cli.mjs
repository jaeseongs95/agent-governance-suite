#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { snapshot, validateReport } from "./validation.mjs";

try {
  const args = process.argv.slice(2);
  const mode = args.shift();
  const options = {};
  while (args.length) {
    const key = args.shift();
    if (!["--input", "--report", "--target-root", "--evidence-root"].includes(key) || !args.length || options[key]) throw new Error("INVALID_INPUT: invalid or repeated option");
    options[key] = args.shift();
  }
  if (!["snapshot", "validate"].includes(mode) || !options["--input"] || !options["--target-root"]) throw new Error("INVALID_INPUT: use snapshot|validate --input request.json --target-root root; validate also requires --report and --evidence-root");
  const request = JSON.parse(readFileSync(options["--input"], "utf8"));
  if (mode === "snapshot") console.log(JSON.stringify(snapshot(request, options["--target-root"])));
  else {
    if (!options["--report"] || !options["--evidence-root"]) throw new Error("INVALID_INPUT: missing report or evidence root");
    const errors = validateReport(request, JSON.parse(readFileSync(options["--report"], "utf8")), { targetRoot: options["--target-root"], evidenceRoot: options["--evidence-root"] });
    console.log(JSON.stringify({ valid: errors.length === 0, errors }));
    process.exitCode = errors.length ? 1 : 0;
  }
} catch (error) {
  console.log(JSON.stringify({ valid: false, code: "INVALID_INPUT", errors: [error.message] }));
  process.exitCode = 2;
}
