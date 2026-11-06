import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = new URL("../../skills/acceptance-evidence-validator/scripts/cli.mjs", import.meta.url);
const validator = new URL("../../skills/acceptance-evidence-validator/scripts/validate-report.mjs", import.meta.url);
const idFor = (statement) => `AC-${createHash("sha256").update(statement, "utf8").digest("hex").slice(0, 12)}`;
const digest = (value) => {
  const canonical = (v) => v && typeof v === "object"
    ? Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
    : JSON.stringify(v);
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
};
const fixture = async (name = "passing") => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
function run(input, entry = cli) {
  const result = spawnSync(process.execPath, [fileURLToPath(entry)], {
    input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, AGENT_GOVERNANCE_LOCALE: "en" },
  });
  assert.equal(result.error, undefined);
  return { code: result.status, body: JSON.parse(result.stdout) };
}
function contentIds(input) {
  const ids = input.taskEnvelope.acceptanceCriteria.map(idFor);
  const translate = (id) => ids[Number(id.slice(3)) - 1];
  for (const evidence of input.evidence) evidence.criterionIds = evidence.criterionIds.map(translate);
  for (const command of input.verificationCommands) command.criterionIds = command.criterionIds.map(translate);
  return input;
}
function legacyBindings(input) {
  input.criterionBindings = input.taskEnvelope.acceptanceCriteria.map((statement, index) => ({ criterionId: `AC-${String(index + 1).padStart(3, "0")}`, statement }));
  return input;
}

test("E06-01/02/09 content IDs and evidence stay on the exact statement after reordering", async () => {
  const input = contentIds(await fixture());
  const original = run(input);
  assert.equal(original.code, 0);
  assert.equal(original.body.verdict, "PASS");
  assert.deepEqual(original.body.criteria.map((c) => c.criterionId), input.taskEnvelope.acceptanceCriteria.map(idFor));
  input.taskEnvelope.acceptanceCriteria.reverse();
  const reordered = run(input);
  assert.equal(reordered.body.verdict, "PASS");
  assert.deepEqual(reordered.body.criteria, [...original.body.criteria].reverse());
  const validation = {
    schemaVersion: "1.0.0", request: input,
    requestArtifact: { artifactId: "request", schemaId: "fixture/v1", locator: "artifact://request", digest: digest(input) },
    report: reordered.body,
  };
  assert.equal(run(validation, validator).body.valid, true);
  validation.report.criteria[0].statement = "replaced criterion";
  assert.equal(run(validation, validator).body.valid, false);
});

test("E06-03 deleting a middle criterion never shifts the remaining evidence", async () => {
  const input = contentIds(await fixture());
  input.verificationCommands = [];
  const third = "Third criterion remains the same.";
  input.taskEnvelope.acceptanceCriteria.push(third);
  input.evidence.push({ ...input.evidence[0], id: "third", criterionIds: [idFor(third)] });
  input.taskEnvelope.acceptanceCriteria.splice(1, 1);
  const stale = run(input);
  assert.equal(stale.code, 2);
  assert.equal(stale.body.error.code, "INVALID_INPUT");
  input.evidence.splice(1, 1);
  const report = run(input).body;
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.criteria.map((c) => c.evidenceRefs), [["test-pass"], ["third"]]);
});

test("E06-04 duplicates are rejected and whitespace changes require fresh evidence", async () => {
  const input = contentIds(await fixture());
  input.taskEnvelope.acceptanceCriteria[0] += " ";
  assert.equal(run(input).code, 2);
  input.evidence[0].criterionIds = [idFor(input.taskEnvelope.acceptanceCriteria[0])];
  input.verificationCommands[0].criterionIds = input.taskEnvelope.acceptanceCriteria.map(idFor);
  assert.equal(run(input).body.verdict, "PASS");
  input.taskEnvelope.acceptanceCriteria.push(input.taskEnvelope.acceptanceCriteria[0]);
  assert.equal(run(input).code, 2);
});

test("E06-05 unbound legacy input remains readable but cannot silently satisfy another statement", async () => {
  const input = await fixture();
  input.taskEnvelope.acceptanceCriteria.reverse();
  const result = run(input);
  assert.equal(result.code, 0);
  assert.equal(result.body.verdict, "BLOCKED");
  assert.ok(result.body.criteria.every((c) => c.status === "insufficient-evidence"));
  assert.ok(result.body.limitations.some((l) => /legacy|positional/iu.test(l)));
});

test("E06-06 legacy aliases migrate with the frozen exact statements, independent of order", async () => {
  const input = legacyBindings(await fixture());
  input.taskEnvelope.acceptanceCriteria.reverse();
  const report = run(input).body;
  assert.equal(report.verdict, "PASS");
  assert.deepEqual(report.criteria.map((c) => c.criterionId), input.taskEnvelope.acceptanceCriteria.map(idFor));
  assert.equal(report.criteria[0].evidenceRefs.includes("test-invalid"), true);
  assert.equal(report.criteria[0].evidenceRefs.includes("test-pass"), false);
});

for (const mutation of ["statement", "duplicate-id", "duplicate-statement"]) {
  test(`E06-07 invalid migration table: ${mutation}`, async () => {
    const input = legacyBindings(await fixture());
    if (mutation === "statement") input.criterionBindings[0].statement += " changed";
    if (mutation === "duplicate-id") input.criterionBindings[1].criterionId = input.criterionBindings[0].criterionId;
    if (mutation === "duplicate-statement") input.criterionBindings[1].statement = input.criterionBindings[0].statement;
    const result = run(input);
    assert.equal(result.code, 2);
    assert.equal(result.body.error.code, "INVALID_INPUT");
  });
}

test("E06-08 migration preserves authority digest validation and failed-command precedence", async () => {
  const waiver = legacyBindings(await fixture("not-applicable"));
  waiver.taskEnvelope.acceptanceCriteria.reverse();
  const report = run(waiver).body;
  assert.equal(report.verdict, "PASS");
  assert.equal(report.criteria[0].status, "not-applicable");
  const failure = legacyBindings(await fixture());
  failure.verificationCommands[0].exitCode = 1;
  assert.equal(run(failure).body.verdict, "FAIL");
});
