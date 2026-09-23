import type { ArtifactRefV1, CheckpointDeltaV1, ContinuitySnapshotV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { convergenceDigest } from "../convergence-logic.js";
import type { DeltaReceiverScope } from "../continuity-store.js";
import { ContractValidator } from "../schema-validator.js";
import { ArtifactReferenceAccess } from "./reference-access.js";

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

/** A08 gate: only an access-checked full checkpoint can restore a missing receiver base. */
export class CheckpointDeltaResync {
  private readonly validator = new ContractValidator();
  private scope: DeltaReceiverScope;
  private targetDigest: string;
  private checkpoint: ContinuitySnapshotV1 | null = null;
  private version = 0;

  /** Scope and target digest must come from trusted receiver state, not a delta or ACK. */
  constructor(private readonly access: ArtifactReferenceAccess, scope: DeltaReceiverScope, targetDigest: string) {
    this.scope = cloneScope(scope);
    this.targetDigest = checkedDigest(targetDigest);
  }

  get status(): "resync-required" | "ready" { return this.checkpoint ? "ready" : "resync-required"; }

  /** Instance or generation changes revoke the old base, even within one session. */
  changeReceiver(scope: DeltaReceiverScope, targetDigest: string): void {
    const digest = checkedDigest(targetDigest);
    const changed = !sameScope(this.scope, scope);
    this.scope = cloneScope(scope);
    this.expectTarget(digest, changed);
  }

  /** Called when the receiver no longer holds its base. */
  loseBase(targetDigest: string): void { this.expectTarget(targetDigest, true); }

  /** A newer target invalidates a reference read that is still in flight. */
  targetChanged(targetDigest: string): void { this.expectTarget(targetDigest, false); }

  async resume(value: unknown): Promise<ContinuitySnapshotV1> {
    const ref: ArtifactRefV1 = this.validator.artifactRef(value);
    if (ref.namespace !== "task" || ref.hashDomain !== "raw-bytes" || ref.mediaType !== "application/json") {
      throw new WorkflowContractError("INVALID_INPUT", "Resync requires a task-scoped raw JSON checkpoint reference.");
    }
    const version = this.version;
    const expected = this.targetDigest;
    const scope = cloneScope(this.scope);
    const bytes = await this.access.read(ref);
    if (version !== this.version || !sameScope(scope, this.scope) || expected !== this.targetDigest) {
      throw new WorkflowContractError("GATE_FAILED", "Resync target changed during checkpoint read.");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString("utf8")) as unknown; }
    catch { throw new WorkflowContractError("INTEGRITY_FAILED", "Checkpoint reference is not JSON."); }
    const snapshot = this.validator.continuitySnapshot(parsed);
    const { snapshotDigest, ...content } = snapshot;
    if (snapshot.taskCorrelation !== scope.taskId || snapshot.epoch !== scope.epoch
      || snapshotDigest !== expected || convergenceDigest(content) !== snapshotDigest) {
      throw new WorkflowContractError("INTEGRITY_FAILED", "Checkpoint reference does not match the current receiver target.");
    }
    this.checkpoint = structuredClone(snapshot);
    return structuredClone(snapshot);
  }

  /** Returns a base only after resync; A07-b remains the sole state ACK and CAS authority. */
  baseForDelta(value: unknown): ContinuitySnapshotV1 | null {
    if (!this.checkpoint) return null;
    const delta: CheckpointDeltaV1 = this.validator.checkpointDelta(value);
    if (delta.taskId !== this.scope.taskId || delta.revision !== this.checkpoint.revision
      || delta.receiver.host !== this.scope.receiver.host
      || delta.receiver.sessionId !== this.scope.receiver.sessionId
      || delta.receiver.instanceId !== this.scope.receiver.instanceId
      || delta.contextGeneration !== this.scope.contextGeneration
      || delta.baseCheckpointDigest !== this.checkpoint.snapshotDigest) return null;
    return structuredClone(this.checkpoint);
  }

  private expectTarget(value: string, revoke: boolean): void {
    const digest = checkedDigest(value);
    if (revoke || digest !== this.targetDigest) {
      this.targetDigest = digest;
      this.checkpoint = null;
      this.version += 1;
    }
  }
}

function checkedDigest(value: string): string {
  if (!digestPattern.test(value)) throw new WorkflowContractError("INVALID_INPUT", "Invalid checkpoint target digest.");
  return value;
}

function cloneScope(scope: DeltaReceiverScope): DeltaReceiverScope {
  return { taskId: scope.taskId, epoch: scope.epoch, receiver: { ...scope.receiver },
    contextGeneration: scope.contextGeneration };
}

function sameScope(left: DeltaReceiverScope, right: DeltaReceiverScope): boolean {
  return left.taskId === right.taskId && left.epoch === right.epoch
    && left.receiver.host === right.receiver.host
    && left.receiver.sessionId === right.receiver.sessionId
    && left.receiver.instanceId === right.receiver.instanceId
    && left.contextGeneration === right.contextGeneration;
}
