import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson, evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";
import { validateMutationIntent, validateMutationReport } from "../../skills/mutation-risk-preflight/scripts/schema-validation.mjs";

const now = "2026-09-09T00:00:00.000Z";
const hash = value => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

function intent() {
  const input = JSON.parse(readFileSync(new URL("./fixtures/local-delete/intent.json", import.meta.url)));
  input.operationId = "create-isolated-resources";
  input.actionClass = "permission-change";
  input.targets = [{ locator: "resource://isolated/new-role", targetType: "resource", environment: "isolated-test", expectedFingerprint: hash("absent") }];
  input.plannedCommandOrTool = { tool: "resource-manager", action: "guard identity and absence; create only new resource; stop and preserve on failure" };
  const locators = input.targets.map(target => target.locator);
  input.scopeRef.includedTargets = locators;
  input.authorizationRef.allowedActions = [input.actionClass];
  input.authorizationRef.allowedTargets = locators;
  input.authorizationRef.environments = ["isolated-test"];
  input.approvalEvidenceRefs = [{ ...input.approvalEvidenceRefs[0], operationId: input.operationId, actionClass: input.actionClass, targetLocators: locators, environments: ["isolated-test"] }];
  input.currentStateEvidenceRefs = [{ locator: "evidence://absent-state", digest: hash("observation"), targetLocator: locators[0], fingerprint: input.targets[0].expectedFingerprint, existence: "absent" }];
  input.recoveryPlan = { available: true, method: "stop and preserve partial new resources", backupRef: null, restoreProcedureRef: "evidence://stop-preserve-procedure", restoreTestEvidenceRef: null, irreversibilityAccepted: false };
  input.expectedBlastRadius = { affectedTargets: 1, affectedUsers: 0, external: false, description: "new isolated resource only" };
  input.recoveryPlan.freshResourceContainment = {
    commandDigest: hash(input.plannedCommandOrTool), targetDigest: evaluatePreflight(input, { now }).targetDigest,
    guardEvidenceRef: { locator: "evidence://verified-create-only-guard", digest: hash("source guard evidence") }, partialFailure: "stop-preserve",
  };
  return input;
}

test("fresh additive permission change uses containment without inventing backup, restore or user approval", () => {
  const input = intent(), report = evaluatePreflight(input, { now });
  assert.equal(validateMutationIntent(input), true);
  assert.equal(validateMutationReport(report), true);
  assert.equal(report.verdict, "READY");
  assert.equal(report.classification.permissionImpact, true);
  assert.equal(report.classification.reversibility, "conditional");
  assert.equal(report.approval.required, true);
  assert.equal(report.approval.status, "observed");
  assert.equal(report.recovery.restoreTested, false);
  assert.equal(report.recovery.irreversibilityAccepted, false);
  assert.match(report.checks.find(check => check.checkId === "recovery").message, /중단·보존/);
  assert.equal(verifyReceipt({ report, intent: input, verificationTime: now }).valid, true);
});

test("method text alone still fails recovery and existing restoration path remains usable", () => {
  const input = intent();
  delete input.recoveryPlan.freshResourceContainment;
  assert.equal(evaluatePreflight(input, { now }).verdict, "NEEDS_REDESIGN");
  input.recoveryPlan.backupRef = "evidence://backup";
  input.recoveryPlan.restoreTestEvidenceRef = "evidence://restore-test";
  const report = evaluatePreflight(input, { now });
  assert.equal(report.verdict, "READY");
  assert.equal(report.recovery.restoreTested, true);
});

for (const [name, mutate, verdict] of [
  ["present target", value => { value.currentStateEvidenceRefs[0].existence = "present"; }, "NEEDS_REDESIGN"],
  ["unknown target", value => { value.currentStateEvidenceRefs[0].existence = "unknown"; }, "NEEDS_REDESIGN"],
  ["undeclared absence", value => { delete value.currentStateEvidenceRefs[0].existence; }, "NEEDS_REDESIGN"],
  ["conflicting observation", value => { value.currentStateEvidenceRefs.push({ ...value.currentStateEvidenceRefs[0], existence: "present" }); }, "NEEDS_REDESIGN"],
  ["missing current state", value => { value.currentStateEvidenceRefs = []; }, "NEEDS_INPUT"],
  ["mismatched fingerprint", value => { value.currentStateEvidenceRefs[0].fingerprint = hash("changed"); }, "NEEDS_INPUT"],
  ["changed command", value => { value.plannedCommandOrTool.action += "; change existing state"; }, "NEEDS_REDESIGN"],
  ["changed target digest", value => { value.recoveryPlan.freshResourceContainment.targetDigest = hash("other"); }, "NEEDS_REDESIGN"],
  ["missing guard evidence", value => { delete value.recoveryPlan.freshResourceContainment.guardEvidenceRef; }, "BLOCKED"],
  ["empty failure procedure", value => { value.recoveryPlan.restoreProcedureRef = " "; }, "NEEDS_REDESIGN"],
  ["automatic rerun", value => { value.recoveryPlan.freshResourceContainment.partialFailure = "retry"; }, "BLOCKED"],
  ["missing approval", value => { value.approvalEvidenceRefs = []; }, "NEEDS_APPROVAL"],
  ["authority mismatch", value => { value.authorizationRef.allowedActions = ["read"]; }, "BLOCKED"],
  ["excluded target", value => { value.scopeRef.excludedTargets = [value.targets[0].locator]; }, "BLOCKED"],
  ["external impact", value => { value.expectedBlastRadius.external = true; }, "NEEDS_REDESIGN"],
  ["production environment", value => { value.targets[0].environment = "production"; value.authorizationRef.environments = ["production"]; value.approvalEvidenceRefs[0].environments = ["production"]; }, "NEEDS_REDESIGN"],
  ["claimed restore test", value => { value.recoveryPlan.restoreTestEvidenceRef = "evidence://unrelated-restore"; }, "READY"],
]) {
  test(`containment boundary: ${name}`, () => {
    const input = intent(); mutate(input);
    const report = evaluatePreflight(input, { now });
    assert.equal(report.verdict, verdict);
    if (verdict === "READY") assert.equal(report.recovery.restoreTested, false);
  });
}

for (const actionClass of ["delete", "overwrite", "migrate", "move", "billing", "global-config", "publish"]) {
  test(`containment does not bypass recovery for ${actionClass}`, () => {
    const input = intent();
    input.actionClass = actionClass;
    input.authorizationRef.allowedActions = [actionClass];
    input.approvalEvidenceRefs[0].actionClass = actionClass;
    assert.equal(evaluatePreflight(input, { now }).verdict, "NEEDS_REDESIGN");
  });
}

test("receipt binds absence semantics, guard proof, command and failure policy; report tampering is rejected", () => {
  const input = intent(), report = evaluatePreflight(input, { now });
  for (const mutate of [
    value => { value.currentStateEvidenceRefs[0].existence = "present"; },
    value => { value.recoveryPlan.freshResourceContainment.guardEvidenceRef.digest = hash("different proof"); },
    value => { value.recoveryPlan.freshResourceContainment.guardEvidenceRef.locator = "evidence://other"; },
    value => { value.recoveryPlan.freshResourceContainment.partialFailure = "retry"; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.equal(verifyReceipt({ report, intent: changed, verificationTime: now }).valid, false);
  }
  const forged = structuredClone(report);
  forged.recovery.restoreTested = true;
  assert.equal(verifyReceipt({ report: forged, intent: input, verificationTime: now }).valid, false);
});

test("common evaluator and verifier CLIs accept the scoped contract without dependencies or remote writes", () => {
  const input = intent();
  input.approvalEvidenceRefs[0].expiresAt = new Date(Date.now() + 60_000).toISOString();
  const run = (script, value) => spawnSync(process.execPath, [fileURLToPath(new URL(`../../skills/mutation-risk-preflight/scripts/${script}`, import.meta.url))], { input: JSON.stringify(value), encoding: "utf8" });
  const evaluated = run("evaluate-preflight.mjs", input);
  assert.equal(evaluated.status, 0, evaluated.stderr);
  const report = JSON.parse(evaluated.stdout);
  const verified = run("verify-preflight-receipt.mjs", { intent: input, report, verificationTime: report.observedAt });
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).valid, true);
});
