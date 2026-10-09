import {selectFixedProfile, validateProviderProfile, isProviderProfileRegistry} from "./profiles.js";
import {ClassificationProviderError, unavailableResponse, unknownUsage, sanitizeRateLimitObservation} from "./providers.js";
import {validateClassificationResponse} from "./validation.js";
import {digestClassificationValue, projectClassificationRequest, validateClassificationRequest} from "./request.js";
import type {ClassificationAttempt, ClassificationConfig, ClassificationResult, ClassificationSnapshot, DispatchState, ProviderEvaluation, ProviderProfile, ProviderProfileRegistry, SkillClassificationProviderPort, SkillClassificationRequestV1} from "./types.js";

/** https://nodejs.org/api/timers.html#settimeoutcallback-delay-args */
export const MAX_CLASSIFICATION_TIMEOUT_MS = 2_147_483_647;

export interface ClassificationBudgetPort {
  reserve(profile: ProviderProfile, reservationId: string, maximumUsd: number, routeKind?: "native" | "remote"): boolean;
  settle(reservationId: string, actualUsd: number | null, dispatchState: DispatchState): void;
}
export interface BudgetLimit {limitUsd: number | null; spentUsd: number | null}
export interface NativeClassificationAllowance {approvalRef: string; remainingCalls: number | null}
export class InMemoryClassificationBudget implements ClassificationBudgetPort {
  private readonly reservations = new Map<string, {bucket: string; maximumUsd: number; profileId: string; nativeProfileId: string | null}>();
  private readonly invalidCostCeilings = new Set<string>();
  private readonly limits = new Map<string, BudgetLimit>();
  private readonly nativeAllowances = new Map<string, NativeClassificationAllowance>();
  constructor(options: {jev: BudgetLimit; vendors: Record<string, BudgetLimit>; nativeAllowances?: Record<string, NativeClassificationAllowance>; maxReservations?: number}) {
    this.maxReservations = options.maxReservations ?? 2048;
    if (!Number.isSafeInteger(this.maxReservations) || this.maxReservations < 1) throw new Error("INVALID_RESERVATION_BOUND");
    this.limits.set("jev", {...options.jev, limitUsd: options.jev.limitUsd === null ? null : Math.min(5, options.jev.limitUsd)});
    for (const [vendor, limit] of Object.entries(options.vendors)) this.limits.set(`vendor:${vendor}`, {...limit});
    for (const [id, allowance] of Object.entries(options.nativeAllowances ?? {})) this.nativeAllowances.set(id, {...allowance});
  }
  private readonly maxReservations: number;
  reserve(profile: ProviderProfile, reservationId: string, maximumUsd: number, routeKind: "native" | "remote" = "remote"): boolean {
    const bucket = profile.providerKind === "jev" ? "jev" : `vendor:${profile.vendorId}`;
    const limit = this.limits.get(bucket);
    if (!Number.isFinite(maximumUsd) || maximumUsd < 0 || this.reservations.has(reservationId) || this.reservations.size >= this.maxReservations
      || this.invalidCostCeilings.has(profile.profileId) || this.invalidCostCeilings.size >= this.maxReservations) return false;
    let nativeProfileId: string | null = null;
    if (routeKind === "native") {
      const allowance = this.nativeAllowances.get(profile.profileId);
      const outstanding = [...this.reservations.values()].filter(r => r.nativeProfileId === profile.profileId).length;
      if (!allowance?.approvalRef || allowance.remainingCalls === null || !Number.isSafeInteger(allowance.remainingCalls) || allowance.remainingCalls - outstanding < 1) return false;
      nativeProfileId = profile.profileId;
    }
    // A qualified native cash ceiling of exactly zero still needs its separate confirmed allowance.
    if (!(routeKind === "native" && maximumUsd === 0) && (!limit || limit.limitUsd === null || limit.spentUsd === null || !Number.isFinite(limit.limitUsd) || !Number.isFinite(limit.spentUsd) || limit.limitUsd < 0 || limit.spentUsd < 0)) return false;
    const reserved = [...this.reservations.values()].filter((r) => r.bucket === bucket).reduce((sum, r) => sum + r.maximumUsd, 0);
    if (maximumUsd > 0 && limit!.spentUsd! + reserved + maximumUsd > limit!.limitUsd!) return false;
    // No await between balance observation and reservation: atomic within this process.
    this.reservations.set(reservationId, {bucket, maximumUsd, profileId: profile.profileId, nativeProfileId});
    return true;
  }
  settle(reservationId: string, actualUsd: number | null, dispatchState: DispatchState): void {
    const reservation = this.reservations.get(reservationId);
    if (!reservation) return;
    if (actualUsd !== null && Number.isFinite(actualUsd) && actualUsd >= 0) {
      const limit = this.limits.get(reservation.bucket);
      if (limit && limit.spentUsd !== null) limit.spentUsd += actualUsd;
      if (actualUsd > reservation.maximumUsd) this.invalidCostCeilings.add(reservation.profileId);
      const nativeAllowance = reservation.nativeProfileId ? this.nativeAllowances.get(reservation.nativeProfileId) : null;
      if (nativeAllowance && nativeAllowance.remainingCalls !== null && dispatchState !== "not-started") nativeAllowance.remainingCalls--;
      if (nativeAllowance && actualUsd > reservation.maximumUsd) nativeAllowance.remainingCalls = null;
      this.reservations.delete(reservationId);
    } else if (dispatchState === "not-started") this.reservations.delete(reservationId);
    // A dispatched call with unknown cost keeps its conservative reservation.
  }
  snapshot() {
    return {limits: Object.fromEntries([...this.limits].map(([key, value]) => [key, {...value}])), nativeAllowances: Object.fromEntries([...this.nativeAllowances].map(([key, value]) => [key, {...value}])), invalidCostCeilings: [...this.invalidCostCeilings], reservations: [...this.reservations].map(([id, value]) => ({id, ...value}))};
  }
}

export interface ClassificationServiceInput {
  request: SkillClassificationRequestV1;
  config: ClassificationConfig;
  registry: ProviderProfileRegistry;
  currentVendorId: string;
  getCurrentSnapshot?: () => ClassificationSnapshot;
  signal?: AbortSignal;
}
interface Operation {identity: string; result: Promise<ClassificationResult>}
const providerFailureCodes = new Set(["ROUTE_NOT_APPROVED", "ROUTE_CAPABILITY_MISMATCH", "CREDENTIAL_UNAVAILABLE", "INVALID_APPROVED_ENDPOINT", "NATIVE_STRUCTURED_CAPABILITY_UNAVAILABLE", "REMOTE_ADAPTER_UNAVAILABLE", "CANCELLED", "INPUT_TOO_LONG", "INVALID_PROVIDER_REQUEST", "TRANSPORT_UNAVAILABLE", "AUTH_UNAVAILABLE", "RATE_LIMITED", "API_UNAVAILABLE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_UNAVAILABLE", "STALE_CLASSIFICATION", "EXTERNAL_CLASSIFICATION_BLOCKED", "BUDGET_UNAVAILABLE", "INVALID_PROVIDER_USAGE", "PROVIDER_TIMEOUT", "OUTPUT_TOO_LONG", "NATIVE_SPAWN_UNAVAILABLE", "NATIVE_OUTPUT_TOO_LARGE", "NATIVE_PROCESS_UNAVAILABLE", "NATIVE_TIMEOUT", "NATIVE_PROFILE_UNSUPPORTED", "NATIVE_CLEANUP_UNAVAILABLE", "PROVIDER_RESPONSE_TOO_LARGE", "INVALID_PROFILE", "QUALIFICATION_CONFIGURATION_MISMATCH", "PROFILE_UNQUALIFIED", "QUALIFICATION_MISMATCH", "QUALIFICATION_EXPIRED", "UNSUPPORTED_OPTIONS", "COST_UNKNOWN"]);
const stale = (a: ClassificationSnapshot, b: ClassificationSnapshot) => b.cancelled || a.taskRevision !== b.taskRevision || a.configRevision !== b.configRevision
  || a.profileRevision !== b.profileRevision || a.inventoryDigest !== b.inventoryDigest || a.requestDigest !== b.requestDigest;

export class SkillClassificationService {
  private readonly operations = new Map<string, Operation>();
  private readonly requestOperations = new Map<string, string>();
  private readonly now: () => number;
  private readonly maxOperations: number;
  constructor(private readonly options: {providers: {jev?: SkillClassificationProviderPort; vendor?: SkillClassificationProviderPort}; budget: ClassificationBudgetPort; now?: () => number; maxOperations?: number}) {
    this.now = options.now ?? Date.now;
    this.maxOperations = options.maxOperations ?? 256;
    if (!Number.isSafeInteger(this.maxOperations) || this.maxOperations < 1) throw new Error("INVALID_OPERATION_BOUND");
  }
  classify(input: ClassificationServiceInput): Promise<ClassificationResult> {
    // Freeze caller-owned profile/config snapshots; an in-flight mutation cannot change the transmitted model.
    const frozen: ClassificationServiceInput = {...input, request: structuredClone(input.request), config: structuredClone(input.config), registry: structuredClone(input.registry)};
    const snapshot = this.snapshot(frozen);
    try { validateClassificationRequest(frozen.request); }
    catch { return Promise.resolve(this.failure(frozen, snapshot, "INVALID_CLASSIFICATION_REQUEST", [], "INVALID")); }
    let identity: string;
    try { identity = digestClassificationValue([frozen.request.requestId, frozen.request.requestDigest, snapshot, frozen.currentVendorId, frozen.config, frozen.registry]); }
    catch {
      const code = !isProviderProfileRegistry(frozen.registry) ? "INVALID_PROFILE_REGISTRY"
        : !Number.isSafeInteger(frozen.config.timeoutMs) || (frozen.config.timeoutMs < 1 || frozen.config.timeoutMs > MAX_CLASSIFICATION_TIMEOUT_MS) ? "INVALID_TIMEOUT" : "INVALID_CLASSIFICATION_CONFIG";
      return Promise.resolve(this.failure(frozen, snapshot, code));
    }
    const previousOperation = this.requestOperations.get(frozen.request.requestId);
    if (previousOperation !== undefined && previousOperation !== frozen.request.operationId) return Promise.resolve(this.failure(frozen, snapshot, "REQUEST_ID_CONFLICT", [], "INVALID"));
    const existing = this.operations.get(frozen.request.operationId);
    if (existing) {
      if (existing.identity !== identity) return Promise.resolve(this.failure(frozen, snapshot, "OPERATION_DIGEST_CONFLICT", [], "INVALID"));
      return existing.result.then((result) => this.current(frozen, result));
    }
    if (this.operations.size >= this.maxOperations) {
      // Keep completed identities for the service lifetime. Eviction would silently permit resending.
      return Promise.resolve(this.failure(frozen, snapshot, "OPERATION_CAPACITY_EXCEEDED"));
    }
    // Promise scheduling publishes the dedup claim before any availability/transport await.
    const operation: Operation = {identity, result: Promise.resolve().then(() => this.run(frozen, snapshot))};
    this.operations.set(frozen.request.operationId, operation);
    this.requestOperations.set(frozen.request.requestId, frozen.request.operationId);
    return operation.result;
  }
  private snapshot(input: ClassificationServiceInput): ClassificationSnapshot {
    return {taskRevision: input.request.confirmedContext.taskRevision, configRevision: input.config.configRevision, profileRevision: input.registry.profileRevision,
      inventoryDigest: input.request.inventoryDigest, requestDigest: input.request.requestDigest, cancelled: input.signal?.aborted ?? false};
  }
  private failure(input: ClassificationServiceInput, snapshot: ClassificationSnapshot, code: string, attempts: ClassificationAttempt[] = [], status: "UNAVAILABLE" | "INVALID" | "UNCERTAIN" = "UNAVAILABLE"): ClassificationResult {
    return {request: input.request, config: input.config, profileRevision: input.registry.profileRevision, snapshot, attempts, response: unavailableResponse(input.request, code, "not-started", status)};
  }
  private current(input: ClassificationServiceInput, result: ClassificationResult): ClassificationResult {
    if (input.signal?.aborted || (input.getCurrentSnapshot && stale(result.snapshot, input.getCurrentSnapshot()))) return this.failure(input, result.snapshot, "STALE_CLASSIFICATION", result.attempts);
    if (result.response.error === null && ["SUCCESS", "PARTIAL", "UNCERTAIN"].includes(result.response.status)) {
      const attempt = result.attempts.at(-1);
      const profile = input.registry.profiles.find(profile => profile.profileId === attempt?.profileId);
      const invalid = profile ? validateProviderProfile(profile, input.request, this.now()) : "PROFILE_UNAVAILABLE";
      if (invalid) return this.failure(input, result.snapshot, invalid, result.attempts);
    }
    return result;
  }
  private async run(input: ClassificationServiceInput, snapshot: ClassificationSnapshot): Promise<ClassificationResult> {
    const attempts: ClassificationAttempt[] = [];
    if (snapshot.cancelled) return this.failure(input, snapshot, "CANCELLED");
    if (input.config.mode !== "shadow" && input.config.mode !== "select") return this.failure(input, snapshot, "UNSUPPORTED_MODE");
    if (!Number.isSafeInteger(input.config.timeoutMs) || (input.config.timeoutMs < 1 || input.config.timeoutMs > MAX_CLASSIFICATION_TIMEOUT_MS)) return this.failure(input, snapshot, "INVALID_TIMEOUT");
    if (!isProviderProfileRegistry(input.registry)) return this.failure(input, snapshot, "INVALID_PROFILE_REGISTRY");
    for (const kind of input.config.jevEnabled ? ["jev", "vendor"] as const : ["vendor"] as const) {
      if (input.signal?.aborted || (input.getCurrentSnapshot && stale(snapshot, input.getCurrentSnapshot()))) return this.failure(input, snapshot, "STALE_CLASSIFICATION", attempts);
      const profile = selectFixedProfile(input.registry, kind, input.currentVendorId);
      const provider = this.options.providers[kind];
      if (!profile || !provider) {
        if (kind === "jev") continue;
        return this.failure(input, snapshot, !profile ? "PROFILE_UNAVAILABLE" : "PROVIDER_UNAVAILABLE", attempts);
      }
      const invalid = validateProviderProfile(profile, input.request, this.now());
      if (invalid) {
        if (kind === "jev") continue;
        return this.failure(input, snapshot, invalid, attempts);
      }
      try { projectClassificationRequest(input.request, profile.maximumInputBytes); }
      catch {
        if (kind === "jev") continue;
        return this.failure(input, snapshot, "INPUT_TOO_LONG", attempts);
      }
      const evaluated = await this.attempt(input, snapshot, provider, profile);
      attempts.push(evaluated.attempt);
      const result: ClassificationResult = {request: input.request, config: input.config, profileRevision: input.registry.profileRevision, snapshot, attempts, response: evaluated.evaluation.response};
      const current = this.current(input, result);
      if (current !== result) return current;
      if (["SUCCESS", "PARTIAL", "UNCERTAIN"].includes(result.response.status) && result.response.error === null) return result;
      if (kind === "vendor") return result;
    }
    return this.failure(input, snapshot, "PROVIDER_UNAVAILABLE", attempts);
  }
  private async attempt(input: ClassificationServiceInput, snapshot: ClassificationSnapshot, provider: SkillClassificationProviderPort, profile: ProviderProfile) {
    const controller = new AbortController();
    let dispatchState: DispatchState = "not-started";
    let reserved = false;
    let retainedUsage = unknownUsage();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reservationId = JSON.stringify([input.request.operationId, input.request.requestDigest, profile.profileId]);
    const stopped = new Promise<ProviderEvaluation>((resolve) => {
      const stop = (code: string) => {controller.abort(); resolve({response: unavailableResponse(input.request, code, dispatchState, dispatchState === "not-started" ? "UNAVAILABLE" : "UNCERTAIN"), usage: unknownUsage(), dispatchState, diagnostics: null});};
      timer = setTimeout(() => {timedOut = true; stop("PROVIDER_TIMEOUT");}, input.config.timeoutMs);
      controller.signal.addEventListener("abort", () => stop(timedOut ? "PROVIDER_TIMEOUT" : "CANCELLED"), {once: true});
    });
    const cancel = () => controller.abort();
    input.signal?.addEventListener("abort", cancel, {once: true});
    if (input.signal?.aborted) controller.abort();
    const work = async (): Promise<ProviderEvaluation> => {
      try {
        const availability = await provider.availability(profile);
        if (controller.signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
        if (!availability.available || !availability.approved) {
          const codes = ["ROUTE_NOT_APPROVED", "ROUTE_CAPABILITY_MISMATCH", "CREDENTIAL_UNAVAILABLE", "INVALID_APPROVED_ENDPOINT", "NATIVE_STRUCTURED_CAPABILITY_UNAVAILABLE", "REMOTE_ADAPTER_UNAVAILABLE"];
          throw new ClassificationProviderError(availability.reasonCode && codes.includes(availability.reasonCode) ? availability.reasonCode : "PROVIDER_UNAVAILABLE", "not-started");
        }
        if (!input.config.externalClassificationAllowed && availability.routeKind !== "native") throw new ClassificationProviderError("EXTERNAL_CLASSIFICATION_BLOCKED", "not-started");
        if (input.getCurrentSnapshot && stale(snapshot, input.getCurrentSnapshot())) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
        const invalid = validateProviderProfile(profile, input.request, this.now());
        if (invalid) throw new ClassificationProviderError(invalid, "not-started");
        if (!this.options.budget.reserve(profile, reservationId, profile.maximumCostUsd!, availability.routeKind)) throw new ClassificationProviderError("BUDGET_UNAVAILABLE", "not-started");
        reserved = true;
        dispatchState = "unknown";
        const beforeDispatch = () => {
          if (controller.signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
          if (input.getCurrentSnapshot && stale(snapshot, input.getCurrentSnapshot())) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
          if (validateProviderProfile(profile, input.request, this.now()) !== null) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
        };
        const evaluation = await provider.classify(input.request, profile, controller.signal, beforeDispatch);
        if (controller.signal.aborted) return evaluation; // only the already-settled race may publish
        const usage = evaluation.usage;
        // Classification/token errors do not erase an independently valid reported charge.
        if (usage && Number.isFinite(usage.actualCostUsd) && usage.actualCostUsd! >= 0) retainedUsage.actualCostUsd = usage.actualCostUsd;
        if (!["not-started", "started", "unknown"].includes(evaluation.dispatchState) || !usage
          || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0))
          || (usage.actualCostUsd !== null && (!Number.isFinite(usage.actualCostUsd) || usage.actualCostUsd < 0))
          || (usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens)
          || (evaluation.diagnostics !== null && (!evaluation.diagnostics || typeof evaluation.diagnostics.scoreKind !== "string" || !Array.isArray(evaluation.diagnostics.scores)
            || evaluation.diagnostics.scoreKind.length === 0 || evaluation.diagnostics.scoreKind.length > 128
            || new Set(evaluation.diagnostics.scores.map(score => score.skillId)).size !== evaluation.diagnostics.scores.length
            || evaluation.diagnostics.scores.some((score) => !input.request.skills.some(skill => skill.skillId === score.skillId) || !Number.isFinite(score.value))))) throw new ClassificationProviderError("INVALID_PROVIDER_USAGE", "unknown", true);
        retainedUsage = {...usage};
        if (validateClassificationResponse(input.request, evaluation.response).length > 0) throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", evaluation.dispatchState, true);
        if (usage.actualCostUsd !== null && usage.actualCostUsd > profile.maximumCostUsd!) return {...evaluation,
          response: unavailableResponse(input.request, "COST_CEILING_EXCEEDED", evaluation.dispatchState)};
        if (usage.outputTokens !== null && usage.outputTokens > profile.maximumOutputTokens) return {...evaluation,
          response: unavailableResponse(input.request, "OUTPUT_TOO_LONG", evaluation.dispatchState, "INVALID")};
        return evaluation;
      } catch (error) {
        const safe = error instanceof ClassificationProviderError ? new ClassificationProviderError(providerFailureCodes.has(error.code) ? error.code : "PROVIDER_UNAVAILABLE",
          ["not-started", "started", "unknown"].includes(error.dispatchState) ? error.dispatchState : "unknown", error.invalid === true, error.code === "RATE_LIMITED" ? sanitizeRateLimitObservation(error.rateLimitObservation) : null) : new ClassificationProviderError("PROVIDER_UNAVAILABLE", dispatchState);
        if (safe.code === "NATIVE_TIMEOUT" || safe.code === "PROVIDER_TIMEOUT") timedOut = true;
        return {response: unavailableResponse(input.request, safe.code, safe.dispatchState, safe.invalid ? "INVALID" : timedOut && safe.dispatchState !== "not-started" ? "UNCERTAIN" : "UNAVAILABLE"), usage: retainedUsage, dispatchState: safe.dispatchState, diagnostics: null, rateLimitObservation: safe.rateLimitObservation};
      }
    };
    let evaluation: ProviderEvaluation;
    try { evaluation = await Promise.race([work(), stopped]); }
    finally { if (timer !== undefined) clearTimeout(timer); input.signal?.removeEventListener("abort", cancel); }
    if (reserved) this.options.budget.settle(reservationId, evaluation.usage.actualCostUsd, evaluation.dispatchState);
    const attempt: ClassificationAttempt = {providerKind: profile.providerKind, profileId: profile.profileId, modelId: profile.modelId, reasoningEffort: profile.reasoningEffort,
      dispatchState: evaluation.dispatchState, status: evaluation.response.status, errorCode: evaluation.response.error?.code ?? null, timedOut, usage: evaluation.usage, reservedCostUsd: reserved ? profile.maximumCostUsd! : 0, diagnostics: structuredClone(evaluation.diagnostics), rateLimitObservation: evaluation.response.error?.code === "RATE_LIMITED" ? sanitizeRateLimitObservation(evaluation.rateLimitObservation) : null};
    return {evaluation, attempt};
  }
}
