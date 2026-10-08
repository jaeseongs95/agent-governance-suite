import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import type { StageResultV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";

const repo = path.resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const read = (root: string, name: string) => JSON.parse(readFileSync(path.join(root, name), "utf8"));
const write = (root: string, name: string, value: unknown) => writeFileSync(path.join(root, name), JSON.stringify(value, null, 2) + "\n");
const digest = (root: string, name: string): `sha256:${string}` => `sha256:${createHash("sha256").update(readFileSync(path.join(root, name))).digest("hex")}`;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture(capability = "test-sensitivity-review", reviewAfter = false) {
  const task: TaskEnvelopeV1 = { schemaVersion: "1.0.0", taskId: "demo-page", objective: "Correct and verify the requested prefix.",
    scope: { included: ["sample/page.mjs", "sample/page.test.mjs"], excluded: [] }, acceptanceCriteria: ["R-PREFIX"], riskLevel: "low",
    workUnits: [{ id: "prefix", objective: "Correct the prefix boundary.", dependencies: [], writeTargets: ["sample/page.mjs"] }],
    requiredCapabilities: reviewAfter ? [capability, "change-code-review"] : [capability], constraints: [], authorization: { allowedActions: ["local-fixture"], prohibitedActions: ["network"], approvalRequired: [] },
    decision: { complexity: "complex", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true } };
  const root = mkdtempSync(path.join(tmpdir(), "ags-engineering-stage-")); roots.push(root);
  // Each fixture executes real red and green; no stored PASS proof is copied.
  const built = spawnSync(process.execPath, [path.join(repo, "tests/engineering-practices/build-example.node.mjs"), root], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0); expect(JSON.parse(built.stdout)).toMatchObject({ red: "FAIL", green: "PASS" });
  write(root, "task.json", task);
  const plan = read(root, "plan.json"); plan.contractDigest = convergenceDigest(task); write(root, "plan.json", plan);
  const proof = read(root, "proof.json"); proof.planDigest = convergenceDigest(plan); write(root, "proof.json", proof);
  const request = read(root, "request.json"); request.contractDigest = convergenceDigest(task); write(root, "request.json", request);
  const report = read(root, "review.json"); report.requestDigest = convergenceDigest(request); write(root, "report.json", report);
  const command = capability === "test-sensitivity-review" ? ["check-proof", "--plan", "plan.json", "--proof", "proof.json"] : ["check-review", "--request", "request.json", "--report", "report.json"];
  const checked = spawnSync(process.execPath, [path.join(repo, "runtime/engineering-practices/cli.mjs"), command[0]!, "--root", root, ...command.slice(1)], { encoding: "utf8" });
  expect(checked.status, checked.stderr).toBe(0); write(root, "result.json", JSON.parse(checked.stdout));
  const inputs = capability === "test-sensitivity-review" ? ["task", "plan", "proof", "result"] : ["task", "request", "report", "result"];
  const sync = () => write(root, "stage-bundle.json", { schemaVersion: "1.0.0", kind: "engineering-stage-bundle", capability,
    ...Object.fromEntries(inputs.map(name => [name, { path: `${name}.json`, digest: digest(root, `${name}.json`) }])) });
  sync();
  const validator = new ContractValidator(); const registry = new FileSkillRegistry(path.join(repo, "skills/registry.json"), validator);
  const service = new WorkflowService(registry, validator); const planned = service.planWorkflow(task);
  expect(planned.error).toBeNull(); const started = service.startWorkflow(planned.data!); expect(started.error).toBeNull();
  const receipt = started.data!;
  const stage = (): StageResultV1 => {
    const output = read(root, "result.json");
    const artifactId = capability === "test-sensitivity-review" ? "engineering-test-result" : "engineering-review-result";
    return { schemaVersion: "1.0.0", runId: receipt.runId, stageId: receipt.plan.stages[0]!.stageId, expectedRevision: receipt.revision,
      state: "passed", executionContext: null, output: { schemaVersion: "1.0.0", kind: "output", output, error: null,
        artifacts: [{ artifactId, schemaId: "engineering-result/v1", locator: path.join(root, "result.json"), digest: digest(root, "result.json"), targetDigest: output.targetDigest, verified: true },
          { artifactId: "engineering-stage-bundle", schemaId: "engineering-stage-bundle/v1", locator: path.join(root, "stage-bundle.json"), digest: digest(root, "stage-bundle.json"), targetDigest: output.targetDigest, verified: true }] },
      evidence: [{ artifactId, kind: "file", locator: path.join(root, "result.json"), verified: true, note: "Actual local subprocess proof; packaging is synthetic, not host attestation." }],
      findings: [], blockers: [], error: null };
  };
  return { root, task, service, receipt, sync, stage };
}

test("selected test review records actual red/green and rechecks the current candidate on finalize", () => {
  const f = fixture(); const red = read(f.root, "evidence/red.json"), green = read(f.root, "evidence/green.json");
  expect(red.status).toBe("FAIL"); expect(green.status).toBe("PASS"); expect(red.argv).toEqual(green.argv);
  expect(red.snapshot.files.find((file: { path: string }) => file.path.endsWith("test.mjs")).digest)
    .toBe(green.snapshot.files.find((file: { path: string }) => file.path.endsWith("test.mjs")).digest);
  const recorded = f.service.recordStageResult(f.stage()); expect(recorded.error).toBeNull();
  expect(f.service.finalizeWorkflow(recorded.data!.runId, recorded.data!.revision).data?.state).toBe("passed");
});

for (const mutation of ["missing-bundle", "missing-requirement", "required-downgrade", "task-drift", "red-absent", "green-only", "timeout-red", "stale-candidate"]) {
  test(`record rejects ${mutation} without advancing the workflow`, () => {
    const f = fixture();
    if (mutation === "missing-requirement") { const p = read(f.root, "plan.json"); p.requirements = ["OTHER"]; p.cases[0].requirementIds = ["OTHER"]; write(f.root, "plan.json", p); }
    if (mutation === "required-downgrade") { const p = read(f.root, "plan.json"); p.cases[0].required = false; write(f.root, "plan.json", p); }
    if (mutation === "task-drift") { const task = read(f.root, "task.json"); task.objective += " changed"; write(f.root, "task.json", task); }
    if (["red-absent", "green-only"].includes(mutation)) { const p = read(f.root, "proof.json"); p.proofs[0].red = mutation === "green-only" ? p.proofs[0].green : { path: "missing.json", digest: digest(f.root, "result.json") }; write(f.root, "proof.json", p); }
    if (mutation === "timeout-red") { const red = read(f.root, "evidence/red.json"); red.status = "TIMED_OUT"; red.exitCode = null; red.signal = "SIGTERM"; delete red.digest; red.digest = convergenceDigest(red); write(f.root, "evidence/red.json", red); const p = read(f.root, "proof.json"); p.proofs[0].red.digest = digest(f.root, "evidence/red.json"); write(f.root, "proof.json", p); }
    if (mutation === "stale-candidate") writeFileSync(path.join(f.root, "sample/page.mjs"), "export function page() { return []; }\n");
    f.sync(); const stage = f.stage(); if (mutation === "missing-bundle") stage.output.artifacts.pop();
    const recorded = f.service.recordStageResult(stage); expect(recorded.ok).toBe(false);
    expect(f.service.getWorkflowStatus(f.receipt.runId).data!.revision).toBe(f.receipt.revision);
  });
}

test("finalize rejects a candidate changed after a valid stage was recorded", () => {
  const f = fixture(); const recorded = f.service.recordStageResult(f.stage()); expect(recorded.error).toBeNull();
  writeFileSync(path.join(f.root, "sample/page.mjs"), "changed after record\n");
  const finalized = f.service.finalizeWorkflow(recorded.data!.runId, recorded.data!.revision); expect(finalized.ok).toBe(false);
  expect(f.service.getWorkflowStatus(f.receipt.runId).data!.revision).toBe(recorded.data!.revision);
});

test("code review uses the same current raw request/report boundary", () => {
  const f = fixture("change-code-review"); const recorded = f.service.recordStageResult(f.stage()); expect(recorded.error).toBeNull();
  writeFileSync(path.join(f.root, "sample/page.mjs"), "stale reviewed candidate\n");
  expect(f.service.finalizeWorkflow(recorded.data!.runId, recorded.data!.revision).ok).toBe(false);
});

test("required NOT_RUN records blocked and prevents the following stage and finalization", () => {
  const f = fixture("test-sensitivity-review", true);
  const proof = read(f.root, "proof.json"); proof.proofs[0] = { caseId: "PAGE-1", status: "NOT_RUN", red: { path: "", digest: convergenceDigest("") },
    green: { path: "", digest: convergenceDigest("") }, mutationPaths: [], assertionWitness: "", reason: "Required execution is unavailable." };
  write(f.root, "proof.json", proof);
  const checked = spawnSync(process.execPath, [path.join(repo, "runtime/engineering-practices/cli.mjs"), "check-proof", "--root", f.root, "--plan", "plan.json", "--proof", "proof.json"], { encoding: "utf8" });
  expect(checked.status).toBe(1); expect(JSON.parse(checked.stdout).verdict).toBe("INCOMPLETE"); write(f.root, "result.json", JSON.parse(checked.stdout)); f.sync();
  const stage = f.stage(); stage.state = "blocked"; stage.error = { code: "MISSING_EVIDENCE", message: "Required proof not run", details: null }; stage.output.error = stage.error;
  const recorded = f.service.recordStageResult(stage); expect(recorded.error).toBeNull(); expect(recorded.data?.state).toBe("blocked");
  const following = { ...stage, stageId: recorded.data!.plan.stages[1]!.stageId, expectedRevision: recorded.data!.revision };
  expect(f.service.recordStageResult(following).ok).toBe(false);
  expect(f.service.finalizeWorkflow(recorded.data!.runId, recorded.data!.revision).ok).toBe(false);
});

test("file-backed engineering output follows the same raw bundle checks", () => {
  const f = fixture(); const stage = f.stage(); stage.outputFile = { locator: path.join(f.root, "result.json"), digest: digest(f.root, "result.json") }; stage.output.output = null;
  const recorded = f.service.recordStageResult(stage); expect(recorded.error).toBeNull();
  expect(f.service.finalizeWorkflow(recorded.data!.runId, recorded.data!.revision).data?.state).toBe("passed");
});
