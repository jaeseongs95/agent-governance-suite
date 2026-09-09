import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isRepoRelativePosixPath, validateTaskContract } from "../../skills/task-contract/scripts/validate-task-contract.mjs";

const testsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const fixture = async (relative) => JSON.parse(await readFile(path.join(testsRoot, "fixtures", relative), "utf8"));
const clone = (value) => JSON.parse(JSON.stringify(value));

test("validates a read-only contract without mutation authority", async () => {
  const input = await fixture("normal/simple-read.json");
  const result = await validateTaskContract(input);
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.taskEnvelope.authorization.allowedActions, ["read repository files"]);
  assert.equal(result.taskEnvelope.workUnits.length, 0);
});

test("validates a high-risk contract while retaining deployment approval", async () => {
  const input = await fixture("boundary/high-risk.json");
  const result = await validateTaskContract(input);
  assert.equal(result.taskEnvelope.riskLevel, "high");
  assert.deepEqual(result.taskEnvelope.authorization.approvalRequired, ["deploy to production"]);
});

test("rejects included and excluded overlap", async () => {
  const input = await fixture("failure/conflicting.json");
  await assert.rejects(validateTaskContract(input), /Included and excluded scope/u);
});

test("rejects cyclic and missing work-unit dependencies", async () => {
  const base = await fixture("normal/simple-read.json");
  const cyclic = clone(base);
  cyclic.report.taskEnvelope.workUnits = [
    { id: "a", objective: "a", dependencies: ["b"], writeTargets: ["src/a.ts"] },
    { id: "b", objective: "b", dependencies: ["a"], writeTargets: ["src/b.ts"] },
  ];
  await assert.rejects(validateTaskContract(cyclic), /cycle/u);

  const missing = clone(base);
  missing.report.taskEnvelope.workUnits = [{ id: "a", objective: "a", dependencies: ["missing"], writeTargets: ["src/a.ts"] }];
  await assert.rejects(validateTaskContract(missing), /does not exist/u);
});

test("rejects Windows, absolute, traversal and glob write targets", () => {
  assert.equal(isRepoRelativePosixPath("src/app.ts"), true);
  assert.equal(isRepoRelativePosixPath("src/generated/"), true);
  for (const value of ["C:\\repo\\app.ts", "src\\app.ts", "/src/app.ts", "../app.ts", "src/*.ts", "src//app.ts", " src/app.ts"]) {
    assert.equal(isRepoRelativePosixPath(value), false, value);
  }
});

test("rejects overlapping included and excluded path subtrees", async () => {
  const input = await fixture("normal/simple-read.json");
  input.report.taskEnvelope.scope = { included: ["src/"], excluded: ["src/generated/"] };
  await assert.rejects(validateTaskContract(input), /path scope must not overlap/u);
});

test("requires a one-to-one exact acceptance evidence mapping", async () => {
  const input = await fixture("normal/simple-read.json");
  input.report.acceptanceEvidencePlan.criteria[0].statement = "[AC-001] Different statement.";
  await assert.rejects(validateTaskContract(input), /must match exactly/u);
});

test("rejects PASS with blocking uncertainty or material unconfirmed assumptions", async () => {
  const ambiguous = await fixture("normal/simple-read.json");
  ambiguous.report.ambiguities.push({ field: "/scope", question: "Which package?", blocking: true });
  await assert.rejects(validateTaskContract(ambiguous), /blocking ambiguity/u);

  const assumed = await fixture("normal/simple-read.json");
  assumed.report.assumptions.push({ statement: "Production is in scope.", impact: "material", confirmationRequired: true });
  await assert.rejects(validateTaskContract(assumed), /material assumption/u);
});

test("allows blocking uncertainty when verdict is NEEDS_INPUT", async () => {
  const input = await fixture("normal/simple-read.json");
  input.report.verdict = "NEEDS_INPUT";
  input.report.ambiguities.push({ field: "/scope", question: "Which package?", blocking: true });
  const result = await validateTaskContract(input);
  assert.equal(result.verdict, "NEEDS_INPUT");
});

test("requires provenance for objective, scope, risk and authorization", async () => {
  const input = await fixture("normal/simple-read.json");
  input.report.provenance = input.report.provenance.filter((item) => item.field !== "/authorization");
  await assert.rejects(validateTaskContract(input), /no provenance/u);
});

test("requires at least one instruction resolution reference", async () => {
  const input = await fixture("normal/simple-read.json");
  input.request.instructionResolutionRefs = [];
  await assert.rejects(validateTaskContract(input), /schema validation failed/u);
});

test("binds every authorization action to exact authority evidence", async () => {
  const missing = await fixture("normal/simple-read.json");
  missing.report.authorizationProvenance = missing.report.authorizationProvenance.filter((entry) => entry.action !== "read repository files");
  await assert.rejects(validateTaskContract(missing), /exactly one provenance binding/u);

  const mismatched = await fixture("normal/simple-read.json");
  mismatched.report.authorizationProvenance[0].sourceLocator = "invented-source";
  await assert.rejects(validateTaskContract(mismatched), /exactly one request authority record/u);
});

test("rejects permission expansion and project instruction grants", async () => {
  const expanded = await fixture("normal/simple-read.json");
  expanded.report.taskEnvelope.authorization.allowedActions.push("delete repository files");
  expanded.report.authorizationProvenance.push({
    action: "delete repository files",
    envelopeField: "/authorization/allowedActions",
    effect: "allow",
    authority: "user",
    sourceLocator: "user-request",
  });
  await assert.rejects(validateTaskContract(expanded), /request authority record/u);

  const projectGrant = await fixture("normal/simple-read.json");
  projectGrant.request.authorizationEvidence[0].authority = "project-instruction";
  projectGrant.report.authorizationProvenance[0].authority = "project-instruction";
  await assert.rejects(validateTaskContract(projectGrant), /cannot expand allowed actions/u);

  const omittedRestriction = await fixture("normal/simple-read.json");
  omittedRestriction.request.authorizationEvidence.push({
    action: "Delete Repository Files",
    effect: "prohibit",
    authority: "developer",
    sourceLocator: "developer-policy",
  });
  await assert.rejects(validateTaskContract(omittedRestriction), /cannot be omitted/u);
});

test("treats path scope case-insensitively under Windows semantics", async () => {
  const windows = await fixture("normal/simple-read.json");
  windows.report.taskEnvelope.scope = { included: ["Src/"], excluded: ["src/generated/"] };
  await assert.rejects(validateTaskContract(windows), /path scope must not overlap/u);

  const posix = await fixture("normal/simple-read.json");
  posix.request.pathSemantics = "posix";
  posix.report.taskEnvelope.scope = { included: ["Src/"], excluded: ["src/generated/"] };
  const result = await validateTaskContract(posix);
  assert.equal(result.verdict, "PASS");
});
