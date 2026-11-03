import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = await Promise.all(["request", "report"].map(async (kind) => {
  const schema = JSON.parse(await readFile(new URL(`../contracts/solid-design-${kind}.v1.schema.json`, import.meta.url), "utf8"));
  return ajv.compile(schema);
}));

/** Checks structure and artifact binding; it does not judge the truth of a design finding. */
export function checkReport(requestBytes, report) {
  let request;
  try { request = JSON.parse(requestBytes.toString("utf8")); }
  catch { return { valid: false, errors: [hostText("skillScripts.solidDesign.requestNotJson")] }; }
  const errors = [];
  for (const [index, data] of [request, report].entries()) {
    if (!validators[index](data)) errors.push(`${index === 0 ? "request" : "report"}: ${ajv.errorsText(validators[index].errors)}`);
  }
  if (errors.length) return { valid: false, errors };
  const expectedDigest = `sha256:${createHash("sha256").update(requestBytes).digest("hex")}`;
  if (report.requestId !== request.requestId) errors.push(hostText("skillScripts.solidDesign.requestIdMismatch"));
  if (report.requestDigest !== expectedDigest) errors.push(hostText("skillScripts.solidDesign.requestDigestMismatch"));
  if (report.snapshotRef !== request.snapshotRef) errors.push(hostText("skillScripts.solidDesign.snapshotRefMismatch"));

  const covered = [...report.scope.reviewed, ...report.scope.notReviewed];
  if (new Set(covered).size !== covered.length) errors.push(hostText("skillScripts.solidDesign.scopeDuplicate"));
  if (covered.some((target) => !request.targets.includes(target))) errors.push(hostText("skillScripts.solidDesign.scopeUndeclared"));
  if (request.targets.some((target) => !covered.includes(target))) errors.push(hostText("skillScripts.solidDesign.scopeOmits"));
  if (new Set(report.findings.map((finding) => finding.id)).size !== report.findings.length) errors.push(hostText("skillScripts.solidDesign.duplicateFinding"));
  for (const finding of report.findings) {
    if (!report.scope.reviewed.includes(finding.target)) errors.push(hostText("skillScripts.solidDesign.findingNotReviewed", { id: finding.id }));
    if (finding.principles.some((principle) => !report.principlesConsidered.includes(principle))) errors.push(hostText("skillScripts.solidDesign.principleNotConsidered", { id: finding.id }));
    if (finding.contractRefs.some((ref) => !request.contractRefs.includes(ref))) errors.push(hostText("skillScripts.solidDesign.contractRefUnbound", { id: finding.id }));
    if (finding.relatedFindingRefs.some((ref) => !request.priorFindingRefs.includes(ref))) errors.push(hostText("skillScripts.solidDesign.priorRefUnbound", { id: finding.id }));
  }
  return { valid: errors.length === 0, errors, validationScope: "schema-and-binding-only" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--report") {
    throw new Error(hostText("skillScripts.solidDesign.usage"));
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
