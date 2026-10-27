import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validators = await Promise.all(["request", "report"].map(async (kind) => {
  const schema = JSON.parse(await readFile(new URL(`../contracts/prompt-engineering-${kind}.v1.schema.json`, import.meta.url), "utf8"));
  return ajv.compile(schema);
}));
const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

/** Validates structure and declared bindings; never proves semantic quality, evidence truth or approval. */
export function checkReport(requestBytes, report) {
  let request;
  try { request = JSON.parse(requestBytes.toString("utf8")); }
  catch { return { valid: false, errors: ["request is not valid JSON"] }; }
  const errors = [];
  for (const [index, data] of [request, report].entries()) {
    if (!validators[index](data)) errors.push(`${index === 0 ? "request" : "report"}: ${ajv.errorsText(validators[index].errors)}`);
  }
  if (errors.length) return { valid: false, errors };
  const requireUnique = (values, label) => {
    if (new Set(values).size !== values.length) errors.push(`duplicate ${label}`);
  };
  const requireSubset = (values, allowed, label) => {
    if (values.some((value) => !allowed.includes(value))) errors.push(`unbound ${label}`);
  };
  if (report.requestId !== request.requestId) errors.push("requestId mismatch");
  if (report.requestDigest !== digest(requestBytes)) errors.push("requestDigest mismatch");
  if (report.snapshotRef !== request.snapshotRef) errors.push("snapshotRef mismatch");

  const covered = [...report.scope.reviewed, ...report.scope.notReviewed];
  requireUnique(covered, "scope target");
  requireSubset(covered, request.targets, "scope target");
  if (request.targets.some((target) => !covered.includes(target))) errors.push("scope omits a requested target");
  const requirements = request.requirements.map((item) => item.id);
  requireUnique(requirements, "request requirement id");
  const traceIds = report.requirementTrace.map((item) => item.requirementId);
  requireUnique(traceIds, "requirement trace id");
  requireSubset(traceIds, requirements, "requirement trace");
  if (requirements.some((id) => !traceIds.includes(id))) errors.push("requirement trace omits a request requirement");

  const evidence = [...request.evidenceRefs, ...request.instructionRefs, ...request.requirements.map((item) => item.sourceRef),
    ...(request.baseline ? [request.baseline.ref] : [])];
  requireSubset(request.environment.verifiedRefs, evidence, "environment reference");
  requireUnique(report.findings.map((item) => item.id), "finding id");
  for (const finding of report.findings) {
    requireSubset([finding.target], report.scope.reviewed, "finding target");
    requireSubset(finding.evidenceRefs, evidence, "finding evidence");
  }
  const candidates = report.candidates.map((item) => item.id);
  requireUnique(candidates, "candidate id");
  for (const candidate of report.candidates) {
    requireSubset([candidate.target], report.scope.reviewed, "candidate target");
    if (candidate.digest !== digest(candidate.text)) errors.push(`${candidate.id}: prompt digest mismatch`);
  }
  for (const trace of report.requirementTrace) requireSubset(trace.candidateRefs, candidates, "trace candidate");
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode) && !candidates.length) {
    errors.push("completed create or improve requires a prompt candidate");
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && request.targets.some((target) => !report.candidates.some((candidate) => candidate.target === target))) {
    errors.push("completed create or improve requires a candidate for every target");
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && report.requirementTrace.some((item) => item.status !== "preserved")) {
    errors.push("unresolved requirement cannot be marked ANALYZED");
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && candidates.length && report.requirementTrace.some((item) => !item.candidateRefs.length)) {
    errors.push("candidate output must trace every requirement");
  }

  const evaluation = report.evaluation;
  requireUnique(evaluation.cases.map((item) => item.id), "evaluation case id");
  for (const testCase of evaluation.cases) requireSubset(testCase.requirementIds, requirements, "case requirement");
  requireUnique(evaluation.runs.map((item) => item.id), "evaluation run id");
  for (const run of evaluation.runs) {
    const candidate = report.candidates.find((item) => item.id === run.candidateId);
    if (!candidate || run.promptDigest !== candidate.digest) errors.push(`${run.id}: run candidate binding mismatch`);
    if (run.baselineDigest !== (request.baseline?.digest ?? null)) errors.push(`${run.id}: baseline digest mismatch`);
    requireSubset([run.datasetRef, run.configurationRef, run.resultRef], request.evidenceRefs, "evaluation evidence");
  }
  if (evaluation.conclusion !== "NOT_ESTABLISHED" && !request.baseline) errors.push("comparison conclusion requires a baseline");
  return { valid: errors.length === 0, errors, validationScope: "structure-and-binding-only" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--report") {
    throw new Error("Usage: node skills/prompt-engineering/scripts/check-report.mjs --request REQUEST.json --report REPORT.json");
  }
  const requestBytes = await readFile(args[1]);
  const report = JSON.parse(await readFile(args[3], "utf8"));
  const result = checkReport(requestBytes, report);
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
