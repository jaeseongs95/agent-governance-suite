import { createHash } from "node:crypto";

import { requestArtifactDigest as diagnosisRequestDigest, validateReport as validateDiagnosisReport } from "../../blocker-diagnostician/scripts/core.mjs";
import { validateTaskContract } from "../../task-contract/scripts/validate-task-contract.mjs";
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

function authorizationMap(request) {
  const output = new Map();
  for (const item of request.authorizationEvidence) {
    if (output.has(item.action)) throw new InputError(`authorizationEvidence action은 하나만 허용됩니다: ${item.action}`);
    if (item.effect === "allow" && item.authority === "project-instruction") throw new InputError(`project-instruction은 allowed action 권한을 만들 수 없습니다: ${item.action}`);
    output.set(item.action, item);
  }
  return output;
}

export function validateRequest(request) {
  if (!validateRequestSchema(request)) throw new InputError(`RecoveryStrategySelectionRequest.v1 계약 위반: ${schemaErrors(validateRequestSchema).join("; ")}`);
  if (!validateDiagnosisReportSchema(request.diagnosis.report)) throw new InputError(`DiagnosisReport.v1 계약 위반: ${schemaErrors(validateDiagnosisReportSchema).join("; ")}`);
  if (!validateTaskEnvelopeSchema(request.sourceTask.envelope)) throw new InputError(`TaskEnvelope.v1 계약 위반: ${schemaErrors(validateTaskEnvelopeSchema).join("; ")}`);
  if (!validateWorkflowReceiptSchema(request.sourceWorkflow.receipt)) throw new InputError(`WorkflowReceipt.v1 계약 위반: ${schemaErrors(validateWorkflowReceiptSchema).join("; ")}`);
  if (artifactDigest(request.diagnosis.report) !== request.diagnosis.digest) throw new InputError("diagnosis report digest가 payload와 일치하지 않습니다.");
  if (diagnosisRequestDigest(request.diagnosis.request) !== request.diagnosis.requestDigest) throw new InputError("diagnosis request digest가 payload와 일치하지 않습니다.");
  const diagnosisErrors = validateDiagnosisReport(request.diagnosis.report, request.diagnosis.request, request.diagnosis.requestDigest);
  if (diagnosisErrors.length > 0) throw new InputError(`DiagnosisReport.v1 원본 결속 위반: ${diagnosisErrors.join("; ")}`);
  if (artifactDigest(request.sourceTask.envelope) !== request.sourceTask.digest) throw new InputError("source task digest가 TaskEnvelope와 일치하지 않습니다.");
  if (request.diagnosis.report.verdict !== "CAUSE_CONFIRMED" || !request.diagnosis.report.confirmedCause) throw new InputError("recovery 전략 선택에는 CAUSE_CONFIRMED diagnosis가 필요합니다.");
  const receipt = request.sourceWorkflow.receipt;
  if (artifactDigest(receipt) !== request.sourceWorkflow.receiptDigest) throw new InputError("source workflow receipt digest가 payload와 일치하지 않습니다.");
  if (receipt.runId !== request.sourceWorkflow.runId || receipt.revision !== request.sourceWorkflow.revision || receipt.state !== request.sourceWorkflow.state) throw new InputError("source workflow metadata가 receipt payload와 일치하지 않습니다.");
  if (!request.sourceWorkflow.receiptLocator || receipt.plan.taskId !== request.sourceTask.envelope.taskId || receipt.plan.taskDigest !== request.sourceTask.digest) throw new InputError("source workflow receipt가 원본 task envelope에 결속되지 않았습니다.");
  if (request.diagnosis.request.objective !== request.sourceTask.envelope.objective) throw new InputError("diagnosis request objective가 source task objective와 일치하지 않습니다.");
  const causeId = request.diagnosis.report.confirmedCause.causeId;
  if (causeId !== request.diagnosis.report.confirmedCause.hypothesisId) throw new InputError("confirmed diagnosis causeId와 hypothesisId가 일치하지 않습니다.");
  const causeBindings = request.diagnosis.report.confirmedCause.evidenceBindings;
  const hasBoundDigest = (expectedDigest) => causeBindings.some((binding) => binding.artifactDigest === expectedDigest && binding.relation === "supports" && binding.hypothesisIds.includes(causeId));
  if (!hasBoundDigest(request.sourceTask.digest)) throw new InputError("confirmed diagnosis가 source task envelope digest에 결속되지 않았습니다.");
  if (!hasBoundDigest(request.sourceWorkflow.receiptDigest)) throw new InputError("confirmed diagnosis가 source workflow receipt digest에 결속되지 않았습니다.");
  authorizationMap(request);
  const evidenceIds = request.evidenceIndex.map((item) => item.evidenceRef);
  if (new Set(evidenceIds).size !== evidenceIds.length) throw new InputError("evidenceIndex evidenceRef는 고유해야 합니다.");
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

function expectedOutcome(strategies) {
  const survivors = strategies.filter((item) => item.objectiveGate.verdict !== "FAIL");
  if (survivors.length === 0) return { survivors, leaders: [], selected: null, verdict: "NO_VIABLE_STRATEGY" };
  const ordered = [...survivors].sort(compareStrategies);
  const leaders = ordered.filter((item) => compareStrategies(item, ordered[0]) === 0);
  if (leaders.length > 1) return { survivors, leaders, selected: null, verdict: "NEEDS_INPUT" };
  const selected = leaders[0];
  return { survivors, leaders, selected, verdict: selected.objectiveGate.verdict === "REQUIRES_APPROVAL" ? "NEEDS_APPROVAL" : "SELECTED" };
}

function validateTaskSeed(seed, selected, request, errors) {
  if (!seed) {
    errors.push("selected strategy에는 nextTaskSeed가 필요합니다.");
    return;
  }
  const source = request.sourceTask.envelope;
  if (seed.objective !== source.objective) errors.push("nextTaskSeed objective는 원래 objective를 보존해야 합니다.");
  if (seed.recoveryObjective !== selected.summary) errors.push("nextTaskSeed recoveryObjective는 선택 전략 summary와 일치해야 합니다.");
  if (seed.addressesCauseId !== selected.addressesCauseId) errors.push("nextTaskSeed addressesCauseId는 선택 전략과 일치해야 합니다.");
  if (seed.rootConditionDigest !== selected.rootConditionDigest) errors.push("nextTaskSeed rootConditionDigest는 선택 전략과 일치해야 합니다.");
  if (!selected.scopeExpansion && !equalValues(seed.scope, source.scope)) errors.push("scope expansion이 없는 nextTaskSeed는 원래 scope를 정확히 보존해야 합니다.");
  if (selected.scopeExpansion) {
    const included = new Set(seed.scope.included);
    if (source.scope.included.some((item) => !included.has(item)) || equalValues(seed.scope, source.scope)) errors.push("scope expansion 전략은 원래 included scope를 보존하면서 변경 범위를 명시해야 합니다.");
  }
  if (!equalValues(seed.acceptanceCriteria, source.acceptanceCriteria)) errors.push("nextTaskSeed acceptanceCriteria는 원래 기준과 정확히 일치해야 합니다.");
  const constraints = sorted([...source.constraints, ...request.constraints]);
  if (!equalValues(sorted(seed.constraints), constraints)) errors.push("nextTaskSeed constraints는 원래 제약과 recovery 제약을 모두 보존해야 합니다.");
  const requested = sorted(selected.actions.map((item) => item.name));
  if (!equalValues(sorted(seed.requestedActions), requested)) errors.push("nextTaskSeed requestedActions는 선택 전략 actions와 일치해야 합니다.");
  const targets = new Set(selected.writeTargets);
  const boundTargets = new Set();
  const workUnitIds = new Set();
  for (const unit of seed.workUnits) {
    if (workUnitIds.has(unit.id)) errors.push(`work unit id가 중복됩니다: ${unit.id}`);
    workUnitIds.add(unit.id);
    unit.writeTargets.forEach((target) => boundTargets.add(target));
    if (unit.writeTargets.some((target) => !targets.has(target))) errors.push(`work unit ${unit.id}가 선택 전략 밖의 write target을 포함합니다.`);
  }
  if (!equalValues(sorted(boundTargets), sorted(targets))) errors.push("nextTaskSeed workUnits는 선택 전략의 모든 write target을 정확히 결속해야 합니다.");
  if (!equalValues(seed.verificationPlan, selected.verificationPlan)) errors.push("nextTaskSeed verificationPlan은 선택 전략과 일치해야 합니다.");
}

export function validateHandoff(request, handoff, frozenRequestDigest = null) {
  const errors = [];
  try { validateRequest(request); } catch (error) { return [error.message]; }
  if (!validateHandoffSchema(handoff)) return schemaErrors(validateHandoffSchema);
  const auth = authorizationMap(request);
  const computedRequestDigest = selectionRequestDigest(request);
  const expectedRequestDigest = frozenRequestDigest ?? computedRequestDigest;
  if (handoff.selectionRequestDigest !== expectedRequestDigest || expectedRequestDigest !== computedRequestDigest) errors.push("handoff가 외부에 동결된 selection request digest와 일치하지 않습니다.");
  if (!equalValues(handoff.sourceTask, { taskId: request.sourceTask.envelope.taskId, envelopeDigest: request.sourceTask.digest })) errors.push("handoff sourceTask 결속이 일치하지 않습니다.");
  if (!equalValues(handoff.sourceWorkflow, { runId: request.sourceWorkflow.runId, revision: request.sourceWorkflow.revision, receiptDigest: request.sourceWorkflow.receiptDigest })) errors.push("handoff sourceWorkflow 결속이 일치하지 않습니다.");
  const causeId = request.diagnosis.report.confirmedCause.causeId;
  const rootConditionDigest = confirmedRootConditionDigest(request);
  if (!equalValues(handoff.diagnosis, { reportDigest: request.diagnosis.digest, requestArtifactDigest: request.diagnosis.report.requestArtifactDigest, confirmedCauseId: causeId, rootConditionDigest })) errors.push("handoff diagnosis 결속이 일치하지 않습니다.");

  const ids = handoff.strategies.map((item) => item.strategyId);
  if (new Set(ids).size !== ids.length) errors.push("strategyId는 고유해야 합니다.");
  const fingerprints = new Set();
  const identities = new Set();
  const evidence = verifiedRefs(request);
  for (const strategy of handoff.strategies) {
    const fingerprint = strategyFingerprint(strategy);
    if (strategy.strategyFingerprint !== fingerprint) errors.push(`strategy ${strategy.strategyId} fingerprint가 일치하지 않습니다.`);
    if (fingerprints.has(fingerprint)) errors.push("구조적으로 동일한 recovery 전략을 중복 제출할 수 없습니다.");
    fingerprints.add(fingerprint);
    const identity = strategyIdentityFingerprint(strategy);
    if (identities.has(identity)) errors.push("mechanism, actions, writeTargets가 같은 복구 전략을 중복 제출할 수 없습니다.");
    identities.add(identity);
    if (strategy.changeBreadth !== strategy.writeTargets.length) errors.push(`strategy ${strategy.strategyId} changeBreadth는 write target 수와 일치해야 합니다.`);
    const expectedGate = gateFor(strategy, request, auth);
    if (strategy.objectiveGate.verdict !== expectedGate.verdict || !equalValues(sorted(strategy.objectiveGate.reasons), expectedGate.reasons)) errors.push(`strategy ${strategy.strategyId} Objective Gate 결과가 결정적 판정과 일치하지 않습니다.`);
    if (!equalValues(sorted(strategy.requiredAuthorization), expectedGate.requiredAuthorization)) errors.push(`strategy ${strategy.strategyId} requiredAuthorization이 권한 근거와 일치하지 않습니다.`);
    if (strategy.addressesCauseId !== causeId) errors.push(`strategy ${strategy.strategyId} addressesCauseId가 confirmed cause와 일치하지 않습니다.`);
    if (strategy.rootConditionDigest !== rootConditionDigest) errors.push(`strategy ${strategy.strategyId} rootConditionDigest가 confirmed root condition과 일치하지 않습니다.`);
    const refs = [...strategy.evidenceRefs, ...strategy.preconditions.flatMap((item) => item.evidenceRefs)];
    if (refs.some((ref) => !evidence.has(ref))) errors.push(`strategy ${strategy.strategyId}가 검증되지 않은 evidence를 참조합니다.`);
  }

  const outcome = expectedOutcome(handoff.strategies);
  const survivorIds = outcome.survivors.map((item) => item.strategyId);
  if (!equalValues(sorted(handoff.survivingStrategyIds), sorted(survivorIds))) errors.push("survivingStrategyIds가 Objective Gate 결과와 일치하지 않습니다.");
  if (handoff.verdict !== outcome.verdict) errors.push(`handoff verdict는 ${outcome.verdict}여야 합니다.`);
  if (handoff.selectedStrategyId !== (outcome.selected?.strategyId ?? null)) errors.push("selectedStrategyId가 고정 비교 순서와 일치하지 않습니다.");

  if (outcome.survivors.length <= 1) {
    if (handoff.crossReview.status !== "not-required" || handoff.crossReview.reviews.length || handoff.crossReview.unresolvedStrategyIds.length) errors.push("생존 전략이 하나 이하이면 cross review를 실행하지 않습니다.");
  } else {
    const reviewIds = handoff.crossReview.reviews.map((item) => item.strategyId);
    if (!equalValues(sorted(reviewIds), sorted(survivorIds)) || new Set(reviewIds).size !== reviewIds.length) errors.push("cross review는 모든 생존 전략을 정확히 한 번 검토해야 합니다.");
    if (handoff.crossReview.reviews.flatMap((item) => item.evidenceRefs).some((ref) => !evidence.has(ref))) errors.push("cross review가 검증되지 않은 evidence를 참조합니다.");
    const expectedStatus = outcome.selected ? "completed" : "unresolved";
    if (handoff.crossReview.status !== expectedStatus) errors.push(`cross review status는 ${expectedStatus}여야 합니다.`);
    const unresolved = outcome.selected ? [] : outcome.leaders.map((item) => item.strategyId);
    if (!equalValues(sorted(handoff.crossReview.unresolvedStrategyIds), sorted(unresolved))) errors.push("cross review unresolvedStrategyIds가 동률 결과와 일치하지 않습니다.");
  }

  if (outcome.selected) {
    validateTaskSeed(handoff.nextTaskSeed, outcome.selected, request, errors);
    if (!equalValues(sorted(handoff.approvalRequired), sorted(outcome.selected.requiredAuthorization))) errors.push("handoff approvalRequired가 선택 전략과 일치하지 않습니다.");
  } else {
    if (handoff.nextTaskSeed !== null || handoff.approvalRequired.length) errors.push("선택 전략이 없으면 nextTaskSeed와 approvalRequired는 비어야 합니다.");
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
  if (!seed || !envelope) errors.push("검증된 nextTaskSeed와 TaskContractReport.taskEnvelope가 필요합니다.");
  else {
    try {
      await validateTaskContract({ schemaVersion: "1.0.0", request: taskContractRequest, report: taskContractReport });
    } catch (error) {
      errors.push(`TaskContractReport.v1 검증 실패: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (taskContractReport.verdict !== "PASS") errors.push("새 task contract verdict는 PASS여야 합니다.");
    if (envelope.taskId === handoff.sourceTask.taskId) errors.push("복구 작업은 원본과 다른 taskId를 사용해야 합니다.");
    for (const field of ["objective", "scope", "acceptanceCriteria", "constraints", "workUnits", "requiredCapabilities"]) {
      if (!equalValues(envelope[field], seed[field])) errors.push(`새 TaskEnvelope ${field}가 recovery task seed와 일치하지 않습니다.`);
    }
    const authorityEvidence = taskContractRequest?.authorizationEvidence ?? [];
    const allowedEvidence = new Map(authorityEvidence.filter((item) => item.effect === "allow" && ["system", "developer", "user"].includes(item.authority) && !item.sourceLocator.startsWith("recovery-handoff:")).map((item) => [item.action, item]));
    for (const action of handoff.approvalRequired.filter((item) => item !== "scope-expansion")) if (!allowedEvidence.has(action)) errors.push(`승인 필요 action에 실제 상위 권한 근거가 없습니다: ${action}`);
    if (handoff.approvalRequired.includes("scope-expansion")) {
      if (!allowedEvidence.has("scope-expansion")) errors.push("scope expansion에 실제 상위 권한 근거가 없습니다.");
    }
    const sourceAllowed = new Set(request.sourceTask.envelope.authorization.allowedActions);
    const requestedActions = new Set(seed.requestedActions);
    for (const action of envelope.authorization.allowedActions) {
      if (!sourceAllowed.has(action) && (!requestedActions.has(action) || !allowedEvidence.has(action))) errors.push(`새 TaskEnvelope가 근거 없이 allowed action을 확대했습니다: ${action}`);
    }
    for (const action of requestedActions) if (!envelope.authorization.allowedActions.includes(action)) errors.push(`선택 전략 action이 새 TaskEnvelope에서 허용되지 않았습니다: ${action}`);
    for (const action of request.sourceTask.envelope.authorization.prohibitedActions) if (!envelope.authorization.prohibitedActions.includes(action)) errors.push(`새 TaskEnvelope가 원본 prohibited action을 제거했습니다: ${action}`);
    for (const action of request.sourceTask.envelope.authorization.approvalRequired) {
      if (!envelope.authorization.approvalRequired.includes(action) && !allowedEvidence.has(action)) errors.push(`새 TaskEnvelope가 승인 없이 원본 approval requirement를 제거했습니다: ${action}`);
    }
    const locator = `recovery-handoff:${handoffDigest}`;
    if (taskContractRequest?.taskId !== envelope.taskId || !taskContractRequest?.suppliedFacts?.some((item) => item.locator === locator)) errors.push("TaskContractRequest가 recovery handoff digest에 결속되지 않았습니다.");
    for (const field of ["/objective", "/scope", "/acceptanceCriteria", "/workUnits"]) {
      if (!taskContractReport.provenance?.some((item) => (item.field === field || item.field.startsWith(`${field}/`)) && item.sourceLocator === locator)) errors.push(`${field} provenance가 recovery handoff digest에 결속되지 않았습니다.`);
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
