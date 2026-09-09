import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { analyzeDiagnosis, checkInputDigest, clusterFailures, InputError, requestArtifactDigest, validateReport } from "../../skills/blocker-diagnostician/scripts/core.mjs";
import { compileAllSchemas } from "../../skills/blocker-diagnostician/scripts/schema-validation.mjs";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(testRoot, "..", "..", "skills", "blocker-diagnostician");
const fixture = async (name) => JSON.parse(await readFile(path.join(testRoot, "fixtures", `${name}.json`), "utf8"));
const validateBoundReport = (report, request) => validateReport(report, request, requestArtifactDigest(request));

test("normal: volatile tuple fields do not split the same failure", async () => {
  const input = await fixture("same-failure");
  const clusters = clusterFailures(input);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].episodeIds, ["attempt-1", "attempt-2"]);
  assert.equal(clusters[0].stableFailureTuple.timestamp, undefined);
});

test("normal: chooses the highest-information authorized discriminating test", async () => {
  const input = await fixture("same-failure");
  const report = analyzeDiagnosis(input);
  assert.equal(report.verdict, "NEXT_TEST");
  assert.equal(report.nextDiscriminatingTest.checkId, "read-cache-acl");
  assert.deepEqual(validateBoundReport(report, input), []);
});

test("boundary: same message in different environments stays separate", async () => {
  const clusters = clusterFailures(await fixture("similar-message"));
  assert.equal(clusters.length, 2);
});

test("normal: confirmed cause requires and preserves direct evidence", async () => {
  const report = analyzeDiagnosis(await fixture("confirmed"));
  assert.equal(report.verdict, "CAUSE_CONFIRMED");
  assert.deepEqual(report.confirmedCause.evidenceBindings.map((item) => item.evidenceRef), ["tool:file-stat"]);
});

test("boundary: an external check without approval is not selected as executable", async () => {
  const report = analyzeDiagnosis(await fixture("approval-needed"));
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.equal(report.nextDiscriminatingTest.checkId, "production-read");
});

test("authorization is explicit even for read-only checks", async () => {
  const input = await fixture("same-failure");
  input.authorization.allowedChecks = [];
  const report = analyzeDiagnosis(input);
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.equal(report.nextDiscriminatingTest.checkId, "read-cache-acl");
});

test("prohibited authorization overrides approval and allowed lists", async () => {
  const input = await fixture("same-failure");
  input.authorization.approvalRequired.push("read-cache-acl");
  input.authorization.prohibitedChecks.push("read-cache-acl");
  const report = analyzeDiagnosis(input);
  assert.equal(report.verdict, "NEEDS_INPUT");
  assert.equal(report.nextDiscriminatingTest, null);
  assert.ok(report.limitations.some((item) => item.includes("prohibited")));
});

test("expected failure: unchanged attempted check is not repeated", async () => {
  const report = analyzeDiagnosis(await fixture("duplicate-check"));
  assert.equal(report.verdict, "NEEDS_INPUT");
  assert.equal(report.nextDiscriminatingTest, null);
  assert.match(report.limitations[0], /Already attempted/u);
});

test("expected failure: non-discriminating outcomes are rejected", async () => {
  const input = await fixture("same-failure");
  input.candidateTests[0].outcomes[1] = structuredClone(input.candidateTests[0].outcomes[0]);
  assert.throws(() => analyzeDiagnosis(input), InputError);
});

test("report validator detects a repeated proposed test", async () => {
  const input = await fixture("same-failure");
  const report = analyzeDiagnosis(input);
  const check = structuredClone(report.nextDiscriminatingTest);
  delete check.inputDigest;
  input.attemptedChecks.push({ checkId: check.checkId, inputDigest: checkInputDigest(check), resultDigest: "result:new", check });
  assert.ok(validateBoundReport(report, input).some((item) => item.includes("repeats")));
});

test("JSON CLI accepts a Windows-style absolute path", async () => {
  const file = path.join(testRoot, "fixtures", "same-failure.json");
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "cli.mjs"), "--input", file], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).verdict, "NEXT_TEST");
});

test("JSON CLI reads stdin and writes only JSON", async () => {
  const input = await fixture("same-failure");
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(JSON.parse(run.stdout).verdict, "NEXT_TEST");
});

test("expected failure: contradicted cause cannot be confirmed", async () => {
  const input = await fixture("confirmed");
  input.candidateHypotheses[0].contradictingEvidence.push("tool:counterexample");
  assert.throws(() => analyzeDiagnosis(input), InputError);
});

test("expected failure: confirmed evidence must exist in the episode inventory", async () => {
  const input = await fixture("confirmed");
  input.candidateHypotheses[0].supportingEvidence = ["tool:fabricated"];
  assert.throws(() => analyzeDiagnosis(input), /outside the failure episode inventory/u);
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("input schema rejects omitted lastKnownGood and episode changeSummary", async () => {
  const missingLastKnownGood = await fixture("same-failure");
  delete missingLastKnownGood.lastKnownGood;
  assert.throws(() => analyzeDiagnosis(missingLastKnownGood), /FailureEpisodeSet.v1 validation failed/u);

  const missingChange = await fixture("same-failure");
  delete missingChange.episodes[0].changeSummary;
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(missingChange) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("input schema requires explicit canonical check input", async () => {
  const input = await fixture("same-failure");
  delete input.candidateTests[0].checkInput;
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "cli.mjs")], { encoding: "utf8", input: JSON.stringify(input) });
  assert.equal(run.status, 2);
  assert.equal(JSON.parse(run.stdout).error.code, "INVALID_INPUT");
});

test("report validator rechecks authorization and cluster fingerprints", async () => {
  const input = await fixture("same-failure");
  const report = analyzeDiagnosis(input);
  const prohibitedReport = structuredClone(report);
  prohibitedReport.nextDiscriminatingTest.checkId = "delete-cache";
  assert.ok(validateBoundReport(prohibitedReport, input).some((item) => item.includes("authorization")));

  input.authorization.prohibitedChecks.push("read-cache-acl");
  let errors = validateBoundReport(report, input);
  assert.ok(errors.some((item) => item.includes("authorization")));
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "validate-report.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ request: input, requestArtifactDigest: requestArtifactDigest(input), report })
  });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stdout).valid, false);

  const cleanInput = await fixture("same-failure");
  const forged = analyzeDiagnosis(cleanInput);
  forged.failureClusters[0].fingerprint = "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
  errors = validateBoundReport(forged, cleanInput);
  assert.ok(errors.some((item) => item.includes("fingerprints")));
});

test("report validation requires the original request and its external frozen digest", async () => {
  const request = await fixture("same-failure");
  const report = analyzeDiagnosis(request);
  const frozenDigest = requestArtifactDigest(request);

  assert.ok(validateReport(report, request).some((item) => item.includes("external frozen")));
  assert.ok(validateReport(report, null, frozenDigest).some((item) => item.includes("original request")));

  const forgedRequest = structuredClone(request);
  const forgedTest = forgedRequest.candidateTests[0];
  forgedTest.checkId = "delete-cache";
  forgedTest.risk = "destructive";
  forgedTest.inputDigest = checkInputDigest(forgedTest);
  forgedRequest.authorization.allowedChecks = ["delete-cache"];
  forgedRequest.authorization.prohibitedChecks = [];
  const forgedReport = analyzeDiagnosis(forgedRequest);
  const errors = validateReport(forgedReport, forgedRequest, frozenDigest);
  assert.ok(errors.some((item) => item.includes("does not match the external frozen")));

  const unauthorized = structuredClone(report);
  unauthorized.nextDiscriminatingTest.risk = "destructive";
  assert.ok(validateReport(unauthorized, request, frozenDigest).some((item) => item.includes("authorization")));
});

test("validate-report CLI rejects a request substituted after the artifact was frozen", async () => {
  const original = await fixture("same-failure");
  const frozenDigest = requestArtifactDigest(original);
  const substituted = structuredClone(original);
  substituted.authorization.allowedChecks = ["read-cache-acl", "delete-cache"];
  substituted.authorization.prohibitedChecks = [];
  const report = analyzeDiagnosis(substituted);
  const run = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "validate-report.mjs")], {
    encoding: "utf8",
    input: JSON.stringify({ request: substituted, requestArtifactDigest: frozenDigest, report })
  });
  assert.equal(run.status, 1);
  assert.ok(JSON.parse(run.stdout).errors.some((item) => item.includes("external frozen")));
});

test("attempted check digest is derived from the embedded canonical check", async () => {
  const input = await fixture("duplicate-check");
  input.attemptedChecks[0].inputDigest = `sha256:${"f".repeat(64)}`;
  assert.throws(() => analyzeDiagnosis(input), /canonical check content/u);

  const candidate = await fixture("same-failure");
  candidate.candidateTests[0].inputDigest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => analyzeDiagnosis(candidate), /canonical check content/u);
});

test("changing ranking metadata cannot disguise an unchanged check input", async () => {
  const input = await fixture("duplicate-check");
  input.candidateTests[0].informationGain = 5;
  input.candidateTests[0].cost = 5;
  input.candidateTests[0].question = "같은 대상의 ACL을 다른 표현으로 다시 확인한다.";
  input.candidateTests[0].inputDigest = checkInputDigest(input.candidateTests[0]);
  const report = analyzeDiagnosis(input);
  assert.equal(report.verdict, "NEEDS_INPUT");
  assert.equal(report.nextDiscriminatingTest, null);
  assert.match(report.limitations[0], /Already attempted/u);
});

test("confirmed cause rejects evidence bound to an unrelated hypothesis", async () => {
  const request = await fixture("confirmed");
  request.candidateHypotheses.push({
    id: "H2",
    causalLayer: "implementation",
    statement: "실행 코드가 잘못된 경로를 계산한다.",
    supportingEvidence: ["logs/one.txt"],
    contradictingEvidence: [],
    state: "supported"
  });
  request.evidenceBindings.push({
    evidenceRef: "logs/one.txt",
    artifactDigest: `sha256:${"2".repeat(64)}`,
    hypothesisIds: ["H2"],
    relation: "supports"
  });
  const report = analyzeDiagnosis(request);
  report.confirmedCause.evidenceBindings = [structuredClone(request.evidenceBindings[1])];
  const errors = validateBoundReport(report, request);
  assert.ok(errors.some((item) => item.includes("not bound to hypothesis H1")));
});

test("confirmed cause rejects an unreflected refuting evidence binding", async () => {
  const request = await fixture("confirmed");
  const cleanReport = analyzeDiagnosis(request);
  request.evidenceBindings.push({
    evidenceRef: "logs/one.txt",
    artifactDigest: request.evidenceBindings[0].artifactDigest,
    hypothesisIds: ["H1"],
    relation: "refutes",
  });

  assert.deepEqual(request.candidateHypotheses[0].contradictingEvidence, []);
  assert.throws(() => analyzeDiagnosis(request), /cannot have a refuting/u);
  const errors = validateBoundReport(cleanReport, request);
  assert.ok(errors.some((item) => item.includes("request cannot substantiate report")));
  assert.notDeepEqual(errors, []);

  const unreflectedSupport = await fixture("confirmed");
  unreflectedSupport.evidenceBindings.push({
    evidenceRef: "logs/one.txt",
    artifactDigest: unreflectedSupport.evidenceBindings[0].artifactDigest,
    hypothesisIds: ["H1"],
    relation: "supports",
  });
  assert.throws(() => analyzeDiagnosis(unreflectedSupport), /not reflected by hypothesis H1/u);
});

test("an outcome cannot both support and refute the same hypothesis", async () => {
  const input = await fixture("same-failure");
  input.candidateTests[0].outcomes[0].refutesHypotheses.push("H1");
  input.candidateTests[0].inputDigest = checkInputDigest(input.candidateTests[0]);
  assert.throws(() => analyzeDiagnosis(input), /both support and refute/u);
});

test("multiple confirmed hypotheses are rejected by the single-cause contract", async () => {
  const input = await fixture("confirmed");
  input.candidateHypotheses.push({
    id: "H2",
    causalLayer: "implementation",
    statement: "실행 코드가 잘못된 경로를 계산한다.",
    supportingEvidence: ["logs/one.txt"],
    contradictingEvidence: [],
    state: "confirmed"
  });
  input.evidenceBindings.push({
    evidenceRef: "logs/one.txt",
    artifactDigest: `sha256:${"2".repeat(64)}`,
    hypothesisIds: ["H2"],
    relation: "supports"
  });
  assert.throws(() => analyzeDiagnosis(input), /Only one confirmed hypothesis/u);
});

test("all JSON Schemas compile in strict Ajv mode", () => {
  assert.doesNotThrow(() => compileAllSchemas());
});

test("runtime scripts do not import Agent Governance Suite", async () => {
  const files = ["core.mjs", "cli.mjs", "cluster-failures.mjs", "validate-report.mjs"];
  for (const file of files) {
    const content = await readFile(path.join(skillRoot, "scripts", file), "utf8");
    assert.equal(content.includes("agent-governance-suite/"), false);
  }
});
