import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { canonicalJson, evaluatePreflight } from "../../skills/mutation-risk-preflight/scripts/evaluate-preflight.mjs";
import { verifyReceipt } from "../../skills/mutation-risk-preflight/scripts/verify-preflight-receipt.mjs";
import { validateMutationIntent, validateMutationReport } from "../../skills/mutation-risk-preflight/scripts/schema-validation.mjs";

const now = "2026-09-09T00:00:00.000Z";
const hash = value => `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;

function intent(environment = "external", actionClass = "deploy") {
  const input = JSON.parse(readFileSync(new URL("./fixtures/local-delete/intent.json", import.meta.url)));
  input.operationId = "prepare-private-external-resource";
  input.actionClass = actionClass;
  input.targets = [{ locator: "resource://account/private-new-object", targetType: "resource", environment, expectedFingerprint: hash("absent") }];
  const locators = input.targets.map(target => target.locator);
  input.plannedCommandOrTool = { tool: "resource-manager", action: "verify authority and absence; conditional create only; stop and preserve on conflict or unknown outcome" };
  input.scopeRef.includedTargets = locators;
  input.authorizationRef.allowedActions = [actionClass];
  input.authorizationRef.allowedTargets = locators;
  input.authorizationRef.environments = [environment];
  input.approvalEvidenceRefs = [{ ...input.approvalEvidenceRefs[0], operationId: input.operationId, actionClass, targetLocators: locators, environments: [environment] }];
  input.currentStateEvidenceRefs = [{ locator: "evidence://absent-state", digest: hash("observation"), targetLocator: locators[0], fingerprint: input.targets[0].expectedFingerprint, existence: "absent" }];
  input.recoveryPlan = { available: true, method: "stop and preserve the new private object", backupRef: null, restoreProcedureRef: "evidence://stop-preserve", restoreTestEvidenceRef: null, irreversibilityAccepted: false };
  input.expectedBlastRadius = { affectedTargets: 1, affectedUsers: 1, external: true, description: "new private resource only; existing state preserved" };
  input.recoveryPlan.freshResourceContainment = {
    commandDigest: hash(input.plannedCommandOrTool), targetDigest: evaluatePreflight(input, { now }).targetDigest,
    guardEvidenceRef: { locator: "evidence://conditional-create-guard", digest: hash("guard source") }, partialFailure: "stop-preserve",
    externalPreparation: {
      exposure: "private-unpublished", existingState: "preserved", sideEffects: "scoped-resources-only",
      effectsEvidenceRef: { locator: "evidence://verified-api-effects", digest: hash("API contract and source effects") },
    },
  };
  return input;
}

test("private external preparation preserves approval and external impact without claiming a restore", () => {
  const input = intent(), report = evaluatePreflight(input, { now });
  assert.equal(validateMutationIntent(input), true);
  assert.equal(validateMutationReport(report), true);
  assert.equal(report.verdict, "READY", JSON.stringify(report.unresolved));
  assert.equal(report.classification.externalImpact, true);
  assert.equal(report.classification.reversibility, "conditional");
  assert.equal(report.approval.required, true);
  assert.equal(report.approval.status, "observed");
  assert.equal(report.recovery.restoreTested, false);
  assert.equal(report.recovery.irreversibilityAccepted, false);
  assert.ok(report.recovery.evidenceRefs.includes(input.recoveryPlan.freshResourceContainment.externalPreparation.effectsEvidenceRef.locator));
  assert.equal(verifyReceipt({ report, intent: input, verificationTime: now }).valid, true);
});

test("external preparation also supports other create-only actions", () => {
  assert.equal(evaluatePreflight(intent("external", "other"), { now }).verdict, "READY");
});

for (const [name, mutate, expected] of [
  ["no external effects contract", value => { delete value.recoveryPlan.freshResourceContainment.externalPreparation; }, "NEEDS_REDESIGN"],
  ["no effects evidence", value => { delete value.recoveryPlan.freshResourceContainment.externalPreparation.effectsEvidenceRef; }, "BLOCKED"],
  ["malformed effects digest", value => { value.recoveryPlan.freshResourceContainment.externalPreparation.effectsEvidenceRef.digest = "unknown"; }, "BLOCKED"],
  ["public exposure", value => { value.recoveryPlan.freshResourceContainment.externalPreparation.exposure = "public"; }, "BLOCKED"],
  ["existing state changes", value => { value.recoveryPlan.freshResourceContainment.externalPreparation.existingState = "modified"; }, "BLOCKED"],
  ["independent side effects", value => { value.recoveryPlan.freshResourceContainment.externalPreparation.sideEffects = "notifications"; }, "BLOCKED"],
  ["present target", value => { value.currentStateEvidenceRefs[0].existence = "present"; }, "NEEDS_REDESIGN"],
  ["conflicting presence", value => { value.currentStateEvidenceRefs.push({ ...value.currentStateEvidenceRefs[0], existence: "present" }); }, "NEEDS_REDESIGN"],
  ["missing approval", value => { value.approvalEvidenceRefs = []; }, "NEEDS_APPROVAL"],
  ["expired approval", value => { value.approvalEvidenceRefs[0].expiresAt = "2026-09-08T00:00:00.000Z"; }, "NEEDS_APPROVAL"],
  ["wrong authority", value => { value.authorizationRef.allowedActions = ["read"]; }, "BLOCKED"],
  ["changed actual command", value => { value.plannedCommandOrTool.action += "; publish"; }, "NEEDS_REDESIGN"],
  ["unobserved child target", value => { value.targets.push({ ...value.targets[0], locator: "resource://account/new-child" }); value.scopeRef.includedTargets.push(value.targets[1].locator); value.authorizationRef.allowedTargets.push(value.targets[1].locator); value.approvalEvidenceRefs[0].targetLocators.push(value.targets[1].locator); value.expectedBlastRadius.affectedTargets = 2; }, "NEEDS_INPUT"],
  ["unknown result retry", value => { value.recoveryPlan.freshResourceContainment.partialFailure = "retry"; }, "BLOCKED"],
  ["restore evidence mixed into new-resource mode", value => { value.recoveryPlan.backupRef = "evidence://backup"; value.recoveryPlan.restoreTestEvidenceRef = "evidence://unrelated-restore"; }, "NEEDS_REDESIGN"],
  ["invented irreversible acceptance", value => { value.recoveryPlan.irreversibilityAccepted = true; }, "NEEDS_REDESIGN"],
  ["private contract on a non-external operation", value => { value.targets[0].environment = "isolated-test"; value.authorizationRef.environments = ["isolated-test"]; value.approvalEvidenceRefs[0].environments = ["isolated-test"]; value.expectedBlastRadius.external = false; value.recoveryPlan.freshResourceContainment.targetDigest = evaluatePreflight(value, { now }).targetDigest; }, "NEEDS_REDESIGN"],
]) {
  test(`external preparation rejects ${name}`, () => {
    const input = intent(); mutate(input);
    assert.equal(evaluatePreflight(input, { now }).verdict, expected);
  });
}

for (const environment of ["production", "prod", "shared"]) {
  test(`external preparation cannot reclassify ${environment}`, () => {
    assert.equal(evaluatePreflight(intent(environment), { now }).verdict, "NEEDS_REDESIGN");
  });
}

for (const actionClass of ["publish", "permission-change", "delete", "overwrite", "migrate", "move", "billing", "global-config"]) {
  test(`external preparation cannot authorize ${actionClass}`, () => {
    assert.equal(evaluatePreflight(intent("external", actionClass), { now }).verdict, "NEEDS_REDESIGN");
  });
}

test("receipt binds external effects evidence and rejects changed reports", () => {
  const input = intent(), report = evaluatePreflight(input, { now });
  assert.equal(report.verdict, "READY");
  for (const mutate of [
    value => { value.recoveryPlan.freshResourceContainment.externalPreparation.effectsEvidenceRef.digest = hash("different source"); },
    value => { value.recoveryPlan.freshResourceContainment.externalPreparation.effectsEvidenceRef.locator = "evidence://other"; },
    value => { value.recoveryPlan.freshResourceContainment.externalPreparation.exposure = "public"; },
    value => { delete value.recoveryPlan.freshResourceContainment.externalPreparation; },
  ]) {
    const changed = structuredClone(input); mutate(changed);
    assert.equal(verifyReceipt({ report, intent: changed, verificationTime: now }).valid, false);
  }
  const forged = structuredClone(report);
  forged.classification.externalImpact = false;
  assert.equal(verifyReceipt({ report: forged, intent: input, verificationTime: now }).valid, false);
});
