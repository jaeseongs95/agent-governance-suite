import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { validateMutationIntent } from "../../skills/mutation-risk-preflight/scripts/schema-validation.mjs";

const now = "2017-01-01T00:00:00.000Z";
const leapSecond = "2016-12-31T23:59:60Z";
async function intent(expiresAt) {
  const input = JSON.parse(await readFile(new URL("./fixtures/local-delete/intent.json", import.meta.url), "utf8"));
  input.approvalEvidenceRefs[0].expiresAt = expiresAt;
  return input;
}
function evaluate(input) {
  // RFC3339 validation remains the common schema's job; executable expiry is the evaluator's.
  assert.equal(validateMutationIntent(input), true, "D0220 must not be fixed by narrowing the common date-time schema");
  return evaluatePreflight(input, {now});
}

test("D0220: a schema-valid leap-second expiry cannot become an observed approval", async () => {
  const report = evaluate(await intent(leapSecond));
  assert.equal(report.verdict, "NEEDS_APPROVAL");
  assert.equal(report.approval.status, "stale");
  assert.equal(report.checks.find(check => check.checkId === "approval").state, "unknown");
});

for (const [expiresAt, status, verdict] of [
  ["2016-12-31T23:59:59Z", "stale", "NEEDS_APPROVAL"],
  ["2017-01-01T00:00:00Z", "stale", "NEEDS_APPROVAL"],
  ["2017-01-01T00:00:01Z", "observed", "READY"],
  ["2017-01-01T01:00:00+01:00", "stale", "NEEDS_APPROVAL"],
  ["2017-01-01T01:00:01+01:00", "observed", "READY"],
  ["2016-12-31T19:00:00-05:00", "stale", "NEEDS_APPROVAL"],
  ["2016-12-31T19:00:01-05:00", "observed", "READY"],
]) {
  test(`D0220: preserves absolute expiry boundary ${expiresAt}`, async () => {
    const report = evaluate(await intent(expiresAt));
    assert.equal(report.approval.status, status); assert.equal(report.verdict, verdict);
  });
}

for (const invalidFirst of [true, false]) {
  test(`D0220: a separate usable matching approval remains sufficient (invalid first: ${invalidFirst})`, async () => {
    const input = await intent(leapSecond), unusable = input.approvalEvidenceRefs[0];
    const usable = {...unusable, locator: "evidence://approval/usable-expiry", expiresAt: "2017-01-01T00:00:01Z"};
    input.approvalEvidenceRefs = invalidFirst ? [unusable, usable] : [usable, unusable];
    const report = evaluate(input);
    assert.equal(report.verdict, "READY");
    assert.deepEqual(report.approval, {required: true, status: "observed", evidenceRefs: [usable.locator]});
  });
}

test("D0220: a future expiry on a mismatched operation cannot rescue the unusable matching approval", async () => {
  const input = await intent(leapSecond), matching = input.approvalEvidenceRefs[0];
  input.approvalEvidenceRefs.push({...matching, operationId: "different-operation", expiresAt: "2017-01-01T00:00:01Z"});
  const report = evaluate(input);
  assert.equal(report.verdict, "NEEDS_APPROVAL"); assert.equal(report.approval.status, "stale");
});
