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

// AGS3-D-0037: the skill covers anything people see, understand and act on, not only screens.
const cases = await readJson("./cases.json");
const skillText = await readFile(new URL("../../skills/ui-ux-design/SKILL.md", import.meta.url), "utf8");
const classification = await readJson("../../skills/ui-ux-design/classification.json");
const descriptor = await readJson("../../skills/ui-ux-design/integration/skill-descriptor.json");
const verificationText = await readFile(new URL("../../skills/ui-ux-design/references/verification.md", import.meta.url), "utf8");
// A span selects its lines joined by "\n", then startByte..endByte (4.0.0: one description line holds both clauses).
const span = (group) => classification[group].map(({ startLine, endLine, startByte, endByte }) => {
  const block = Buffer.from(skillText.split(/\r?\n/u).slice(startLine - 1, endLine).join("\n"));
  return block.subarray(startByte ?? 0, endByte ?? block.length).toString("utf8");
}).join("\n");
const preconditions = descriptor.providers[0].preconditions.join("\n").toLowerCase();

for (const item of cases.selection.select) {
  test(`selection text names the medium of ${item.id}`, () => {
    for (const term of item.applicabilityTerms) assert.ok(span("applicability").includes(term), `applicability lacks ${term}`);
    for (const term of item.descriptorTerms) assert.ok(preconditions.includes(term), `descriptor preconditions lack ${term}`);
  });
}

for (const item of cases.selection.exclude) {
  test(`exclusion text keeps out ${item.id}`, () => {
    for (const term of item.exclusionTerms) assert.ok(span("exclusions").includes(term), `exclusions lack ${term}`);
  });
}

test("classification targets are not limited to screen interfaces", () => {
  const nonScreen = ["print-and-advertising", "video", "physical-space-and-signage", "physical-product", "service-process", "document-and-form"];
  for (const target of nonScreen) assert.ok(classification.targets.includes(target), `targets lack ${target}`);
});

test("the audience-fit check comes first and applies to every medium", () => {
  const sections = verificationText.split(/^## /mu).slice(1);
  assert.match(sections[0], /^대상 사용자에게 통하는지/u);
  assert.match(sections[0], /매체와 무관/u);
  const audience = skillText.indexOf("대상 사용자에게 통하는지");
  const screenOnly = skillText.indexOf("화면일 때");
  assert.ok(audience > 0 && screenOnly > audience, "SKILL.md must state the audience check before screen-only items");
  assert.ok(preconditions.includes("intended audience"), "descriptor preconditions lack the audience check");
});

test("request accepts non-screen media and still rejects an unknown medium", () => {
  for (const surface of ["web", "desktop", "mobile", "cross-platform", "print", "video", "physical-space", "physical-product", "service-process", "document", "multi-channel"]) {
    const request = structuredClone(requestTemplate);
    request.surface = surface;
    assert.equal(validateRequest(request), true, `${surface}: ${ajv.errorsText(validateRequest.errors)}`);
  }
  const request = structuredClone(requestTemplate);
  request.surface = "anything";
  assert.equal(validateRequest(request), false);
});

test("request and report keep their v1 required field names", async () => {
  const requestSchema = await readJson("../../skills/ui-ux-design/contracts/ui-ux-design-request.v1.schema.json");
  const reportSchema = await readJson("../../skills/ui-ux-design/contracts/ui-ux-design-report.v1.schema.json");
  assert.deepEqual(requestSchema.required, ["schemaVersion", "requestId", "mode", "objective", "snapshotRef", "surface", "targets", "constraints", "evidenceRefs"]);
  assert.deepEqual(reportSchema.required, ["schemaVersion", "requestId", "snapshotRef", "mode", "status", "summary", "scope", "deliverables", "findings", "checks", "limitations", "handoffs"]);
});

test("an observed audience check needs evidence and environment like any other check", () => {
  const report = observedReport();
  report.checks[0].kind = "audience";
  report.checks[0].scope = "Five target readers name the offer and the call to action after a five-second view of the print ad";
  expectValid(report);
  report.checks[0].evidenceRefs = [];
  assert.equal(validateReport(report), false);
});

test("schema validation does not fetch evidence or assert cross-document identity", () => {
  const report = observedReport();
  report.requestId = "a-different-declared-request";
  report.checks[0].evidenceRefs = ["fixture:unobserved-synthetic-reference"];
  expectValid(report);
  // Identity, source existence and semantic truth belong to the caller's actual evidence review.
});
