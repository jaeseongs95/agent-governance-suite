import type { CheckpointDeltaV1 } from "../../../contracts/types.js";
import { ContractValidator } from "../schema-validator.js";
import { type DeltaCommitFunctions, type DeltaCommitResult, type DeltaReceiverScope, SqliteContinuityStore } from "../continuity-store.js";
import { applyCheckpointDelta } from "./apply-checkpoint-delta.js";

/** Internal receiver boundary. Scope must come from verified server state, not a delta or transport ACK. */
export class CheckpointDeltaReceiver {
  private readonly validator = new ContractValidator();

  constructor(private readonly store: SqliteContinuityStore, private readonly scope: DeltaReceiverScope) {}

  /** Bind a verified receiver to the current full continuity checkpoint. */
  bind(): boolean {
    return this.store.bindDeltaReceiver(this.scope, (value) => this.validator.continuitySnapshot(value));
  }

  /** A transport receipt is not accepted here; only an A06 delta can change state. */
  receive(value: unknown): DeltaCommitResult {
    const delta: CheckpointDeltaV1 = this.validator.checkpointDelta(value);
    const functions: DeltaCommitFunctions = {
      validateCheckpoint: (item) => this.validator.continuitySnapshot(item),
      validateAck: (item) => this.validator.checkpointDeltaStateAck(item),
      apply: applyCheckpointDelta,
    };
    return this.store.commitDelta(this.scope, delta, functions);
  }
}
