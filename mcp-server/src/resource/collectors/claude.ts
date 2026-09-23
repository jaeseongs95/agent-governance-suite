import { WorkflowContractError } from "../../../../contracts/types.js";
import { type CollectorProjectionV1, type CollectorScopeV1, type ResourceCollectorPortV1,
  type ResourceCollectorResponseV1,
  validateCollectorResponseV1, validateCollectorScopeV1 } from "../collector-port.js";

/** A server-owned reader of Claude Code transcript events, never model-supplied JSON. */
export interface ClaudeUsageReaderV1 { readLatestUsage(): Promise<unknown | null> }

export interface ClaudeUsageObservationV1 {
  source: "claude-code-transcript";
  coverage: "unknown";
  sequence: number;
  observedAt: string;
  inputTokens: number;
  cacheReadInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  /** Per-message output is provisional in Claude Code; do not promote it. */
  outputTokens: null;
  quotaWindow: null;
}

export interface ClaudeUsageCollectorOptionsV1 {
  /** A server-registered pseudonymous scope. Transcript usage does not bind an account itself. */
  scope: CollectorScopeV1;
  reader: ClaudeUsageReaderV1;
  now?: () => Date;
  /** Server-owned R13 projection for the same scope, required to resume a registration. */
  resume?: Pick<CollectorProjectionV1, "scope" | "sequence">;
}

function invalid(): never { throw new WorkflowContractError("INVALID_INPUT", "Invalid Claude usage observation."); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function optionalCount(value: unknown): number | null {
  if (value == null) return null;
  if (!count(value)) invalid();
  return value;
}

function parseUsage(event: unknown, sequence: number, observedAt: string): ClaudeUsageObservationV1 | null {
  if (!record(event) || event.type !== "assistant" || !record(event.message)
    || event.message.type !== "message" || event.message.role !== "assistant"
    || typeof event.message.model !== "string" || !event.message.model
    || !record(event.message.usage)) return null;
  const usage = event.message.usage;
  if (!count(usage.input_tokens)) return null;
  const cacheRead = optionalCount(usage.cache_read_input_tokens);
  const cacheCreation = optionalCount(usage.cache_creation_input_tokens);
  const details = record(usage.cache_creation) ? usage.cache_creation : null;
  const fiveMinutes = details ? optionalCount(details.ephemeral_5m_input_tokens) : null;
  const oneHour = details ? optionalCount(details.ephemeral_1h_input_tokens) : null;
  if (details && fiveMinutes !== null && oneHour !== null && cacheCreation !== null
    && fiveMinutes + oneHour !== cacheCreation) invalid();
  return { source: "claude-code-transcript", coverage: "unknown", sequence, observedAt,
    inputTokens: usage.input_tokens, cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation, cacheCreation5mInputTokens: fiveMinutes,
    cacheCreation1hInputTokens: oneHour, outputTokens: null, quotaWindow: null };
}

/** Token usage remains separate from subscription quota; no token-to-percent conversion exists. */
export class ClaudeUsageCollectorV1 implements ResourceCollectorPortV1 {
  readonly scope: CollectorScopeV1;
  private readonly reader: ClaudeUsageReaderV1;
  private readonly now: () => Date;
  private sequence: number;
  private latest: ClaudeUsageObservationV1 | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(options: ClaudeUsageCollectorOptionsV1) {
    this.scope = Object.freeze(structuredClone(validateCollectorScopeV1(options.scope)));
    if (this.scope.source !== "provider-reported" || typeof options.reader?.readLatestUsage !== "function") invalid();
    const prior = options.resume;
    if (prior && (!prior.scope || prior.scope.collectorId !== this.scope.collectorId
      || prior.scope.source !== this.scope.source || prior.scope.accountScope !== this.scope.accountScope
      || prior.scope.resourcePoolId !== this.scope.resourcePoolId
      || !Number.isSafeInteger(prior.sequence) || prior.sequence < 1)) invalid();
    this.reader = options.reader;
    this.now = options.now ?? (() => new Date());
    this.sequence = prior?.sequence ?? 0;
  }

  get latestUsage(): ClaudeUsageObservationV1 | null {
    return this.latest ? structuredClone(this.latest) : null;
  }

  collect(): Promise<ResourceCollectorResponseV1> {
    const next = this.pending.then(() => this.collectOnce());
    this.pending = next.then(() => undefined, () => undefined);
    return next;
  }

  private async collectOnce(): Promise<ResourceCollectorResponseV1> {
    if (!Number.isSafeInteger(this.sequence + 1)) invalid();
    this.latest = null;
    let event: unknown;
    try { event = await this.reader.readLatestUsage(); }
    catch { return this.unavailable("temporarily-unavailable"); }
    const observedAt = this.now();
    if (!Number.isFinite(observedAt.getTime())) invalid();
    this.latest = parseUsage(event, this.sequence + 1, observedAt.toISOString());
    return this.unavailable("not-exposed");
  }

  private unavailable(reason: "not-exposed" | "temporarily-unavailable"): ResourceCollectorResponseV1 {
    return validateCollectorResponseV1({ schemaVersion: "1.0.0", kind: "unavailable", ...this.scope,
      sequence: ++this.sequence, reason }, this.scope);
  }
}
