import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeAcceptance, InputError, sha256, validateReport } from "../../skills/acceptance-evidence-validator/scripts/core.mjs";
import { compileAllSchemas } from "../../skills/acceptance-evidence-validator/scripts/schema-validation.mjs";

const testRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(testRoot, "..", "..", "skills", "acceptance-evidence-validator");
const fixture = async (name) => JSON.parse(await readFile(path.join(testRoot, "fixtures", `${name}.json`), "utf8"));
const requestArtifact = (request) => ({
  artifactId: `acceptance-request:${request.taskEnvelope.taskId}`,
  schemaId: "https://agent-governance-skills.local/acceptance-evidence-validator/contracts/acceptance-evidence-input.v1.schema.json",
  locator: `artifact://acceptance-request/${request.taskEnvelope.taskId}`,
  digest: sha256(request),
});
const validation = (request, report) => ({ schemaVersion: "1.0.0", request, requestArtifact: requestArtifact(request), report });

test("normal: every criterion has current verified evidence", async () => {
  const input = await fixture("passing");
  const report = analyzeAcceptance(input);
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.criteria.map((item) => item.criterionId), ["AC-001", "AC-002"]);
  assert.deepEqual(validateReport(validation(input, report)), []);
});

test("boundary: stale evidence is not accepted for the current target", async () => {
  const report = analyzeAcceptance(await fixture("stale"));
  assert.equal(report.verdict, "BLOCKED");
  assert.equal(report.criteria[0].status, "insufficient-evidence");
  assert.match(report.limitations[0], /stale/u);
});

test("boundary: explicit not-applicable authority can complete a criterion", async () => {
  const report = analyzeAcceptance(await fixture("not-applicable"));
  assert.equal(report.verdict, "PASS");
  assert.equal(report.criteria[1].status, "not-applicable");
});

test("expected failure: an arbitrary authorityRef cannot waive a criterion", async () => {
  const input = await fixture("not-applicable");
  input.criterionOverrides[0].authorityRef = "caller-asserted-authority";
  assert.throws(() => analyzeAcceptance(input), /verified current authority evidence/u);
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("expected failure: authority evidence must be bound to the TaskEnvelope value", async () => {
  const input = await fixture("not-applicable");
  input.evidence.find((item) => item.id === "deployment-exclusion").digest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  assert.throws(() => analyzeAcceptance(input), /digest does not match TaskEnvelope/u);
});

test("expected failure: authority digest binds criterion IDs and target", async () => {
  const remapped = await fixture("not-applicable");
  remapped.evidence.find((item) => item.id === "deployment-exclusion").criterionIds = ["AC-001"];
  remapped.criterionOverrides = [{
    criterionId: "AC-001",
    status: "not-applicable",
    rationale: "재지정된 기준으로 우회를 시도한다.",
    authorityRef: "deployment-exclusion",
  }];
  assert.throws(() => analyzeAcceptance(remapped), /digest does not match TaskEnvelope/u);

  const retargeted = await fixture("not-applicable");
  const newDigest = "sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  retargeted.target.digest = newDigest;
  retargeted.evidence.find((item) => item.id === "deployment-exclusion").targetDigest = newDigest;
  assert.throws(() => analyzeAcceptance(retargeted), /digest does not match TaskEnvelope/u);
});

test("expected failure: verified refuting evidence produces FAIL", async () => {
  const report = analyzeAcceptance(await fixture("failing"));
  assert.equal(report.verdict, "FAIL");
  assert.equal(report.criteria[0].status, "unsatisfied");
});

test("expected failure: unknown criterion mapping is rejected", async () => {
  const input = await fixture("passing");
  input.evidence[0].criterionIds = ["AC-999"];
  assert.throws(() => analyzeAcceptance(input), InputError);
});

test("report validator enforces one-to-one criteria", async () => {
  const input = await fixture("passing");
  const report = analyzeAcceptance(input);
  report.criteria[0].statement = "weakened statement";
  assert.ok(validateReport(validation(input, report)).some((item) => item.includes("one-to-one")));
});

test("report validator rejects forged satisfied refs and an empty verified index", async () => {
  const input = await fixture("passing");
  const report = analyzeAcceptance(input);
  report.verifiedEvidenceIndex = [];
  report.criteria[0].evidenceRefs = ["forged-evidence"];
  const errors = validateReport(validation(input, report));
  assert.ok(errors.some((item) => item.includes("absent from verifiedEvidenceIndex")));
  assert.ok(errors.some((item) => item.includes("does not exactly match")));
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "validate-report.mjs")], {
    encoding: "utf8",
    input: JSON.stringify(validation(input, report))
  });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).valid, false);
});

test("verification commands affect the criterion verdict", async () => {
  const failed = await fixture("passing");
  failed.verificationCommands[0].exitCode = 1;
  assert.equal(analyzeAcceptance(failed).verdict, "FAIL");

  const stale = await fixture("passing");
  stale.verificationCommands[0].targetDigest = "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
  const staleReport = analyzeAcceptance(stale);
  assert.equal(staleReport.verdict, "BLOCKED");
  assert.ok(staleReport.criteria.every((item) => item.status === "insufficient-evidence"));
});

test("TaskEnvelope conflicts map to NEEDS_INPUT", async () => {
  const input = await fixture("passing");
  input.taskEnvelope.decision.hasConflicts = true;
  const report = analyzeAcceptance(input);
  assert.equal(report.verdict, "NEEDS_INPUT");
  assert.deepEqual(validateReport(validation(input, report)), []);
});

test("report validation requires the original request and frozen artifact digest", async () => {
  const input = await fixture("passing");
  const report = analyzeAcceptance(input);

  assert.ok(validateReport(report).some((item) => item.includes("validation input schema")));
  assert.ok(validateReport({ schemaVersion: "1.0.0", request: input, report }).some((item) => item.includes("validation input schema")));

  const wrongDigest = validation(input, report);
  wrongDigest.requestArtifact.digest = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  assert.ok(validateReport(wrongDigest).some((item) => item.includes("canonical frozen request")));

  const reportOnly = spawnSync(process.execPath, [path.join(root, "scripts", "validate-report.mjs")], {
    encoding: "utf8",
    input: JSON.stringify(report),
  });
  assert.equal(reportOnly.status, 1);
  assert.equal(JSON.parse(reportOnly.stdout).valid, false);
});

test("frozen request digest and request-derived report reject remapping", async () => {
  const input = await fixture("passing");
  const report = analyzeAcceptance(input);
  const frozen = validation(input, report);

  const changedRequest = globalThis.structuredClone(frozen);
  changedRequest.request.evidence[0].criterionIds = ["AC-002"];
  assert.ok(validateReport(changedRequest).some((item) => item.includes("canonical frozen request")));

  const changedReport = globalThis.structuredClone(frozen);
  changedReport.report.criteria.reverse();
  assert.ok(validateReport(changedReport).some((item) => item.includes("one-to-one")));
});

test("JSON CLI reads a Windows-style path argument", async () => {
  const file = path.join(testRoot, "fixtures", "passing.json");
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "cli.mjs"), "--input", file], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).verdict, "PASS");
});

test("JSON CLI reads stdin and writes only JSON", async () => {
  const input = await fixture("passing");
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).verdict, "PASS");
});

test("invalid TaskEnvelope graph returns structured INVALID_INPUT", async () => {
  const input = await fixture("passing");
  input.taskEnvelope.workUnits = [{ id: "one", objective: "invalid", dependencies: ["missing"], writeTargets: [] }];
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("input schema rejects a target kind outside the enum", async () => {
  const input = await fixture("passing");
  input.target.kind = "branch";
  const run = spawnSync(process.execPath, [path.join(root, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("all JSON Schemas compile in strict Ajv mode", () => {
  assert.doesNotThrow(() => compileAllSchemas());
});

test("vendored TaskEnvelope snapshot matches its lock", async () => {
  const lock = JSON.parse(await readFile(path.join(root, "contracts", "upstream", "lock.json"), "utf8"));
  const snapshot = await readFile(path.join(root, "contracts", "upstream", "task-envelope.v1.schema.json"));
  const digest = `sha256:${createHash("sha256").update(snapshot).digest("hex")}`;
  assert.equal(lock.files[0].sha256, digest);
  assert.equal(JSON.parse(snapshot).$id, lock.files[0].schemaId);
});

test("integration adapter is optional for direct CLI execution", async () => {
  const descriptor = path.join(root, "integration", "skill-descriptor.json");
  const input = await fixture("passing");
  assert.equal(analyzeAcceptance(input).verdict, "PASS");
  assert.ok((await readFile(descriptor, "utf8")).includes("acceptance-evidence-validation"));
});
