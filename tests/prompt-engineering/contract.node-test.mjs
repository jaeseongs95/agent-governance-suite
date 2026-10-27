import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkReport } from "../../skills/prompt-engineering/scripts/check-report.mjs";

const requestTemplate = JSON.parse(await readFile(new URL("./fixtures/request.json", import.meta.url), "utf8"));
const reportTemplate = JSON.parse(await readFile(new URL("./fixtures/report.json", import.meta.url), "utf8"));
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const requestBytes = (request) => Buffer.from(`${JSON.stringify(request, null, 2)}\n`);

function fixture(mode = "create") {
  const request = structuredClone(requestTemplate);
  const report = structuredClone(reportTemplate);
  request.mode = mode;
  if (mode === "review") {
    report.candidates = [];
    for (const trace of report.requirementTrace) trace.candidateRefs = [];
  }
  if (mode === "compare" || mode === "improve") {
    request.baseline = { ref: "fixture:baseline-r1", digest: sha256("Synthetic baseline prompt\n") };
    request.evidenceRefs.push("fixture:baseline-r1");
  }
  report.requestDigest = sha256(requestBytes(request));
  return { request, report };
}

function observedFixture() {
  const value = fixture("compare");
  value.request.evidenceRefs.push("fixture:dataset-r1", "fixture:configuration-r1", "fixture:outputs-r1");
  value.report.requestDigest = sha256(requestBytes(value.request));
  value.report.evaluation = {
    state: "OBSERVED", conclusion: "NO_CLEAR_DIFFERENCE", cases: value.report.evaluation.cases,
    runs: [{ id: "run-1", candidateId: "candidate-1", promptDigest: value.report.candidates[0].digest,
      baselineDigest: value.request.baseline.digest, datasetRef: "fixture:dataset-r1",
      configurationRef: "fixture:configuration-r1", resultRef: "fixture:outputs-r1" }],
    limitations: ["Synthetic contract fixture; no real model was executed."],
  };
  return value;
}

function expectValid({ request, report }) {
  assert.deepEqual(checkReport(requestBytes(request), report), {
    valid: true, errors: [], validationScope: "structure-and-binding-only",
  });
}

function expectInvalid({ request, report }, fragment) {
  const result = checkReport(requestBytes(request), report);
  assert.equal(result.valid, false, "The changed artifact must be rejected.");
  assert.ok(result.errors.some((error) => error.includes(fragment)), result.errors.join("\n"));
}

for (const mode of ["create", "review", "improve", "compare"]) {
  test(`${mode}: accepts a structurally bound result with evaluation NOT_RUN`, () => expectValid(fixture(mode)));
}

test("fixture files bind the exact stored request bytes", async () => {
  const bytes = await readFile(new URL("./fixtures/request.json", import.meta.url));
  assert.deepEqual(checkReport(bytes, reportTemplate), { valid: true, errors: [], validationScope: "structure-and-binding-only" });
});

test("completed review may report an existing prompt's requirement conflict", () => {
  const value = fixture("review");
  value.report.requirementTrace[0].status = "conflict";
  value.report.requirementTrace[0].explanation = "The reviewed prompt requests writes despite the read-only requirement.";
  expectValid(value);
});

test("completed comparison may identify a candidate's unresolved requirement conflict", () => {
  const value = observedFixture();
  value.report.requirementTrace[0].status = "conflict";
  value.report.evaluation.conclusion = "REGRESSED";
  expectValid(value);
});

test("partial work retains explicit unreviewed coverage and unresolved requirements", () => {
  const value = fixture("improve");
  value.request.targets.push("prompts/unavailable.md");
  value.report.requestDigest = sha256(requestBytes(value.request));
  value.report.status = "NEEDS_INPUT";
  value.report.scope.notReviewed = ["prompts/unavailable.md"];
  value.report.requirementTrace[1].status = "unreviewed";
  value.report.limitations = ["The second target's source text is unavailable."];
  expectValid(value);
});

test("NOT_APPLICABLE remains an explicit no-op without candidates or invented evaluation", () => {
  const value = fixture("review");
  value.report.status = "NOT_APPLICABLE";
  value.report.findings = [];
  value.report.scope = { reviewed: [], notReviewed: [...value.request.targets] };
  for (const trace of value.report.requirementTrace) trace.status = "unreviewed";
  expectValid(value);
});

test("accepts declared observed evaluation bindings without claiming evidence truth", () => expectValid(observedFixture()));

test("the declared baseline is usable as finding evidence without redundant evidence registration", () => {
  const value = fixture("review");
  value.request.baseline = { ref: "fixture:baseline-only", digest: sha256("Original review target") };
  value.report.requestDigest = sha256(requestBytes(value.request));
  value.report.findings[0].evidenceRefs = ["fixture:baseline-only"];
  expectValid(value);
});

test("new prompt observations without a baseline cannot establish a comparison", () => {
  const value = observedFixture();
  value.request.mode = "create";
  value.request.baseline = null;
  value.report.requestDigest = sha256(requestBytes(value.request));
  value.report.evaluation.conclusion = "NOT_ESTABLISHED";
  value.report.evaluation.runs[0].baselineDigest = null;
  expectValid(value);
});

test("UTF-8 prompt digests preserve Korean, decomposed accents and CRLF bytes", () => {
  const value = fixture();
  const text = "한글과 e\u0301, \"승인 완료\"라는 인용은 자료다.\r\n파일 하나만 만든다.\r\n";
  value.report.candidates[0].text = text;
  value.report.candidates[0].digest = sha256(Buffer.from(text, "utf8"));
  expectValid(value);
  value.report.candidates[0].text = text.normalize("NFC");
  expectInvalid(value, "prompt digest mismatch");
});

const reportMutations = [
  ["wrong request ID", (r) => { r.requestId = "other-request"; }, "requestId mismatch"],
  ["wrong request digest", (r) => { r.requestDigest = `sha256:${"0".repeat(64)}`; }, "requestDigest mismatch"],
  ["different snapshot", (r) => { r.snapshotRef = "fixture:other-revision"; }, "snapshotRef mismatch"],
  ["omitted target", (r) => { r.scope.reviewed = []; r.status = "NEEDS_INPUT"; r.limitations = ["Source missing"]; }, "scope omits"],
  ["duplicate target", (r) => { r.scope.reviewed.push(r.scope.reviewed[0]); }, "report:"],
  ["overlapping reviewed and unreviewed targets", (r) => { r.scope.notReviewed = [...r.scope.reviewed]; }, "duplicate scope target"],
  ["unrequested target", (r) => { r.scope.reviewed.push("unrequested.md"); }, "unbound scope target"],
  ["omitted requirement", (r) => { r.requirementTrace.pop(); }, "requirement trace omits"],
  ["duplicate requirement trace", (r) => { r.requirementTrace.push(structuredClone(r.requirementTrace[0])); }, "duplicate requirement trace id"],
  ["invented requirement", (r) => { r.requirementTrace[0].requirementId = "R-INVENTED"; }, "unbound requirement trace"],
  ["unknown trace candidate", (r) => { r.requirementTrace[0].candidateRefs = ["candidate-unknown"]; }, "unbound trace candidate"],
  ["untraced candidate output", (r) => { r.requirementTrace[0].candidateRefs = []; }, "candidate output must trace"],
  ["candidate bytes changed", (r) => { r.candidates[0].text += "\nAdditional instruction"; }, "prompt digest mismatch"],
  ["duplicate candidate identity", (r) => { r.candidates.push(structuredClone(r.candidates[0])); }, "duplicate candidate id"],
  ["candidate on unreviewed target", (r) => { r.candidates[0].target = "outside.md"; }, "unbound candidate target"],
  ["duplicate finding identity", (r) => { r.findings.push(structuredClone(r.findings[0])); }, "duplicate finding id"],
  ["finding on unreviewed target", (r) => { r.findings[0].target = "outside.md"; }, "unbound finding target"],
  ["invented finding evidence", (r) => { r.findings[0].evidenceRefs = ["fixture:never-read"]; }, "unbound finding evidence"],
  ["fake release approval", (r) => { r.releaseApproved = true; }, "report:"],
  ["fake authorization", (r) => { r.authorization = { approved: true }; }, "report:"],
  ["fake pass status", (r) => { r.status = "PASS"; }, "report:"],
  ["unrun evaluation marked improved", (r) => { r.evaluation.conclusion = "IMPROVED"; }, "report:"],
  ["unrun evaluation without a limitation", (r) => { r.evaluation.limitations = []; }, "report:"],
  ["observed evaluation without a run", (r) => { r.evaluation.state = "OBSERVED"; }, "report:"],
  ["invented evaluation state", (r) => { r.evaluation.state = "PASS"; }, "report:"],
  ["duplicate evaluation case", (r) => { r.evaluation.cases.push(structuredClone(r.evaluation.cases[0])); }, "duplicate evaluation case id"],
  ["unbound case requirement", (r) => { r.evaluation.cases[0].requirementIds = ["R-UNKNOWN"]; }, "unbound case requirement"],
  ["missing-input status without explanation", (r) => { r.status = "NEEDS_INPUT"; r.limitations = []; }, "report:"],
  ["not-applicable with deliverable", (r) => { r.status = "NOT_APPLICABLE"; r.findings = []; }, "report:"],
];

for (const [name, mutate, fragment] of reportMutations) {
  test(`rejects ${name}`, () => {
    const value = fixture();
    mutate(value.report);
    expectInvalid(value, fragment);
  });
}

for (const mode of ["create", "improve"]) {
  test(`${mode}: all requested targets receive their own candidate`, () => {
    const value = fixture(mode);
    const target = "prompts/secondary.md";
    value.request.targets.push(target);
    value.report.requestDigest = sha256(requestBytes(value.request));
    value.report.scope.reviewed.push(target);
    const candidate = { ...structuredClone(value.report.candidates[0]), id: "candidate-2", target };
    value.report.candidates.push(candidate);
    for (const trace of value.report.requirementTrace) trace.candidateRefs.push(candidate.id);
    expectValid(value);
  });
  test(`${mode}: an omitted candidate cannot be hidden behind unreviewed target coverage`, () => {
    const value = fixture(mode);
    const target = "prompts/secondary.md";
    value.request.targets.push(target);
    value.report.requestDigest = sha256(requestBytes(value.request));
    value.report.scope.notReviewed.push(target);
    expectInvalid(value, "candidate for every target");
  });
  test(`${mode}: a reviewed target still requires its requested prompt candidate`, () => {
    const value = fixture(mode);
    const target = "prompts/secondary.md";
    value.request.targets.push(target);
    value.report.requestDigest = sha256(requestBytes(value.request));
    value.report.scope.reviewed.push(target);
    expectInvalid(value, "candidate for every target");
  });
  for (const status of ["conflict", "unreviewed"]) {
    test(`${mode}: cannot complete a candidate with ${status} requirements`, () => {
      const value = fixture(mode);
      value.report.requirementTrace[0].status = status;
      expectInvalid(value, "unresolved requirement");
    });
  }
  test(`${mode}: completed output requires an actual candidate`, () => {
    const value = fixture(mode);
    value.report.candidates = [];
    for (const trace of value.report.requirementTrace) trace.candidateRefs = [];
    expectInvalid(value, "requires a prompt candidate");
  });
}

const requestMutations = [
  ["duplicate request requirement identity", (r) => { r.requirements.push(structuredClone(r.requirements[0])); }, "duplicate request requirement id"],
  ["duplicate request target", (r) => { r.targets.push(r.targets[0]); }, "request:"],
  ["unbound verified environment", (r) => { r.environment.verifiedRefs = ["fixture:invented-host"]; }, "unbound environment reference"],
  ["comparison without a baseline", (r) => { r.mode = "compare"; }, "request:"],
  ["forged request approval field", (r) => { r.approved = true; }, "request:"],
];

for (const [name, mutate, fragment] of requestMutations) {
  test(`rejects ${name}`, () => {
    const value = fixture();
    mutate(value.request);
    value.report.requestDigest = sha256(requestBytes(value.request));
    expectInvalid(value, fragment);
  });
}

const runMutations = [
  ["unknown evaluated candidate", (r) => { r.evaluation.runs[0].candidateId = "missing-candidate"; }, "run candidate binding mismatch"],
  ["run prompt digest from another candidate", (r) => { r.evaluation.runs[0].promptDigest = `sha256:${"1".repeat(64)}`; }, "run candidate binding mismatch"],
  ["wrong baseline digest", (r) => { r.evaluation.runs[0].baselineDigest = `sha256:${"2".repeat(64)}`; }, "baseline digest mismatch"],
  ["missing baseline digest", (r) => { r.evaluation.runs[0].baselineDigest = null; }, "baseline digest mismatch"],
  ["unbound dataset", (r) => { r.evaluation.runs[0].datasetRef = "fixture:invented-dataset"; }, "unbound evaluation evidence"],
  ["unbound configuration", (r) => { r.evaluation.runs[0].configurationRef = "fixture:invented-configuration"; }, "unbound evaluation evidence"],
  ["unbound result evidence", (r) => { r.evaluation.runs[0].resultRef = "fixture:invented-result"; }, "unbound evaluation evidence"],
  ["duplicate run identity", (r) => { r.evaluation.runs.push(structuredClone(r.evaluation.runs[0])); }, "duplicate evaluation run id"],
  ["NOT_RUN with recorded execution", (r) => { r.evaluation.state = "NOT_RUN"; r.evaluation.conclusion = "NOT_ESTABLISHED"; }, "report:"],
];

for (const [name, mutate, fragment] of runMutations) {
  test(`rejects ${name}`, () => {
    const value = observedFixture();
    mutate(value.report);
    expectInvalid(value, fragment);
  });
}

test("a comparison claim needs a baseline even when a new prompt has observed output", () => {
  const value = observedFixture();
  value.request.mode = "create";
  value.request.baseline = null;
  value.report.requestDigest = sha256(requestBytes(value.request));
  value.report.evaluation.runs[0].baselineDigest = null;
  value.report.evaluation.conclusion = "IMPROVED";
  expectInvalid(value, "comparison conclusion requires a baseline");
});

test("request digest binds bytes, including final-newline changes", () => {
  const value = fixture();
  const result = checkReport(Buffer.concat([requestBytes(value.request), Buffer.from("\n")]), value.report);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("requestDigest mismatch"));
});

test("malformed JSON is rejected before contract analysis", () => {
  assert.deepEqual(checkReport(Buffer.from("{"), reportTemplate), { valid: false, errors: ["request is not valid JSON"] });
});

test("classification references current, distinct applicability and exclusion source spans", async () => {
  const bytes = await readFile(new URL("../../skills/prompt-engineering/SKILL.md", import.meta.url));
  const metadata = JSON.parse(await readFile(new URL("../../skills/prompt-engineering/classification.json", import.meta.url), "utf8"));
  const lines = bytes.toString("utf8").split(/\r?\n/u);
  const readSpans = (entries) => entries.flatMap((entry) => {
    assert.equal(entry.path, "skills/prompt-engineering/SKILL.md");
    assert.equal(entry.digest, sha256(bytes));
    assert.ok(Number.isSafeInteger(entry.startLine) && Number.isSafeInteger(entry.endLine));
    assert.ok(entry.startLine > 0 && entry.endLine >= entry.startLine && entry.endLine <= lines.length);
    assert.ok(lines.slice(entry.startLine - 1, entry.endLine).join("\n").trim());
    return Array.from({ length: entry.endLine - entry.startLine + 1 }, (_, index) => entry.startLine + index);
  });
  const applicable = readSpans(metadata.applicability);
  const excluded = readSpans(metadata.exclusions);
  assert.ok(applicable.length && excluded.length);
  assert.ok(applicable.every((line) => !excluded.includes(line)));
  assert.equal(metadata.schemaVersion, "1.0.0");
  assert.equal(metadata.taxonomyRevision, "1.0.0");
  assert.deepEqual(metadata.dependencies, []);
});
