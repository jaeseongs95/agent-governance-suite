import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Ajv2020 } from "../../runtime/schema-validation.mjs";

const readJson = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const requestTemplate = await readJson("./fixtures/request.json");
const reportTemplate = await readJson("./fixtures/report.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateRequest = ajv.compile(await readJson("../../skills/ui-ux-design/contracts/ui-ux-design-request.v1.schema.json"));
const validateReport = ajv.compile(await readJson("../../skills/ui-ux-design/contracts/ui-ux-design-report.v1.schema.json"));
const fixture = () => structuredClone(reportTemplate);

function expectValid(report) {
  assert.equal(validateReport(report), true, ajv.errorsText(validateReport.errors));
}

function observedReport(status = "PASSED") {
  const report = fixture();
  report.mode = "review";
  report.deliverables[0].kind = "review";
  report.checks[0] = {
    id: "keyboard-01", kind: "interaction", scope: "Tab traversal and focus return for the session dialog",
    status, environment: "Synthetic Linux keyboard trace at fixture:session-list-design-r1",
    evidenceRefs: ["fixture:keyboard-trace-r1"], detail: "Declared trace for a contract test; not an actual UI execution.",
  };
  return report;
}

test("a new design accepts no prior screen or evidence without inventing a baseline", () => {
  assert.equal(validateRequest(requestTemplate), true, ajv.errorsText(validateRequest.errors));
  expectValid(fixture());
});

test("review input preserves Korean text, platform and authorization constraints", () => {
  const request = structuredClone(requestTemplate);
  request.mode = "review";
  request.objective = "한글 조합 중 Enter와 실제 전송을 구분한다.";
  request.evidenceRefs = ["fixture:composition-handler-r1"];
  assert.equal(validateRequest(request), true, ajv.errorsText(validateRequest.errors));
});

test("design completion can preserve explicit NOT_RUN checks and their limitations", () => {
  const report = fixture();
  expectValid(report);
  assert.equal(report.checks[0].status, "NOT_RUN");
});

test("completed review may report a real defect without claiming product acceptance", () => {
  const report = observedReport("FAILED");
  report.findings = [{
    id: "focus-return", severity: "major", target: "session-list", basis: "observed",
    evidenceRefs: ["fixture:keyboard-trace-r1"], observation: "The declared trace loses focus after closing the dialog.",
    impact: "The keyboard user cannot continue at the selected row.", recommendation: "Restore focus to the invoking control or the next logical target.",
  }];
  expectValid(report);
});

test("partial work retains deliverables while material missing input blocks completion", () => {
  const report = fixture();
  report.status = "NEEDS_INPUT";
  report.scope.notReviewed = ["session-detail"];
  report.limitations = ["The requested detail screen and designated test environment are unavailable."];
  expectValid(report);
  assert.equal(report.deliverables.length, 1);
});

test("outside-scope work returns an explicit no-op without invented UI results", () => {
  const report = fixture();
  report.status = "NOT_APPLICABLE";
  report.scope = { reviewed: [], notReviewed: ["backend-index"] };
  report.deliverables = [];
  report.checks[0].status = "NOT_APPLICABLE";
  report.checks[0].detail = "The request changes a backend index only.";
  report.limitations = [];
  expectValid(report);
});

test("an observed check requires explicit evidence and environment declarations", () => expectValid(observedReport()));

const invalidReports = [
  ["a product PASS status", (r) => { r.status = "PASS"; }],
  ["a release approval field", (r) => { r.releaseApproved = true; }],
  ["invented mutation authority", (r) => { r.authorization = { approved: true }; }],
  ["completion without a usable result", (r) => { r.deliverables = []; }],
  ["completion with an unreviewed target", (r) => { r.scope.notReviewed = ["session-detail"]; }],
  ["completion without reviewed scope", (r) => { r.scope.reviewed = []; }],
  ["a whitespace-only deliverable", (r) => { r.deliverables[0].content = " \n "; }],
  ["missing verification coverage", (r) => { r.checks = []; }],
  ["NOT_RUN without a limitation", (r) => { r.limitations = []; }],
  ["NOT_RUN with a fabricated run reference", (r) => { r.checks[0].evidenceRefs = ["fixture:old-pass"]; }],
  ["an unexplained nonexecution", (r) => { r.checks[0].detail = ""; }],
  ["an unknown check state", (r) => { r.checks[0].status = "SUCCESS_PROBABLY"; }],
  ["missing-input status without a reason", (r) => { r.status = "NEEDS_INPUT"; r.limitations = []; }],
  ["not-applicable status with a deliverable", (r) => { r.status = "NOT_APPLICABLE"; }],
];

for (const [name, mutate] of invalidReports) {
  test(`rejects ${name}`, () => {
    const report = fixture();
    mutate(report);
    assert.equal(validateReport(report), false, `The schema must reject ${name}.`);
  });
}

for (const status of ["PASSED", "FAILED"]) {
  test(`${status} cannot omit evidence`, () => {
    const report = observedReport(status);
    report.checks[0].evidenceRefs = [];
    assert.equal(validateReport(report), false);
  });
  test(`${status} cannot omit the observed environment`, () => {
    const report = observedReport(status);
    report.checks[0].environment = null;
    assert.equal(validateReport(report), false);
  });
}

for (const [name, mutate] of [
  ["unsupported implementation-phase mutation", (r) => { r.mode = "implement-and-deploy"; }],
  ["invented authorization", (r) => { r.approved = true; }],
  ["a targetless request", (r) => { r.targets = []; }],
  ["an unknown platform", (r) => { r.surface = "invented-host"; }],
]) {
  test(`request rejects ${name}`, () => {
    const request = structuredClone(requestTemplate);
    mutate(request);
    assert.equal(validateRequest(request), false);
  });
}

test("schema validation does not fetch evidence or assert cross-document identity", () => {
  const report = observedReport();
  report.requestId = "a-different-declared-request";
  report.checks[0].evidenceRefs = ["fixture:unobserved-synthetic-reference"];
  expectValid(report);
  // Identity, source existence and semantic truth belong to the caller's actual evidence review.
});
