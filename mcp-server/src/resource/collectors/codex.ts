import { createHash, createHmac } from "node:crypto";

import { WorkflowContractError } from "../../../../contracts/types.js";
import { type CollectorProjectionV1, type CollectorScopeV1, type ResourceCollectorPortV1, type ResourceCollectorResponseV1,
  type ResourceWindowV1, validateCollectorResponseV1, validateCollectorScopeV1 } from "../collector-port.js";

interface CodexWindow { usedPercent: number; resetsAt?: number | null; windowDurationMins?: number | null }
interface CodexBucket { limitId?: string | null; primary?: CodexWindow | null; secondary?: CodexWindow | null }
interface CodexRead {
  accountId?: string | null;
  rateLimits: CodexBucket;
  rateLimitsByLimitId?: Record<string, CodexBucket> | null;
}

/** Supply only a server-owned app-server connection. Caller JSON is not an authenticated read. */
export interface CodexRateLimitsReaderV1 { readRateLimits(): Promise<unknown> }

export interface CodexCollectorOptionsV1 {
  collectorId: string;
  resourcePoolId: string;
  /** The raw account ID is used only while deriving the registered scope. */
  accountId: string;
  hmacKey: Uint8Array;
  reader: CodexRateLimitsReaderV1;
  now?: () => Date;
  /** Server-owned R13 projection for the same scope; required when resuming an existing registry entry. */
  resume?: Pick<CollectorProjectionV1, "scope" | "sequence" | "knownWindows">;
}

function invalid(): never { throw new WorkflowContractError("INVALID_INPUT", "Invalid Codex resource response."); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function window(value: unknown): value is CodexWindow {
  return record(value) && Number.isSafeInteger(value.usedPercent)
    && (value.resetsAt == null || Number.isSafeInteger(value.resetsAt))
    && (value.windowDurationMins == null || Number.isSafeInteger(value.windowDurationMins));
}
function bucket(value: unknown): value is CodexBucket {
  return record(value) && (value.primary == null || window(value.primary))
    && (value.secondary == null || window(value.secondary));
}
function read(value: unknown): value is CodexRead {
  return record(value) && bucket(value.rateLimits)
    && (value.accountId == null || typeof value.accountId === "string")
    && (value.rateLimitsByLimitId == null || (record(value.rateLimitsByLimitId)
      && Object.values(value.rateLimitsByLimitId).every(bucket)));
}
function resetAt(seconds: number | null | undefined): string | null {
  if (seconds == null) return null;
  const millis = seconds * 1000;
  if (!Number.isSafeInteger(millis) || millis < 0 || millis > 8.64e15) invalid();
  return new Date(millis).toISOString();
}
function opaqueBucketId(id: string): string {
  return `codex-${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
}

/** Full reads avoid sparse notification ordering and legacy/multi-bucket double counting. */
export class CodexResourceCollectorV1 implements ResourceCollectorPortV1 {
  readonly scope: CollectorScopeV1;
  private readonly hmacKey: Uint8Array;
  private readonly reader: CodexRateLimitsReaderV1;
  private readonly now: () => Date;
  private sequence = 0;
  private readonly knownWindows = new Map<string, { resetEpoch: number; revision: number }>();
  private pending: Promise<void> = Promise.resolve();

  constructor(options: CodexCollectorOptionsV1) {
    if (!options.accountId || options.hmacKey.byteLength < 32
      || typeof options.reader?.readRateLimits !== "function") invalid();
    this.hmacKey = Uint8Array.from(options.hmacKey);
    this.scope = Object.freeze(validateCollectorScopeV1({
      collectorId: options.collectorId, source: "provider-reported",
      accountScope: this.accountScope(options.accountId), resourcePoolId: options.resourcePoolId,
    }));
    this.reader = options.reader;
    this.now = options.now ?? (() => new Date());
    if (options.resume) {
      const { scope, sequence, knownWindows } = options.resume;
      if (!scope || scope.collectorId !== this.scope.collectorId || scope.source !== this.scope.source
        || scope.accountScope !== this.scope.accountScope || scope.resourcePoolId !== this.scope.resourcePoolId
        || !Number.isSafeInteger(sequence) || sequence < 1 || !Array.isArray(knownWindows)) invalid();
      for (const item of knownWindows) {
        if (!item || typeof item.windowId !== "string" || this.knownWindows.has(item.windowId)
          || !Number.isSafeInteger(item.resetEpoch) || item.resetEpoch < 0
          || !Number.isSafeInteger(item.revision) || item.revision < 0) invalid();
        this.knownWindows.set(item.windowId, { resetEpoch: item.resetEpoch, revision: item.revision });
      }
      this.sequence = sequence;
    }
  }

  private accountScope(accountId: string): string {
    return `acct-hmac-sha256:${createHmac("sha256", this.hmacKey).update(accountId).digest("hex")}`;
  }

  collect(): Promise<ResourceCollectorResponseV1> {
    const next = this.pending.then(() => this.collectOnce());
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  /** Notification payloads carry no sequence; always re-read and ignore their sparse values. */
  onRateLimitsUpdated(): Promise<ResourceCollectorResponseV1> {
    return this.collect();
  }

  private async collectOnce(): Promise<ResourceCollectorResponseV1> {
    if (!Number.isSafeInteger(this.sequence + 1)) invalid();
    let raw: unknown;
    try { raw = await this.reader.readRateLimits(); }
    catch { return this.unavailable("temporarily-unavailable"); }
    if (!read(raw)) invalid();
    if (!raw.accountId) return this.unavailable("not-exposed");
    if (this.accountScope(raw.accountId) !== this.scope.accountScope) {
      throw new WorkflowContractError("INVALID_INPUT", "Codex account scope changed.");
    }
    const observedAt = this.now();
    if (!Number.isFinite(observedAt.getTime())) invalid();
    const ttlExpiresAt = observedAt.getTime() + 5 * 60_000;
    const byId = raw.rateLimitsByLimitId;
    const buckets = byId && Object.keys(byId).length
      ? Object.entries(byId) : [["legacy", raw.rateLimits]] as Array<[string, CodexBucket]>;
    const windows: ResourceWindowV1[] = [];
    for (const [id, value] of buckets) {
      for (const slot of ["primary", "secondary"] as const) {
        const input = value[slot];
        if (!input) continue;
        const bucketId = opaqueBucketId(id);
        const windowId = `${bucketId}-${slot}`;
        const prior = this.knownWindows.get(windowId);
        const revision = (prior?.revision ?? 0) + 1;
        if (!Number.isSafeInteger(revision)) invalid();
        const reset = resetAt(input.resetsAt);
        const resetMillis = reset ? Date.parse(reset) : null;
        if (resetMillis !== null && resetMillis <= observedAt.getTime()) {
          return this.unavailable("temporarily-unavailable");
        }
        windows.push({ windowId, resetEpoch: prior?.resetEpoch ?? 0,
          resetAt: reset, revision,
          limitBucket: { bucketId, kind: "subscription-percent", unit: "percent", limit: 100,
            remaining: input.usedPercent >= 0 && input.usedPercent <= 100 ? 100 - input.usedPercent : null },
          coverage: "unknown", source: { kind: "provider-observation", evidenceDigest: null },
          observedAt: observedAt.toISOString(),
          expiresAt: new Date(Math.min(ttlExpiresAt, resetMillis ?? ttlExpiresAt)).toISOString() });
      }
    }
    if (!windows.length) return this.unavailable("not-exposed");
    if (windows.length > 64) invalid();
    const response = { schemaVersion: "1.0.0", kind: "full", ...this.scope,
      sequence: ++this.sequence, snapshot: { schemaVersion: "1.0.0", accountScope: this.scope.accountScope,
        resourcePoolId: this.scope.resourcePoolId, accessPath: "subscription", windows } } as const;
    const checked = validateCollectorResponseV1(response, this.scope);
    for (const item of windows) this.knownWindows.set(item.windowId,
      { resetEpoch: item.resetEpoch, revision: item.revision });
    return checked;
  }

  private unavailable(reason: "not-exposed" | "temporarily-unavailable"): ResourceCollectorResponseV1 {
    return validateCollectorResponseV1({ schemaVersion: "1.0.0", kind: "unavailable", ...this.scope,
      sequence: ++this.sequence, reason }, this.scope);
  }
}
