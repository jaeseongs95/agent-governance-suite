import {createHash} from "node:crypto";
import {readFile, writeFile, mkdir, open, rename} from "node:fs/promises";
import path from "node:path";
import {pathToFileURL, fileURLToPath} from "node:url";

type Reference = {path: string; digest: string};
export interface BootstrapConfig {
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
type LedgerEntry = {requestId: string; requestDigest: string; state: "reserved" | "unknown" | "known" | "not-started"; reservedUsd: number; actualCostUsd: number | null; dispatchState: string; resultDigest: string | null};
type Ledger = {schemaVersion: "1.0.0"; runId: string; configDigest: string; initialRemainingUsd: number; entries: LedgerEntry[]};
const hash = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const modules = async (repo: string) => {
  const source = (name: string) => import(pathToFileURL(path.join(repo, "mcp-server/src/skill-classification", name)).href);
  const [inventory, request, providers, profiles, validation, evaluation] = await Promise.all([
    source("inventory.ts"), source("request.ts"), source("providers.ts"), source("profiles.ts"), source("validation.ts"),
    import(pathToFileURL(path.join(repo, "tests/skill-classification/evaluation.ts")).href),
  ]);
  return {inventory, request, providers, profiles, validation, evaluation};
};
const requireCondition = (value: unknown, code: string): void => {if (!value) throw new Error(code);};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const sameKeys = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
const references = ["route", "price", "priorLedger", "remaining", "hardTokenCaps", "operatorAuthorization"] as const;
const configKeys = ["schemaVersion", "runId", "repo", "outputDirectory", "endpointEnv", "credentialEnv", "approvedEndpointDigest", "approvedRouteRef", "approvalRef", "profile", "limits", "prices", "budget", "evidence"];

/** The operator-reviewed evidence binds the exact configured numbers/options, not mere file presence. */
export function evidenceValues(config: BootstrapConfig, kind: typeof references[number]) {
  if (kind === "route") return {approvedRouteRef: config.approvedRouteRef, approvedEndpointDigest: config.approvedEndpointDigest, approvalRef: config.approvalRef,
    modelId: config.profile?.modelId ?? null, modelRevision: config.profile?.modelRevision ?? null, reasoningEffort: config.profile?.reasoningEffort ?? null, adapterRevision: config.profile?.adapterRevision ?? null};
  if (kind === "price") return {billingUnit: "USD", prices: config.prices};
  if (kind === "priorLedger") return {totalLimitUsd: config.budget?.totalLimitUsd ?? null, verifiedPriorSpendUsd: config.budget?.verifiedPriorSpendUsd ?? null, priorUnknownReservedUsd: config.budget?.priorUnknownReservedUsd ?? null};
  if (kind === "remaining") return {currentRemainingUsd: config.budget?.currentRemainingUsd ?? null, observedAt: config.budget?.observedAt ?? null, validUntil: config.budget?.validUntil ?? null};
  if (kind === "hardTokenCaps") return {approvedRouteRef: config.approvedRouteRef,
    inputTokens: config.prices && config.prices.inputUsdPer1k > 0 ? config.limits?.inputTokens ?? null : null,
    outputTokens: config.prices && config.prices.outputUsdPer1k > 0 ? config.limits?.outputTokens ?? null : null,
    pricedTokenCapsEnforcedByRoute: true};
  return {runId: config.runId, approvedRouteRef: config.approvedRouteRef, approvalRef: config.approvalRef, limits: config.limits, publicOnly: true, transport: "one-attempt", mode: "qualification-bootstrap"};
}
export const evidenceValuesDigest = (config: BootstrapConfig, kind: typeof references[number]) => hash(JSON.stringify(evidenceValues(config, kind)));

export async function prepare(config: BootstrapConfig) {
  requireCondition(config.schemaVersion === "1.0.0" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(config.runId), "INVALID_RUN_ID");
  requireCondition(sameKeys(config, configKeys) && sameKeys(config.evidence, [...references]), "UNKNOWN_CONFIG_FIELD");
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
  return {api, corpus, cases, inventory, requests, fixtureFileDigest: hash(fixtureBytes)};
}

/** No endpoint/credential environment lookup and no transport call in this function. */
export async function preflight(config: BootstrapConfig, prepared: Awaited<ReturnType<typeof prepare>>, now = Date.now()) {
  const blocked: string[] = [];
  const validatedEvidenceExpiries: {kind: string; deadlineMs: number}[] = [];
  const fail = (condition: unknown, code: string) => {if (!condition) blocked.push(code);};
  fail(sameKeys(config, configKeys) && sameKeys(config.evidence, [...references]), "UNKNOWN_CONFIG_FIELD");
  fail(/^[A-Z][A-Z0-9_]+$/.test(config.endpointEnv) && /^[A-Z][A-Z0-9_]+$/.test(config.credentialEnv) && config.endpointEnv !== config.credentialEnv, "INVALID_ENV_NAMES");
  fail(typeof config.approvedEndpointDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(config.approvedEndpointDigest), "APPROVED_ENDPOINT_UNBOUND");
  fail(config.approvedRouteRef && config.approvalRef, "ROUTE_APPROVAL_MISSING");
  const hardCapsRequired = config.prices?.billingMode === "token" && (config.prices.inputUsdPer1k > 0 || config.prices.outputUsdPer1k > 0);
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
      if (!sameKeys(record, ["schemaVersion", "kind", "verifiedBy", "sourceRef", "validUntil", "valuesDigest"])
        || record.schemaVersion !== "1.0.0" || record.kind !== kind || typeof record.verifiedBy !== "string" || !record.verifiedBy
        || typeof record.sourceRef !== "string" || !record.sourceRef || Date.parse(record.validUntil) <= now
        || !Number.isFinite(Date.parse(record.validUntil)) || record.valuesDigest !== evidenceValuesDigest(config, kind)) blocked.push(`EVIDENCE_UNBOUND:${kind}`);
      else validatedEvidenceExpiries.push({kind, deadlineMs: Date.parse(record.validUntil)});
    } catch {blocked.push(`EVIDENCE_UNREADABLE:${kind}`);}
  }
  if (blocked.some(code => code.endsWith(":hardTokenCaps"))) blocked.push(config.prices && config.prices.outputUsdPer1k > 0 ? "OUTPUT_CAP_UNVERIFIED" : "INPUT_BILLING_CAP_UNVERIFIED");
  const {limits, prices, budget} = config;
  fail(limits && sameKeys(limits, ["requests", "inputBytes", "inputTokens", "outputTokens", "responseBytes", "timeoutMs", "runUsd"])
    && positiveInt(limits.requests) && limits.requests <= 21 && positiveInt(limits.inputBytes) && limits.inputBytes <= 4 * 1024 * 1024
    && positiveInt(limits.inputTokens) && positiveInt(limits.outputTokens) && positiveInt(limits.responseBytes) && limits.responseBytes <= 1024 * 1024
    && positiveInt(limits.timeoutMs) && limits.timeoutMs <= 60000 && finite(limits.runUsd) && limits.runUsd > 0, "FINITE_LIMITS_MISSING");
  fail(limits && finite(limits.runUsd) && limits.runUsd <= 5 && budget && finite(budget.totalLimitUsd) && budget.totalLimitUsd <= 5, "BUDGET_HARD_LIMIT_USD_5");
  const validPrices = prices && sameKeys(prices, ["billingMode", "inputUsdPer1k", "outputUsdPer1k", "fixedCallMaxUsd"])
    && ["token", "fixed-per-call"].includes(prices.billingMode) && [prices.inputUsdPer1k, prices.outputUsdPer1k, prices.fixedCallMaxUsd].every(finite)
    && (prices.billingMode !== "fixed-per-call" || (prices.inputUsdPer1k === 0 && prices.outputUsdPer1k === 0));
  fail(validPrices, "VERIFIED_PRICE_UPPER_BOUND_MISSING");
  fail(budget && sameKeys(budget, ["totalLimitUsd", "verifiedPriorSpendUsd", "priorUnknownReservedUsd", "currentRemainingUsd", "observedAt", "validUntil"])
    && [budget.totalLimitUsd, budget.verifiedPriorSpendUsd, budget.priorUnknownReservedUsd, budget.currentRemainingUsd].every(finite)
    && budget.currentRemainingUsd <= budget.totalLimitUsd - budget.verifiedPriorSpendUsd - budget.priorUnknownReservedUsd + 1e-12
    && Number.isFinite(Date.parse(budget.observedAt)) && Date.parse(budget.observedAt) <= now && Date.parse(budget.validUntil) > now, "CURRENT_LEDGER_OR_REMAINING_UNVERIFIED");
  if (budget && Number.isFinite(Date.parse(budget.validUntil)) && Date.parse(budget.validUntil) > now) validatedEvidenceExpiries.push({kind: "budget", deadlineMs: Date.parse(budget.validUntil)});
  const profile = config.profile;
  fail(profile && prepared.api.profiles.isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "bootstrap-candidate", profiles: [profile]}), "INVALID_CANDIDATE_PROFILE");
  if (profile) {
    fail(profile.providerKind === "jev", "NATIVE_FACTORY_UNAVAILABLE");
    fail(profile.approvedRouteRef === config.approvedRouteRef, "APPROVED_ROUTE_MISMATCH");
    const q = profile.qualification as Record<string, unknown> | undefined;
    fail(q?.status === "NOT_RUN" && q.inventoryDigest === prepared.inventory.inventoryDigest && q.taxonomyRevision === prepared.inventory.taxonomyRevision
      && q.modelRevision === profile.modelRevision && q.promptRevision === profile.promptRevision
      && q.profileConfigurationDigest === prepared.api.profiles.digestProviderProfileConfiguration(profile), "CANDIDATE_BINDING_MISMATCH");
    fail(profile.reasoningEffort === null && profile.judgmentPolicy !== null, "JEV_OPTIONS_UNSUPPORTED");
    const supported = profile.supportedOptions as {structuredOutput?: boolean; reasoningEfforts?: unknown[]} | undefined;
    fail(supported?.structuredOutput === true && supported.reasoningEfforts?.includes(profile.reasoningEffort), "UNSUPPORTED_PROFILE_CAPABILITY");
    fail(limits && profile.maximumInputBytes === limits.inputBytes && profile.maximumOutputTokens === limits.outputTokens, "PROFILE_CAP_MISMATCH");
  }
  let perRequestReservedUsd: number | null = null;
  if (limits && prices && [limits.inputTokens, limits.outputTokens].every(positiveInt) && validPrices) {
    const cost = prices.billingMode === "fixed-per-call" ? 0 : prepared.api.profiles.estimateTokenCostUsd({uncachedInputUsdPer1k: prices.inputUsdPer1k, cachedInputUsdPer1k: null, outputUsdPer1k: prices.outputUsdPer1k}, limits.inputTokens, 0, limits.outputTokens);
    if (cost !== null) perRequestReservedUsd = Math.ceil((cost + prices.fixedCallMaxUsd) * 1e12) / 1e12;
    fail(perRequestReservedUsd !== null && profile?.maximumCostUsd === perRequestReservedUsd, "PROFILE_COST_BOUND_MISMATCH");
    fail(budget && perRequestReservedUsd !== null && perRequestReservedUsd * limits.requests <= Math.min(limits.runUsd, budget.currentRemainingUsd), "RUN_BUDGET_INSUFFICIENT");
  }
  if (profile && limits && positiveInt(limits.inputBytes)) for (const {request} of prepared.requests) {
    try {fail(Buffer.byteLength(JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, profile))) <= limits.inputBytes, "INPUT_TOO_LONG");}
    catch {blocked.push("WIRE_ENCODE_FAILED");}
  }
  return {status: blocked.length ? "BLOCKED" as const : "READY_FOR_OPERATOR_DISPATCH" as const, blocked: [...new Set(blocked)],
    validatedEvidenceDeadlineMs: validatedEvidenceExpiries.length ? Math.min(...validatedEvidenceExpiries.map(record => record.deadlineMs)) : null,
    validatedEvidenceExpiries,
    perRequestReservedUsd, candidateStatus: "NOT_RUN", requestCount: prepared.requests.length, inventoryDigest: prepared.inventory.inventoryDigest,
    oracleSentToProvider: false, hostSelection: "NOT_RUN", releaseAcceptance: "NOT_ASSESSED"};
}

async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {flag: "wx", mode: 0o600});
  await rename(temporary, file);
}

/** Qualification experiment only. Production profile validation/service are never changed. */
export async function run(config: BootstrapConfig, options: {fetcher?: typeof fetch; env?: NodeJS.ProcessEnv; executionKind?: "offline-mock" | "provider-live"; now?: () => number} = {}) {
  // Clock injection is a test-only function argument; the CLI always uses Date.now.
  const now = options.now ?? Date.now;
  const prepared = await prepare(config);
  const checked = await preflight(config, prepared, now());
  if (checked.status === "BLOCKED") return checked;
  requireCondition(checked.validatedEvidenceDeadlineMs !== null, "BOUND_EVIDENCE_DEADLINE_MISSING");
  const evidenceExpired = () => {const current = now(); return !Number.isFinite(current) || current >= checked.validatedEvidenceDeadlineMs!;};
  const limits = config.limits!;
  const output = path.resolve(config.outputDirectory);
  await mkdir(output, {recursive: true});
  const lock = await open(path.join(output, "bootstrap.lock"), "wx", 0o600);
  // A persistent lock also prevents a crashed/uncertain run from being retried automatically.
  try {
    const configDigest = hash(JSON.stringify(config));
    const ledgerFile = path.join(output, "ledger.json");
    let ledger: Ledger;
    try {ledger = JSON.parse(await readFile(ledgerFile, "utf8"));}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("LEDGER_UNREADABLE");
      ledger = {schemaVersion: "1.0.0", runId: config.runId, configDigest, initialRemainingUsd: config.budget!.currentRemainingUsd, entries: []};
      await atomicJson(ledgerFile, ledger);
    }
    requireCondition(ledger.runId === config.runId && ledger.configDigest === configDigest && ledger.entries.length === 0, "RUN_ALREADY_RESERVED_OR_EXECUTED");
    const environment = options.env ?? process.env;
    const endpoint = environment[config.endpointEnv];
    requireCondition(endpoint && hash(endpoint) === config.approvedEndpointDigest, "APPROVED_ENDPOINT_ENV_MISMATCH");
    const profile = config.profile!;
    let transportInvocations = 0;
    let evidenceExpiredBeforeFetch = false;
    let stopReason: string | null = null;
    const transport: typeof fetch = async (...args) => {
      if (evidenceExpired()) {evidenceExpiredBeforeFetch = true; throw new Error("BOUND_EVIDENCE_EXPIRED");}
      transportInvocations++; return (options.fetcher ?? fetch)(...args);
    };
    const provider = new prepared.api.providers.ApprovedRouteClassificationProvider([{
      kind: "remote", routeRef: config.approvedRouteRef, approvalRef: config.approvalRef, approved: true,
      providerKind: "jev", vendorId: profile.vendorId, adapterRevision: profile.adapterRevision, modelIds: [profile.modelId],
      reasoningEfforts: [profile.reasoningEffort], structuredOutput: true, endpoint,
      getCredential: async () => {
        if (evidenceExpired()) {evidenceExpiredBeforeFetch = true; return null;}
        return environment[config.credentialEnv] ?? null;
      }, adapter: prepared.api.providers.jevNoulWireAdapter,
    }], transport, {maximumResponseBytes: limits.responseBytes});
    const observations: unknown[] = [];
    for (const {caseId, request} of prepared.requests.slice(0, limits.requests)) {
      if (evidenceExpired()) {stopReason = "BOUND_EVIDENCE_EXPIRED"; break;}
      const spentOrReserved = ledger.entries.reduce((sum, row) => sum + (row.state === "known" ? row.actualCostUsd! : row.state === "not-started" ? 0 : row.reservedUsd), 0);
      requireCondition(spentOrReserved + checked.perRequestReservedUsd! <= Math.min(limits.runUsd, ledger.initialRemainingUsd), "LEDGER_BUDGET_EXHAUSTED");
      const entry: LedgerEntry = {requestId: request.requestId, requestDigest: request.requestDigest, state: "reserved", reservedUsd: checked.perRequestReservedUsd!, actualCostUsd: null, dispatchState: "not-started", resultDigest: null};
      ledger.entries.push(entry); await atomicJson(ledgerFile, ledger);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
      let evaluation: any = null;
      let errorCode: string | null = null;
      let capViolation = false;
      try {
        const abort = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new Error("DISPATCH_TIMEOUT_UNKNOWN")), {once: true}));
        evaluation = await Promise.race([provider.classify(request, profile, controller.signal), abort]);
        const errors = prepared.api.validation.validateClassificationResponse(request, evaluation.response);
        requireCondition(errors.length === 0, "COMMON_RESPONSE_INVALID");
        capViolation = !Number.isSafeInteger(evaluation.usage.inputTokens) || evaluation.usage.inputTokens < 0 || !Number.isSafeInteger(evaluation.usage.outputTokens) || evaluation.usage.outputTokens < 0
          || evaluation.usage.inputTokens > limits.inputTokens || evaluation.usage.outputTokens > limits.outputTokens;
        entry.dispatchState = evaluation.dispatchState;
        const actualCost = evaluation.usage.actualCostUsd;
        if (finite(actualCost)) {entry.state = "known"; entry.actualCostUsd = actualCost; if (actualCost > entry.reservedUsd) capViolation = true;}
        else entry.state = "unknown";
      } catch (error) {
        const providerError = error instanceof prepared.api.providers.ClassificationProviderError;
        entry.dispatchState = evidenceExpiredBeforeFetch ? "not-started" : providerError ? (error as {dispatchState: string}).dispatchState : "unknown";
        errorCode = evidenceExpiredBeforeFetch ? "BOUND_EVIDENCE_EXPIRED" : providerError ? (error as {code: string}).code : controller.signal.aborted ? "DISPATCH_TIMEOUT_UNKNOWN" : "BOOTSTRAP_RESPONSE_FAILED";
        entry.state = entry.dispatchState === "not-started" ? "not-started" : "unknown";
      } finally {clearTimeout(timer);}
      const record = {schemaVersion: "1.0.0", caseId, request, response: evaluation?.response ?? null, usage: evaluation?.usage ?? prepared.api.providers.unknownUsage(),
        diagnostics: evaluation?.diagnostics ?? null, errorCode, capViolation, dispatchState: entry.dispatchState,
        executionKind: options.executionKind ?? "provider-live", hostSelection: "NOT_RUN", applied: "NOT_RUN", verified: "NOT_RUN"};
      entry.resultDigest = hash(JSON.stringify(record));
      await writeFile(path.join(output, `${caseId}.raw.json`), JSON.stringify(record, null, 2) + "\n", {flag: "wx", mode: 0o600});
      await atomicJson(ledgerFile, ledger);
      observations.push({caseId, layer: "jevRaw", state: errorCode || capViolation ? "BLOCKED" : "PASS", skillIds: errorCode || capViolation || evaluation.response.status === "UNCERTAIN" ? null : evaluation.response.judgments.filter((row: {judgment: string}) => row.judgment === "needed").map((row: {skillId: string}) => row.skillId),
        selectionStatus: errorCode ? "NEEDS_INPUT" : evaluation.response.status === "SUCCESS" ? "SELECTED" : "NEEDS_INPUT", reasonCodes: errorCode ? [errorCode] : evaluation.response.unresolvedItems.map((row: {reasonCode: string}) => row.reasonCode),
        selectionReasons: evaluation?.response.judgments.map((row: {skillId: string; reasonRefs: string[]}) => ({skillId: row.skillId, reason: row.reasonRefs.join(",")})) ?? [],
        executionKind: options.executionKind ?? "provider-live", host: null, hostReceipt: null, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest,
        conditionDigest: configDigest, stageEvidence: {read: false, applied: false, verified: false}});
      if (errorCode || capViolation) {stopReason = errorCode ?? "OBSERVED_CAP_VIOLATION"; break;} // No automatic timeout resend or alternate provider.
    }
    const raw = prepared.api.evaluation.aggregate(prepared.cases.filter((row: {oracle: unknown}) => row.oracle !== null), observations.filter((row: any) => prepared.cases.find((item: any) => item.caseId === row.caseId)?.oracle !== null), "jevRaw", prepared.inventory.skills.map((skill: {skillId: string}) => skill.skillId));
    const report = {...checked, status: "RAW_EVALUATION_RECORDED" as const, executionKind: options.executionKind ?? "provider-live", raw,
      transportAttempts: transportInvocations, requestsReserved: ledger.entries.length, ledger, fixtureFileDigest: prepared.fixtureFileDigest,
      stopReason,
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
