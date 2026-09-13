import {
  CONTRACT_VERSION,
  type ConvergenceRootHandleV1,
  type ConvergenceRootV1,
  type ConvergenceStatusSummaryV1,
  type ConvergenceStatusV1,
  type WorkflowReceiptV1,
  type WorkflowStatusSummaryV1,
} from "../../contracts/types.js";
import { convergenceDigest } from "./convergence-logic.js";

export function convergenceRootHandle(root: ConvergenceRootV1): ConvergenceRootHandleV1 {
  return {
    schemaVersion: CONTRACT_VERSION,
    rootId: root.rootId,
    revision: root.revision,
    state: root.state,
    currentEpoch: root.currentEpoch,
    taskDigest: root.taskDigest,
    frameDigest: root.frameDigest,
    workspaceDigest: root.workspaceDigest,
    controlDigest: root.controlDigest,
    targetDigest: root.targetDigest,
    operationalDigest: root.operationalDigest,
  };
}

export function workflowStatusSummary(receipt: WorkflowReceiptV1): WorkflowStatusSummaryV1 {
  return {
    schemaVersion: CONTRACT_VERSION,
    runId: receipt.runId,
    revision: receipt.revision,
    state: receipt.state,
    currentStageId: receipt.plan.currentStageId,
    nextStageId: receipt.plan.nextStageId,
    lastRecordedStageId: receipt.stageResults.at(-1)?.stageId ?? null,
    completedStageCount: receipt.stageResults.length,
    totalStageCount: receipt.plan.stages.length,
    blockerCount: receipt.blockers.length,
    unresolvedCount: receipt.unresolved.length,
    errorCode: receipt.error?.code ?? null,
    receiptDigest: convergenceDigest(receipt),
  };
}

export function convergenceStatusSummary(status: ConvergenceStatusV1): ConvergenceStatusSummaryV1 {
  const latestOutcome = status.outcomes.at(-1);
  const issuedLease = [...status.leases].reverse().find((lease) => lease.state === "issued");
  return {
    schemaVersion: CONTRACT_VERSION,
    root: convergenceRootHandle(status.root),
    currentEpoch: status.currentEpoch,
    maxAttemptsPerEpoch: status.maxAttemptsPerEpoch,
    maxEpochs: status.maxEpochs,
    attemptsUsedInEpoch: status.attemptsUsedInEpoch,
    attemptsRemainingInEpoch: status.attemptsRemainingInEpoch,
    issuedLeaseId: issuedLease?.leaseId ?? null,
    latestWorkflowRunId: status.workflowRunIds.at(-1) ?? null,
    latestOutcomeId: latestOutcome?.outcomeId ?? null,
    latestOutcomeState: latestOutcome?.state ?? null,
    latestOutcomeReceiptDigest: latestOutcome?.receiptDigest ?? null,
    proposalCount: status.proposals.length,
    leaseCount: status.leases.length,
    outcomeCount: status.outcomes.length,
    reviewCount: status.reviews.length,
    gateErrorCode: status.gateError?.code ?? null,
  };
}
