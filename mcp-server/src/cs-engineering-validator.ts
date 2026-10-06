import { spawnSync } from "node:child_process";
import path from "node:path";
import { type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { canonicalJson } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";

/** A selected 2.x review checks its supplied bundle; it never activates a server policy. */
export function assertCsStageBundle(
  rootDirectory: string,
  taskDigest: string | undefined,
  result: StageResultV1,
  validator: ContractValidator,
): void {
  if (result.output.kind !== "output") return;
  if (!taskDigest) throw new WorkflowContractError("BINDING_REQUIRED", "CS review requires a signed task digest.");
  const references = result.output.artifacts.filter((artifact) => artifact.artifactId === "cs-review-bundle");
  const reference = references[0];
  if (references.length !== 1 || !reference?.verified || !path.isAbsolute(reference.locator)
    || /^(?:\\\\|\/\/)/u.test(reference.locator)) {
    throw new WorkflowContractError("MISSING_EVIDENCE", "CS review requires one verified local cs-review-bundle artifact.");
  }
  const root = path.dirname(reference.locator);
  const checked = spawnSync(process.execPath, [
    path.join(rootDirectory, "skills/cs-engineering/scripts/validate.mjs"), "check-stage-bundle",
    "--root", root, "--input", path.basename(reference.locator),
    "--bundle-digest", reference.digest, "--task-digest", taskDigest,
  ], {encoding:"utf8", timeout:10_000, maxBuffer:4 * 1024 * 1024, windowsHide:true});
  let assessment: Record<string, unknown>;
  try { assessment = JSON.parse(checked.stdout) as Record<string, unknown>; }
  catch { throw new WorkflowContractError("INVALID_INPUT", "CS stage bundle validator did not return bounded JSON."); }
  if (checked.error || ![0, 3, 4].includes(checked.status ?? -1) || assessment.kind !== "cs-bundle-check") {
    throw new WorkflowContractError("GATE_FAILED", "CS stage bundle could not be validated. Correct the supplied files and references.");
  }
  validator.planWorkflowRequest(assessment.task);
  if (canonicalJson(assessment.review, "CS review") !== canonicalJson(result.output.output, "CS provider output")) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "CS stage output differs from its validated bundle review.");
  }
  const reviewRef = assessment.reviewRef as {path: string; digest: string};
  const reports = result.output.artifacts.filter((artifact) => artifact.artifactId === "cs-review-report");
  const report = reports[0];
  if (reports.length !== 1 || !report?.verified || report.digest !== reviewRef.digest
    || path.resolve(report.locator) !== path.resolve(root, reviewRef.path)
    || report.targetDigest !== assessment.candidateDigest || reference.targetDigest !== assessment.candidateDigest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "CS report artifact and bundle must name the same review bytes and candidate.");
  }
}
