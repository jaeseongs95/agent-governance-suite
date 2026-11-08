import {validateBoundProviderProfile} from "./profile-validation.js";
import {selectFixedProfile, isProviderProfileRegistry} from "./profiles.js";
import {ClassificationProviderError, unavailableResponse, unknownUsage, sanitizeRateLimitObservation, validateLegacyProviderConfiguration} from "./providers.js";
import {validateClassificationResponse} from "./validation.js";
import {digestClassificationValue, projectClassificationRequest, validateClassificationRequest} from "./request.js";
import {nativeDecodeFailureCodes} from "./types.js";
import type {ClassificationAttempt, ClassificationConfig, ClassificationResult, ClassificationScoreDiagnostics, ClassificationSkipped, ClassificationSnapshot, DispatchState, ProviderEvaluation, ProviderProfile, ProviderProfileRegistry, SkillClassificationProviderPort, SkillClassificationRequestV1, SkillClassificationResponseV1} from "./types.js";

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
  /**
   * `jevSignedLimitUsd` reads the JEV budget the user signed on the admin page (null: none). The narrower of it and the
   * installation's limit applies. When the installation gives neither a limit nor a spent amount, the signed budget
   * counts from zero in this process; an installation limit with an unknown spent amount still refuses, as before.
   */
  constructor(options: {jev: BudgetLimit; vendors: Record<string, BudgetLimit>; nativeAllowances?: Record<string, NativeClassificationAllowance>; maxReservations?: number;
    jevSignedLimitUsd?: () => number | null}) {
    this.maxReservations = options.maxReservations ?? 2048;
    if (!Number.isSafeInteger(this.maxReservations) || this.maxReservations < 1) throw new Error("INVALID_RESERVATION_BOUND");
    this.jevSignedLimitUsd = options.jevSignedLimitUsd ?? null;
    const unset = options.jev.limitUsd === null && options.jev.spentUsd === null;
    this.limits.set("jev", {limitUsd: options.jev.limitUsd,
      spentUsd: unset && this.jevSignedLimitUsd ? 0 : options.jev.spentUsd});
    for (const [vendor, limit] of Object.entries(options.vendors)) this.limits.set(`vendor:${vendor}`, {...limit});
    for (const [id, allowance] of Object.entries(options.nativeAllowances ?? {})) this.nativeAllowances.set(id, {...allowance});
  }
  private readonly maxReservations: number;
  private readonly jevSignedLimitUsd: (() => number | null) | null;
  /** The limit in force for a bucket; for JEV, the narrower of the installation's and the signed budget. */
  private limitFor(bucket: string): BudgetLimit | undefined {
    const limit = this.limits.get(bucket);
    if (bucket !== "jev" || !limit || !this.jevSignedLimitUsd) return limit;
    let signed: number | null;
    try { signed = this.jevSignedLimitUsd(); } catch { return {limitUsd: null, spentUsd: limit.spentUsd}; }
    const limits = [limit.limitUsd, signed].filter((value): value is number => value !== null && Number.isFinite(value));
    return {limitUsd: limits.length ? Math.min(...limits) : null, spentUsd: limit.spentUsd};
  }
  reserve(profile: ProviderProfile, reservationId: string, maximumUsd: number, routeKind: "native" | "remote" = "remote"): boolean {
    const bucket = profile.providerKind === "jev" ? "jev" : `vendor:${profile.vendorId}`;
    const limit = this.limitFor(bucket);
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
  /** Gateway-owned content permission; caller requests cannot grant remote transmission. */
  remoteContentAllowed?: boolean;
  /**
   * JEV as the user signed it on the admin page (4.0.0). `transmissionAllowed` is the consent to send the request to the
   * JEV provider; for the JEV attempt it replaces the installation's external-transmission settings. With JEV on, a
   * vendor attempt follows a failed JEV attempt only for the signed fallback vendor (null: none). Absent: the earlier
   * behavior (installation settings, the current vendor).
   */
  jev?: ClassificationJevSettings;
  getCurrentSnapshot?: () => ClassificationSnapshot;
  signal?: AbortSignal;
}
export interface ClassificationJevSettings {transmissionAllowed: boolean; fallbackVendorId: string | null}
interface Operation {identity: string; result: Promise<ClassificationResult>}
const providerFailureCodes = new Set(["ROUTE_NOT_APPROVED", "ROUTE_CAPABILITY_MISMATCH", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_MALFORMED", "INVALID_APPROVED_ENDPOINT", "NATIVE_STRUCTURED_CAPABILITY_UNAVAILABLE", "REMOTE_ADAPTER_UNAVAILABLE", "CANCELLED", "INPUT_TOO_LONG", "INVALID_PROVIDER_REQUEST", "TRANSPORT_UNAVAILABLE", "AUTH_UNAVAILABLE", "RATE_LIMITED", "SERVER_UNAVAILABLE", "API_UNAVAILABLE", "INVALID_PROVIDER_RESPONSE", "PROVIDER_UNAVAILABLE", "STALE_CLASSIFICATION", "REMOTE_CONTENT_NOT_APPROVED", "EXTERNAL_CLASSIFICATION_BLOCKED", "BUDGET_UNAVAILABLE", "INVALID_PROVIDER_USAGE", "PROVIDER_TIMEOUT", "OUTPUT_TOO_LONG", "NATIVE_SPAWN_UNAVAILABLE", "NATIVE_OUTPUT_TOO_LARGE", "NATIVE_PROCESS_UNAVAILABLE", "NATIVE_TIMEOUT", "NATIVE_PROFILE_UNSUPPORTED", "NATIVE_PROFILE_ENCODING_UNAVAILABLE", "NATIVE_CLEANUP_UNAVAILABLE", "PROVIDER_RESPONSE_TOO_LARGE", "INVALID_PROFILE", "QUALIFICATION_CONFIGURATION_MISMATCH", "PROFILE_UNQUALIFIED", "QUALIFICATION_MISMATCH", "QUALIFICATION_EXPIRED", "UNSUPPORTED_OPTIONS", "COST_UNKNOWN"]);
// Only known helper execution/response faults after this service's dispatch fence qualify.
// Coarse API/spawn/process failures may conceal request, permission or unknown causes.
const continuationFailureCodes = new Set(["TRANSPORT_UNAVAILABLE", "RATE_LIMITED", "SERVER_UNAVAILABLE", "INVALID_PROVIDER_RESPONSE", "INVALID_PROVIDER_USAGE", "PROVIDER_TIMEOUT", "OUTPUT_TOO_LONG", "NATIVE_OUTPUT_TOO_LARGE", "NATIVE_TIMEOUT", "PROVIDER_RESPONSE_TOO_LARGE"]);
// These exact decode faults previously arrived as INVALID_PROVIDER_RESPONSE.
// Preserve their existing post-dispatch eligibility without weakening the fence.
for (const code of nativeDecodeFailureCodes) {providerFailureCodes.add(code); continuationFailureCodes.add(code);}
interface HelperFailure {profileId: string; errorCode: string; helperResultDigest: string}
const stale = (a: ClassificationSnapshot, b: ClassificationSnapshot) => b.cancelled || a.taskRevision !== b.taskRevision || a.configRevision !== b.configRevision
  || a.profileRevision !== b.profileRevision || a.inventoryDigest !== b.inventoryDigest || a.requestDigest !== b.requestDigest;

export class SkillClassificationService {
  readonly #helperFailures = new WeakMap<ClassificationResult, HelperFailure>();
  private readonly operations = new Map<string, Operation>();
  private readonly requestOperations = new Map<string, string>();
  private readonly resultFences = new WeakMap<ClassificationResult, () => boolean>();
  private readonly now: () => number;
  private readonly maxOperations: number;
  constructor(private readonly options: {providers: {jev?: SkillClassificationProviderPort; vendor?: SkillClassificationProviderPort}; budget: ClassificationBudgetPort; now?: () => number; maxOperations?: number}) {
    this.now = options.now ?? Date.now;
    this.maxOperations = options.maxOperations ?? 256;
    if (!Number.isSafeInteger(this.maxOperations) || this.maxOperations < 1) throw new Error("INVALID_OPERATION_BOUND");
  }
  /** Shared by run, rechecks and gateway acceptance; no availability or credential side effect. */
  validateProfile(profile: ProviderProfile, request: SkillClassificationRequestV1, nowMs = this.now()): string | null {
    const provider = this.options.providers[profile.providerKind];
    return validateBoundProviderProfile(profile, request, nowMs,
      value => provider?.validateConfiguration ? provider.validateConfiguration(value) : validateLegacyProviderConfiguration(value));
  }
  /** Only the exact service-owned result can authorize later use of its original provider binding. */
  validateResultBinding(result: ClassificationResult): string | null {
    try {return this.resultFences.get(result)?.() === true ? null : "STALE_CLASSIFICATION";}
    catch {return "STALE_CLASSIFICATION";}
  }
  private providerFence(provider: SkillClassificationProviderPort, profile: ProviderProfile): () => boolean {
    const validate = provider.validateConfiguration, classify = provider.classify, availability = provider.availability;
    const routeKind = provider.routeKind, capture = provider.captureConfigurationFence;
    let current: (() => boolean) | undefined;
    try {current = capture?.call(provider, profile);} catch {return () => false;}
    return () => this.options.providers[profile.providerKind] === provider && provider.validateConfiguration === validate
      && provider.classify === classify && provider.availability === availability && provider.routeKind === routeKind
      && provider.captureConfigurationFence === capture && (capture === undefined || current?.() === true);
  }
  /** Exact in-process terminal object and immutable digest; serialized caller results cannot mint evidence. */
  helperFailure(result: ClassificationResult): Readonly<HelperFailure> | null {
    const proof = this.#helperFailures.get(result);
    return proof && result.response.error !== null && proof.helperResultDigest === digestClassificationValue(result) && this.validateResultBinding(result) === null ? {...proof} : null;
  }
  private bindHelperFailure(result: ClassificationResult, failure: Omit<HelperFailure, "helperResultDigest"> | null, bindingCurrent?: () => boolean): ClassificationResult {
    if (failure) {
      if (bindingCurrent) this.resultFences.set(result, bindingCurrent);
      this.#helperFailures.set(result, {...failure, helperResultDigest: digestClassificationValue(result)});
    }
    return result;
  }
  /** Pure preflight: no credentials, availability, reservation or transport. Unknown ports stay closed. */
  hasNativeRoute(input: Pick<ClassificationServiceInput, "request" | "config" | "registry" | "currentVendorId">): boolean {
    for (const kind of input.config.jevEnabled ? ["jev", "vendor"] as const : ["vendor"] as const) {
      const profile = selectFixedProfile(input.registry, kind, input.currentVendorId);
      if (!profile || this.validateProfile(profile, input.request, this.now()) !== null) continue;
      try { if (this.options.providers[kind]?.routeKind?.(profile) === "native") return true; }
      catch { /* Unknown route metadata cannot authorize a content bypass. */ }
    }
    return false;
  }
  classify(input: ClassificationServiceInput): Promise<ClassificationResult> {
    // Freeze caller-owned profile/config snapshots; an in-flight mutation cannot change the transmitted model.
    const frozen: ClassificationServiceInput = {...input, request: structuredClone(input.request), config: structuredClone(input.config), registry: structuredClone(input.registry),
      ...(input.jev ? {jev: {...input.jev}} : {})};
    const snapshot = this.snapshot(frozen);
    try { validateClassificationRequest(frozen.request); }
    catch { return Promise.resolve(this.failure(frozen, snapshot, "INVALID_CLASSIFICATION_REQUEST", [], "INVALID")); }
    let identity: string;
    try { identity = digestClassificationValue([frozen.request.requestId, frozen.request.requestDigest, snapshot, frozen.currentVendorId, frozen.config, frozen.registry, frozen.remoteContentAllowed ?? true, frozen.jev ?? null]); }
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
  private failure(input: ClassificationServiceInput, snapshot: ClassificationSnapshot, code: string, attempts: ClassificationAttempt[] = [], status: "UNAVAILABLE" | "INVALID" | "UNCERTAIN" = "UNAVAILABLE", skipped: ClassificationSkipped[] = []): ClassificationResult {
    return {request: input.request, config: input.config, profileRevision: input.registry.profileRevision, snapshot, attempts, skipped, response: unavailableResponse(input.request, code, "not-started", status)};
  }
  private current(input: ClassificationServiceInput, result: ClassificationResult): ClassificationResult {
    if (input.signal?.aborted || (input.getCurrentSnapshot && stale(result.snapshot, input.getCurrentSnapshot()))) return this.failure(input, result.snapshot, "STALE_CLASSIFICATION", result.attempts, "UNAVAILABLE", result.skipped);
    if (result.response.error === null && ["SUCCESS", "PARTIAL", "UNCERTAIN"].includes(result.response.status)) {
      const attempt = result.attempts.at(-1);
      const profile = input.registry.profiles.find(profile => profile.profileId === attempt?.profileId);
      const invalid = profile ? this.validateProfile(profile, input.request, this.now()) : "PROFILE_UNAVAILABLE";
      if (invalid) return this.failure(input, result.snapshot, invalid, result.attempts, "UNAVAILABLE", result.skipped);
      const bindingError = this.validateResultBinding(result);
      if (bindingError) return this.failure(input, result.snapshot, bindingError, result.attempts, "UNAVAILABLE", result.skipped);
    }
    return result;
  }
  private async run(input: ClassificationServiceInput, snapshot: ClassificationSnapshot): Promise<ClassificationResult> {
    const attempts: ClassificationAttempt[] = [];
    const skipped: ClassificationSkipped[] = [];
    let helperFailure: Omit<HelperFailure, "helperResultDigest"> | null = null;
    let helperBinding: (() => boolean) | undefined;
    if (snapshot.cancelled) return this.failure(input, snapshot, "CANCELLED");
    if (input.config.mode !== "shadow" && input.config.mode !== "select") return this.failure(input, snapshot, "UNSUPPORTED_MODE");
    if (!Number.isSafeInteger(input.config.timeoutMs) || (input.config.timeoutMs < 1 || input.config.timeoutMs > MAX_CLASSIFICATION_TIMEOUT_MS)) return this.failure(input, snapshot, "INVALID_TIMEOUT");
    if (!isProviderProfileRegistry(input.registry)) return this.failure(input, snapshot, "INVALID_PROFILE_REGISTRY");
    // With JEV on and signed settings present, the vendor attempt after JEV is the signed fallback, or none.
    const signedJev = input.config.jevEnabled ? input.jev : undefined;
    const noFallback = signedJev?.fallbackVendorId === null;
    const kinds = !input.config.jevEnabled ? ["vendor"] as const : noFallback ? ["jev"] as const : ["jev", "vendor"] as const;
    const vendorId = signedJev?.fallbackVendorId ?? input.currentVendorId;
    for (const kind of kinds) {
      if (input.signal?.aborted || (input.getCurrentSnapshot && stale(snapshot, input.getCurrentSnapshot()))) return this.failure(input, snapshot, "STALE_CLASSIFICATION", attempts, "UNAVAILABLE", skipped);
      const profile = selectFixedProfile(input.registry, kind, vendorId);
      const provider = this.options.providers[kind];
      if (!profile || !provider) {
        const code = !profile ? "PROFILE_UNAVAILABLE" : "PROVIDER_UNAVAILABLE";
        if (kind === "jev") {skipped.push({providerKind: kind, profileId: profile?.profileId ?? null, reasonCode: code, dispatchState: "not-started"}); continue;}
        return this.bindHelperFailure(this.failure(input, snapshot, code, attempts, "UNAVAILABLE", skipped), !profile ? helperFailure : null, !profile ? helperBinding : undefined);
      }
      const invalid = this.validateProfile(profile, input.request, this.now());
      if (invalid) {
        if (kind === "jev") {skipped.push({providerKind: kind, profileId: profile.profileId, reasonCode: invalid, dispatchState: "not-started"}); continue;}
        return this.failure(input, snapshot, invalid, attempts, "UNAVAILABLE", skipped);
      }
      try { projectClassificationRequest(input.request, profile.maximumInputBytes); }
      catch {
        if (kind === "jev") {skipped.push({providerKind: kind, profileId: profile.profileId, reasonCode: "INPUT_TOO_LONG", dispatchState: "not-started"}); continue;}
        return this.failure(input, snapshot, "INPUT_TOO_LONG", attempts, "UNAVAILABLE", skipped);
      }
      const bindingCurrent = this.providerFence(provider, profile);
      const jevConsent = kind === "jev" ? signedJev?.transmissionAllowed : undefined;
      const evaluated = await dispatchAdvisoryAttempt({provider, profile, budget: this.options.budget, timeoutMs: input.config.timeoutMs,
        externalClassificationAllowed: jevConsent ?? input.config.externalClassificationAllowed, remoteContentAllowed: jevConsent ?? input.remoteContentAllowed, signal: input.signal, bindingCurrent},
      this.classificationTask(input, snapshot, profile));
      attempts.push(evaluated.attempt);
      const result: ClassificationResult = {request: input.request, config: input.config, profileRevision: input.registry.profileRevision, snapshot, attempts, skipped, response: evaluated.evaluation.response};
      this.resultFences.set(result, bindingCurrent);
      const current = this.current(input, result);
      if (current !== result) return current;
      if (["SUCCESS", "PARTIAL", "UNCERTAIN"].includes(result.response.status) && result.response.error === null) return result;
      helperFailure = evaluated.helperFailure;
      helperBinding = helperFailure ? bindingCurrent : undefined;
      // No fallback was chosen: the JEV attempt's own failure is the answer (the agent then chooses by itself).
      if (kind === "vendor" || noFallback) return this.bindHelperFailure(result, helperFailure);
    }
    if (noFallback) return this.failure(input, snapshot, skipped.at(-1)?.reasonCode ?? "PROVIDER_UNAVAILABLE", attempts, "UNAVAILABLE", skipped);
    return this.failure(input, snapshot, "PROVIDER_UNAVAILABLE", attempts, "UNAVAILABLE", skipped);
  }
  /** The skill classification task: request, failure responses, qualification, staleness and response checks. */
  private classificationTask(input: ClassificationServiceInput, snapshot: ClassificationSnapshot, profile: ProviderProfile): AdvisoryDispatchTask {
    const request = input.request;
    return {request,
      failureResponse: (code, dispatchState, status) => unavailableResponse(request, code, dispatchState, status),
      stale: () => input.getCurrentSnapshot !== undefined && stale(snapshot, input.getCurrentSnapshot()),
      qualify: () => this.validateProfile(profile, request, this.now()),
      validDiagnostics: ({scoreKind, scores}) => typeof scoreKind === "string" && Array.isArray(scores) && scoreKind.length > 0 && scoreKind.length <= 128
        && new Set(scores.map(score => score.skillId)).size === scores.length
        && scores.every(score => request.skills.some(skill => skill.skillId === score.skillId) && Number.isFinite(score.value)),
      validResponse: response => validateClassificationResponse(request, response).length === 0};
  }
}

/** Service-owned controls for one dispatch. No task supplies or reaches them. */
export interface AdvisoryDispatchControls {
  provider: SkillClassificationProviderPort;
  profile: ProviderProfile;
  budget: ClassificationBudgetPort;
  timeoutMs: number;
  externalClassificationAllowed: boolean;
  /** Gateway-owned content permission, already bound there to the approved request digests. */
  remoteContentAllowed: boolean | undefined;
  signal: AbortSignal | undefined;
  /** Provider registry identity captured before the attempt. */
  bindingCurrent: () => boolean;
}
/** One advisory purpose. The engine calls these only at its own points; budget, fence and failure evidence stay with the engine. */
export interface AdvisoryDispatchTask {
  /** Fixed request; its operationId and requestDigest form the reservation identity. */
  readonly request: SkillClassificationRequestV1;
  failureResponse(code: string, dispatchState: DispatchState, status: "UNAVAILABLE" | "INVALID" | "UNCERTAIN"): SkillClassificationResponseV1;
  stale(): boolean;
  /** Profile qualification; null when the profile may be used now. */
  qualify(): string | null;
  validDiagnostics(diagnostics: ClassificationScoreDiagnostics): boolean;
  validResponse(response: SkillClassificationResponseV1): boolean;
}
export interface AdvisoryDispatchOutcome {
  evaluation: ProviderEvaluation;
  attempt: ClassificationAttempt;
  helperFailure: {profileId: string; errorCode: string} | null;
}

/** Purpose-neutral dispatch engine: transmission permission, budget, dispatch fence, usage checks and helper-failure evidence. */
export async function dispatchAdvisoryAttempt(controls: AdvisoryDispatchControls, task: AdvisoryDispatchTask): Promise<AdvisoryDispatchOutcome> {
  const {provider, profile, budget, bindingCurrent} = controls;
  const request = task.request, failureResponse = task.failureResponse.bind(task);
  // A throwing task method is a task fault, never a provider fault that could become helper-failure evidence.
  const guarded = <A extends unknown[], R>(method: (...args: A) => R) => (...args: A): R => {
    try {return method.apply(task, args);} catch {throw new Error("ADVISORY_TASK_FAULT");}
  };
  const isStale = guarded(task.stale), qualify = guarded(task.qualify);
  const validDiagnostics = guarded(task.validDiagnostics), validResponse = guarded(task.validResponse);
  const controller = new AbortController();
  let dispatchFenced = false;
  const failures = new WeakMap<ProviderEvaluation, {profileId: string; errorCode: string}>();
  // Evidence uses the engine's own code and fence, never a code read back from a task-built response.
  const withEvidence = (evaluation: ProviderEvaluation, code: string) => {
    if (dispatchFenced && continuationFailureCodes.has(code)) failures.set(evaluation, {profileId: profile.profileId, errorCode: code});
    return evaluation;
  };
  let dispatchState: DispatchState = "not-started";
  let reserved = false;
  let retainedUsage = unknownUsage();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reservationId = JSON.stringify([request.operationId, request.requestDigest, profile.profileId]);
  const stopped = new Promise<ProviderEvaluation>((resolve) => {
    const stop = (code: string) => {controller.abort(); resolve(withEvidence({response: failureResponse(code, dispatchState, dispatchState === "not-started" ? "UNAVAILABLE" : "UNCERTAIN"), usage: unknownUsage(), dispatchState, diagnostics: null}, code));};
    timer = setTimeout(() => {timedOut = true; stop("PROVIDER_TIMEOUT");}, controls.timeoutMs);
    controller.signal.addEventListener("abort", () => stop(timedOut ? "PROVIDER_TIMEOUT" : "CANCELLED"), {once: true});
  });
  const cancel = () => controller.abort();
  controls.signal?.addEventListener("abort", cancel, {once: true});
  if (controls.signal?.aborted) controller.abort();
  const work = async (): Promise<ProviderEvaluation> => {
    try {
      if (controls.remoteContentAllowed === false && provider.routeKind !== undefined && provider.routeKind(profile) !== "native") throw new ClassificationProviderError("REMOTE_CONTENT_NOT_APPROVED", "not-started");
      const availability = await provider.availability(profile);
      if (controller.signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
      if (!availability.available || !availability.approved) {
        const codes = ["ROUTE_NOT_APPROVED", "ROUTE_CAPABILITY_MISMATCH", "CREDENTIAL_UNAVAILABLE", "CREDENTIAL_MALFORMED", "INVALID_APPROVED_ENDPOINT", "NATIVE_STRUCTURED_CAPABILITY_UNAVAILABLE", "REMOTE_ADAPTER_UNAVAILABLE"];
        throw new ClassificationProviderError(availability.reasonCode && codes.includes(availability.reasonCode) ? availability.reasonCode : "PROVIDER_UNAVAILABLE", "not-started");
      }
      if (controls.remoteContentAllowed === false && availability.routeKind !== "native") throw new ClassificationProviderError("REMOTE_CONTENT_NOT_APPROVED", "not-started");
      if (!controls.externalClassificationAllowed && availability.routeKind !== "native") throw new ClassificationProviderError("EXTERNAL_CLASSIFICATION_BLOCKED", "not-started");
      if (isStale()) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
      const invalid = qualify();
      if (invalid) throw new ClassificationProviderError(invalid, "not-started");
      if (!budget.reserve(profile, reservationId, profile.maximumCostUsd!, availability.routeKind)) throw new ClassificationProviderError("BUDGET_UNAVAILABLE", "not-started");
      reserved = true;
      dispatchState = "unknown";
      const beforeDispatch = () => {
        dispatchFenced = false;
        if (controls.remoteContentAllowed === false && provider.routeKind !== undefined && provider.routeKind(profile) !== "native") throw new ClassificationProviderError("REMOTE_CONTENT_NOT_APPROVED", "not-started");
        if (controller.signal.aborted) throw new ClassificationProviderError("CANCELLED", "not-started");
        if (isStale()) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
        if (qualify() !== null || !bindingCurrent()) throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");
        dispatchFenced = true;
      };
      let evaluation: ProviderEvaluation;
      let providerFailure: ClassificationProviderError | null = null;
      try { evaluation = await provider.classify(request, profile, controller.signal, beforeDispatch); }
      catch (error) {
        if (!(error instanceof ClassificationProviderError) || !error.usage) throw error;
        providerFailure = error;
        evaluation = {response: failureResponse(error.code, error.dispatchState, "UNAVAILABLE"), usage: error.usage, dispatchState: error.dispatchState, diagnostics: null};
      }
      if (controller.signal.aborted) return evaluation; // only the already-settled race may publish
      const usage = evaluation.usage;
      // Classification/token errors do not erase an independently valid reported charge.
      if (usage && Number.isFinite(usage.actualCostUsd) && usage.actualCostUsd! >= 0) retainedUsage.actualCostUsd = usage.actualCostUsd;
      if (!["not-started", "started", "unknown"].includes(evaluation.dispatchState) || !usage
        || ![usage.inputTokens, usage.outputTokens, usage.cachedInputTokens].every((n) => n === null || (Number.isSafeInteger(n) && n >= 0))
        || (usage.actualCostUsd !== null && (!Number.isFinite(usage.actualCostUsd) || usage.actualCostUsd < 0))
        || (usage.inputTokens !== null && usage.cachedInputTokens !== null && usage.cachedInputTokens > usage.inputTokens)
        || (evaluation.diagnostics !== null && (!evaluation.diagnostics || !validDiagnostics(evaluation.diagnostics)))) throw new ClassificationProviderError("INVALID_PROVIDER_USAGE", "unknown", true);
      retainedUsage = {...usage};
      if (providerFailure) throw providerFailure;
      if (!validResponse(evaluation.response)) throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", evaluation.dispatchState, true);
      if (usage.actualCostUsd !== null && usage.actualCostUsd > profile.maximumCostUsd!) return {...evaluation,
        response: failureResponse("COST_CEILING_EXCEEDED", evaluation.dispatchState, "UNAVAILABLE")};
      if (usage.outputTokens !== null && usage.outputTokens > profile.maximumOutputTokens) return withEvidence({...evaluation,
        response: failureResponse("OUTPUT_TOO_LONG", evaluation.dispatchState, "INVALID")}, "OUTPUT_TOO_LONG");
      // A returned response error alone is not trusted failure provenance.
      return evaluation;
    } catch (error) {
      const safe = error instanceof ClassificationProviderError ? new ClassificationProviderError(providerFailureCodes.has(error.code) ? error.code : "PROVIDER_UNAVAILABLE",
        ["not-started", "started", "unknown"].includes(error.dispatchState) ? error.dispatchState : "unknown", error.invalid === true, error.code === "RATE_LIMITED" ? sanitizeRateLimitObservation(error.rateLimitObservation) : null) : new ClassificationProviderError("PROVIDER_UNAVAILABLE", dispatchState);
      if (safe.code === "NATIVE_TIMEOUT" || safe.code === "PROVIDER_TIMEOUT") timedOut = true;
      return withEvidence({response: failureResponse(safe.code, safe.dispatchState, safe.invalid ? "INVALID" : timedOut && safe.dispatchState !== "not-started" ? "UNCERTAIN" : "UNAVAILABLE"), usage: retainedUsage, dispatchState: safe.dispatchState, diagnostics: null, rateLimitObservation: safe.rateLimitObservation}, safe.code);
    }
  };
  let evaluation: ProviderEvaluation;
  try { evaluation = await Promise.race([work(), stopped]); }
  finally { if (timer !== undefined) clearTimeout(timer); controls.signal?.removeEventListener("abort", cancel); }
  if (reserved) budget.settle(reservationId, evaluation.usage.actualCostUsd, evaluation.dispatchState);
  const attempt: ClassificationAttempt = {providerKind: profile.providerKind, profileId: profile.profileId, modelId: profile.modelId, reasoningEffort: profile.reasoningEffort,
    dispatchState: evaluation.dispatchState, status: evaluation.response.status, errorCode: evaluation.response.error?.code ?? null, timedOut, usage: evaluation.usage, reservedCostUsd: reserved ? profile.maximumCostUsd! : 0, diagnostics: structuredClone(evaluation.diagnostics), rateLimitObservation: evaluation.response.error?.code === "RATE_LIMITED" ? sanitizeRateLimitObservation(evaluation.rateLimitObservation) : null};
  return {evaluation, attempt, helperFailure: failures.get(evaluation) ?? null};
}
