import { CONTEXT_TRANSITION_ACTIONS, type CheckpointDeltaReceiverV1, type ContextTransitionBindingV1,
  type ContextTransitionIntentV1 } from "../../../contracts/types.js";

export type ActivityScopeV1 = Readonly<Pick<ContextTransitionBindingV1,
  "taskId" | "revision" | "contextGeneration"> & { receiver: Readonly<CheckpointDeltaReceiverV1> }>;

/** Each tracker reports its own freshness; one fresh tracker cannot mask a missing one. */
export interface ActivityObservationV1<T> {
  readonly sourceId: string;
  readonly availability: "available" | "unavailable" | "unknown";
  readonly observedAtMs: number | null;
  readonly expiresAtMs: number | null;
  readonly value: T | null;
}

export interface ActivitySnapshotV1 {
  readonly scope: ActivityScopeV1;
  readonly workflowMutation: ActivityObservationV1<boolean>;
  readonly activeJobs: ActivityObservationV1<number>;
  readonly activeChildren: ActivityObservationV1<number>;
  readonly pendingIntents: ActivityObservationV1<number>;
}

/** C15 supplies authoritative observations. This port has no mutation or host operation. */
export interface ActivitySnapshotPort {
  readActivitySnapshot(scope: ActivityScopeV1): Promise<ActivitySnapshotV1 | null>;
}

type BoundaryReason = "explicit-safe" | "snapshot-unavailable" | "scope-mismatch" | "source-unavailable"
  | "source-unknown" | "source-stale" | "activity-unknown" | "workflow-mutation" | "active-job"
  | "active-child" | "pending-intent" | "unsupported-action";

export interface SafeBoundaryDecisionV1 {
  readonly boundary: "safe" | "busy" | "unknown";
  readonly action: ContextTransitionIntentV1["action"];
  /** Permits review only; it is neither admission nor a transition result/base ACK. */
  readonly reviewAllowed: boolean;
  readonly reason: BoundaryReason;
}

const activityFields = ["workflowMutation", "activeJobs", "activeChildren", "pendingIntents"] as const;
const busyReasons = { workflowMutation: "workflow-mutation", activeJobs: "active-job",
  activeChildren: "active-child", pendingIntents: "pending-intent" } as const;
const isTime = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function scopeMatches(expected: ActivityScopeV1, actual: ActivityScopeV1 | undefined): boolean {
  return actual != null && expected.receiver != null && actual.receiver != null
    && [expected.taskId, expected.receiver.host, expected.receiver.sessionId, expected.receiver.instanceId]
      .every(value => typeof value === "string" && value.trim().length > 0)
    && isTime(expected.revision) && isTime(expected.contextGeneration)
    && expected.taskId === actual.taskId && expected.revision === actual.revision
    && expected.contextGeneration === actual.contextGeneration
    && expected.receiver.host === actual.receiver.host
    && expected.receiver.sessionId === actual.receiver.sessionId
    && expected.receiver.instanceId === actual.receiver.instanceId;
}

/** Consumes a C01-validated intent. A later runner must reobserve at the effect boundary. */
export function evaluateSafeBoundary(intent: ContextTransitionIntentV1,
  snapshot: ActivitySnapshotV1 | null | undefined, nowMs: number): SafeBoundaryDecisionV1 {
  const unknown = (reason: BoundaryReason): SafeBoundaryDecisionV1 =>
    ({ boundary: "unknown", action: "CONTINUE", reviewAllowed: false, reason });
  if (!CONTEXT_TRANSITION_ACTIONS.includes(intent.action)) return unknown("unsupported-action");
  if (snapshot == null) return unknown("snapshot-unavailable");
  if (!scopeMatches(intent.binding, snapshot.scope)) return unknown("scope-mismatch");
  if (!isTime(nowMs)) return unknown("source-stale");

  // Unknown sources/values are never coerced to false or zero, including incomplete JS input.
  for (const field of activityFields) {
    const observation = snapshot[field];
    if (observation == null || observation.availability === "unavailable") return unknown("source-unavailable");
    if (observation.availability !== "available" || typeof observation.sourceId !== "string"
      || observation.sourceId.trim().length === 0) return unknown("source-unknown");
    if (!isTime(observation.observedAtMs) || !isTime(observation.expiresAtMs)
      || observation.observedAtMs > nowMs || observation.expiresAtMs <= nowMs) return unknown("source-stale");
    if (field === "workflowMutation" ? typeof observation.value !== "boolean" : !isTime(observation.value)) {
      return unknown("activity-unknown");
    }
    if (observation.value !== false && observation.value !== 0) {
      return { boundary: "busy", action: "CONTINUE", reviewAllowed: false, reason: busyReasons[field] };
    }
  }
  return { boundary: "safe", action: intent.action, reviewAllowed: intent.action !== "CONTINUE", reason: "explicit-safe" };
}
