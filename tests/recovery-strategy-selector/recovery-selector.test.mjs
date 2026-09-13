import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { analyzeDiagnosis, requestArtifactDigest as diagnosisRequestDigest } from "../../skills/blocker-diagnostician/scripts/core.mjs";
import {
  artifactDigest,
  selectionRequestDigest,
  strategyFingerprint,
  validateHandoff,
  validateRequest,
  validateTaskBinding,
} from "../../skills/recovery-strategy-selector/scripts/core.mjs";
import { compileAllSchemas, validateBindingReportSchema } from "../../skills/recovery-strategy-selector/scripts/schema-validation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(here, "..", "..", "skills", "recovery-strategy-selector");
const digest = (value) => artifactDigest(value);

function taskEnvelope() {
  return {
    schemaVersion: "1.0.0",
    taskId: "failed-task",
    objective: "Repair the local cache writer.",
    scope: { included: ["cache writer"], excluded: ["deployment"] },
    acceptanceCriteria: ["[AC-001] The cache write completes and its regression test passes."],
    riskLevel: "medium",
    workUnits: [{ id: "repair", objective: "Repair cache writes.", dependencies: [], writeTargets: ["src/cache.ts"] }],
    requiredCapabilities: ["local-fix"],
    constraints: ["Keep production untouched."],
    authorization: { allowedActions: ["local-edit", "rollback"], prohibitedActions: ["deploy"], approvalRequired: ["schema-migration"] },
    decision: { complexity: "complex", hasConflicts: false },
    orchestration: { requested: true, mcpAvailable: true },
  };
}

function selectionRequest() {
  const envelope = taskEnvelope();
  const diagnosisRequest = {
    schemaVersion: "1.0.0",
    objective: "Repair the local cache writer.",
    expectedBehavior: "The cache writer stores its entry.",
    episodes: [{ attemptId: "attempt-1", operation: "write cache", stableFailureTuple: { code: "EACCES" }, environmentDigest: "env:local", changeSummary: "", evidenceRefs: ["cause-evidence"] }],
    lastKnownGood: null,
    constraints: ["Keep production untouched."],
    authorization: { allowedChecks: [], approvalRequired: [], prohibitedChecks: [] },
    evidenceBindings: [{ evidenceRef: "cause-evidence", artifactDigest: digest({ mode: "readonly" }), hypothesisIds: ["cause-cache-permission"], relation: "supports" }],
    attemptedChecks: [],
    candidateHypotheses: [{ id: "cause-cache-permission", causalLayer: "permission", statement: "The cache path lacks write permission.", supportingEvidence: ["cause-evidence"], contradictingEvidence: [], state: "confirmed" }],
    candidateTests: [],
    accessBlockers: [],
  };
  const report = analyzeDiagnosis(diagnosisRequest);
  const workflowReceipt = {
    schemaVersion: "1.0.0",
    runId: "run-failed",
    revision: 4,
    state: "failed",
    plan: { schemaVersion: "1.0.0", taskId: envelope.taskId, taskDigest: digest(envelope), integrityToken: "fixture-signature", executionMode: "orchestrated", state: "failed", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] },
    stageResults: [],
    blockers: ["cache-write-failed"],
    unresolved: ["cache-write-failed"],
    error: null,
  };
  return {
    schemaVersion: "1.0.0",
    selectionId: "selection-001",
    diagnosis: { locator: "diagnosis:run-2", digest: digest(report), report, requestLocator: "diagnosis-request:run-2", requestDigest: diagnosisRequestDigest(diagnosisRequest), request: diagnosisRequest },
    sourceTask: { locator: "task:failed-task", digest: digest(envelope), envelope },
    sourceWorkflow: { runId: "run-failed", revision: 4, state: "failed", receiptLocator: "workflow:run-failed", receiptDigest: digest(workflowReceipt), receipt: workflowReceipt },
    constraints: ["Use a fresh workflow run."],
    authorizationEvidence: [
      { action: "local-edit", effect: "allow", authority: "user", sourceLocator: "request:/authorization" },
      { action: "rollback", effect: "allow", authority: "user", sourceLocator: "request:/authorization" },
      { action: "schema-migration", effect: "require-approval", authority: "user", sourceLocator: "request:/authorization" },
      { action: "deploy", effect: "prohibit", authority: "user", sourceLocator: "request:/authorization" },
    ],
    priorStrategyFingerprints: [],
    evidenceIndex: [{ evidenceRef: "cause-evidence", locator: "tool:file-stat", digest: digest({ mode: "readonly" }), verified: true }],
  };
}

function strategy(id, overrides = {}) {
  const item = {
    strategyId: id,
    summary: `Apply ${id}.`,
    mechanism: `mechanism-${id}`,
    actions: [{ name: "local-edit", target: "src/cache.ts" }],
    writeTargets: [`${id}.ts`],
    preconditions: [{ statement: "The cause evidence is current.", status: "satisfied", evidenceRefs: ["cause-evidence"] }],
    verificationPlan: [{ check: `test-${id}`, expectedResult: "passes", evidenceRequired: "test output" }],
    stopConditions: ["Stop after one failed verification."],
    failureImpact: "low",
    reversibility: "full",
    causeFit: "direct",
    verificationStrength: "direct",
    changeBreadth: 1,
    scopeExpansion: false,
    objectivePreserved: true,
    acceptanceCriteriaPreserved: true,
    mutatesPriorRun: false,
    repeatsPriorAttempt: false,
    requiredAuthorization: [],
    evidenceRefs: ["cause-evidence"],
    strategyFingerprint: "",
    objectiveGate: { verdict: "PASS", reasons: [] },
    ...overrides,
  };
  item.strategyFingerprint = strategyFingerprint(item);
  return item;
}

function handoff(request, strategies, { verdict = "SELECTED", selected = strategies[0]?.strategyId ?? null, crossReview } = {}) {
  const chosen = strategies.find((item) => item.strategyId === selected) ?? null;
  const survivingStrategyIds = strategies.filter((item) => item.objectiveGate.verdict !== "FAIL").map((item) => item.strategyId);
  const review = crossReview ?? (survivingStrategyIds.length > 1
    ? { status: selected ? "completed" : "unresolved", reviews: survivingStrategyIds.map((strategyId) => ({ strategyId, challenge: "Could a narrower change work?", response: "This option directly addresses the confirmed cause.", evidenceRefs: ["cause-evidence"] })), unresolvedStrategyIds: selected ? [] : survivingStrategyIds }
    : { status: "not-required", reviews: [], unresolvedStrategyIds: [] });
  return {
    schemaVersion: "1.0.0",
    handoffId: "handoff-001",
    selectionRequestDigest: selectionRequestDigest(request),
    sourceTask: { taskId: request.sourceTask.envelope.taskId, envelopeDigest: request.sourceTask.digest },
    sourceWorkflow: { runId: request.sourceWorkflow.runId, revision: request.sourceWorkflow.revision, receiptDigest: request.sourceWorkflow.receiptDigest },
    diagnosis: { reportDigest: request.diagnosis.digest, requestArtifactDigest: request.diagnosis.report.requestArtifactDigest, confirmedCauseId: request.diagnosis.report.confirmedCause.hypothesisId },
    strategies,
    survivingStrategyIds,
    crossReview: review,
    selectedStrategyId: selected,
    nextTaskSeed: chosen ? {
      objective: request.sourceTask.envelope.objective,
      recoveryObjective: chosen.summary,
      scope: request.sourceTask.envelope.scope,
      acceptanceCriteria: request.sourceTask.envelope.acceptanceCriteria,
      constraints: [...request.sourceTask.envelope.constraints, ...request.constraints].sort(),
      workUnits: [{ id: "new-recovery", objective: chosen.summary, dependencies: [], writeTargets: chosen.writeTargets }],
      requiredCapabilities: ["local-fix"],
      requestedActions: chosen.actions.map((item) => item.name),
      verificationPlan: chosen.verificationPlan,
    } : null,
    approvalRequired: chosen?.requiredAuthorization ?? [],
    limitations: ["The selector does not execute the strategy."],
    verdict,
  };
}

function taskContract(recoveryHandoff, { allowedActions = ["local-edit", "rollback"], approvalRequired = ["schema-migration"], extraAuthority = [] } = {}) {
  const seed = recoveryHandoff.nextTaskSeed;
  const locator = `recovery-handoff:${artifactDigest(recoveryHandoff)}`;
  const taskContractRequest = {
    schemaVersion: "1.0.0",
    taskId: "recovery-task-001",
    request: "Create a new recovery task from the validated handoff.",
    instructionResolutionRefs: ["instructions:root"],
    pathSemantics: "windows",
    authorizationEvidence: [
      ...allowedActions.map((action) => ({ action, effect: "allow", authority: "user", sourceLocator: `user-approval:${action}` })),
      { action: "deploy", effect: "prohibit", authority: "user", sourceLocator: "source-task:deploy" },
      ...approvalRequired.map((action) => ({ action, effect: "require-approval", authority: "user", sourceLocator: `source-task:${action}` })),
      ...extraAuthority,
    ],
    suppliedFacts: [{ statement: "Use the validated recovery handoff.", locator }],
    userDecisions: [],
  };
  const taskContractReport = {
    schemaVersion: "1.0.0",
    taskEnvelope: {
      schemaVersion: "1.0.0",
      taskId: "recovery-task-001",
      objective: seed.objective,
      scope: seed.scope,
      acceptanceCriteria: seed.acceptanceCriteria,
      riskLevel: "medium",
      workUnits: seed.workUnits,
      requiredCapabilities: seed.requiredCapabilities,
      constraints: seed.constraints,
      authorization: { allowedActions, prohibitedActions: ["deploy"], approvalRequired },
      decision: { complexity: "complex", hasConflicts: false },
      orchestration: { requested: true, mcpAvailable: true },
    },
    acceptanceEvidencePlan: { schemaVersion: "1.0.0", criteria: [{ criterionId: "AC-001", statement: seed.acceptanceCriteria[0], verificationMethod: "Run the cache regression test.", expectedEvidenceKinds: ["test"], passCondition: "The regression test passes." }] },
    provenance: [
      ...["/objective", "/scope", "/acceptanceCriteria", "/workUnits"].map((field) => ({ field, valueSummary: "Bound from recovery handoff.", sourceLocator: locator, basis: "explicit" })),
      { field: "/riskLevel", valueSummary: "Preserve medium risk.", sourceLocator: "source-task:risk", basis: "explicit" },
      { field: "/authorization", valueSummary: "Bind current authority evidence.", sourceLocator: "task-contract-request:authorization", basis: "explicit" },
    ],
    authorizationProvenance: taskContractRequest.authorizationEvidence.map((item) => ({ action: item.action, envelopeField: item.effect === "allow" ? "/authorization/allowedActions" : item.effect === "prohibit" ? "/authorization/prohibitedActions" : "/authorization/approvalRequired", effect: item.effect, authority: item.authority, sourceLocator: item.sourceLocator })),
    assumptions: [],
    ambiguities: [],
    contradictions: [],
    verdict: "PASS",
  };
  return { taskContractRequest, taskContractReport };
}

describe("recovery strategy selector", () => {
  it("normal: selects the only strategy that passes the Objective Gate", () => {
    const request = selectionRequest();
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [strategy("safe"), rejected]);
    expect(validateHandoff(request, output)).toEqual([]);
  });

  it("normal: requires cross-review for multiple surviving strategies and selects deterministically", () => {
    const request = selectionRequest();
    const output = handoff(request, [strategy("direct"), strategy("contained", { causeFit: "containment" })]);
    expect(validateHandoff(request, output)).toEqual([]);
    expect(output.crossReview.status).toBe("completed");
  });

  it("boundary: leaves an exact comparison tie to user input", () => {
    const request = selectionRequest();
    const output = handoff(request, [strategy("a"), strategy("b")], { verdict: "NEEDS_INPUT", selected: null });
    expect(validateHandoff(request, output)).toEqual([]);
    expect(output.crossReview).toMatchObject({ status: "unresolved", unresolvedStrategyIds: ["a", "b"] });
  });

  it("boundary: reports no viable strategy when every Objective Gate fails", () => {
    const request = selectionRequest();
    const failed = (id) => strategy(id, { verificationStrength: "unavailable", objectiveGate: { verdict: "FAIL", reasons: ["verification-unavailable"] } });
    const output = handoff(request, [failed("a"), failed("b")], { verdict: "NO_VIABLE_STRATEGY", selected: null });
    expect(validateHandoff(request, output)).toEqual([]);
  });

  it("boundary: preserves approval-required selection without treating it as execution authority", async () => {
    const request = selectionRequest();
    const approval = strategy("migration", {
      actions: [{ name: "schema-migration", target: "cache schema" }],
      writeTargets: ["schema.sql"],
      requiredAuthorization: ["schema-migration"],
      objectiveGate: { verdict: "REQUIRES_APPROVAL", reasons: [] },
    });
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [approval, rejected], { verdict: "NEEDS_APPROVAL", selected: "migration" });
    expect(validateHandoff(request, output)).toEqual([]);
    const missingApproval = taskContract(output);
    expect(await validateTaskBinding(request, output, missingApproval.taskContractRequest, missingApproval.taskContractReport)).toMatchObject({ valid: false });
    const approved = taskContract(output, { allowedActions: ["local-edit", "rollback", "schema-migration"], approvalRequired: [] });
    expect(await validateTaskBinding(request, output, approved.taskContractRequest, approved.taskContractReport)).toMatchObject({ valid: true });
  });

  it("expected failure: rejects an unconfirmed or tampered diagnosis", () => {
    const request = selectionRequest();
    request.diagnosis.report.verdict = "NEXT_TEST";
    expect(() => validateRequest(request)).toThrow(/digest|CAUSE_CONFIRMED/);
  });

  it("expected failure: rejects a diagnosis report that is not bound to its original request", () => {
    const request = selectionRequest();
    request.diagnosis.request.objective = "A different failure objective.";
    expect(() => validateRequest(request)).toThrow(/diagnosis request digest/);
  });

  it("expected failure: rejects a receipt that is not bound to the source task", () => {
    const request = selectionRequest();
    request.sourceWorkflow.receipt.plan.taskId = "unrelated-task";
    request.sourceWorkflow.receiptDigest = digest(request.sourceWorkflow.receipt);
    expect(() => validateRequest(request)).toThrow(/원본 task envelope/);
  });

  it("expected failure: derives prior-run mutation from action and write targets", () => {
    const request = selectionRequest();
    const disguised = strategy("disguised", {
      actions: [{ name: "local-edit", target: "workflow:run-failed" }],
      writeTargets: ["workflow:run-failed"],
    });
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [disguised, rejected]);
    expect(validateHandoff(request, output).join("\n")).toMatch(/Objective Gate 결과/);
  });

  it("expected failure: rejects strategies with the same mechanism, actions, and write targets", () => {
    const request = selectionRequest();
    const first = strategy("first");
    const second = strategy("second", {
      mechanism: first.mechanism,
      actions: first.actions,
      writeTargets: first.writeTargets,
      stopConditions: ["Stop after two failed verifications."],
    });
    const output = handoff(request, [first, second], { verdict: "NEEDS_INPUT", selected: null });
    expect(validateHandoff(request, output).join("\n")).toMatch(/mechanism, actions, writeTargets/);
  });

  it("expected failure: rejects bare approval objects and incomplete task contracts", async () => {
    const request = selectionRequest();
    const selected = strategy("safe");
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [selected, rejected]);
    const result = await validateTaskBinding(
      request,
      output,
      { authorizationEvidence: [{ action: "deploy", effect: "allow", authority: "user", sourceLocator: "message:1" }] },
      { verdict: "PASS", taskEnvelope: { ...request.sourceTask.envelope, taskId: "new-task", authorization: { allowedActions: ["local-edit", "rollback", "deploy"], prohibitedActions: [], approvalRequired: [] } }, provenance: [] },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/TaskContractReport.v1 검증 실패/);
    expect(result.errors.join("\n")).toMatch(/원본 prohibited action/);
  });

  it("expected failure: rejects stale request binding, duplicate strategies, and unverified evidence", () => {
    const request = selectionRequest();
    const first = strategy("a");
    const duplicate = { ...first, strategyId: "b", summary: "Apply b." };
    const output = handoff(request, [first, duplicate], { verdict: "NEEDS_INPUT", selected: null });
    output.selectionRequestDigest = digest({ stale: true });
    output.strategies[0].evidenceRefs = ["missing-evidence"];
    const errors = validateHandoff(request, output, selectionRequestDigest(request));
    expect(errors.join("\n")).toMatch(/동결된 selection request digest/);
    expect(errors.join("\n")).toMatch(/중복 제출/);
    expect(errors.join("\n")).toMatch(/검증되지 않은 evidence/);
  });

  it("expected failure: rejects a recovery task that reuses the old task or expands authority", async () => {
    const request = selectionRequest();
    const output = handoff(request, [strategy("safe"), strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } })]);
    const contract = taskContract(output, { allowedActions: ["local-edit", "rollback", "deploy"], approvalRequired: ["schema-migration"] });
    contract.taskContractReport.taskEnvelope.taskId = request.sourceTask.envelope.taskId;
    contract.taskContractReport.taskEnvelope.authorization.prohibitedActions = [];
    contract.taskContractReport.provenance = [];
    const result = await validateTaskBinding(request, output, contract.taskContractRequest, contract.taskContractReport);
    expect(result.valid).toBe(false);
    expect(result.errors.join("\n")).toMatch(/다른 taskId/);
    expect(result.errors.join("\n")).toMatch(/allowed action을 확대/);
    expect(result.errors.join("\n")).toMatch(/provenance/);
    expect(validateBindingReportSchema(result)).toBe(true);
  });

  it("contracts compile and the digest CLI accepts stdin JSON", () => {
    compileAllSchemas();
    const request = selectionRequest();
    const execution = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "digest-request.mjs")], { input: JSON.stringify(request), encoding: "utf8" });
    expect(execution.status).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({ requestArtifactDigest: selectionRequestDigest(request) });
  });
});
