import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { analyzeDiagnosis, requestArtifactDigest as diagnosisRequestDigest } from "../../skills/blocker-diagnostician/scripts/core.mjs";
import {
  artifactDigest,
  confirmedRootConditionDigest,
  selectionRequestDigest,
  strategyFingerprint,
  validateHandoff,
  validateRequest,
  validateTaskBinding,
} from "../../skills/recovery-strategy-selector/scripts/core.mjs";
import { compileAllSchemas, validateBindingReportSchema, validateWorkflowReceiptSchema } from "../../skills/recovery-strategy-selector/scripts/schema-validation.mjs";

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
  const workflowReceipt = {
    schemaVersion: "1.0.0",
    runId: "run-failed",
    revision: 4,
    state: "failed",
    plan: { schemaVersion: "1.0.0", taskId: envelope.taskId, taskDigest: digest(envelope), integrityToken: "A".repeat(43), executionMode: "orchestrated", state: "failed", selectedSkills: [], stages: [], currentStageId: null, nextStageId: null, errors: [] },
    stageResults: [],
    blockers: ["cache-write-failed"],
    unresolved: ["cache-write-failed"],
    error: null,
    unverifiedClaims: [],
  };
  const diagnosisRequest = {
    schemaVersion: "1.0.0",
    objective: "Repair the local cache writer.",
    expectedBehavior: "The cache writer stores its entry.",
    episodes: [{ attemptId: "attempt-1", operation: "write cache", stableFailureTuple: { code: "EACCES" }, environmentDigest: "env:local", changeSummary: "", evidenceRefs: ["cause-evidence", "source-task-envelope", "source-workflow-receipt"] }],
    lastKnownGood: null,
    constraints: ["Keep production untouched."],
    authorization: { allowedChecks: [], approvalRequired: [], prohibitedChecks: [] },
    evidenceBindings: [
      { evidenceRef: "cause-evidence", artifactDigest: digest({ mode: "readonly" }), hypothesisIds: ["cause-cache-permission"], relation: "supports" },
      { evidenceRef: "source-task-envelope", artifactDigest: digest(envelope), hypothesisIds: ["cause-cache-permission"], relation: "supports" },
      { evidenceRef: "source-workflow-receipt", artifactDigest: digest(workflowReceipt), hypothesisIds: ["cause-cache-permission"], relation: "supports" },
    ],
    attemptedChecks: [],
    candidateHypotheses: [{ id: "cause-cache-permission", causalLayer: "permission", statement: "The cache path lacks write permission.", supportingEvidence: ["cause-evidence", "source-task-envelope", "source-workflow-receipt"], contradictingEvidence: [], state: "confirmed", causeAnalysis: { symptom: "Cache writes fail with EACCES.", mechanism: "The writer reaches a path without write permission.", rootCondition: "The cache path lacks write permission.", discriminatingEvidence: { statement: "The file check identifies the denied path.", evidenceRefs: ["cause-evidence"] }, eliminationObservation: { statement: "The permission result rules out a serialization failure.", evidenceRefs: ["cause-evidence"] } } }],
    candidateTests: [],
    accessBlockers: [],
  };
  const report = analyzeDiagnosis(diagnosisRequest);
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

function receiptWithEffort(effort) {
  const value = selectionRequest().sourceWorkflow.receipt;
  value.plan.bootstrapExecution = {
    requirement: { policyId: "semantic-execution-assurance-v1", kind: "semantic", minimumModelClass: effort === null ? null : "general", minimumReasoningEffort: effort, observationRequired: true },
    context: { schemaVersion: "1.0.0", model: "fixture-model", modelClass: "general", reasoningEffort: effort, source: "runtime", observedAt: "2026-11-07T00:00:00Z" },
  };
  return value;
}

function strategy(id, overrides = {}) {
  const item = {
    strategyId: id,
    summary: `Apply ${id}.`,
    mechanism: `mechanism-${id}`,
    addressesCauseId: "cause-cache-permission",
    rootConditionDigest: digest({ causeId: "cause-cache-permission", rootCondition: "The cache path lacks write permission." }),
    rootConditionChange: `Change the denied cache-path condition with ${id}.`,
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
    diagnosis: { reportDigest: request.diagnosis.digest, requestArtifactDigest: request.diagnosis.report.requestArtifactDigest, confirmedCauseId: request.diagnosis.report.confirmedCause.hypothesisId, rootConditionDigest: confirmedRootConditionDigest(request) },
    strategies,
    survivingStrategyIds,
    crossReview: review,
    selectedStrategyId: selected,
    nextTaskSeed: chosen ? {
      objective: request.sourceTask.envelope.objective,
      recoveryObjective: chosen.summary,
      addressesCauseId: chosen.addressesCauseId,
      rootConditionDigest: chosen.rootConditionDigest,
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

/** A request whose evidenceIndex also holds the panel's verified DecisionRecord (D0341, review 902e). */
function panelRequest() {
  const request = selectionRequest();
  request.evidenceIndex.push({ evidenceRef: "panel-record", locator: "artifact:decision-record", digest: digest({ panel: "tie" }), verified: true,
    kind: "independent-deliberation-panel/decision-record.v1" });
  return request;
}

function tieReview(survivorIds, unresolvedStrategyIds, deliberation) {
  return {
    status: unresolvedStrategyIds.length ? "unresolved" : "completed",
    reviews: survivorIds.map((strategyId) => ({ strategyId, challenge: "Could a narrower change work?", response: "This option directly addresses the confirmed cause.", evidenceRefs: ["cause-evidence"] })),
    unresolvedStrategyIds,
    ...(deliberation ? { deliberation } : {}),
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

// The assertions below compare the English model-locale sentences (catalog domain skillChecksKo, locales/en); the host
// locale is set to ko on purpose, since it must not change the output.
beforeAll(() => { vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "ko"); });
afterAll(() => { vi.unstubAllEnvs(); });

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

  it("boundary: selects the tied leader chosen by a resolved deliberation record bound to verified evidence", () => {
    const request = panelRequest();
    const output = handoff(request, [strategy("a"), strategy("b")], { selected: "b", crossReview: tieReview(["a", "b"], [], { selectedStrategyId: "b", evidenceRefs: ["cause-evidence", "panel-record"] }) });
    expect(validateHandoff(request, output)).toEqual([]);

    const approval = (id) => strategy(id, {
      actions: [{ name: "schema-migration", target: "cache schema" }],
      writeTargets: [`${id}.sql`],
      requiredAuthorization: ["schema-migration"],
      objectiveGate: { verdict: "REQUIRES_APPROVAL", reasons: [] },
    });
    const gated = handoff(request, [approval("m1"), approval("m2")], { verdict: "NEEDS_APPROVAL", selected: "m2", crossReview: tieReview(["m1", "m2"], [], { selectedStrategyId: "m2", evidenceRefs: ["panel-record"] }) });
    expect(validateHandoff(request, gated)).toEqual([]);
    expect(gated.approvalRequired).toEqual(["schema-migration"]);
  });

  it("boundary: keeps NEEDS_INPUT when a tie has no deliberation record or an unresolved one", () => {
    const request = panelRequest();
    const strategies = [strategy("a"), strategy("b")];
    const unresolved = handoff(request, strategies, { verdict: "NEEDS_INPUT", selected: null, crossReview: tieReview(["a", "b"], ["a", "b"], { selectedStrategyId: null, evidenceRefs: ["panel-record"] }) });
    expect(validateHandoff(request, unresolved)).toEqual([]);
    for (const deliberation of [undefined, { selectedStrategyId: null, evidenceRefs: ["panel-record"] }]) {
      const claimed = handoff(request, strategies, { selected: "a", crossReview: tieReview(["a", "b"], [], deliberation) });
      expect(validateHandoff(request, claimed)).toContain("The handoff verdict must be NEEDS_INPUT.");
    }
  });

  it("negative: a tie-breaking deliberation record citing only cause evidence, without the panel's DecisionRecord, keeps NEEDS_INPUT", () => {
    const panelKind = "The deliberation must reference at least one verified evidence of kind independent-deliberation-panel/decision-record.v1.";
    const strategies = [strategy("a"), strategy("b")];
    for (const request of [selectionRequest(), panelRequest()]) {
      const causeOnly = validateHandoff(request, handoff(request, strategies, { selected: "a", crossReview: tieReview(["a", "b"], [], { selectedStrategyId: "a", evidenceRefs: ["cause-evidence"] }) }));
      expect(causeOnly).toContain("The handoff verdict must be NEEDS_INPUT.");
      expect(causeOnly).toContain(panelKind);
    }
    // The panel record kind is bound only to verified evidence.
    const unverifiedPanel = selectionRequest();
    unverifiedPanel.evidenceIndex.push({ evidenceRef: "panel-record", locator: "artifact:decision-record", digest: digest({ panel: "tie" }), verified: false,
      kind: "independent-deliberation-panel/decision-record.v1" });
    const fallback = handoff(unverifiedPanel, strategies, { verdict: "NEEDS_INPUT", selected: null, crossReview: tieReview(["a", "b"], ["a", "b"], { selectedStrategyId: "a", evidenceRefs: ["panel-record"] }) });
    expect(validateHandoff(unverifiedPanel, fallback)).toEqual(["The deliberation references unverified evidence.", panelKind]);
  });

  it("negative: rejects a tie-breaking deliberation record that names a non-leader or cites unverified evidence", () => {
    const request = panelRequest();
    const strategies = [strategy("a"), strategy("b"), strategy("c", { causeFit: "containment" })];
    const survivors = ["a", "b", "c"];
    const nonLeader = validateHandoff(request, handoff(request, strategies, { selected: "c", crossReview: tieReview(survivors, [], { selectedStrategyId: "c", evidenceRefs: ["panel-record"] }) }));
    expect(nonLeader).toContain("The handoff verdict must be NEEDS_INPUT.");
    expect(nonLeader).toContain("The deliberation selectedStrategyId must be one of the tied top strategies.");

    const unverifiedRecord = { selectedStrategyId: "a", evidenceRefs: ["unverified-panel-record"] };
    const unverified = validateHandoff(request, handoff(request, strategies, { selected: "a", crossReview: tieReview(survivors, [], unverifiedRecord) }));
    expect(unverified).toContain("The handoff verdict must be NEEDS_INPUT.");
    expect(unverified).toContain("The deliberation references unverified evidence.");
    const fallback = handoff(request, strategies, { verdict: "NEEDS_INPUT", selected: null, crossReview: tieReview(survivors, ["a", "b"], unverifiedRecord) });
    expect(validateHandoff(request, fallback)).toEqual(["The deliberation references unverified evidence.",
      "The deliberation must reference at least one verified evidence of kind independent-deliberation-panel/decision-record.v1."]);
  });

  it("policy: requires independent-deliberation-panel internal tie-breaking before escalating an unresolved tie to NEEDS_INPUT", () => {
    const repoRoot = path.resolve(here, "..", "..");
    for (const relPath of [
      "skills/recovery-strategy-selector/references/entry-details.md",
      "skills/recovery-strategy-selector/references/selection-protocol.md",
    ]) {
      const canonical = readFileSync(path.join(repoRoot, relPath), "utf8");
      const claudeMirror = readFileSync(path.join(repoRoot, "claude-plugin", relPath), "utf8");
      expect(claudeMirror).toBe(canonical);
      expect(canonical).toContain("independent-deliberation-panel");
      expect(canonical).not.toContain("가중 점수를 만들지 않으며 동률은 사용자가 결정하도록 남긴다.");
      expect(canonical).not.toContain("모든 축이 같은 최상위 전략이 둘 이상이면 `NEEDS_INPUT`으로 반환한다.");
    }
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

  it("expected failure: rejects a fully regenerated diagnosis from another task and workflow", () => {
    const request = selectionRequest();
    for (const binding of request.diagnosis.request.evidenceBindings) {
      if (binding.evidenceRef === "source-task-envelope") binding.artifactDigest = digest({ taskId: "unrelated-task" });
      if (binding.evidenceRef === "source-workflow-receipt") binding.artifactDigest = digest({ runId: "unrelated-run" });
    }
    request.diagnosis.report = analyzeDiagnosis(request.diagnosis.request);
    request.diagnosis.requestDigest = diagnosisRequestDigest(request.diagnosis.request);
    request.diagnosis.digest = digest(request.diagnosis.report);
    expect(() => validateRequest(request)).toThrow(/source task envelope digest/);
  });

  it("expected failure: rejects a receipt that is not bound to the source task", () => {
    const request = selectionRequest();
    request.sourceWorkflow.receipt.plan.taskId = "unrelated-task";
    request.sourceWorkflow.receiptDigest = digest(request.sourceWorkflow.receipt);
    expect(() => validateRequest(request)).toThrow("The source workflow receipt is not bound to the source task envelope.");
  });

  it("expected failure: derives prior-run mutation from action and write targets", () => {
    const request = selectionRequest();
    const disguised = strategy("disguised", {
      actions: [{ name: "local-edit", target: "workflow:run-failed" }],
      writeTargets: ["workflow:run-failed"],
    });
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [disguised, rejected]);
    expect(validateHandoff(request, output).join("\n")).toMatch(/Objective Gate result/);
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
    expect(validateHandoff(request, output).join("\n")).toMatch(/mechanism, actions, and writeTargets cannot be submitted twice/);
  });

  it("expected failure: rejects a recovery strategy bound to another cause", () => {
    const request = selectionRequest();
    const wrongCause = strategy("wrong-cause", { addressesCauseId: "other-cause" });
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [wrongCause, rejected]);
    expect(validateHandoff(request, output).join("\n")).toMatch(/addressesCauseId/);
  });

  it("expected failure: rejects a recovery strategy bound to another root condition", () => {
    const request = selectionRequest();
    const wrongRoot = strategy("wrong-root", { rootConditionDigest: digest({ causeId: "cause-cache-permission", rootCondition: "A different condition." }) });
    const rejected = strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } });
    const output = handoff(request, [wrongRoot, rejected]);
    expect(validateHandoff(request, output).join("\n")).toMatch(/rootConditionDigest|root condition/u);
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
    expect(result.errors.join("\n")).toMatch(/TaskContractReport.v1 validation failed: /);
    expect(result.errors.join("\n")).toMatch(/The new TaskEnvelope removed a prohibited action of the original: /);
  });

  it("expected failure: rejects stale request binding, duplicate strategies, and unverified evidence", () => {
    const request = selectionRequest();
    const first = strategy("a");
    const duplicate = { ...first, strategyId: "b", summary: "Apply b." };
    const output = handoff(request, [first, duplicate], { verdict: "NEEDS_INPUT", selected: null });
    output.selectionRequestDigest = digest({ stale: true });
    output.strategies[0].evidenceRefs = ["missing-evidence"];
    const errors = validateHandoff(request, output, selectionRequestDigest(request));
    expect(errors.join("\n")).toMatch(/externally frozen selection request digest/);
    expect(errors.join("\n")).toMatch(/cannot be submitted twice/);
    expect(errors.join("\n")).toMatch(/references unverified evidence/);
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
    expect(result.errors.join("\n")).toMatch(/taskId different from the original/);
    expect(result.errors.join("\n")).toMatch(/expanded an allowed action without evidence/);
    expect(result.errors.join("\n")).toMatch(/provenance/);
    expect(validateBindingReportSchema(result)).toBe(true);
  });

  it("i18n: renders validation errors in the model locale, whatever the host locale", async () => {
    const request = selectionRequest();
    // A schema-valid handoff (two strategies), so the digest check is the one that reports.
    const output = handoff(request, [strategy("direct"), strategy("contained", { causeFit: "containment" })]);
    output.selectionRequestDigest = digest({ stale: true });
    const frozen = selectionRequestDigest(request);
    const unbound = selectionRequest();
    unbound.sourceWorkflow.receipt.plan.taskId = "unrelated-task";
    unbound.sourceWorkflow.receiptDigest = digest(unbound.sourceWorkflow.receipt);
    for (const locale of ["en", "ko", undefined]) {
      vi.stubEnv("AGENT_GOVERNANCE_LOCALE", locale);
      const errors = validateHandoff(request, output, frozen);
      expect(errors).toContain("The handoff does not match the externally frozen selection request digest.");
      expect(errors.join("\n")).not.toMatch(/[가-힣]/u);
      expect(() => validateRequest(unbound)).toThrow("The source workflow receipt is not bound to the source task envelope.");
    }
    vi.stubEnv("AGENT_GOVERNANCE_LOCALE", "ko");
  });

  it("contracts compile and the digest CLI accepts stdin JSON", () => {
    compileAllSchemas();
    const request = selectionRequest();
    const execution = spawnSync(process.execPath, [path.join(skillRoot, "scripts", "digest-request.mjs")], { input: JSON.stringify(request), encoding: "utf8" });
    expect(execution.status).toBe(0);
    expect(JSON.parse(execution.stdout)).toEqual({ requestArtifactDigest: selectionRequestDigest(request) });
  });

  it.each(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", null])("workflow receipts preserve supported reasoning effort %s", (effort) => {
    expect(validateWorkflowReceiptSchema(receiptWithEffort(effort)), JSON.stringify(validateWorkflowReceiptSchema.errors)).toBe(true);
  });

  it.each(["context-effort", "minimum-effort", "extra-field"])("workflow receipts reject invalid model policy input %s", (mutation) => {
    const value = receiptWithEffort("high");
    if (mutation === "context-effort") value.plan.bootstrapExecution.context.reasoningEffort = "unsupported";
    else if (mutation === "minimum-effort") value.plan.bootstrapExecution.requirement.minimumReasoningEffort = "unsupported";
    else value.plan.bootstrapExecution.context.undeclaredField = true;
    expect(validateWorkflowReceiptSchema(value)).toBe(false);
  });

  it("runs the standalone digest CLI without node_modules and retains contract rejection", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "ags-recovery-runtime-"));
    if (path.dirname(path.resolve(directory)) !== path.resolve(tmpdir())) throw new Error("Unexpected disposable fixture path");
    try {
      const repository = path.resolve(here, "../..");
      mkdirSync(path.join(directory, "skills"));
      for (const relative of ["contracts", "runtime", "skills/recovery-strategy-selector", "skills/blocker-diagnostician", "skills/task-contract"]) {
        cpSync(path.join(repository, relative), path.join(directory, relative), { recursive: true });
      }
      expect(existsSync(path.join(directory, "node_modules"))).toBe(false);
      const cli = path.join(directory, "skills", "recovery-strategy-selector", "scripts", "digest-request.mjs");
      const request = selectionRequest();
      const accepted = spawnSync(process.execPath, [cli], { cwd: directory, input: JSON.stringify(request), encoding: "utf8" });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(JSON.parse(accepted.stdout)).toEqual({ requestArtifactDigest: selectionRequestDigest(request) });
      const rejected = spawnSync(process.execPath, [cli], { cwd: directory, input: JSON.stringify({ ...request, undeclaredField: true }), encoding: "utf8" });
      expect(rejected.status, rejected.stderr).toBe(1);
      expect(rejected.stdout).toBe("");
      expect(rejected.stderr).toContain("RecoveryStrategySelectionRequest.v1");
      expect(rejected.stderr).not.toMatch(/MissingRefError|can't resolve reference/u);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
