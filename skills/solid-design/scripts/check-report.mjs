import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = await Promise.all(["request", "report"].map(async (kind) => {
  const schema = JSON.parse(await readFile(new URL(`../contracts/solid-design-${kind}.v1.schema.json`, import.meta.url), "utf8"));
  return ajv.compile(schema);
}));

/** Checks structure and artifact binding; it does not judge the truth of a design finding. */
export function checkReport(requestBytes, report) {
  let request;
  try { request = JSON.parse(requestBytes.toString("utf8")); }
  catch { return { valid: false, errors: ["request is not valid JSON"] }; }
  const errors = [];
  for (const [index, data] of [request, report].entries()) {
    if (!validators[index](data)) errors.push(`${index === 0 ? "request" : "report"}: ${ajv.errorsText(validators[index].errors)}`);
  }
  if (errors.length) return { valid: false, errors };
  const expectedDigest = `sha256:${createHash("sha256").update(requestBytes).digest("hex")}`;
  if (report.requestId !== request.requestId) errors.push("requestId mismatch");
  if (report.requestDigest !== expectedDigest) errors.push("requestDigest mismatch");
  if (report.snapshotRef !== request.snapshotRef) errors.push("snapshotRef mismatch");

  const covered = [...report.scope.reviewed, ...report.scope.notReviewed];
  if (new Set(covered).size !== covered.length) errors.push("scope contains duplicate or overlapping targets");
  if (covered.some((target) => !request.targets.includes(target))) errors.push("scope contains an undeclared target");
  if (request.targets.some((target) => !covered.includes(target))) errors.push("scope omits a requested target");
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) errors.push("duplicate finding id");
  for (const finding of report.findings) {
    if (!report.scope.reviewed.includes(finding.target)) errors.push(`${finding.id}: finding target was not reviewed`);
    if (finding.principles.some((principle) => !report.principlesConsidered.includes(principle))) errors.push(`${finding.id}: principle was not considered`);
    if (finding.contractRefs.some((ref) => !request.contractRefs.includes(ref))) errors.push(`${finding.id}: contract reference is not bound to the request`);
    if (finding.relatedFindingRefs.some((ref) => !request.priorFindingRefs.includes(ref))) errors.push(`${finding.id}: prior finding reference is not bound to the request`);
  }
  return { valid: errors.length === 0, errors, validationScope: "schema-and-binding-only" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--report") {
    throw new Error("Usage: node skills/solid-design/scripts/check-report.mjs --request REQUEST.json --report REPORT.json");
  }
  const requestBytes = await readFile(args[1]);
  const report = JSON.parse(await readFile(args[3], "utf8"));
  const result = checkReport(requestBytes, report);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
