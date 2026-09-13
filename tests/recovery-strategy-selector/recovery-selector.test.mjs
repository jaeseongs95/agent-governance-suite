import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    acceptanceCriteria: ["The cache write completes and its regression test passes."],
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
  const report = {
    schemaVersion: "1.0.0",
    requestArtifactDigest: digest({ failure: "cache-permission" }),
    failureClusters: [{ fingerprint: digest({ cluster: "cache" }), episodeIds: ["attempt-1"], operation: "write cache", environmentDigest: "env:local", stableFailureTuple: { code: "EACCES" } }],
    observations: [{ id: "OBS-001", statement: "The cache path is read-only.", evidenceRefs: ["cause-evidence"] }],
    hypotheses: [{ id: "cause-cache-permission", causalLayer: "permission", statement: "The cache path lacks write permission.", supportingEvidence: ["cause-evidence"], contradictingEvidence: [], state: "confirmed" }],
    nextDiscriminatingTest: null,
    confirmedCause: { hypothesisId: "cause-cache-permission", statement: "The cache path lacks write permission.", evidenceBindings: [{ evidenceRef: "cause-evidence", artifactDigest: digest({ mode: "readonly" }), hypothesisIds: ["cause-cache-permission"], relation: "supports" }] },
    recommendedNextAction: "Select a separately authorized recovery strategy.",
    limitations: [],
    verdict: "CAUSE_CONFIRMED",
  };
  return {
    schemaVersion: "1.0.0",
    selectionId: "selection-001",
    diagnosis: { locator: "diagnosis:run-2", digest: digest(report), report },
    sourceTask: { locator: "task:failed-task", digest: digest(envelope), envelope },
    sourceWorkflow: { runId: "run-failed", revision: 4, state: "failed", receiptLocator: "workflow:run-failed", receiptDigest: digest({ runId: "run-failed", revision: 4, state: "failed" }) },
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

function taskContractReport(recoveryHandoff, allowedActions = ["local-edit", "rollback"]) {
  const seed = recoveryHandoff.nextTaskSeed;
  const locator = `recovery-handoff:${artifactDigest(recoveryHandoff)}`;
  return {
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
      authorization: { allowedActions, prohibitedActions: ["deploy"], approvalRequired: [] },
      decision: { complexity: "complex", hasConflicts: false },
      orchestration: { requested: true, mcpAvailable: true },
    },
    acceptanceEvidencePlan: [],
    provenance: ["/objective", "/scope", "/acceptanceCriteria", "/workUnits"].map((field) => ({ field, valueSummary: "Bound from recovery handoff.", sourceLocator: locator, basis: "explicit" })),
    authorizationProvenance: [],
    assumptions: [],
    ambiguities: [],
    contradictions: [],
    verdict: "PASS",
  };
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

  it("boundary: preserves approval-required selection without treating it as execution authority", () => {
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
    expect(validateTaskBinding(request, output, taskContractReport(output, ["local-edit", "rollback", "schema-migration"]))).toMatchObject({ valid: false });
    expect(validateTaskBinding(request, output, taskContractReport(output, ["local-edit", "rollback", "schema-migration"]), [{ action: "schema-migration", authority: "user", sourceLocator: "approval:message" }])).toMatchObject({ valid: true });
  });

  it("expected failure: rejects an unconfirmed or tampered diagnosis", () => {
    const request = selectionRequest();
    request.diagnosis.report.verdict = "NEXT_TEST";
    expect(() => validateRequest(request)).toThrow(/digest|CAUSE_CONFIRMED/);
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

  it("expected failure: rejects a recovery task that reuses the old task or expands authority", () => {
    const request = selectionRequest();
    const output = handoff(request, [strategy("safe"), strategy("unsafe", { mutatesPriorRun: true, objectiveGate: { verdict: "FAIL", reasons: ["prior-run-mutation"] } })]);
    const report = taskContractReport(output, ["local-edit", "rollback", "deploy"]);
    report.taskEnvelope.taskId = request.sourceTask.envelope.taskId;
    report.provenance = [];
    const result = validateTaskBinding(request, output, report);
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
