import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "../../../runtime/schema-validation.mjs";
import { hostText } from "../../../runtime/i18n.mjs";

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
  catch { return { valid: false, errors: [hostText("skillScripts.promptEngineering.requestNotJson")] }; }
  const errors = [];
  for (const [index, data] of [request, report].entries()) {
    if (!validators[index](data)) errors.push(`${index === 0 ? "request" : "report"}: ${ajv.errorsText(validators[index].errors)}`);
  }
  if (errors.length) return { valid: false, errors };
  const hasDuplicates = (values) => new Set(values).size !== values.length;
  const hasUnbound = (values, allowed) => values.some((value) => !allowed.includes(value));
  if (report.requestId !== request.requestId) errors.push(hostText("skillScripts.promptEngineering.requestIdMismatch"));
  if (report.requestDigest !== digest(requestBytes)) errors.push(hostText("skillScripts.promptEngineering.requestDigestMismatch"));
  if (report.snapshotRef !== request.snapshotRef) errors.push(hostText("skillScripts.promptEngineering.snapshotRefMismatch"));

  const covered = [...report.scope.reviewed, ...report.scope.notReviewed];
  if (hasDuplicates(covered)) errors.push(hostText("skillScripts.promptEngineering.duplicateScopeTarget"));
  if (hasUnbound(covered, request.targets)) errors.push(hostText("skillScripts.promptEngineering.unboundScopeTarget"));
  if (request.targets.some((target) => !covered.includes(target))) errors.push(hostText("skillScripts.promptEngineering.scopeOmits"));
  const requirements = request.requirements.map((item) => item.id);
  if (hasDuplicates(requirements)) errors.push(hostText("skillScripts.promptEngineering.duplicateRequestRequirementId"));
  const traceIds = report.requirementTrace.map((item) => item.requirementId);
  if (hasDuplicates(traceIds)) errors.push(hostText("skillScripts.promptEngineering.duplicateRequirementTraceId"));
  if (hasUnbound(traceIds, requirements)) errors.push(hostText("skillScripts.promptEngineering.unboundRequirementTrace"));
  if (requirements.some((id) => !traceIds.includes(id))) errors.push(hostText("skillScripts.promptEngineering.traceOmits"));

  const evidence = [...request.evidenceRefs, ...request.instructionRefs, ...request.requirements.map((item) => item.sourceRef),
    ...(request.baseline ? [request.baseline.ref] : [])];
  if (hasUnbound(request.environment.verifiedRefs, evidence)) errors.push(hostText("skillScripts.promptEngineering.unboundEnvironmentReference"));
  if (hasDuplicates(report.findings.map((item) => item.id))) errors.push(hostText("skillScripts.promptEngineering.duplicateFindingId"));
  for (const finding of report.findings) {
    if (hasUnbound([finding.target], report.scope.reviewed)) errors.push(hostText("skillScripts.promptEngineering.unboundFindingTarget"));
    if (hasUnbound(finding.evidenceRefs, evidence)) errors.push(hostText("skillScripts.promptEngineering.unboundFindingEvidence"));
  }
  const candidates = report.candidates.map((item) => item.id);
  if (hasDuplicates(candidates)) errors.push(hostText("skillScripts.promptEngineering.duplicateCandidateId"));
  for (const candidate of report.candidates) {
    if (hasUnbound([candidate.target], report.scope.reviewed)) errors.push(hostText("skillScripts.promptEngineering.unboundCandidateTarget"));
    if (candidate.digest !== digest(candidate.text)) errors.push(hostText("skillScripts.promptEngineering.promptDigestMismatch", { id: candidate.id }));
  }
  for (const trace of report.requirementTrace) if (hasUnbound(trace.candidateRefs, candidates)) errors.push(hostText("skillScripts.promptEngineering.unboundTraceCandidate"));
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode) && !candidates.length) {
    errors.push(hostText("skillScripts.promptEngineering.needsCandidate"));
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && request.targets.some((target) => !report.candidates.some((candidate) => candidate.target === target))) {
    errors.push(hostText("skillScripts.promptEngineering.needsCandidateEveryTarget"));
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && report.requirementTrace.some((item) => item.status !== "preserved")) {
    errors.push(hostText("skillScripts.promptEngineering.unresolvedAnalyzed"));
  }
  if (report.status === "ANALYZED" && ["create", "improve"].includes(request.mode)
    && candidates.length && report.requirementTrace.some((item) => !item.candidateRefs.length)) {
    errors.push(hostText("skillScripts.promptEngineering.candidateTraceAll"));
  }

  const evaluation = report.evaluation;
  if (hasDuplicates(evaluation.cases.map((item) => item.id))) errors.push(hostText("skillScripts.promptEngineering.duplicateEvaluationCaseId"));
  for (const testCase of evaluation.cases) if (hasUnbound(testCase.requirementIds, requirements)) errors.push(hostText("skillScripts.promptEngineering.unboundCaseRequirement"));
  if (hasDuplicates(evaluation.runs.map((item) => item.id))) errors.push(hostText("skillScripts.promptEngineering.duplicateEvaluationRunId"));
  for (const run of evaluation.runs) {
    const candidate = report.candidates.find((item) => item.id === run.candidateId);
    if (!candidate || run.promptDigest !== candidate.digest) errors.push(hostText("skillScripts.promptEngineering.runCandidateBinding", { id: run.id }));
    if (run.baselineDigest !== (request.baseline?.digest ?? null)) errors.push(hostText("skillScripts.promptEngineering.runBaselineDigest", { id: run.id }));
    if (hasUnbound([run.datasetRef, run.configurationRef, run.resultRef], request.evidenceRefs)) errors.push(hostText("skillScripts.promptEngineering.unboundEvaluationEvidence"));
  }
  if (evaluation.conclusion !== "NOT_ESTABLISHED" && !request.baseline) errors.push(hostText("skillScripts.promptEngineering.conclusionNeedsBaseline"));
  return { valid: errors.length === 0, errors, validationScope: "structure-and-binding-only" };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--request" || args[2] !== "--report") {
    throw new Error(hostText("skillScripts.promptEngineering.usage"));
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
