import { spawnSync } from "node:child_process";
import path from "node:path";
import { type StageResultV1, WorkflowContractError } from "../../contracts/types.js";
import { canonicalJson } from "./convergence-logic.js";
import { ContractValidator } from "./schema-validator.js";

/** Existing selected providers recheck raw files; this does not select skills or attest execution. */
export function assertEngineeringStageBundle(
  rootDirectory: string, taskDigest: string | undefined, capability: string,
  result: StageResultV1, validator: ContractValidator,
): void {
  if (!["test-sensitivity-review", "change-code-review"].includes(capability) || result.output.kind !== "output") return;
  if (!taskDigest) throw new WorkflowContractError("BINDING_REQUIRED", "Engineering review requires a signed task digest.");
  const references = result.output.artifacts.filter(artifact => artifact.artifactId === "engineering-stage-bundle");
  const reference = references[0];
  if (references.length !== 1 || !reference?.verified || !path.isAbsolute(reference.locator) || /^(?:\\\\|\/\/)/u.test(reference.locator)) {
    throw new WorkflowContractError("MISSING_EVIDENCE", "Engineering review requires one verified local engineering-stage-bundle artifact.");
  }
  const root = path.dirname(reference.locator);
  const checked = spawnSync(process.execPath, [path.join(rootDirectory, "runtime/engineering-practices/cli.mjs"), "check-stage-bundle",
    "--root", root, "--input", path.basename(reference.locator), "--bundle-digest", reference.digest,
    "--task-digest", taskDigest, "--capability", capability], { encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  let assessment: Record<string, unknown>;
  try { assessment = JSON.parse(checked.stdout) as Record<string, unknown>; }
  catch { throw new WorkflowContractError("INVALID_INPUT", "Engineering stage validator did not return bounded JSON."); }
  if (checked.error || ![0, 1].includes(checked.status ?? -1) || assessment.kind !== "engineering-stage-check") {
    throw new WorkflowContractError("GATE_FAILED", "Engineering stage files could not be validated.");
  }
  validator.planWorkflowRequest(assessment.task);
  if (canonicalJson(assessment.result, "Engineering result") !== canonicalJson(result.output.output, "Engineering provider output")) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Provider output differs from validated raw engineering files.");
  }
  const resultRef = assessment.resultRef as { path: string; digest: string };
  const artifactId = capability === "test-sensitivity-review" ? "engineering-test-result" : "engineering-review-result";
  const reports = result.output.artifacts.filter(artifact => artifact.artifactId === artifactId);
  const report = reports[0];
  if (reports.length !== 1 || !report?.verified || report.digest !== resultRef.digest
    || path.resolve(report.locator) !== path.resolve(root, resultRef.path)
    || report.targetDigest !== assessment.targetDigest || reference.targetDigest !== assessment.targetDigest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Engineering artifacts must bind the validated result bytes and current candidate.");
  }
}
