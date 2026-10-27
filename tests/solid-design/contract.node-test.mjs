import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { checkReport } from "../../skills/solid-design/scripts/check-report.mjs";

const request = {
  schemaVersion: "1.0.0", requestId: "solid-fixture-r1", objective: "Review cancellation semantics",
  snapshotRef: "fixture:cancel-r1", targets: ["adapter.ts", "caller.ts"],
  instructionRefs: ["fixture:instructions"], contractRefs: ["fixture:abort-contract"], priorFindingRefs: ["F-12"],
};
const bytes = Buffer.from(`${JSON.stringify(request, null, 2)}\n`);
const base = {
  schemaVersion: "1.0.0", requestId: request.requestId,
  requestDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  snapshotRef: request.snapshotRef, status: "ANALYZED", summary: "Cancellation behavior differs",
  principlesConsidered: ["LSP"], scope: { reviewed: request.targets, notReviewed: [] },
  findings: [{
    id: "S-1", kind: "contract-violation", principles: ["LSP"], target: "adapter.ts",
    evidenceRefs: ["fixture:adapter.ts:10", "fixture:caller.ts:20"], observation: "An error is converted to success",
    reasoning: "The caller records completion on success", contractRefs: ["fixture:abort-contract"],
    recommendation: "Preserve cancellation and error behavior", preserve: ["public API"],
    verificationNeeds: ["A cancelled request does not send or record completion"], relatedFindingRefs: ["F-12"],
  }], limitations: [], handoffs: [],
};

test("accepts a bound report without treating its violation as approval", () => {
  assert.deepEqual(checkReport(bytes, base), { valid: true, errors: [], validationScope: "schema-and-binding-only" });
});

const rejected = [
  ["candidate changed", (r) => { r.snapshotRef = "fixture:r2"; }, "snapshotRef mismatch"],
  ["request identity changed", (r) => { r.requestId = "different"; }, "requestId mismatch"],
  ["request bytes changed", (r) => { r.requestDigest = `sha256:${"0".repeat(64)}`; }, "requestDigest mismatch"],
  ["target omitted", (r) => { r.scope.reviewed = ["adapter.ts"]; }, "scope omits"],
  ["target duplicated across coverage", (r) => { r.scope.notReviewed = ["adapter.ts"]; }, "overlapping"],
  ["unrequested target", (r) => { r.scope.reviewed.push("outside.ts"); }, "undeclared"],
  ["finding on unreviewed source", (r) => { r.scope.reviewed = ["caller.ts"]; r.scope.notReviewed = ["adapter.ts"]; }, "was not reviewed"],
  ["unsupported principle claim", (r) => { r.findings[0].principles = ["DIP"]; }, "was not considered"],
  ["unbound contract", (r) => { r.findings[0].contractRefs = ["invented:contract"]; }, "not bound"],
  ["unbound prior finding", (r) => { r.findings[0].relatedFindingRefs = ["invented:finding"]; }, "not bound"],
  ["duplicate finding", (r) => { r.findings.push(structuredClone(r.findings[0])); }, "duplicate finding"],
  ["violation without contract", (r) => { r.findings[0].contractRefs = []; }, "report:"],
  ["unsupported approval field", (r) => { r.releaseApproved = true; }, "report:"],
  ["unknown pass status", (r) => { r.status = "PASS"; }, "report:"],
  ["empty analysis coverage", (r) => { r.scope.reviewed = []; r.scope.notReviewed = [...request.targets]; }, "report:"],
  ["missing evidence marked analysed", (r) => { r.status = "NEEDS_INPUT"; r.limitations = []; }, "report:"],
  ["not applicable with findings", (r) => { r.status = "NOT_APPLICABLE"; r.principlesConsidered = []; }, "report:"],
];
for (const [name, mutate, message] of rejected) {
  test(`rejects ${name}`, () => {
    const report = structuredClone(base);
    mutate(report);
    const result = checkReport(bytes, report);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.includes(message)), result.errors.join("\n"));
  });
}

test("accepts explicit missing evidence and preserves partial coverage", () => {
  const report = structuredClone(base);
  report.status = "NEEDS_INPUT";
  report.limitations = ["Consumer error contract unavailable"];
  report.findings = [];
  report.scope = { reviewed: ["adapter.ts"], notReviewed: ["caller.ts"] };
  assert.equal(checkReport(bytes, report).valid, true);
});

test("accepts no-op applicability outcome without creating design work", () => {
  const report = structuredClone(base);
  report.status = "NOT_APPLICABLE";
  report.principlesConsidered = [];
  report.findings = [];
  report.summary = "Wording-only correction";
  assert.equal(checkReport(bytes, report).valid, true);
});

test("rejects malformed input instead of accepting empty findings", () => {
  assert.equal(checkReport(Buffer.from("{"), base).valid, false);
});

test("classification binds current, distinct applicability and exclusion source spans", async () => {
  const skill = await readFile(new URL("../../skills/solid-design/SKILL.md", import.meta.url));
  const classification = JSON.parse(await readFile(new URL("../../skills/solid-design/classification.json", import.meta.url), "utf8"));
  const digest = `sha256:${createHash("sha256").update(skill).digest("hex")}`;
  const lines = skill.toString("utf8").split("\n");
  const spans = (entries) => entries.flatMap((entry) => {
    assert.equal(entry.digest, digest);
    assert.equal(entry.path, "skills/solid-design/SKILL.md");
    assert.ok(entry.startLine >= 1 && entry.endLine >= entry.startLine && entry.endLine <= lines.length);
    return Array.from({ length: entry.endLine - entry.startLine + 1 }, (_, i) => i + entry.startLine);
  });
  const positive = spans(classification.applicability);
  const negative = spans(classification.exclusions);
  assert.ok(positive.length && negative.length);
  assert.ok(!positive.some((line) => negative.includes(line)));
  assert.deepEqual(classification.dependencies, []);
});
