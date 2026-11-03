import path from "node:path";
import { type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { msg } from "./i18n.js";
import { canonicalJson } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";
import { runStageValidator } from "./stage-validator-process.js";

/** A selected 2.x review checks its supplied bundle; it never activates a server policy. */
export function assertCsStageBundle(
  rootDirectory: string,
  taskDigest: string | undefined,
  result: StageResultV1,
  validator: ContractValidator,
): void {
  if (result.output.kind !== "output") return;
  if (!taskDigest) throw new WorkflowContractError("BINDING_REQUIRED", msg("workflow.cs.csReviewRequiresSignedTask", {}));
  const references = result.output.artifacts.filter((artifact) => artifact.artifactId === "cs-review-bundle");
  const reference = references[0];
  if (references.length !== 1 || !reference?.verified || !path.isAbsolute(reference.locator)
    || /^[\\/]{2}/u.test(reference.locator)) {
    throw new WorkflowContractError("MISSING_EVIDENCE", msg("workflow.cs.csReviewRequiresVerifiedLocal", {}));
  }
  const root = path.dirname(reference.locator);
  const assessment = runStageValidator("CS stage bundle", path.join(rootDirectory, "skills/cs-engineering/scripts/validate.mjs"), [
    "check-stage-bundle", "--root", root, "--input", path.basename(reference.locator),
    "--bundle-digest", reference.digest, "--task-digest", taskDigest,
  ], [0, 3, 4]);
  if (assessment.kind !== "cs-bundle-check") {
    throw new WorkflowContractError("GATE_FAILED", msg("workflow.cs.csStageBundleCouldValidated", {}),
      {step: "kind", kind: typeof assessment.kind === "string" ? assessment.kind : null});
  }
  validator.planWorkflowRequest(assessment.task);
  if (canonicalJson(assessment.review, "CS review") !== canonicalJson(result.output.output, "CS provider output")) {
    throw new WorkflowContractError("INTEGRITY_FAILED", msg("workflow.cs.csStageOutputDiffersValidated", {}));
  }
  const reviewRef = assessment.reviewRef as {path: string; digest: string};
  const reports = result.output.artifacts.filter((artifact) => artifact.artifactId === "cs-review-report");
  const report = reports[0];
  if (reports.length !== 1 || !report?.verified || report.digest !== reviewRef.digest
    || path.resolve(report.locator) !== path.resolve(root, reviewRef.path)
    || report.targetDigest !== assessment.candidateDigest || reference.targetDigest !== assessment.candidateDigest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", msg("workflow.cs.csReportArtifactBundleName", {}));
  }
}
