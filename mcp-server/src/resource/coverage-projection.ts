import { WorkflowContractError } from "../../../contracts/types.js";

const id = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const digest = /^sha256:[a-f0-9]{64}$/u;
type Coverage = "complete" | "partial" | "unknown";
type Inclusion = "included" | "excluded" | "unknown" | "different-unit";

/** All inclusion claims must already be admitted from the snapshot's trusted producer. */
export type CoverageSnapshotV1 = {
  accountScope: string; poolId: string; windowId: string; resetEpoch: number;
  unit: string; metricKind: "used" | "remaining";
  observedAmount: number | null; coverage: Coverage;
  jobBindingDigest: string;
  /** Proven members. Absence from this list alone says nothing. */
  includedEventIds: readonly string[];
  /** Proven nonmembers; absence from this list alone says nothing. */
  excludedEventIds: readonly string[];
  /** Included, gap-free prefix of the job's normal delta stream; later events are unknown. */
  watermarkSequence: number | null;
};
export type CoverageEventV1 = {
  eventId: string; accountScope: string; poolId: string; windowId: string;
  resetEpoch: number; jobBindingDigest: string; unit: string;
  amount: number | null; basis: "delta" | "cumulative";
  sequence: number | null;
  /** Corrections are never inferred included by a normal-event watermark. */
  correctsEventId: string | null;
};
export type InternalSlotBudgetV1 = {
  unit: "slot"; reservedAmount: number; observedUse: number | null;
};
export type CoverageProjectionInputV1 = {
  snapshot: CoverageSnapshotV1;
  events: readonly CoverageEventV1[];
  internalSlotBudget: InternalSlotBudgetV1;
};
export type CoverageProjectionV1 = {
  providerMetric: {
    unit: string; metricKind: "used" | "remaining";
    observedAmount: number | null; coverage: Coverage;
    knownExcludedDelta: number;
    projectedAmount: number | null;
  };
  internalSlotBudget: InternalSlotBudgetV1;
  eventInclusion: ReadonlyArray<{ eventId: string; status: Inclusion }>;
  needsReconciliation: boolean;
};

function invalid(message: string): never {
  throw new WorkflowContractError("INVALID_INPUT", message);
}
function quantity(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function scopeMatches(snapshot: CoverageSnapshotV1, event: CoverageEventV1): boolean {
  return snapshot.accountScope === event.accountScope && snapshot.poolId === event.poolId
    && snapshot.windowId === event.windowId && snapshot.resetEpoch === event.resetEpoch;
}

/** Pure, conservative projection. It neither writes a ledger nor authorizes settlement. */
export function projectSnapshotCoverageV1(input: CoverageProjectionInputV1): CoverageProjectionV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || !input.snapshot || !Array.isArray(input.events) || !input.internalSlotBudget) {
    invalid("Invalid coverage projection input.");
  }
  const { snapshot, events, internalSlotBudget } = input;
  if (!/^acct-hmac-sha256:[a-f0-9]{64}$/u.test(snapshot.accountScope)
    || !id.test(snapshot.poolId) || !id.test(snapshot.windowId)
    || !id.test(snapshot.unit) || !digest.test(snapshot.jobBindingDigest)
    || !["used", "remaining"].includes(snapshot.metricKind)
    || !Number.isSafeInteger(snapshot.resetEpoch) || snapshot.resetEpoch < 0
    || !["complete", "partial", "unknown"].includes(snapshot.coverage)
    || (snapshot.observedAmount !== null && !quantity(snapshot.observedAmount))
    || (snapshot.coverage === "complete" && snapshot.observedAmount === null)
    || !Array.isArray(snapshot.includedEventIds)
    || snapshot.includedEventIds.some(eventId => !id.test(eventId))
    || new Set(snapshot.includedEventIds).size !== snapshot.includedEventIds.length
    || !Array.isArray(snapshot.excludedEventIds)
    || snapshot.excludedEventIds.some(eventId => !id.test(eventId))
    || new Set(snapshot.excludedEventIds).size !== snapshot.excludedEventIds.length
    || snapshot.excludedEventIds.some(eventId => snapshot.includedEventIds.includes(eventId))
    || (snapshot.watermarkSequence !== null
      && (!Number.isSafeInteger(snapshot.watermarkSequence) || snapshot.watermarkSequence < 0))) {
    invalid("Invalid snapshot coverage or inclusion proof.");
  }
  if (internalSlotBudget.unit !== "slot" || !quantity(internalSlotBudget.reservedAmount)
    || (internalSlotBudget.observedUse !== null && !quantity(internalSlotBudget.observedUse))) {
    invalid("Invalid internal slot budget.");
  }
  const seen = new Set<string>();
  const included = new Set(snapshot.includedEventIds);
  const excluded = new Set(snapshot.excludedEventIds);
  let knownExcludedDelta = 0;
  let needsReconciliation = snapshot.coverage !== "complete";
  const eventInclusion: Array<{ eventId: string; status: Inclusion }> = [];
  for (const event of events) {
    if (!event || typeof event !== "object" || !id.test(event.eventId)
      || !/^acct-hmac-sha256:[a-f0-9]{64}$/u.test(event.accountScope)
      || !id.test(event.poolId) || !id.test(event.windowId)
      || !id.test(event.unit) || !digest.test(event.jobBindingDigest)
      || !Number.isSafeInteger(event.resetEpoch) || event.resetEpoch < 0
      || !["delta", "cumulative"].includes(event.basis)
      || (event.amount !== null && !quantity(event.amount))
      || (event.sequence !== null && (!Number.isSafeInteger(event.sequence) || event.sequence < 1))
      || (event.correctsEventId !== null && !id.test(event.correctsEventId))
      || seen.has(event.eventId) || !scopeMatches(snapshot, event)) {
      invalid("Invalid, duplicate, or foreign usage event.");
    }
    seen.add(event.eventId);
    if (excluded.has(event.eventId) && event.correctsEventId === null
      && event.basis === "delta" && snapshot.watermarkSequence !== null
      && event.sequence !== null && event.sequence <= snapshot.watermarkSequence
      && event.unit === snapshot.unit && event.jobBindingDigest === snapshot.jobBindingDigest) {
      invalid("Explicit exclusion contradicts the included watermark prefix.");
    }
    let status: Inclusion;
    if (event.unit !== snapshot.unit) status = "different-unit";
    else if (event.jobBindingDigest !== snapshot.jobBindingDigest) status = "unknown";
    else if (included.has(event.eventId)) status = "included";
    else if (excluded.has(event.eventId)) status = "excluded";
    else if (event.correctsEventId !== null || event.basis !== "delta") status = "unknown";
    else if (snapshot.watermarkSequence === null || event.sequence === null) status = "unknown";
    else status = event.sequence <= snapshot.watermarkSequence ? "included" : "unknown";
    eventInclusion.push({ eventId: event.eventId, status });
    if (status === "excluded" && event.basis === "delta"
      && event.correctsEventId === null && event.amount !== null) {
      knownExcludedDelta += event.amount;
      if (!Number.isFinite(knownExcludedDelta)) invalid("Excluded usage overflows.");
    }
    if (status === "unknown" || status === "different-unit"
      || (status === "excluded" && (event.basis !== "delta"
        || event.correctsEventId !== null || event.amount === null))) {
      needsReconciliation = true;
    }
  }
  const projected = !needsReconciliation && snapshot.observedAmount !== null
    ? snapshot.observedAmount + (snapshot.metricKind === "used" ? 1 : -1) * knownExcludedDelta
    : null;
  if (projected !== null && !Number.isFinite(projected)) invalid("Projected usage overflows.");
  return {
    providerMetric: { unit: snapshot.unit, metricKind: snapshot.metricKind,
      observedAmount: snapshot.observedAmount,
      coverage: snapshot.coverage, knownExcludedDelta, projectedAmount: projected },
    internalSlotBudget: { ...internalSlotBudget }, eventInclusion, needsReconciliation,
  };
}
