import {createHash, randomUUID} from "node:crypto";
import {readFile, writeFile, mkdir, open, rename} from "node:fs/promises";
import {readFileSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, realpathSync, lstatSync} from "node:fs";
import path from "node:path";
import {pathToFileURL, fileURLToPath} from "node:url";
import type {ClassificationObservation} from "../evaluation.js";
import type {ProviderConfiguration, ProviderEvaluationConfigurationV1, SkillClassificationRequestV1} from "../../../mcp-server/src/skill-classification/types.js";

type Reference = {path: string; digest: string};
interface LegacyBootstrapConfig {
  schemaVersion: "1.0.0";
  runId: string;
  repo: string;
  outputDirectory: string;
  endpointEnv: string;
  credentialEnv: string;
  approvedEndpointDigest: string | null;
  approvedRouteRef: string | null;
  approvalRef: string | null;
  profile: Record<string, unknown> | null;
  limits: {requests: number; inputBytes: number; inputTokens: number; outputTokens: number; responseBytes: number; timeoutMs: number; runUsd: number} | null;
  prices: {billingMode: "token" | "fixed-per-call"; inputUsdPer1k: number; outputUsdPer1k: number; fixedCallMaxUsd: number} | null;
  budget: {totalLimitUsd: number; verifiedPriorSpendUsd: number; priorUnknownReservedUsd: number; currentRemainingUsd: number; observedAt: string; validUntil: string} | null;
  evidence: {route: Reference | null; price: Reference | null; priorLedger: Reference | null; remaining: Reference | null; hardTokenCaps: Reference | null; operatorAuthorization: Reference | null};
}
type RunBudget = {scope: "run"; runId: string; totalAuthorizationUsd: number; allocatedUsd: number; allocationRef: string;
  priorRunConfirmedSpendUsd: number; priorRunUnknownReservedUsd: number;
  accountBalanceUsd: number | null; accountPriorSpendUsd: number | null; accountUnknownReservedUsd: number | null;
  observedAt: string; validUntil: string};
type Estimator = {method: "utf8-bytes-as-input-tokens-v1"; inputArtifact: Reference; sources: Reference[]; uncertainty: string};
type ScopedBootstrapConfig = Omit<LegacyBootstrapConfig, "schemaVersion" | "budget"> & {
  schemaVersion: "2.0.0"; budget: RunBudget | null; reservationMode: "verified-upper-bound" | "reviewed-estimate"; estimator: Estimator | null};
export type PreparedBootstrapConfig = Omit<ScopedBootstrapConfig, "schemaVersion" | "budget" | "profile"> & {
  schemaVersion: "3.0.0"; budget: Omit<RunBudget, "validUntil"> | null; profile: ProviderEvaluationConfigurationV1 | null;
  currentAuthority: {scope: "single-run-directory"; ownerId: string; revision: string; budgetRevision: string; reference: Reference} | null};
export type BootstrapConfig = LegacyBootstrapConfig | ScopedBootstrapConfig | PreparedBootstrapConfig;
type LedgerEntry = {requestId: string; requestDigest: string; state: "reserved" | "unknown" | "known" | "not-started"; reservedUsd: number; actualCostUsd: number | null; estimatedCostUsd: number | null; dispatchState: string; resultDigest: string | null};
type Ledger = {schemaVersion: "1.0.0" | "2.0.0" | "3.0.0"; runId: string; configDigest: string; budgetScope: "legacy-unscoped" | "run"; initialRemainingUsd: number; entries: LedgerEntry[]};
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const modules = async (repo: string) => {
  const source = (name: string) => import(pathToFileURL(path.join(repo, "mcp-server/src/skill-classification", name)).href);
  const [inventory, request, providers, profiles, validation, evaluationConfig, evaluation] = await Promise.all([
    source("inventory.ts"), source("request.ts"), source("providers.ts"), source("profiles.ts"), source("validation.ts"),
    source("evaluation-config.ts"),
    import(pathToFileURL(path.join(repo, "tests/skill-classification/evaluation.ts")).href),
  ]);
  return {inventory, request, providers, profiles, validation, evaluationConfig, evaluation};
};
const requireCondition = (value: unknown, code: string): void => {if (!value) throw new Error(code);};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const references = ["route", "price", "priorLedger", "remaining", "hardTokenCaps", "operatorAuthorization"] as const;
const configKeys = ["schemaVersion", "runId", "repo", "outputDirectory", "endpointEnv", "credentialEnv", "approvedEndpointDigest", "approvedRouteRef", "approvalRef", "profile", "limits", "prices", "budget", "evidence"];
// Local run-allocation policy within the existing USD5 authority; not account balance or a provider billing guarantee.
const MAX_RUN_ALLOCATION_USD = 0.15;
const validConfigKeys = (config: BootstrapConfig) => sameKeys(config, config.schemaVersion === "1.0.0" ? configKeys
  : [...configKeys, "reservationMode", "estimator", ...(config.schemaVersion === "3.0.0" ? ["currentAuthority"] : [])]);
const estimateMode = (config: BootstrapConfig) => config.schemaVersion !== "1.0.0" && config.reservationMode === "reviewed-estimate";
const candidateProfile = (config: BootstrapConfig): Record<string, unknown> | null => config.schemaVersion === "3.0.0"
  ? config.profile?.configuration as unknown as Record<string, unknown> ?? null : config.profile;
const remaining = (config: BootstrapConfig) => config.schemaVersion !== "1.0.0"
  ? config.budget ? config.budget.allocatedUsd - config.budget.priorRunConfirmedSpendUsd - config.budget.priorRunUnknownReservedUsd : null
  : config.budget?.currentRemainingUsd ?? null;

/** The operator-reviewed evidence binds the exact configured numbers/options, not mere file presence. */
export function evidenceValues(config: BootstrapConfig, kind: typeof references[number]) {
  const profile = candidateProfile(config);
  if (kind === "route") return {approvedRouteRef: config.approvedRouteRef, approvedEndpointDigest: config.approvedEndpointDigest, approvalRef: config.approvalRef,
    modelId: profile?.modelId ?? null, modelRevision: profile?.modelRevision ?? null, reasoningEffort: profile?.reasoningEffort ?? null, adapterRevision: profile?.adapterRevision ?? null};
  if (kind === "price") return {billingUnit: "USD", prices: config.prices};
  if (config.schemaVersion !== "1.0.0" && (kind === "priorLedger" || kind === "remaining")) return {scope: "run", runId: config.runId, budget: config.budget};
  if (kind === "priorLedger" && config.schemaVersion === "1.0.0") return {totalLimitUsd: config.budget?.totalLimitUsd ?? null, verifiedPriorSpendUsd: config.budget?.verifiedPriorSpendUsd ?? null, priorUnknownReservedUsd: config.budget?.priorUnknownReservedUsd ?? null};
  if (kind === "remaining" && config.schemaVersion === "1.0.0") return {currentRemainingUsd: config.budget?.currentRemainingUsd ?? null, observedAt: config.budget?.observedAt ?? null, validUntil: config.budget?.validUntil ?? null};
  if (kind === "hardTokenCaps") return {approvedRouteRef: config.approvedRouteRef,
    inputTokens: config.prices && config.prices.inputUsdPer1k > 0 ? config.limits?.inputTokens ?? null : null,
    outputTokens: config.prices && config.prices.outputUsdPer1k > 0 ? config.limits?.outputTokens ?? null : null,
    pricedTokenCapsEnforcedByRoute: true};
  const operation = {runId: config.runId, approvedRouteRef: config.approvedRouteRef, approvalRef: config.approvalRef, limits: config.limits, publicOnly: true, transport: "one-attempt", mode: "qualification-bootstrap"};
  return config.schemaVersion !== "1.0.0" ? {...operation, scope: "run", budget: config.budget, reservationMode: config.reservationMode,
    estimator: config.estimator, profile: config.profile, prices: config.prices, retryCount: 0} : operation;
}
export const evidenceValuesDigest = (config: BootstrapConfig, kind: typeof references[number]) => hash(JSON.stringify(evidenceValues(config, kind)));

/** Author a preparation definition only; current issuer authority is a separate required input. Never retag a legacy issuer record. */
export function createPreparationEvidence(config: PreparedBootstrapConfig, kind: typeof references[number],
  provenance: {verifiedBy: string; sourceRef: string; preparedAt: string}, policy: {kind: "immutable-preparation"} | {kind: "issuer"; validUntil: string}) {
  requireCondition(provenance.verifiedBy && provenance.sourceRef && Number.isFinite(Date.parse(provenance.preparedAt)), "PREPARATION_PROVENANCE_INVALID");
  requireCondition(policy.kind === "immutable-preparation" || (policy.kind === "issuer" && Number.isFinite(Date.parse(policy.validUntil))), "ISSUER_EXPIRY_INVALID");
  return {schemaVersion: "2.0.0", kind, ...provenance, expiryPolicy: policy.kind,
    ...(policy.kind === "issuer" ? {validUntil: policy.validUntil} : {}), valuesDigest: evidenceValuesDigest(config, kind)};
}

function boundedLocalReference(config: BootstrapConfig, ref: Reference): string {
  requireCondition(ref && sameKeys(ref, ["path", "digest"]) && typeof ref.path === "string" && /^sha256:[a-f0-9]{64}$/.test(ref.digest), "CURRENT_REFERENCE_INVALID");
  const root = realpathSync(config.outputDirectory), file = path.resolve(root, ref.path);
  requireCondition(!path.isAbsolute(ref.path) && !path.relative(root, file).startsWith("..") && lstatSync(file).isFile() && lstatSync(file).size <= 1024 * 1024
    && realpathSync(file) === file, "CURRENT_REFERENCE_OUTSIDE_SCOPE");
  return file;
}

/** Trusted local issuer input, separate from the immutable preparation. No authority is minted here. */
function assertCurrentAuthority(config: PreparedBootstrapConfig): void {
  const authority = config.currentAuthority;
  requireCondition(authority && sameKeys(authority, ["scope", "ownerId", "revision", "budgetRevision", "reference"])
    && authority.scope === "single-run-directory", "AUTHORITY_SCOPE_UNSUPPORTED");
  requireCondition([authority!.ownerId, authority!.revision, authority!.budgetRevision].every(value => typeof value === "string" && value.length > 0), "CURRENT_AUTHORITY_UNBOUND");
  const bytes = readFileSync(boundedLocalReference(config, authority!.reference));
  requireCondition(bytes.length <= 65536 && hash(bytes) === authority!.reference.digest, "CURRENT_AUTHORITY_CHANGED");
  const record = JSON.parse(bytes.toString("utf8"));
  requireCondition(record && sameKeys(record, ["schemaVersion", "scope", "runId", "outputDirectory", "ownerId", "revision", "budgetRevision", "approved", "cancelled", "valuesDigest"])
    && record.schemaVersion === "1.0.0" && record.scope === authority!.scope && record.runId === config.runId
    && record.outputDirectory === realpathSync(config.outputDirectory) && record.ownerId === authority!.ownerId
    && record.revision === authority!.revision && record.budgetRevision === authority!.budgetRevision && record.approved === true && record.cancelled === false
    && record.valuesDigest === evidenceValuesDigest(config, "operatorAuthorization"), "CURRENT_AUTHORITY_REVOKED_OR_UNBOUND");
}

export async function prepare(config: BootstrapConfig) {
  requireCondition(["1.0.0", "2.0.0", "3.0.0"].includes(config.schemaVersion) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(config.runId), "INVALID_RUN_ID");
  requireCondition(validConfigKeys(config) && sameKeys(config.evidence, [...references]), "UNKNOWN_CONFIG_FIELD");
  const api = await modules(path.resolve(config.repo));
  const fixtureBytes = await readFile(path.join(config.repo, "tests/skill-classification/fixtures.json"));
  const corpus = JSON.parse(fixtureBytes.toString("utf8"));
  requireCondition(api.evaluation.oracleDigest(corpus) === corpus.oracleDigest, "FROZEN_ORACLE_DIGEST_MISMATCH");
  for (const source of corpus.sourceSkills) requireCondition(hash(await readFile(path.join(config.repo, source.path))) === source.digest, "ORACLE_SOURCE_MISMATCH");
  const cases = corpus.cases.filter((row: {publicSynthetic: boolean; originalPrompt: unknown}) => row.publicSynthetic === true && typeof row.originalPrompt === "string" && row.originalPrompt.length > 0);
  requireCondition(cases.length === 21 && new Set(cases.map((row: {caseId: string}) => row.caseId)).size === 21, "PUBLIC_FIXTURE_SET_MISMATCH");
  const inventory = await api.inventory.loadSkillInventory({root: path.resolve(config.repo)});
  requireCondition(inventory.issues.length === 0, "INVENTORY_INCOMPLETE");
  const requests = cases.map((row: {caseId: string; originalPrompt: string}) => ({caseId: row.caseId,
    request: api.request.createClassificationRequest({requestId: `${config.runId}/${row.caseId}`, operationId: `${config.runId}/${row.caseId}`,
      originalPrompt: row.originalPrompt, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"})}));
  const sourceBindings: Reference[] = [];
  if (config.schemaVersion === "3.0.0") {
    const names = ["inventory.ts", "request.ts", "providers.ts", "profiles.ts", "evaluation-config.ts", "validation.ts", "types.ts", "digest.ts"];
    const files = [...names.map(name => path.join(config.repo, "mcp-server/src/skill-classification", name)),
      path.join(config.repo, "tests/skill-classification/evaluation.ts"), fileURLToPath(import.meta.url), path.join(config.repo, "tests/skill-classification/fixtures.json"),
      ...inventory.skills.flatMap((skill: {sourceRefs: Reference[]}) => skill.sourceRefs.map(ref => path.resolve(config.repo, ref.path)))];
    for (const file of new Set<string>(files)) sourceBindings.push({path: file, digest: hash(await readFile(file))});
  }
  return {api, corpus, cases, inventory, requests, fixtureFileDigest: hash(fixtureBytes), sourceBindings};
}

/** No endpoint/credential environment lookup and no transport call in this function. */
export async function preflight(config: BootstrapConfig, prepared: Awaited<ReturnType<typeof prepare>>, now = Date.now()) {
  const blocked: string[] = [];
  const validatedEvidenceExpiries: {kind: string; deadlineMs: number}[] = [];
  const fail = (condition: unknown, code: string) => {if (!condition) blocked.push(code);};
  fail(validConfigKeys(config) && sameKeys(config.evidence, [...references]), "UNKNOWN_CONFIG_FIELD");
  fail(/^[A-Z][A-Z0-9_]+$/.test(config.endpointEnv) && /^[A-Z][A-Z0-9_]+$/.test(config.credentialEnv) && config.endpointEnv !== config.credentialEnv, "INVALID_ENV_NAMES");
  fail(typeof config.approvedEndpointDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(config.approvedEndpointDigest), "APPROVED_ENDPOINT_UNBOUND");
  fail(config.approvedRouteRef && config.approvalRef, "ROUTE_APPROVAL_MISSING");
  const hardCapsRequired = !estimateMode(config) && config.prices?.billingMode === "token" && (config.prices.inputUsdPer1k > 0 || config.prices.outputUsdPer1k > 0);
  for (const kind of references) {
    if (kind === "hardTokenCaps" && !hardCapsRequired) continue;
    const ref = config.evidence?.[kind];
    if (!ref || !/^sha256:[a-f0-9]{64}$/.test(ref.digest)) {blocked.push(`EVIDENCE_MISSING:${kind}`); continue;}
    const target = path.resolve(config.outputDirectory, ref.path);
    if (path.isAbsolute(ref.path) || path.relative(path.resolve(config.outputDirectory), target).startsWith("..")) {blocked.push(`EVIDENCE_PATH_INVALID:${kind}`); continue;}
    try {
      const bytes = await readFile(target);
      if (hash(bytes) !== ref.digest) {blocked.push(`EVIDENCE_STALE:${kind}`); continue;}
      const record = JSON.parse(bytes.toString("utf8"));
      const preparedRecord = config.schemaVersion === "3.0.0" && record.schemaVersion === "2.0.0";
      const issuerExpiry = !preparedRecord || record.expiryPolicy === "issuer";
      const keys = preparedRecord ? ["schemaVersion", "kind", "verifiedBy", "sourceRef", "preparedAt", "expiryPolicy", "valuesDigest", ...(issuerExpiry ? ["validUntil"] : [])]
        : ["schemaVersion", "kind", "verifiedBy", "sourceRef", "validUntil", "valuesDigest"];
      if (!sameKeys(record, keys) || (!preparedRecord && record.schemaVersion !== "1.0.0") || record.kind !== kind
        || typeof record.verifiedBy !== "string" || !record.verifiedBy || typeof record.sourceRef !== "string" || !record.sourceRef
        || (preparedRecord && (!["immutable-preparation", "issuer"].includes(record.expiryPolicy) || !Number.isFinite(Date.parse(record.preparedAt))))
        || (issuerExpiry && (!Number.isFinite(Date.parse(record.validUntil)) || Date.parse(record.validUntil) <= now))
        || record.valuesDigest !== evidenceValuesDigest(config, kind)) blocked.push(`EVIDENCE_UNBOUND:${kind}`);
      else if (issuerExpiry) validatedEvidenceExpiries.push({kind, deadlineMs: Date.parse(record.validUntil)});
    } catch {blocked.push(`EVIDENCE_UNREADABLE:${kind}`);}
  }
  if (blocked.some(code => code.endsWith(":hardTokenCaps"))) blocked.push(config.prices && config.prices.outputUsdPer1k > 0 ? "OUTPUT_CAP_UNVERIFIED" : "INPUT_BILLING_CAP_UNVERIFIED");
  const {limits, prices, budget} = config;
  fail(limits && sameKeys(limits, ["requests", "inputBytes", "inputTokens", "outputTokens", "responseBytes", "timeoutMs", "runUsd"])
    && positiveInt(limits.requests) && limits.requests <= 21 && positiveInt(limits.inputBytes) && limits.inputBytes <= 4 * 1024 * 1024
    && positiveInt(limits.inputTokens) && positiveInt(limits.outputTokens) && positiveInt(limits.responseBytes) && limits.responseBytes <= 1024 * 1024
    && positiveInt(limits.timeoutMs) && limits.timeoutMs <= 60000 && finite(limits.runUsd) && limits.runUsd > 0, "FINITE_LIMITS_MISSING");
  fail(limits && finite(limits.runUsd) && limits.runUsd <= 5 && budget
    && (config.schemaVersion === "1.0.0" ? finite(config.budget!.totalLimitUsd) && config.budget!.totalLimitUsd <= 5
      : finite(config.budget!.totalAuthorizationUsd) && config.budget!.totalAuthorizationUsd <= 5), "BUDGET_HARD_LIMIT_USD_5");
  const validPrices = prices && sameKeys(prices, ["billingMode", "inputUsdPer1k", "outputUsdPer1k", "fixedCallMaxUsd"])
    && ["token", "fixed-per-call"].includes(prices.billingMode) && [prices.inputUsdPer1k, prices.outputUsdPer1k, prices.fixedCallMaxUsd].every(finite)
    && (prices.billingMode !== "fixed-per-call" || (prices.inputUsdPer1k === 0 && prices.outputUsdPer1k === 0));
  fail(validPrices, "VERIFIED_PRICE_UPPER_BOUND_MISSING");
  if (config.schemaVersion === "1.0.0") {
    const legacy = config.budget;
    fail(legacy && sameKeys(legacy, ["totalLimitUsd", "verifiedPriorSpendUsd", "priorUnknownReservedUsd", "currentRemainingUsd", "observedAt", "validUntil"])
      && [legacy.totalLimitUsd, legacy.verifiedPriorSpendUsd, legacy.priorUnknownReservedUsd, legacy.currentRemainingUsd].every(finite)
      && legacy.currentRemainingUsd <= legacy.totalLimitUsd - legacy.verifiedPriorSpendUsd - legacy.priorUnknownReservedUsd + 1e-12
      && Number.isFinite(Date.parse(legacy.observedAt)) && Date.parse(legacy.observedAt) <= now && Date.parse(legacy.validUntil) > now, "CURRENT_LEDGER_OR_REMAINING_UNVERIFIED");
  } else {
    const runBudget = config.budget;
    fail(["verified-upper-bound", "reviewed-estimate"].includes(config.reservationMode), "RESERVATION_MODE_INVALID");
    fail(runBudget && sameKeys(runBudget, ["scope", "runId", "totalAuthorizationUsd", "allocatedUsd", "allocationRef", "priorRunConfirmedSpendUsd", "priorRunUnknownReservedUsd", "accountBalanceUsd", "accountPriorSpendUsd", "accountUnknownReservedUsd", "observedAt", ...(config.schemaVersion === "2.0.0" ? ["validUntil"] : [])])
      && runBudget.scope === "run" && runBudget.runId === config.runId && typeof runBudget.allocationRef === "string" && runBudget.allocationRef.length > 0
      && [runBudget.totalAuthorizationUsd, runBudget.allocatedUsd, runBudget.priorRunConfirmedSpendUsd, runBudget.priorRunUnknownReservedUsd].every(finite)
      && runBudget.allocatedUsd > 0 && runBudget.allocatedUsd <= MAX_RUN_ALLOCATION_USD && runBudget.allocatedUsd <= runBudget.totalAuthorizationUsd
      && [runBudget.accountBalanceUsd, runBudget.accountPriorSpendUsd, runBudget.accountUnknownReservedUsd].every(value => value === null || finite(value))
      && remaining(config)! >= 0 && limits && limits.runUsd <= runBudget.allocatedUsd
      && Number.isFinite(Date.parse(runBudget.observedAt))
      && (config.schemaVersion === "3.0.0" || (Date.parse(runBudget.observedAt) <= now && Date.parse(config.budget!.validUntil) > now)), "RUN_ALLOCATION_UNVERIFIED");
  }
  const budgetExpiry = config.schemaVersion !== "3.0.0" ? config.budget?.validUntil : null;
  if (budgetExpiry && Number.isFinite(Date.parse(budgetExpiry)) && Date.parse(budgetExpiry) > now) validatedEvidenceExpiries.push({kind: "budget", deadlineMs: Date.parse(budgetExpiry)});
  const profile = candidateProfile(config);
  if (config.schemaVersion === "3.0.0") {
    fail(prepared.api.evaluationConfig.validateProviderEvaluationConfiguration(config.profile, prepared.inventory) === null, "INVALID_EVALUATION_CONFIGURATION");
    try {assertCurrentAuthority(config);} catch (error) {blocked.push(error instanceof Error && ["AUTHORITY_SCOPE_UNSUPPORTED", "CURRENT_AUTHORITY_CHANGED", "CURRENT_AUTHORITY_REVOKED_OR_UNBOUND"].includes(error.message) ? error.message : "CURRENT_AUTHORITY_UNAVAILABLE");}
  } else fail(profile && prepared.api.profiles.isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "bootstrap-candidate", profiles: [profile]}), "INVALID_CANDIDATE_PROFILE");
  if (profile) {
    fail(profile.providerKind === "jev", "NATIVE_FACTORY_UNAVAILABLE");
    fail(profile.approvedRouteRef === config.approvedRouteRef, "APPROVED_ROUTE_MISMATCH");
    const q = profile.qualification as Record<string, unknown> | undefined;
    if (config.schemaVersion !== "3.0.0") {
      fail(q?.status === "NOT_RUN" && q.inventoryDigest === prepared.inventory.inventoryDigest && q.taxonomyRevision === prepared.inventory.taxonomyRevision
      && q.modelRevision === profile.modelRevision && q.promptRevision === profile.promptRevision
      && q.profileConfigurationDigest === prepared.api.profiles.digestProviderProfileConfiguration(profile), "CANDIDATE_BINDING_MISMATCH");
    fail(typeof q?.validUntil === "string" && Date.parse(q.validUntil) > now, "CANDIDATE_EXPIRED");
      if (typeof q?.validUntil === "string" && Date.parse(q.validUntil) > now) validatedEvidenceExpiries.push({kind: "candidate", deadlineMs: Date.parse(q.validUntil)});
    }
    fail(profile.reasoningEffort === null && profile.judgmentPolicy !== null, "JEV_OPTIONS_UNSUPPORTED");
    const supported = profile.supportedOptions as {structuredOutput?: boolean; reasoningEfforts?: unknown[]} | undefined;
    fail(supported?.structuredOutput === true && supported.reasoningEfforts?.includes(profile.reasoningEffort), "UNSUPPORTED_PROFILE_CAPABILITY");
    fail(limits && profile.maximumInputBytes === limits.inputBytes && profile.maximumOutputTokens === limits.outputTokens, "PROFILE_CAP_MISMATCH");
  }
  let perRequestReservedUsd: number | null = null;
  let requestReservations: {caseId: string; requestDigest: string; reservedUsd: number}[] = [];
  if (limits && prices && [limits.inputTokens, limits.outputTokens].every(positiveInt) && validPrices) {
    const cost = prices.billingMode === "fixed-per-call" ? 0 : prepared.api.profiles.estimateTokenCostUsd({uncachedInputUsdPer1k: prices.inputUsdPer1k, cachedInputUsdPer1k: null, outputUsdPer1k: prices.outputUsdPer1k}, limits.inputTokens, 0, limits.outputTokens);
    if (cost !== null) perRequestReservedUsd = Math.ceil((cost + prices.fixedCallMaxUsd) * 1e12) / 1e12;
    if (perRequestReservedUsd !== null) requestReservations = prepared.requests.map(({caseId, request}: any) => ({caseId, requestDigest: request.requestDigest, reservedUsd: perRequestReservedUsd!}));
    if (!estimateMode(config)) fail(perRequestReservedUsd !== null && profile?.maximumCostUsd === perRequestReservedUsd, "PROFILE_COST_BOUND_MISMATCH");
    if (!estimateMode(config)) fail(budget && perRequestReservedUsd !== null && perRequestReservedUsd * limits.requests <= Math.min(limits.runUsd, remaining(config)!), "RUN_BUDGET_INSUFFICIENT");
  }
  if (config.schemaVersion !== "1.0.0") {
    if (estimateMode(config)) {
      const estimator = config.estimator;
      fail(estimator && sameKeys(estimator, ["method", "inputArtifact", "sources", "uncertainty"])
        && estimator.method === "utf8-bytes-as-input-tokens-v1" && typeof estimator.uncertainty === "string" && estimator.uncertainty.length > 0
        && Array.isArray(estimator.sources) && estimator.sources.length > 0 && estimator.sources.length <= 10
        && prices?.billingMode === "token" && prices.outputUsdPer1k === 0 && prices.fixedCallMaxUsd === 0, "ESTIMATE_PLAN_MISSING");
      const readBound = async (ref: Reference) => {
        requireCondition(ref && sameKeys(ref, ["path", "digest"]) && typeof ref.path === "string" && /^sha256:[a-f0-9]{64}$/.test(ref.digest), "ESTIMATE_REFERENCE_INVALID");
        const file = path.resolve(config.outputDirectory, ref.path);
        requireCondition(!path.isAbsolute(ref.path) && !path.relative(path.resolve(config.outputDirectory), file).startsWith(".."), "ESTIMATE_PATH_INVALID");
        const bytes = await readFile(file); requireCondition(bytes.length <= 1024 * 1024 && hash(bytes) === ref.digest, "ESTIMATE_SOURCE_STALE"); return bytes;
      };
      try {
        requireCondition(estimator && profile, "ESTIMATE_PLAN_MISSING");
        const inputArtifact = JSON.parse((await readBound(estimator!.inputArtifact)).toString("utf8"));
        const measurements = prepared.requests.map(({caseId, request}: {caseId: string; request: any}) => {const wire = JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, profile));
          return {caseId, requestDigest: request.requestDigest, wireDigest: hash(wire), utf8Bytes: Buffer.byteLength(wire)};});
        requireCondition(JSON.stringify(inputArtifact) === JSON.stringify({runId: config.runId, inventoryDigest: prepared.inventory.inventoryDigest, measurements}), "ESTIMATE_INPUT_UNBOUND");
        for (const ref of estimator!.sources) await readBound(ref);
        requireCondition(prices?.billingMode === "token" && finite(prices.inputUsdPer1k), "ESTIMATE_PRICE_INVALID");
        // Reviewed assumption only: 1 UTF8 byte = 1 charged input token. No provider tokenization/billing guarantee.
        // Interpret the configured Number's canonical decimal spelling, then ceil each request in picoUSD.
        // Only reviewed-estimate uses this calculation; old ledger rows are never settled or repriced here.
        const [priceCoefficient, priceExponent = "0"] = prices!.inputUsdPer1k.toString().toLowerCase().split("e");
        const [priceWhole, priceFraction = ""] = priceCoefficient!.split(".");
        const priceUnits = BigInt(priceWhole! + priceFraction);
        const picoExponent = 9 + Number(priceExponent) - priceFraction.length;
        const priceNumerator = priceUnits * (picoExponent >= 0 ? 10n ** BigInt(picoExponent) : 1n);
        const priceDenominator = picoExponent < 0 ? 10n ** BigInt(-picoExponent) : 1n;
        const reserveUsd = (bytes: number) => {
          const pico = (BigInt(bytes) * priceNumerator + priceDenominator - 1n) / priceDenominator;
          requireCondition(pico <= BigInt(Number.MAX_SAFE_INTEGER), "ESTIMATE_RESERVATION_OUT_OF_RANGE");
          return Number(pico) / 1e12;
        };
        requestReservations = measurements.map((row: {caseId: string; requestDigest: string; utf8Bytes: number}) => ({caseId: row.caseId, requestDigest: row.requestDigest,
          reservedUsd: reserveUsd(row.utf8Bytes)}));
        perRequestReservedUsd = Math.max(...requestReservations.map(row => row.reservedUsd));
      } catch {blocked.push("ESTIMATE_SOURCE_OR_INPUT_UNBOUND");}
      fail(perRequestReservedUsd !== null && profile?.maximumCostUsd === perRequestReservedUsd, "PROFILE_COST_BOUND_MISMATCH");
      fail(limits && remaining(config) !== null && requestReservations.length === 21
        && requestReservations.slice(0, limits.requests).reduce((sum, row) => sum + row.reservedUsd, 0) <= Math.min(limits.runUsd, remaining(config)!) + 1e-12, "RUN_BUDGET_INSUFFICIENT");
    } else fail(config.estimator === null, "UNEXPECTED_ESTIMATE_PLAN");
  }
  if (profile && limits && positiveInt(limits.inputBytes)) for (const {request} of prepared.requests) {
    try {fail(Buffer.byteLength(JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, profile))) <= limits.inputBytes, "INPUT_TOO_LONG");}
    catch {blocked.push("WIRE_ENCODE_FAILED");}
  }
  let eligibleRequestCount = 0, cumulativeReservationUsd = 0;
  for (const row of requestReservations) {
    if (!limits || remaining(config) === null || cumulativeReservationUsd + row.reservedUsd > Math.min(limits.runUsd, remaining(config)!) + 1e-12) break;
    eligibleRequestCount++; cumulativeReservationUsd += row.reservedUsd;
  }
  return {status: blocked.length ? "BLOCKED" as const : "READY_FOR_OPERATOR_DISPATCH" as const, blocked: [...new Set(blocked)],
    validatedEvidenceDeadlineMs: validatedEvidenceExpiries.length ? Math.min(...validatedEvidenceExpiries.map(record => record.deadlineMs)) : null,
    validatedEvidenceExpiries,
    perRequestReservedUsd, requestReservations, eligibleRequestCount, eligibleReservationUsd: cumulativeReservationUsd,
    ineligibleCaseIds: prepared.requests.slice(eligibleRequestCount).map((row: any) => row.caseId),
    candidateStatus: "NOT_RUN", requestCount: prepared.requests.length, inventoryDigest: prepared.inventory.inventoryDigest,
    reservationMode: config.schemaVersion !== "1.0.0" ? config.reservationMode : "legacy-unscoped",
    budgetScope: config.schemaVersion !== "1.0.0" ? "run" : "legacy-unscoped", billingGuarantee: estimateMode(config) ? "NOT_VERIFIED" : "BOUND_EVIDENCE_REQUIRED",
    accountObservation: config.schemaVersion !== "1.0.0" ? {balanceUsd: config.budget?.accountBalanceUsd ?? null, priorSpendUsd: config.budget?.accountPriorSpendUsd ?? null, unknownReservedUsd: config.budget?.accountUnknownReservedUsd ?? null} : null,
    admissionScope: config.schemaVersion === "3.0.0" ? "single-canonical-run-directory-local-filesystem" : "legacy-single-run-directory",
    crossRunAccountOrGlobalAtomicity: "UNSUPPORTED",
    oracleSentToProvider: false, hostSelection: "NOT_RUN", releaseAcceptance: "NOT_ASSESSED"};
}

async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600});
  await rename(temporary, file);
}

function durableJsonSync(file: string, value: unknown, expectedDigest?: string | null): string {
  const bytes = JSON.stringify(value, null, 2) + "\n", temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try {writeFileSync(fd, bytes); fsyncSync(fd);} finally {closeSync(fd);}
  if (expectedDigest !== undefined) requireCondition(hash(readFileSync(file)) === expectedDigest, "RESERVATION_OWNER_OR_LEDGER_CHANGED");
  renameSync(temporary, file);
  return hash(bytes);
}

/** Retain only an inspectable bounded JEV body; never forward arbitrary error text or credential echoes. */
function providerObservation(bytes: Uint8Array, partial: boolean, credential: string, endpoint: string, modelRevision: string, skillIds: string[]) {
  const unknown = {inputTokens: null as number | null, outputTokens: null as number | null, cachedInputTokens: null, actualCostUsd: null};
  let text: string, parsed: Record<string, unknown>;
  try {text = new TextDecoder("utf-8", {fatal: true}).decode(bytes); parsed = JSON.parse(text);} catch {return {rawBody: null, usage: unknown, partial, byteCount: bytes.byteLength, omissionReason: "UNINSPECTABLE_BODY"};}
  const seen: Set<string>[] = [];
  try {
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/gu)) {
      const token = match[0];
      if (token === "{" || token === "[") seen.push(new Set());
      else if (token === "}" || token === "]") seen.pop();
      else {
        const value = JSON.parse(token) as string;
        if ((credential && value.includes(credential)) || (endpoint && value.includes(endpoint))) throw new Error("UNSAFE");
        if (/^\s*:/u.test(text.slice(match.index + token.length))) {
          if (seen.at(-1)?.has(value)) throw new Error("DUPLICATE");
          seen.at(-1)?.add(value);
        }
      }
    }
  } catch {return {rawBody: null, usage: unknown, partial, byteCount: bytes.byteLength, omissionReason: "UNSAFE_OR_AMBIGUOUS_BODY"};}
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  const usage = record(parsed) && record(parsed.usage) ? {inputTokens: positiveInt(parsed.usage.input_tokens) || parsed.usage.input_tokens === 0 ? parsed.usage.input_tokens as number : null,
    outputTokens: positiveInt(parsed.usage.output_tokens) || parsed.usage.output_tokens === 0 ? parsed.usage.output_tokens as number : null, cachedInputTokens: null, actualCostUsd: null} : unknown;
  const safe = record(parsed) && sameKeys(parsed, ["model", "answers", "usage"]) && parsed.model === modelRevision && record(parsed.answers) && record(parsed.usage)
    && sameKeys(parsed.usage, ["input_tokens", "output_tokens"]) && Object.keys(parsed.answers).length === skillIds.length && skillIds.every(id => {
      const answer = (parsed.answers as Record<string, unknown>)[id];
      return record(answer) && sameKeys(answer, ["type", "noul"]) && answer.type === "noul" && typeof answer.noul === "number" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
    });
  return {rawBody: safe ? text : null, usage, partial, byteCount: bytes.byteLength, omissionReason: safe ? null : "BODY_OUTSIDE_SAFE_JEV_CONTRACT"};
}

/** Qualification experiment only. Production profile validation/service are never changed. */
export async function run(config: BootstrapConfig, options: {fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; executionKind?: "offline-mock" | "provider-live"; now?: () => number} = {}) {
  const sourceConfig = config, configDigest = hash(JSON.stringify(config));
  config = structuredClone(config);
  // Clock injection is a test-only function argument; the CLI always uses Date.now.
  const clock = options.now ?? Date.now;
  let observedTime: number | null = null;
  const now = config.schemaVersion !== "3.0.0" ? clock : () => {
    const value = clock();
    if (!Number.isFinite(value)) return value;
    observedTime = observedTime === null ? value : Math.max(observedTime, value);
    return observedTime; // A backward wallclock sample cannot revive an expiry already observed in this run.
  };
  const fetcher = options.fetcher ?? fetch;
  const prepared = await prepare(config);
  const requestBindings = new Map<SkillClassificationRequestV1, string>(prepared.requests.map(({request}: {request: SkillClassificationRequestV1}) =>
    [request, prepared.api.request.digestClassificationValue(request)]));
  const checked = await preflight(config, prepared, now());
  if (checked.status === "BLOCKED") return checked;
  requireCondition(hash(JSON.stringify(sourceConfig)) === configDigest && hash(JSON.stringify(config)) === configDigest
    && prepared.requests.every(({request}: {request: SkillClassificationRequestV1}) => requestBindings.get(request) === prepared.api.request.digestClassificationValue(request)), "STALE_CLASSIFICATION");
  requireCondition(config.schemaVersion === "3.0.0" || checked.validatedEvidenceDeadlineMs !== null, "BOUND_EVIDENCE_DEADLINE_MISSING");
  const evidenceExpired = () => {const current = now(); return !Number.isFinite(current) || (checked.validatedEvidenceDeadlineMs !== null && current >= checked.validatedEvidenceDeadlineMs);};
  const limits = config.limits!;
  await mkdir(path.resolve(config.outputDirectory), {recursive: true});
  const output = realpathSync(config.outputDirectory), lockFile = path.join(output, "bootstrap.lock");
  const lock = await open(lockFile, "wx", 0o600);
  // A persistent lock also prevents a crashed/uncertain run from being retried automatically.
  try {
    let lockDigest: string | null = null, ledgerDigest: string | null = null;
    if (config.schemaVersion === "3.0.0") {
      const bytes = JSON.stringify({schemaVersion: "1.0.0", runId: config.runId, configDigest, ownerId: config.currentAuthority!.ownerId, writerId: randomUUID(), processId: process.pid, persistent: true}) + "\n";
      await lock.writeFile(bytes); await lock.sync(); lockDigest = hash(bytes);
      assertCurrentAuthority(config);
    }
    const ledgerFile = path.join(output, "ledger.json");
    let ledger: Ledger;
    try {
      const bytes = await readFile(ledgerFile, "utf8"); ledger = JSON.parse(bytes);
      if (config.schemaVersion === "3.0.0") ledgerDigest = hash(bytes);
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("LEDGER_UNREADABLE");
      ledger = {schemaVersion: config.schemaVersion, runId: config.runId, configDigest, budgetScope: config.schemaVersion !== "1.0.0" ? "run" : "legacy-unscoped", initialRemainingUsd: remaining(config)!, entries: []};
      await atomicJson(ledgerFile, ledger);
      if (config.schemaVersion === "3.0.0") ledgerDigest = hash(JSON.stringify(ledger, null, 2) + "\n");
    }
    requireCondition(ledger.runId === config.runId && ledger.configDigest === configDigest && ledger.entries.length === 0, "RUN_ALREADY_RESERVED_OR_EXECUTED");
    if (config.schemaVersion === "3.0.0") {
      const selected = prepared.requests.slice(0, limits.requests);
      const reservations: LedgerEntry[] = selected.map(({request}: {request: SkillClassificationRequestV1}) => {
        const reservation = checked.requestReservations.find(row => row.requestDigest === request.requestDigest);
        requireCondition(reservation, "REQUEST_RESERVATION_MISSING");
        return {requestId: request.requestId, requestDigest: request.requestDigest, state: "reserved" as const, reservedUsd: reservation!.reservedUsd,
          actualCostUsd: null, estimatedCostUsd: null, dispatchState: "not-started", resultDigest: null};
      });
      requireCondition(reservations.reduce((sum, row) => sum + row.reservedUsd, 0) <= Math.min(limits.runUsd, ledger.initialRemainingUsd) + 1e-12, "FULL_RESERVATION_EXCEEDS_ALLOCATION");
      ledger.entries = reservations;
      ledgerDigest = durableJsonSync(ledgerFile, ledger, ledgerDigest);
    }
    const assertExecutionState = () => {
      if (config.schemaVersion !== "3.0.0") return;
      assertCurrentAuthority(config);
      requireCondition(hash(readFileSync(lockFile)) === lockDigest && hash(readFileSync(ledgerFile)) === ledgerDigest, "RESERVATION_OWNER_OR_LEDGER_CHANGED");
      for (const ref of prepared.sourceBindings) requireCondition(hash(readFileSync(ref.path)) === ref.digest, "PREPARED_SOURCE_CHANGED");
      for (const kind of references) {
        const ref = config.evidence[kind];
        if (ref) requireCondition(hash(readFileSync(boundedLocalReference(config, ref))) === ref.digest, "CURRENT_EVIDENCE_CHANGED");
      }
      if (config.estimator) for (const ref of [config.estimator.inputArtifact, ...config.estimator.sources]) {
        requireCondition(hash(readFileSync(boundedLocalReference(config, ref))) === ref.digest, "CURRENT_ESTIMATE_INPUT_OR_SOURCE_CHANGED");
      }
    };
    assertExecutionState();
    const environment = options.env ?? process.env;
    const endpoint = environment[config.endpointEnv];
    requireCondition(endpoint && hash(endpoint) === config.approvedEndpointDigest, "APPROVED_ENDPOINT_ENV_MISMATCH");
    const profile = candidateProfile(config)!;
    let transportInvocations = 0;
    let evidenceExpiredBeforeFetch = false;
    let billingOrBalanceFailure = false;
    let stopReason: string | null = null;
    const transport: typeof fetch = async (...args) => {
      if (evidenceExpired()) {evidenceExpiredBeforeFetch = true; throw new Error("BOUND_EVIDENCE_EXPIRED");}
      assertExecutionState();
      transportInvocations++;
      const response = await fetcher(...args);
      if (response.status === 402) billingOrBalanceFailure = true;
      return response;
    };
    // Evaluation admission is the READY preflight for this frozen NOT_RUN corpus.
    // Keep this transport private: production classification still requires PASS.
    const {ClassificationProviderError} = prepared.api.providers;
    const adapter = prepared.api.providers.jevNoulWireAdapter;
    const {encode, decode, validateRawResponse} = adapter;
    const discardBody = (response: Response) => {
      try {void response.body?.cancel().catch(() => {});} catch { /* Cleanup cannot replace the original failure or wait past its deadline. */ }
    };
    const endpointUrl = (() => {
      try {
        const value = new URL(endpoint!);
        if (value.protocol === "https:" && !value.username && !value.password) return value;
      } catch { /* Return only the fixed admission error, never endpoint/credential text. */ }
      return null;
    })();
    const providerObservations = new Map<string, ReturnType<typeof providerObservation>>();
    const classify = async (request: SkillClassificationRequestV1, signal: AbortSignal) => {
      const fixedRequest = structuredClone(request), fixedProfile = structuredClone(profile) as unknown as ProviderConfiguration;
      const requestBinding = requestBindings.get(request);
      const profileBinding = prepared.api.request.digestClassificationValue(fixedProfile);
      let started = false, claimed = false;
      const deadlineMs = config.schemaVersion === "3.0.0" ? now() + limits.timeoutMs : null;
      const assertCurrent = () => {
        const state = started || claimed ? "unknown" : "not-started";
        if (signal.aborted || (deadlineMs !== null && now() >= deadlineMs)) throw new ClassificationProviderError(started || claimed ? "DISPATCH_TIMEOUT_UNKNOWN" : "CANCELLED", state);
        if (evidenceExpired()) throw new ClassificationProviderError("BOUND_EVIDENCE_EXPIRED", state);
        try {assertExecutionState();} catch {throw new ClassificationProviderError("CURRENT_AUTHORITY_OR_RESERVATION_CHANGED", state);}
        let current = false;
        try {
          current = hash(JSON.stringify(sourceConfig)) === configDigest && hash(JSON.stringify(config)) === configDigest
            && prepared.api.request.digestClassificationValue(request) === requestBinding
            && prepared.api.request.digestClassificationValue(fixedRequest) === requestBinding
            && prepared.api.request.digestClassificationValue(profile) === profileBinding
            && prepared.api.request.digestClassificationValue(fixedProfile) === profileBinding
            && prepared.api.providers.jevNoulWireAdapter === adapter
            && adapter.encode === encode && adapter.decode === decode && adapter.validateRawResponse === validateRawResponse
            && (config.schemaVersion === "3.0.0" ? prepared.api.evaluationConfig.validateProviderEvaluationConfiguration(config.profile, prepared.inventory) === null
              : (fixedProfile as unknown as {qualification: {status: string; validUntil: string}}).qualification.status === "NOT_RUN"
                && Date.parse((fixedProfile as unknown as {qualification: {validUntil: string}}).qualification.validUntil) > now());
        } catch { /* Changes to the approved evaluation inputs fail closed. */ }
        if (!current) throw new ClassificationProviderError("STALE_CLASSIFICATION", state);
      };
      assertCurrent();
      if (!endpointUrl) throw new ClassificationProviderError("INVALID_APPROVED_ENDPOINT", "not-started");
      let key: string | null;
      try {key = await Promise.resolve(environment[config.credentialEnv] ?? null);}
      catch {throw new ClassificationProviderError("CREDENTIAL_UNAVAILABLE", "not-started");}
      assertCurrent();
      if (!key) throw new ClassificationProviderError("CREDENTIAL_UNAVAILABLE", "not-started");
      let body: string;
      try {body = JSON.stringify(encode.call(adapter, fixedRequest, fixedProfile));}
      catch {throw new ClassificationProviderError("INVALID_PROVIDER_REQUEST", "not-started", true);}
      if (typeof body !== "string") throw new ClassificationProviderError("INVALID_PROVIDER_REQUEST", "not-started", true);
      if (Buffer.byteLength(body, "utf8") > fixedProfile.maximumInputBytes) throw new ClassificationProviderError("INPUT_TOO_LONG", "not-started");
      assertCurrent();
      let response: Response;
      // The ledger reservation was persisted by the caller; this is the only dispatch.
      try {
        if (config.schemaVersion === "3.0.0") {
          const entry = ledger.entries.find(row => row.requestId === request.requestId && row.requestDigest === request.requestDigest);
          requireCondition(entry?.state === "reserved", "ATTEMPT_NOT_RESERVED");
          const claimFile = path.join(output, `${hash(request.operationId).slice(7)}.attempt-1.claim.json`);
          const fd = openSync(claimFile, "wx", 0o600);
          try {
            writeFileSync(fd, JSON.stringify({runId: config.runId, ownerId: config.currentAuthority!.ownerId, configDigest, operationId: request.operationId,
              requestDigest: request.requestDigest, wireDigest: hash(body), reservedUsd: entry!.reservedUsd, state: "UNKNOWN", additionalAttempts: 0}) + "\n");
            fsyncSync(fd);
          } finally {closeSync(fd);}
          claimed = true;
          entry!.state = "unknown"; entry!.dispatchState = "unknown";
          assertCurrent(); // A consumed claim must not conceal changes made before journal persistence.
          ledgerDigest = durableJsonSync(ledgerFile, ledger, ledgerDigest);
          assertCurrent(); // No await between the final claim/journal fence and the actual transport.
        }
        started = true;
        response = await transport(endpointUrl.href, {method: "POST", headers: {authorization: `Bearer ${key}`, "content-type": "application/json"}, body, signal, redirect: "error"});
      } catch (error) {if (error instanceof ClassificationProviderError) throw error; throw new ClassificationProviderError("TRANSPORT_UNAVAILABLE", started || claimed ? "unknown" : "not-started");}
      let staleResponse: unknown = null;
      const checkResponseState = () => {
        try {assertCurrent();}
        catch (error) {if (config.schemaVersion === "3.0.0" && !signal.aborted && deadlineMs !== null && now() < deadlineMs) staleResponse = error; else throw error;}
      };
      try {checkResponseState();}
      catch (error) {discardBody(response); throw error;}
      if (!response.ok && config.schemaVersion !== "3.0.0") {
        discardBody(response);
        const code = response.status === 401 || response.status === 403 ? "AUTH_UNAVAILABLE"
          : response.status === 429 || response.status === 529 ? "RATE_LIMITED" : "API_UNAVAILABLE";
        throw new ClassificationProviderError(code, "started");
      }
      if (!response.body) throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true);
      const reader = response.body.getReader(), chunks: Uint8Array[] = [];
      const cancelReader = () => {void reader.cancel().catch(() => {});};
      signal.addEventListener("abort", cancelReader, {once: true});
      let bytes = 0, bodyText: string;
      try {
        while (true) {
          checkResponseState();
          let item: ReadableStreamReadResult<Uint8Array>;
          try {item = await reader.read();}
          catch {throw new ClassificationProviderError("TRANSPORT_UNAVAILABLE", "unknown");}
          if (config.schemaVersion !== "3.0.0") checkResponseState();
          if (item.done) {if (config.schemaVersion === "3.0.0") checkResponseState(); break;}
          if (item.value.byteLength > limits.responseBytes - bytes) {
            throw new ClassificationProviderError("PROVIDER_RESPONSE_TOO_LARGE", "unknown", true);
          }
          if (item.value.byteLength) {
            bytes += item.value.byteLength; chunks.push(item.value);
            // Preserve received safe bytes before the timeout race can finish the outer record.
            if (config.schemaVersion === "3.0.0") providerObservations.set(request.requestDigest,
              providerObservation(Buffer.concat(chunks, bytes), true, key, endpoint!, fixedProfile.modelRevision, fixedRequest.skills.map(skill => skill.skillId)));
          }
          if (config.schemaVersion === "3.0.0") checkResponseState();
        }
        try {bodyText = new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(chunks, bytes));}
        catch {throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true);}
      } catch (error) {
        if (config.schemaVersion === "3.0.0") providerObservations.set(request.requestDigest, providerObservation(Buffer.concat(chunks, bytes), true, key, endpoint!, fixedProfile.modelRevision, fixedRequest.skills.map(skill => skill.skillId)));
        cancelReader(); throw error;
      }
      finally {signal.removeEventListener("abort", cancelReader); reader.releaseLock();}
      if (config.schemaVersion === "3.0.0") providerObservations.set(request.requestDigest, providerObservation(Buffer.concat(chunks, bytes), false, key, endpoint!, fixedProfile.modelRevision, fixedRequest.skills.map(skill => skill.skillId)));
      if (staleResponse) throw staleResponse;
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? "AUTH_UNAVAILABLE"
          : response.status === 429 || response.status === 529 ? "RATE_LIMITED" : "API_UNAVAILABLE";
        throw new ClassificationProviderError(code, "started");
      }
      let evaluation: any;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        validateRawResponse?.call(adapter, bodyText);
        evaluation = decode.call(adapter, parsed, fixedRequest, fixedProfile);
      } catch {throw new ClassificationProviderError("INVALID_PROVIDER_RESPONSE", "started", true);}
      assertCurrent();
      return evaluation;
    };
    const observations: ClassificationObservation[] = [];
    for (const {caseId, request} of prepared.requests.slice(0, limits.requests)) {
      if (evidenceExpired()) {stopReason = "BOUND_EVIDENCE_EXPIRED"; break;}
      const spentOrReserved = config.schemaVersion === "3.0.0" ? 0 : ledger.entries.reduce((sum, row) => sum + (row.state === "known" ? row.actualCostUsd! : row.state === "not-started" ? 0 : row.reservedUsd), 0);
      const reservation = checked.requestReservations.find(row => row.requestDigest === request.requestDigest);
      requireCondition(reservation, "REQUEST_RESERVATION_MISSING");
      if (spentOrReserved + reservation!.reservedUsd > Math.min(limits.runUsd, ledger.initialRemainingUsd) + 1e-12) {stopReason = "LEDGER_BUDGET_EXHAUSTED"; break;}
      const entry: LedgerEntry = config.schemaVersion === "3.0.0" ? ledger.entries.find(row => row.requestId === request.requestId)!
        : {requestId: request.requestId, requestDigest: request.requestDigest, state: "reserved", reservedUsd: reservation!.reservedUsd, actualCostUsd: null, estimatedCostUsd: null, dispatchState: "not-started", resultDigest: null};
      if (config.schemaVersion !== "3.0.0") {ledger.entries.push(entry); await atomicJson(ledgerFile, ledger);}
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
      let evaluation: any = null;
      let errorCode: string | null = null;
      let responseValidationErrors: string[] = [];
      const attemptsBefore = transportInvocations;
      let capViolation = false;
      let onAbort: (() => void) | undefined;
      try {
        const abort = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new Error("DISPATCH_TIMEOUT_UNKNOWN"));
          controller.signal.addEventListener("abort", onAbort, {once: true});
        });
        evaluation = await Promise.race([classify(request, controller.signal), abort]);
        responseValidationErrors = prepared.api.validation.validateClassificationResponse(request, evaluation.response);
        requireCondition(responseValidationErrors.length === 0, "COMMON_RESPONSE_INVALID");
        capViolation = !Number.isSafeInteger(evaluation.usage.inputTokens) || evaluation.usage.inputTokens < 0 || !Number.isSafeInteger(evaluation.usage.outputTokens) || evaluation.usage.outputTokens < 0
          || evaluation.usage.inputTokens > limits.inputTokens || evaluation.usage.outputTokens > limits.outputTokens;
        entry.dispatchState = evaluation.dispatchState;
        if (config.prices?.billingMode === "token" && Number.isSafeInteger(evaluation.usage.inputTokens) && evaluation.usage.inputTokens >= 0
          && Number.isSafeInteger(evaluation.usage.outputTokens) && evaluation.usage.outputTokens >= 0) {
          entry.estimatedCostUsd = prepared.api.profiles.estimateTokenCostUsd({uncachedInputUsdPer1k: config.prices.inputUsdPer1k, cachedInputUsdPer1k: null, outputUsdPer1k: config.prices.outputUsdPer1k}, evaluation.usage.inputTokens, 0, evaluation.usage.outputTokens);
          if (entry.estimatedCostUsd !== null && entry.estimatedCostUsd > entry.reservedUsd) capViolation = true;
        }
        const actualCost = evaluation.usage.actualCostUsd;
        if (finite(actualCost)) {entry.state = "known"; entry.actualCostUsd = actualCost; if (actualCost > entry.reservedUsd) capViolation = true;}
        else entry.state = "unknown";
      } catch (error) {
        const providerError = error instanceof prepared.api.providers.ClassificationProviderError;
        const durableUnknown = config.schemaVersion === "3.0.0" && entry.state === "unknown";
        entry.dispatchState = durableUnknown ? "unknown" : evidenceExpiredBeforeFetch ? "not-started" : providerError ? (error as {dispatchState: string}).dispatchState : "unknown";
        errorCode = evidenceExpiredBeforeFetch ? "BOUND_EVIDENCE_EXPIRED" : billingOrBalanceFailure ? "BILLING_OR_BALANCE_UNAVAILABLE" : providerError ? (error as {code: string}).code : controller.signal.aborted ? "DISPATCH_TIMEOUT_UNKNOWN" : "BOOTSTRAP_RESPONSE_FAILED";
        entry.state = entry.dispatchState === "not-started" ? "not-started" : "unknown";
      } finally {clearTimeout(timer); if (onAbort) controller.signal.removeEventListener("abort", onAbort);}
      const observedProvider = providerObservations.get(request.requestDigest);
      const record = {schemaVersion: "1.0.0", caseId, request, response: evaluation?.response ?? null, usage: evaluation?.usage ?? observedProvider?.usage ?? prepared.api.providers.unknownUsage(),
        costAccounting: {estimatedCostUsd: entry.estimatedCostUsd, confirmedActualCostUsd: entry.actualCostUsd, unknownReservedUsd: entry.state === "unknown" ? entry.reservedUsd : 0},
        diagnostics: evaluation?.diagnostics ?? null, errorCode, capViolation, dispatchState: entry.dispatchState,
        responseValidationErrors, transportAttempts: transportInvocations - attemptsBefore,
        ...(config.schemaVersion === "3.0.0" ? {providerObservation: observedProvider ?? null} : {}),
        executionKind: options.executionKind ?? "provider-live", hostSelection: "NOT_RUN", applied: "NOT_RUN", verified: "NOT_RUN"};
      entry.resultDigest = hash(JSON.stringify(record));
      await writeFile(path.join(output, `${caseId}.raw.json`), JSON.stringify(record, null, 2) + "\n", {flag: "wx", mode: 0o600});
      if (config.schemaVersion === "3.0.0") {
        requireCondition(hash(readFileSync(ledgerFile)) === ledgerDigest, "RESERVATION_OWNER_OR_LEDGER_CHANGED");
        ledgerDigest = durableJsonSync(ledgerFile, ledger, ledgerDigest);
      }
      else await atomicJson(ledgerFile, ledger);
      observations.push(prepared.api.evaluation.fromClassification(caseId, request, record.response, {
        state: errorCode || capViolation ? "BLOCKED" : "PASS", executionKind: options.executionKind ?? "provider-live", conditionDigest: configDigest,
        producerDiagnostics: {errorCode, capViolation, dispatchState: entry.dispatchState, responseValidationErrors}}));
      if (errorCode || capViolation) {stopReason = errorCode ?? "OBSERVED_CAP_VIOLATION"; break;} // No automatic timeout resend or alternate provider.
    }
    const raw = prepared.api.evaluation.aggregate(prepared.cases.filter((row: {oracle: unknown}) => row.oracle !== null), observations.filter((row: any) => prepared.cases.find((item: any) => item.caseId === row.caseId)?.oracle !== null), "jevRaw", prepared.inventory.skills.map((skill: {skillId: string}) => skill.skillId));
    const report = {...checked, status: "RAW_EVALUATION_RECORDED" as const, executionKind: options.executionKind ?? "provider-live", raw,
      observationRevision: prepared.api.evaluation.OBSERVATION_REVISION, scorerRevision: prepared.api.evaluation.OBSERVATION_REVISION, observations,
      transportAttempts: transportInvocations, requestsReserved: ledger.entries.length, ledger, fixtureFileDigest: prepared.fixtureFileDigest,
      stopReason,
      unevaluatedCaseIds: prepared.requests.filter((row: any) => !ledger.entries.some(entry => entry.requestId === row.request.requestId && entry.dispatchState !== "not-started")).map((row: any) => row.caseId),
      qualificationStatus: "NOT_RUN", qualificationRecommendation: "INDEPENDENT_REVIEW_REQUIRED", productionProfileWritten: false,
      unscoredOperationalCases: prepared.cases.filter((row: {oracle: unknown}) => row.oracle === null).map((row: {caseId: string}) => row.caseId),
      full39Cases: "NOT_RUN", paired120HostTrials: "NOT_RUN", selectedReadAppliedVerified: "NOT_RUN"};
    await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", {flag: "wx", mode: 0o600});
    return report;
  } finally {await lock.close();}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, configFile] = process.argv.slice(2);
  requireCondition(["prepare", "preflight", "run"].includes(mode!) && !!configFile && process.argv.length === 4, "USAGE: bootstrap.mts prepare|preflight|run config.json");
  try {
    const config = JSON.parse(await readFile(path.resolve(configFile!), "utf8"));
    const prepared = await prepare(config);
    if (mode === "prepare") {
      await mkdir(config.outputDirectory, {recursive: true});
      await writeFile(path.join(config.outputDirectory, "public-requests.json"), JSON.stringify({schemaVersion: "1.0.0", fixtureFileDigest: prepared.fixtureFileDigest,
        inventoryDigest: prepared.inventory.inventoryDigest, taxonomyRevision: prepared.inventory.taxonomyRevision, requests: prepared.requests}, null, 2) + "\n", {flag: "wx", mode: 0o600});
      console.log(JSON.stringify({status: "PREPARED", requests: prepared.requests.length, candidateSkills: prepared.inventory.skills.length, labelsSent: false, modelCalls: 0}));
    } else {
      const result = mode === "preflight" ? await preflight(config, prepared) : await run(config);
      console.log(JSON.stringify(result)); if (result.status === "BLOCKED") process.exitCode = 2;
    }
  } catch {console.error(JSON.stringify({status: "BLOCKED", code: "BOOTSTRAP_FAILED", credentialLogged: false})); process.exitCode = 2;}
}
