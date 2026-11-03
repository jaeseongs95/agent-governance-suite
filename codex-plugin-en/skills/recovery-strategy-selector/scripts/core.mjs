import { createHash } from "node:crypto";

import { requestArtifactDigest as diagnosisRequestDigest, validateReport as validateDiagnosisReport } from "../../blocker-diagnostician/scripts/core.mjs";
import { validateTaskContract } from "../../task-contract/scripts/validate-task-contract.mjs";
import { hostText } from "../../../runtime/i18n.mjs";
import {
  schemaErrors,
  validateDiagnosisReportSchema,
  validateHandoffSchema,
  validateRequestSchema,
  validateTaskEnvelopeSchema,
  validateWorkflowReceiptSchema,
} from "./schema-validation.mjs";

export class InputError extends Error {}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function artifactDigest(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

export const selectionRequestDigest = artifactDigest;

export function confirmedRootConditionDigest(request) {
  const cause = request.diagnosis.report.confirmedCause;
  return artifactDigest({ causeId: cause.causeId, rootCondition: cause.rootCondition });
}

export function strategyFingerprint(strategy) {
  return artifactDigest({
    mechanism: strategy.mechanism,
    addressesCauseId: strategy.addressesCauseId,
    rootConditionDigest: strategy.rootConditionDigest,
    rootConditionChange: strategy.rootConditionChange,
    actions: strategy.actions,
    writeTargets: strategy.writeTargets,
    preconditions: strategy.preconditions.map(({ statement }) => statement),
    verificationPlan: strategy.verificationPlan,
    stopConditions: strategy.stopConditions,
  });
}

export function strategyIdentityFingerprint(strategy) {
  return artifactDigest({
    mechanism: strategy.mechanism.trim(),
    actions: [...strategy.actions].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right))),
    writeTargets: sorted(strategy.writeTargets),
  });
}

function equalValues(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function verifiedRefs(request) {
  return new Set(request.evidenceIndex.filter((item) => item.verified).map((item) => item.evidenceRef));
}

/** The evidence kind an independent-deliberation-panel DecisionRecord carries in the request evidenceIndex. */
export const PANEL_DECISION_RECORD_KIND = "independent-deliberation-panel/decision-record.v1";

function panelRecordRefs(request) {
  return new Set(request.evidenceIndex.filter((item) => item.verified && item.kind === PANEL_DECISION_RECORD_KIND).map((item) => item.evidenceRef));
}

function authorizationMap(request) {
  const output = new Map();
  for (const item of request.authorizationEvidence) {
    if (output.has(item.action)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.authorizationActionDuplicate", { action: item.action }));
    if (item.effect === "allow" && item.authority === "project-instruction") throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.projectInstructionCannotAllow", { action: item.action }));
    output.set(item.action, item);
  }
  return output;
}

export function validateRequest(request) {
  if (!validateRequestSchema(request)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.requestContractViolation", { errors: schemaErrors(validateRequestSchema).join("; ") }));
  if (!validateDiagnosisReportSchema(request.diagnosis.report)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisReportContractViolation", { errors: schemaErrors(validateDiagnosisReportSchema).join("; ") }));
  if (!validateTaskEnvelopeSchema(request.sourceTask.envelope)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.taskEnvelopeContractViolation", { errors: schemaErrors(validateTaskEnvelopeSchema).join("; ") }));
  if (!validateWorkflowReceiptSchema(request.sourceWorkflow.receipt)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.workflowReceiptContractViolation", { errors: schemaErrors(validateWorkflowReceiptSchema).join("; ") }));
  if (artifactDigest(request.diagnosis.report) !== request.diagnosis.digest) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisReportDigestMismatch"));
  if (diagnosisRequestDigest(request.diagnosis.request) !== request.diagnosis.requestDigest) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisRequestDigestMismatch"));
  const diagnosisErrors = validateDiagnosisReport(request.diagnosis.report, request.diagnosis.request, request.diagnosis.requestDigest);
  if (diagnosisErrors.length > 0) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisReportBindingViolation", { errors: diagnosisErrors.join("; ") }));
  if (artifactDigest(request.sourceTask.envelope) !== request.sourceTask.digest) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.sourceTaskDigestMismatch"));
  if (request.diagnosis.report.verdict !== "CAUSE_CONFIRMED" || !request.diagnosis.report.confirmedCause) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.causeConfirmedRequired"));
  const receipt = request.sourceWorkflow.receipt;
  if (artifactDigest(receipt) !== request.sourceWorkflow.receiptDigest) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.sourceReceiptDigestMismatch"));
  if (receipt.runId !== request.sourceWorkflow.runId || receipt.revision !== request.sourceWorkflow.revision || receipt.state !== request.sourceWorkflow.state) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.sourceWorkflowMetadataMismatch"));
  if (!request.sourceWorkflow.receiptLocator || receipt.plan.taskId !== request.sourceTask.envelope.taskId || receipt.plan.taskDigest !== request.sourceTask.digest) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.sourceReceiptNotBoundToTask"));
  if (request.diagnosis.request.objective !== request.sourceTask.envelope.objective) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisObjectiveMismatch"));
  const causeId = request.diagnosis.report.confirmedCause.causeId;
  if (causeId !== request.diagnosis.report.confirmedCause.hypothesisId) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.causeHypothesisIdMismatch"));
  const causeBindings = request.diagnosis.report.confirmedCause.evidenceBindings;
  const hasBoundDigest = (expectedDigest) => causeBindings.some((binding) => binding.artifactDigest === expectedDigest && binding.relation === "supports" && binding.hypothesisIds.includes(causeId));
  if (!hasBoundDigest(request.sourceTask.digest)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisNotBoundToTaskDigest"));
  if (!hasBoundDigest(request.sourceWorkflow.receiptDigest)) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.diagnosisNotBoundToReceiptDigest"));
  authorizationMap(request);
  const evidenceIds = request.evidenceIndex.map((item) => item.evidenceRef);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new InputError(hostText("skillChecksKo.recoveryStrategySelector.evidenceRefNotUnique"));
  return request;
}

function gateFor(strategy, request, auth) {
  const reasons = [];
  const sourceAuthorization = request.sourceTask.envelope.authorization;
  if (!strategy.objectivePreserved) reasons.push("objective-not-preserved");
  if (!strategy.acceptanceCriteriaPreserved) reasons.push("acceptance-criteria-not-preserved");
  if (strategy.causeFit === "none") reasons.push("confirmed-cause-not-addressed");
  if (strategy.addressesCauseId !== request.diagnosis.report.confirmedCause.causeId) reasons.push("confirmed-cause-id-mismatch");
  if (strategy.rootConditionDigest !== confirmedRootConditionDigest(request)) reasons.push("confirmed-root-condition-mismatch");
  if (!strategy.rootConditionChange.trim()) reasons.push("root-condition-change-missing");
  if (strategy.verificationStrength === "unavailable" || strategy.verificationPlan.length === 0) reasons.push("verification-unavailable");
  if (strategy.stopConditions.length === 0) reasons.push("stop-condition-missing");
  if (strategy.mutatesPriorRun) reasons.push("prior-run-mutation");
  const protectedTargets = [
    request.sourceWorkflow.runId,
    `run:${request.sourceWorkflow.runId}`,
    `workflow:${request.sourceWorkflow.runId}`,
    request.sourceWorkflow.receiptLocator,
  ];
  const targets = [...strategy.actions.map((item) => item.target), ...strategy.writeTargets];
  if (targets.some((target) => protectedTargets.some((protectedTarget) => {
    if (target === protectedTarget) return true;
    const suffix = target.startsWith(protectedTarget) ? target.slice(protectedTarget.length) : "";
    return /^[/#?:]/u.test(suffix);
  }))) reasons.push("prior-run-target");
  if (strategy.repeatsPriorAttempt || request.priorStrategyFingerprints.includes(strategy.strategyFingerprint)) reasons.push("unchanged-failed-attempt");
  if (strategy.preconditions.some((item) => item.status !== "satisfied")) reasons.push("precondition-not-satisfied");

  let approval = strategy.scopeExpansion;
  const requiredAuthorization = [];
  for (const action of strategy.actions) {
    const evidence = auth.get(action.name);
    if (sourceAuthorization.prohibitedActions.includes(action.name)) {
      reasons.push(`action-prohibited-by-source-task:${action.name}`);
    } else if (!evidence) {
      reasons.push(`authorization-missing:${action.name}`);
    } else if (evidence.effect === "prohibit") {
      reasons.push(`action-prohibited:${action.name}`);
    } else if (evidence.effect === "require-approval") {
      approval = true;
      requiredAuthorization.push(action.name);
    }
    if (sourceAuthorization.approvalRequired.includes(action.name)) {
      approval = true;
      requiredAuthorization.push(action.name);
    }
  }
  if (strategy.scopeExpansion) requiredAuthorization.push("scope-expansion");
  return {
    verdict: reasons.length ? "FAIL" : approval ? "REQUIRES_APPROVAL" : "PASS",
    reasons: sorted(reasons),
    requiredAuthorization: sorted(requiredAuthorization),
  };
}

const ranks = {
  causeFit: { direct: 3, containment: 2, workaround: 1, none: 0 },
  verificationStrength: { direct: 2, indirect: 1, unavailable: 0 },
  reversibility: { full: 2, partial: 1, none: 0 },
  failureImpact: { low: 3, medium: 2, high: 1, critical: 0 },
  gate: { PASS: 1, REQUIRES_APPROVAL: 0 },
};

function comparisonKey(strategy) {
  return [
    ranks.causeFit[strategy.causeFit],
    ranks.verificationStrength[strategy.verificationStrength],
    ranks.reversibility[strategy.reversibility],
    ranks.failureImpact[strategy.failureImpact],
    -strategy.changeBreadth,
    ranks.gate[strategy.objectiveGate.verdict],
  ];
}

function compareStrategies(left, right) {
  const a = comparisonKey(left);
  const b = comparisonKey(right);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return b[index] - a[index];
  }
  return 0;
}

function expectedOutcome(strategies, deliberation, evidence, panelRecords) {
  const survivors = strategies.filter((item) => item.objectiveGate.verdict !== "FAIL");
  if (survivors.length === 0) return { survivors, leaders: [], selected: null, verdict: "NO_VIABLE_STRATEGY" };
  const ordered = [...survivors].sort(compareStrategies);
  const leaders = ordered.filter((item) => compareStrategies(item, ordered[0]) === 0);
  // An exact tie is broken only by a deliberation record that picks a tied leader on verified evidence, at least one of
  // which is the panel's own DecisionRecord: cause evidence alone is not a deliberation (review 902e).
  const resolved = leaders.length > 1 && deliberation?.evidenceRefs.every((ref) => evidence.has(ref))
    && deliberation.evidenceRefs.some((ref) => panelRecords.has(ref))
    ? leaders.find((item) => item.strategyId === deliberation.selectedStrategyId)
    : null;
  if (leaders.length > 1 && !resolved) return { survivors, leaders, selected: null, verdict: "NEEDS_INPUT" };
  const selected = resolved ?? leaders[0];
  return { survivors, leaders, selected, verdict: selected.objectiveGate.verdict === "REQUIRES_APPROVAL" ? "NEEDS_APPROVAL" : "SELECTED" };
}

function validateTaskSeed(seed, selected, request, errors) {
  if (!seed) {
    errors.push(hostText("skillChecksKo.recoveryStrategySelector.nextTaskSeedRequired"));
    return;
  }
  const source = request.sourceTask.envelope;
  if (seed.objective !== source.objective) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedObjectiveNotPreserved"));
  if (seed.recoveryObjective !== selected.summary) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedRecoveryObjectiveMismatch"));
  if (seed.addressesCauseId !== selected.addressesCauseId) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedCauseIdMismatch"));
  if (seed.rootConditionDigest !== selected.rootConditionDigest) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedRootConditionDigestMismatch"));
  if (!selected.scopeExpansion && !equalValues(seed.scope, source.scope)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedScopeNotPreserved"));
  if (selected.scopeExpansion) {
    const included = new Set(seed.scope.included);
    if (source.scope.included.some((item) => !included.has(item)) || equalValues(seed.scope, source.scope)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedScopeExpansionUnclear"));
  }
  if (!equalValues(seed.acceptanceCriteria, source.acceptanceCriteria)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedAcceptanceCriteriaMismatch"));
  const constraints = sorted([...source.constraints, ...request.constraints]);
  if (!equalValues(sorted(seed.constraints), constraints)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedConstraintsNotPreserved"));
  const requested = sorted(selected.actions.map((item) => item.name));
  if (!equalValues(sorted(seed.requestedActions), requested)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedRequestedActionsMismatch"));
  const targets = new Set(selected.writeTargets);
  const boundTargets = new Set();
  const workUnitIds = new Set();
  for (const unit of seed.workUnits) {
    if (workUnitIds.has(unit.id)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.workUnitIdDuplicate", { id: unit.id }));
    workUnitIds.add(unit.id);
    unit.writeTargets.forEach((target) => boundTargets.add(target));
    if (unit.writeTargets.some((target) => !targets.has(target))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.workUnitOutsideWriteTarget", { id: unit.id }));
  }
  if (!equalValues(sorted(boundTargets), sorted(targets))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedWorkUnitsTargetsMismatch"));
  if (!equalValues(seed.verificationPlan, selected.verificationPlan)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.seedVerificationPlanMismatch"));
}

export function validateHandoff(request, handoff, frozenRequestDigest = null) {
  const errors = [];
  try { validateRequest(request); } catch (error) { return [error.message]; }
  if (!validateHandoffSchema(handoff)) return schemaErrors(validateHandoffSchema);
  const auth = authorizationMap(request);
  const computedRequestDigest = selectionRequestDigest(request);
  const expectedRequestDigest = frozenRequestDigest ?? computedRequestDigest;
  if (handoff.selectionRequestDigest !== expectedRequestDigest || expectedRequestDigest !== computedRequestDigest) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffRequestDigestMismatch"));
  if (!equalValues(handoff.sourceTask, { taskId: request.sourceTask.envelope.taskId, envelopeDigest: request.sourceTask.digest })) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffSourceTaskMismatch"));
  if (!equalValues(handoff.sourceWorkflow, { runId: request.sourceWorkflow.runId, revision: request.sourceWorkflow.revision, receiptDigest: request.sourceWorkflow.receiptDigest })) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffSourceWorkflowMismatch"));
  const causeId = request.diagnosis.report.confirmedCause.causeId;
  const rootConditionDigest = confirmedRootConditionDigest(request);
  if (!equalValues(handoff.diagnosis, { reportDigest: request.diagnosis.digest, requestArtifactDigest: request.diagnosis.report.requestArtifactDigest, confirmedCauseId: causeId, rootConditionDigest })) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffDiagnosisMismatch"));

  const ids = handoff.strategies.map((item) => item.strategyId);
  if (new Set(ids).size !== ids.length) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyIdNotUnique"));
  const fingerprints = new Set();
  const identities = new Set();
  const evidence = verifiedRefs(request);
  for (const strategy of handoff.strategies) {
    const fingerprint = strategyFingerprint(strategy);
    if (strategy.strategyFingerprint !== fingerprint) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyFingerprintMismatch", { strategyId: strategy.strategyId }));
    if (fingerprints.has(fingerprint)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyDuplicateStructure"));
    fingerprints.add(fingerprint);
    const identity = strategyIdentityFingerprint(strategy);
    if (identities.has(identity)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyDuplicateIdentity"));
    identities.add(identity);
    if (strategy.changeBreadth !== strategy.writeTargets.length) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyChangeBreadthMismatch", { strategyId: strategy.strategyId }));
    const expectedGate = gateFor(strategy, request, auth);
    if (strategy.objectiveGate.verdict !== expectedGate.verdict || !equalValues(sorted(strategy.objectiveGate.reasons), expectedGate.reasons)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyGateMismatch", { strategyId: strategy.strategyId }));
    if (!equalValues(sorted(strategy.requiredAuthorization), expectedGate.requiredAuthorization)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyRequiredAuthorizationMismatch", { strategyId: strategy.strategyId }));
    if (strategy.addressesCauseId !== causeId) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyCauseIdMismatch", { strategyId: strategy.strategyId }));
    if (strategy.rootConditionDigest !== rootConditionDigest) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyRootConditionDigestMismatch", { strategyId: strategy.strategyId }));
    const refs = [...strategy.evidenceRefs, ...strategy.preconditions.flatMap((item) => item.evidenceRefs)];
    if (refs.some((ref) => !evidence.has(ref))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.strategyUnverifiedEvidence", { strategyId: strategy.strategyId }));
  }

  const deliberation = handoff.crossReview.deliberation;
  const panelRecords = panelRecordRefs(request);
  const outcome = expectedOutcome(handoff.strategies, deliberation, evidence, panelRecords);
  const survivorIds = outcome.survivors.map((item) => item.strategyId);
  if (!equalValues(sorted(handoff.survivingStrategyIds), sorted(survivorIds))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.survivingStrategyIdsMismatch"));
  if (handoff.verdict !== outcome.verdict) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffVerdictMismatch", { verdict: outcome.verdict }));
  if (handoff.selectedStrategyId !== (outcome.selected?.strategyId ?? null)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.selectedStrategyIdMismatch"));

  if (outcome.survivors.length <= 1) {
    if (handoff.crossReview.status !== "not-required" || handoff.crossReview.reviews.length || handoff.crossReview.unresolvedStrategyIds.length) errors.push(hostText("skillChecksKo.recoveryStrategySelector.crossReviewNotAllowed"));
  } else {
    const reviewIds = handoff.crossReview.reviews.map((item) => item.strategyId);
    if (!equalValues(sorted(reviewIds), sorted(survivorIds)) || new Set(reviewIds).size !== reviewIds.length) errors.push(hostText("skillChecksKo.recoveryStrategySelector.crossReviewCoverage"));
    if (handoff.crossReview.reviews.flatMap((item) => item.evidenceRefs).some((ref) => !evidence.has(ref))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.crossReviewUnverifiedEvidence"));
    const expectedStatus = outcome.selected ? "completed" : "unresolved";
    if (handoff.crossReview.status !== expectedStatus) errors.push(hostText("skillChecksKo.recoveryStrategySelector.crossReviewStatusMismatch", { status: expectedStatus }));
    const unresolved = outcome.selected ? [] : outcome.leaders.map((item) => item.strategyId);
    if (!equalValues(sorted(handoff.crossReview.unresolvedStrategyIds), sorted(unresolved))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.crossReviewUnresolvedMismatch"));
  }
  if (deliberation) {
    if (outcome.leaders.length < 2) errors.push(hostText("skillChecksKo.recoveryStrategySelector.deliberationOnlyOnTie"));
    if (deliberation.evidenceRefs.some((ref) => !evidence.has(ref))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.deliberationUnverifiedEvidence"));
    if (!deliberation.evidenceRefs.some((ref) => panelRecords.has(ref))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.deliberationPanelRecordRequired", { kind: PANEL_DECISION_RECORD_KIND }));
    if (deliberation.selectedStrategyId !== null && !outcome.leaders.some((item) => item.strategyId === deliberation.selectedStrategyId)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.deliberationSelectedNotLeader"));
  }

  if (outcome.selected) {
    validateTaskSeed(handoff.nextTaskSeed, outcome.selected, request, errors);
    if (!equalValues(sorted(handoff.approvalRequired), sorted(outcome.selected.requiredAuthorization))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.handoffApprovalRequiredMismatch"));
  } else {
    if (handoff.nextTaskSeed !== null || handoff.approvalRequired.length) errors.push(hostText("skillChecksKo.recoveryStrategySelector.noSelectionNoSeed"));
  }
  return errors;
}

export async function validateTaskBinding(request, handoff, taskContractRequest, taskContractReport) {
  const errors = validateHandoff(request, handoff);
  const seed = handoff?.nextTaskSeed;
  const envelope = taskContractReport?.taskEnvelope;
  const handoffDigest = artifactDigest(handoff ?? null);
  if (errors.length > 0) {
    return {
      schemaVersion: "1.0.0",
      valid: false,
      handoffDigest,
      taskEnvelopeDigest: envelope ? artifactDigest(envelope) : null,
      errors,
    };
  }
  if (!seed || !envelope) errors.push(hostText("skillChecksKo.recoveryStrategySelector.bindingInputsRequired"));
  else {
    try {
      await validateTaskContract({ schemaVersion: "1.0.0", request: taskContractRequest, report: taskContractReport });
    } catch (error) {
      errors.push(hostText("skillChecksKo.recoveryStrategySelector.taskContractReportInvalid", { reason: error instanceof Error ? error.message : String(error) }));
    }
    if (taskContractReport.verdict !== "PASS") errors.push(hostText("skillChecksKo.recoveryStrategySelector.newContractVerdictNotPass"));
    if (envelope.taskId === handoff.sourceTask.taskId) errors.push(hostText("skillChecksKo.recoveryStrategySelector.recoveryTaskIdMustDiffer"));
    for (const field of ["objective", "scope", "acceptanceCriteria", "constraints", "workUnits", "requiredCapabilities"]) {
      if (!equalValues(envelope[field], seed[field])) errors.push(hostText("skillChecksKo.recoveryStrategySelector.envelopeFieldSeedMismatch", { field }));
    }
    const authorityEvidence = taskContractRequest?.authorizationEvidence ?? [];
    const allowedEvidence = new Map(authorityEvidence.filter((item) => item.effect === "allow" && ["system", "developer", "user"].includes(item.authority) && !item.sourceLocator.startsWith("recovery-handoff:")).map((item) => [item.action, item]));
    for (const action of handoff.approvalRequired.filter((item) => item !== "scope-expansion")) if (!allowedEvidence.has(action)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.approvalActionNoAuthority", { action }));
    if (handoff.approvalRequired.includes("scope-expansion")) {
      if (!allowedEvidence.has("scope-expansion")) errors.push(hostText("skillChecksKo.recoveryStrategySelector.scopeExpansionNoAuthority"));
    }
    const sourceAllowed = new Set(request.sourceTask.envelope.authorization.allowedActions);
    const requestedActions = new Set(seed.requestedActions);
    for (const action of envelope.authorization.allowedActions) {
      if (!sourceAllowed.has(action) && (!requestedActions.has(action) || !allowedEvidence.has(action))) errors.push(hostText("skillChecksKo.recoveryStrategySelector.envelopeAllowedActionExpanded", { action }));
    }
    for (const action of requestedActions) if (!envelope.authorization.allowedActions.includes(action)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.envelopeActionNotAllowed", { action }));
    for (const action of request.sourceTask.envelope.authorization.prohibitedActions) if (!envelope.authorization.prohibitedActions.includes(action)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.envelopeProhibitedActionRemoved", { action }));
    for (const action of request.sourceTask.envelope.authorization.approvalRequired) {
      if (!envelope.authorization.approvalRequired.includes(action) && !allowedEvidence.has(action)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.envelopeApprovalRequirementRemoved", { action }));
    }
    const locator = `recovery-handoff:${handoffDigest}`;
    if (taskContractRequest?.taskId !== envelope.taskId || !taskContractRequest?.suppliedFacts?.some((item) => item.locator === locator)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.taskContractRequestNotBound"));
    for (const field of ["/objective", "/scope", "/acceptanceCriteria", "/workUnits"]) {
      if (!taskContractReport.provenance?.some((item) => (item.field === field || item.field.startsWith(`${field}/`)) && item.sourceLocator === locator)) errors.push(hostText("skillChecksKo.recoveryStrategySelector.provenanceNotBound", { field }));
    }
  }
  return {
    schemaVersion: "1.0.0",
    valid: errors.length === 0,
    handoffDigest,
    taskEnvelopeDigest: envelope ? artifactDigest(envelope) : null,
    errors,
  };
}
