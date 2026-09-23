import { createHash } from "node:crypto";

import type { ResourceStateSnapshotV1 } from "../../../contracts/types.js";
import { WorkflowContractError } from "../../../contracts/types.js";
import { canonicalJson } from "../convergence-logic.js";
import { ContractValidator } from "../schema-validator.js";

export type CollectorSourceV1 = "fake" | "operator-configured" | "provider-reported";
export type ResourceWindowV1 = ResourceStateSnapshotV1["windows"][number];

/** This scope must be supplied by a server-owned collector registry, not by a model call. */
export interface CollectorScopeV1 {
  collectorId: string;
  source: CollectorSourceV1;
  accountScope: string;
  resourcePoolId: string;
}

interface CollectorEnvelopeV1 extends CollectorScopeV1 {
  schemaVersion: "1.0.0";
  sequence: number;
}

export type ResourceCollectorResponseV1 = CollectorEnvelopeV1 & (
  | { kind: "full"; snapshot: ResourceStateSnapshotV1 }
  | { kind: "delta"; baseSequence: number; upsertWindows: ResourceWindowV1[]; removeWindowIds: string[] }
  | { kind: "unavailable"; reason: "not-exposed" | "temporarily-unavailable" }
);

export interface ResourceCollectorPortV1 {
  readonly scope: CollectorScopeV1;
  collect(): Promise<ResourceCollectorResponseV1>;
}

/** Transition candidate only. B03 must authenticate the collector and atomically admit raw evidence. */
export interface CollectorProjectionV1 {
  scope: CollectorScopeV1;
  sequence: number;
  responseDigest: string;
  observationAdmitted: false;
  availability: "available" | "unavailable";
  snapshot: ResourceStateSnapshotV1 | null;
  /** Preserve monotonicity across unavailable and removed windows without exposing stale quantities. */
  knownWindows: Array<{ windowId: string; resetEpoch: number; revision: number; digest: string }>;
}

const validator = new ContractValidator();
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/u;
const accountPattern = /^acct-hmac-sha256:[a-f0-9]{64}$/u;
const sourceKinds: Record<CollectorSourceV1, ResourceWindowV1["source"]["kind"]> = {
  fake: "user-declared",
  "operator-configured": "configured",
  "provider-reported": "provider-observation",
};

function invalid(message: string): never { throw new WorkflowContractError("INVALID_INPUT", message); }

function exactKeys(value: unknown, expected: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== expected.length
    || expected.some((key) => !Object.hasOwn(value, key))) invalid("Unknown or missing collector field.");
}

function validSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === "number" && value > 0;
}

export function validateCollectorScopeV1(value: unknown): CollectorScopeV1 {
  exactKeys(value, ["collectorId", "source", "accountScope", "resourcePoolId"]);
  if (typeof value.collectorId !== "string" || !idPattern.test(value.collectorId)
    || !(value.source === "fake" || value.source === "operator-configured" || value.source === "provider-reported")
    || typeof value.accountScope !== "string" || !accountPattern.test(value.accountScope)
    || typeof value.resourcePoolId !== "string" || !idPattern.test(value.resourcePoolId)) {
    invalid("Invalid collector scope.");
  }
  return value as unknown as CollectorScopeV1;
}

function validateWindows(snapshot: ResourceStateSnapshotV1, scope: CollectorScopeV1): void {
  if (snapshot.accountScope !== scope.accountScope || snapshot.resourcePoolId !== scope.resourcePoolId
    || snapshot.windows.some((window) => window.source.kind !== sourceKinds[scope.source])) {
    invalid("Collector snapshot scope or source does not match its registered identity.");
  }
}

function checkWindowRevision(window: ResourceWindowV1, known: CollectorProjectionV1["knownWindows"],
  allowIdentical: boolean): void {
  const prior = known.find((item) => item.windowId === window.windowId);
  if (!prior) return;
  const digest = `sha256:${createHash("sha256").update(canonicalJson(window)).digest("hex")}`;
  if (window.resetEpoch < prior.resetEpoch
    || (window.resetEpoch === prior.resetEpoch && (window.revision < prior.revision
      || (window.revision === prior.revision && (!allowIdentical || digest !== prior.digest))))) {
    invalid("Collector window revision regresses or conflicts with its last known value.");
  }
}

/** Reject extra fields and source laundering before a response can be projected. */
export function validateCollectorResponseV1(value: unknown, registeredScope: CollectorScopeV1): ResourceCollectorResponseV1 {
  const scope = validateCollectorScopeV1(registeredScope);
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Invalid collector response.");
  const record = value as Record<string, unknown>;
  const common = ["schemaVersion", "kind", "collectorId", "source", "accountScope", "resourcePoolId", "sequence"];
  if (record.kind === "full") exactKeys(record, [...common, "snapshot"]);
  else if (record.kind === "delta") exactKeys(record, [...common, "baseSequence", "upsertWindows", "removeWindowIds"]);
  else if (record.kind === "unavailable") exactKeys(record, [...common, "reason"]);
  else invalid("Unknown collector response kind.");
  if (record.schemaVersion !== "1.0.0" || !validSequence(record.sequence)
    || record.collectorId !== scope.collectorId || record.source !== scope.source
    || record.accountScope !== scope.accountScope || record.resourcePoolId !== scope.resourcePoolId) {
    invalid("Collector response does not match its registered scope.");
  }
  if (record.kind === "full") {
    const snapshot = validator.resourceStateSnapshotV1(record.snapshot);
    validateWindows(snapshot, scope);
  } else if (record.kind === "delta") {
    if (!validSequence(record.baseSequence) || record.baseSequence >= record.sequence
      || !Array.isArray(record.upsertWindows) || !Array.isArray(record.removeWindowIds)
      || record.upsertWindows.length + record.removeWindowIds.length === 0
      || record.upsertWindows.length > 64 || record.removeWindowIds.length > 64
      || record.removeWindowIds.some((id) => typeof id !== "string" || !idPattern.test(id))) {
      invalid("Invalid collector delta.");
    }
    const upserts = record.upsertWindows as ResourceWindowV1[];
    const removals = record.removeWindowIds as string[];
    if (new Set(upserts.map((window) => window?.windowId)).size !== upserts.length
      || new Set(removals).size !== removals.length
      || upserts.some((window) => removals.includes(window?.windowId))) invalid("Conflicting collector delta window IDs.");
    if (upserts.length) {
      const snapshot = validator.resourceStateSnapshotV1({ schemaVersion: "1.0.0",
        accountScope: scope.accountScope, resourcePoolId: scope.resourcePoolId,
        accessPath: "subscription", windows: upserts });
      validateWindows(snapshot, scope);
    }
  } else if (record.reason !== "not-exposed" && record.reason !== "temporarily-unavailable") {
    invalid("Invalid collector unavailability reason.");
  }
  return structuredClone(value) as ResourceCollectorResponseV1;
}

/** Pure sequence/base projection. A duplicate is idempotent only when its bytes agree. */
export function projectCollectorResponseV1(registeredScope: CollectorScopeV1,
  current: CollectorProjectionV1 | null, input: unknown):
  { kind: "applied" | "duplicate" | "out-of-order" | "resync-required"; state: CollectorProjectionV1 | null } {
  const response = validateCollectorResponseV1(input, registeredScope);
  const digest = `sha256:${createHash("sha256").update(canonicalJson(response)).digest("hex")}`;
  if (current) {
    if (canonicalJson(current.scope) !== canonicalJson(registeredScope)) invalid("Collector state scope mismatch.");
    if (response.sequence < current.sequence) return { kind: "out-of-order", state: structuredClone(current) };
    if (response.sequence === current.sequence) {
      if (digest !== current.responseDigest) throw new WorkflowContractError("SNAPSHOT_CONFLICT", "Conflicting duplicate collector sequence.");
      return { kind: "duplicate", state: structuredClone(current) };
    }
  }
  if (response.kind === "delta" && (!current || current.availability !== "available" || !current.snapshot
    || response.sequence !== current.sequence + 1 || response.baseSequence !== current.sequence)) {
    return { kind: "resync-required", state: current ? structuredClone(current) : null };
  }
  let snapshot: ResourceStateSnapshotV1 | null = null;
  if (response.kind === "full") {
    snapshot = response.snapshot;
    for (const window of snapshot.windows) checkWindowRevision(window, current?.knownWindows ?? [], true);
  }
  if (response.kind === "delta" && current?.snapshot) {
    const removals = new Set(response.removeWindowIds);
    const windows = new Map(current.snapshot.windows.filter((window) => !removals.has(window.windowId))
      .map((window) => [window.windowId, window]));
    for (const window of response.upsertWindows) windows.set(window.windowId, window);
    snapshot = validator.resourceStateSnapshotV1({ ...current.snapshot, windows: [...windows.values()] });
    validateWindows(snapshot, registeredScope);
    for (const window of response.upsertWindows) checkWindowRevision(window, current.knownWindows, false);
  }
  const knownWindows = new Map((current?.knownWindows ?? []).map((window) => [window.windowId, window]));
  for (const window of snapshot?.windows ?? []) knownWindows.set(window.windowId, {
    windowId: window.windowId, resetEpoch: window.resetEpoch, revision: window.revision,
    digest: `sha256:${createHash("sha256").update(canonicalJson(window)).digest("hex")}`,
  });
  return { kind: "applied", state: { scope: structuredClone(registeredScope), sequence: response.sequence,
    responseDigest: digest, observationAdmitted: false,
    availability: response.kind === "unavailable" ? "unavailable" : "available",
    snapshot: snapshot ? structuredClone(snapshot) : null,
    knownWindows: structuredClone([...knownWindows.values()]) } };
}
