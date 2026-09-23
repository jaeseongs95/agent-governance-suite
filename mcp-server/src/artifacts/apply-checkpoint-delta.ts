import type { CheckpointDeltaReceiverV1, ContinuitySnapshotV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { convergenceDigest } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";

export interface CheckpointDeltaExpectedV1 {
  /** Receiver-owned values, never copied from the delta. */
  taskId: string;
  revision: number;
  receiver: CheckpointDeltaReceiverV1;
  contextGeneration: number;
  sequence: number;
}

const validator = new ContractValidator();

/** Reconstructs a checkpoint value only; persistence and state ACK belong to the receiver CAS. */
export function applyCheckpointDelta(
  baseValue: unknown, deltaValue: unknown, expected: CheckpointDeltaExpectedV1,
): ContinuitySnapshotV1 {
  const delta = validator.checkpointDeltaForReceiver(deltaValue, expected);
  const base = validator.continuitySnapshot(baseValue);
  if (delta.taskId !== expected.taskId || delta.revision !== expected.revision
    || delta.sequence !== expected.sequence
    || base.taskCorrelation !== expected.taskId || base.revision !== expected.revision) {
    throw new WorkflowContractError("GATE_FAILED", "Checkpoint delta task, revision or sequence changed.");
  }
  if (convergenceDigest(snapshotContent(base)) !== base.snapshotDigest
    || delta.baseCheckpointDigest !== base.snapshotDigest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Checkpoint delta base digest differs from the verified checkpoint.");
  }

  const target = structuredClone(base);
  for (const operation of delta.operations) {
    switch (operation.path) {
      case "/status": target.status = operation.value; break;
      case "/core/objective": target.core.objective = operation.value; break;
      case "/core/completionCriteria": target.core.completionCriteria = structuredClone(operation.value); break;
      case "/core/constraints": target.core.constraints = structuredClone(operation.value); break;
      case "/core/decisions": target.core.decisions = structuredClone(operation.value); break;
      case "/core/progress": target.core.progress = structuredClone(operation.value); break;
      case "/core/blockers": target.core.blockers = structuredClone(operation.value); break;
      case "/core/nextActions": target.core.nextActions = structuredClone(operation.value); break;
      case "/evidenceRefs": target.evidenceRefs = structuredClone(operation.value); break;
      default: throw new WorkflowContractError("INVALID_INPUT", "Checkpoint delta path is not applicable.");
    }
  }
  target.snapshotDigest = delta.targetCheckpointDigest;
  validator.continuitySnapshot(target);
  if (convergenceDigest(snapshotContent(target)) !== delta.targetCheckpointDigest) {
    throw new WorkflowContractError("INTEGRITY_FAILED", "Checkpoint delta does not reproduce its target digest.");
  }
  return target;
}

function snapshotContent(snapshot: ContinuitySnapshotV1): Partial<ContinuitySnapshotV1> {
  const content: Partial<ContinuitySnapshotV1> = { ...snapshot };
  delete content.snapshotDigest;
  return content;
}
