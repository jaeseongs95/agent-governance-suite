import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile, rm, cp, access} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {BootstrapConfig} from "./bootstrap.mts";

type RunConfig = Extract<BootstrapConfig, {schemaVersion: "2.0.0"}>;
interface OracleRow {caseId: string; requestDigest: string; wireDigest: string; utf8Bytes: number; reservedPicoUsd: string}
interface OracleBudgetCase {id: string; historicalId: string; capUsd: string; unchangedUnknownUsd: string; historicalConfirmedUsd: string; proposedSyntheticConfirmedUsd: string}
interface BudgetWireOracle {
  schemaVersion: string; canonicalRunId: string; modelId: string; inventoryDigest: string;
  prices: {currency: string; inputUsdPer1000Tokens: string; outputUsdPer1000Tokens: string; fixedCallUsd: string; assumedInputTokensPerUtf8Byte: string; usdPerByteNumerator: string; usdPerByteDenominator: string};
  rows: OracleRow[]; syntheticOverBudgetCases: OracleBudgetCase[];
  fractionalRoundingFixture: {inputUsdPer1000Tokens: string; rows: Pick<OracleRow, "caseId" | "reservedPicoUsd">[]; sumOfPerRequestCeilPicoUsd: string; invalidRoundAfterSummingPicoUsd: string};
}

interface PrecisionCase {id: string; kind: "reviewed-estimate" | "invalid-price" | "legacy-fixed" | "verified-upper-bound"; priceNumberText: string; expectedStatus: string; expectedReason: string | null; expectedRows: Pick<OracleRow, "caseId" | "reservedPicoUsd">[]; expectedSumPicoUsd: string | null; expectedMaxPicoUsd: string | null}
interface PrecisionOracle {schemaVersion: string; parentOracleSha256: string; unknownUsd: string; safeMaxPicoUsd: string; cases: PrecisionCase[]}
const repo = path.resolve(process.argv[2]!);
const helper = path.resolve(process.argv[3]!);
assert(process.argv[2] && process.argv[3], "Usage: precision-regression.mts REPO HELPER");
const api = await import(pathToFileURL(helper).href) as typeof import("./bootstrap.mts");
const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const env = {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-real"};
const oracleBytes = await readFile(path.join(import.meta.dirname, "budget-wire-oracle.json"));
assert.equal(hash(oracleBytes.toString("utf8")), "sha256:f6ea158f65473b5aa08846196bbb54a02ca5db7fffaed39d0ba25c2f61148b56");
const oracle = JSON.parse(oracleBytes.toString("utf8")) as BudgetWireOracle;
const boundaryBytes = await readFile(path.join(import.meta.dirname, "precision-boundary-oracle.json"));
assert.equal(hash(boundaryBytes.toString("utf8")), "sha256:618afb36e06a7372656e9a4139bf3f91e45f12d1487bac42e72f0994a7d2f835");
const precision = JSON.parse(boundaryBytes.toString("utf8")) as PrecisionOracle;
assert.equal(precision.parentOracleSha256, oracleBytes.length && hash(oracleBytes.toString("utf8")).slice(7));
assert.equal(precision.safeMaxPicoUsd, BigInt(Number.MAX_SAFE_INTEGER).toString());
const frozenPrices = {billingMode: "token", inputUsdPer1k: Number(oracle.prices.inputUsdPer1000Tokens), outputUsdPer1k: Number(oracle.prices.outputUsdPer1000Tokens), fixedCallMaxUsd: Number(oracle.prices.fixedCallUsd)};
const frozenWireRows = oracle.rows.map(({caseId, wireDigest, utf8Bytes}) => ({caseId, wireDigest, utf8Bytes}));
const root = await mkdtemp(path.join(os.tmpdir(), "ags-precision-regression-"));
const failures: {caseId: string; errorType: string; errorCode: string; assertion: {message: string; actual: unknown; expected: unknown; operator: string | null} | null}[] = [], completed: string[] = [];
let environmentReads = 0, credentialReads = 0, fetches = 0;
const forbiddenEnv = new Proxy({}, {get: (_target, key) => {environmentReads++; if (key === "AGS_BOOTSTRAP_JEV_KEY") credentialReads++; assert.fail("PRECISION_PREFLIGHT_MUST_NOT_READ_ENV");}});
const exists = async (file: string) => {try {await access(file); return true;} catch {return false;}};
  async function bind(config: BootstrapConfig) {
    await mkdir(config.outputDirectory, {recursive: true});
    for (const kind of Object.keys(config.evidence) as (keyof BootstrapConfig["evidence"])[]) {
      if (kind === "hardTokenCaps") continue;
      const bytes = JSON.stringify({schemaVersion: "1.0.0", kind, verifiedBy: "offline-mock-only", sourceRef: "synthetic-not-approval",
        validUntil: config.budget!.validUntil, valuesDigest: api.evidenceValuesDigest(config, kind)});
      await writeFile(path.join(config.outputDirectory, `${kind}.json`), bytes);
      config.evidence[kind] = {path: `${kind}.json`, digest: hash(bytes)};
    }
  }
  async function ready(runId: string, estimate = true): Promise<RunConfig> {
    const config: RunConfig = {schemaVersion: "2.0.0", runId, repo, outputDirectory: path.join(root, runId), endpointEnv: "AGS_BOOTSTRAP_ENDPOINT", credentialEnv: "AGS_BOOTSTRAP_JEV_KEY",
      approvedEndpointDigest: hash(env.AGS_BOOTSTRAP_ENDPOINT), approvedRouteRef: "mock-route", approvalRef: "mock-only", profile: null,
      reservationMode: estimate ? "reviewed-estimate" : "verified-upper-bound", estimator: null,
      limits: {requests: 2, inputBytes: 1048576, inputTokens: 300000, outputTokens: 10000, responseBytes: 128000, timeoutMs: 1000, runUsd: 0.15},
      prices: estimate ? {billingMode: "token", inputUsdPer1k: 0.000042, outputUsdPer1k: 0, fixedCallMaxUsd: 0} : {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001},
      budget: {scope: "run", runId, totalAuthorizationUsd: 5, allocatedUsd: 0.15, allocationRef: "offline-mock-allocation", priorRunConfirmedSpendUsd: 0,
        priorRunUnknownReservedUsd: 0, accountBalanceUsd: null, accountPriorSpendUsd: null, accountUnknownReservedUsd: null,
        observedAt: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 60000).toISOString()},
      evidence: {route: null, price: null, priorLedger: null, remaining: null, hardTokenCaps: null, operatorAuthorization: null}};
    const prepared = await api.prepare(config);
    config.profile = {profileId: "mock-profile", providerKind: "jev", vendorId: "mock-vendor", modelId: "mock-model", modelRevision: "mock-revision", reasoningEffort: null,
      supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: config.approvedRouteRef, qualificationRevision: "mock-not-qualified",
      qualification: {status: "NOT_RUN", inventoryDigest: prepared.inventory.inventoryDigest, taxonomyRevision: prepared.inventory.taxonomyRevision, modelRevision: "mock-revision", promptRevision: "mock-question-v1", validUntil: config.budget!.validUntil, profileConfigurationDigest: ""},
      adapterRevision: "mock-adapter-v1", promptRevision: "mock-question-v1", maximumInputBytes: config.limits!.inputBytes, maximumOutputTokens: config.limits!.outputTokens,
      maximumCostUsd: estimate ? 0.002688 : 0.001, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
    (config.profile.qualification as Record<string, unknown>).profileConfigurationDigest = prepared.api.profiles.digestProviderProfileConfiguration(config.profile);
    if (estimate) {
      await mkdir(config.outputDirectory, {recursive: true});
      const measurements = prepared.requests.map(({caseId, request}: {caseId: string; request: {requestDigest: string}}) => {const wire = JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, config.profile));
        return {caseId, requestDigest: request.requestDigest, wireDigest: hash(wire), utf8Bytes: Buffer.byteLength(wire)};});
      assert.equal(config.profile.modelId, oracle.modelId);
      assert.equal(prepared.inventory.inventoryDigest, oracle.inventoryDigest);
      assert.deepEqual(config.prices, frozenPrices);
      assert.deepEqual(measurements.map(({caseId, wireDigest, utf8Bytes}: Pick<OracleRow, "caseId" | "wireDigest" | "utf8Bytes">) => ({caseId, wireDigest, utf8Bytes})), frozenWireRows,
        "FROZEN_SYNTHETIC_WIRE_ORDER_DIGEST_BYTES");
      if (runId === oracle.canonicalRunId) assert.deepEqual(measurements.map(({caseId, requestDigest}: Pick<OracleRow, "caseId" | "requestDigest">) => ({caseId, requestDigest})), oracle.rows.map(({caseId, requestDigest}: Pick<OracleRow, "caseId" | "requestDigest">) => ({caseId, requestDigest})));
      const artifact = JSON.stringify({runId, inventoryDigest: prepared.inventory.inventoryDigest, measurements});
      const source = "offline synthetic price/context source; not tokenization or billing proof";
      await writeFile(path.join(config.outputDirectory, "inputs.json"), artifact); await writeFile(path.join(config.outputDirectory, "source.txt"), source);
      config.estimator = {method: "utf8-bytes-as-input-tokens-v1", inputArtifact: {path: "inputs.json", digest: hash(artifact)}, sources: [{path: "source.txt", digest: hash(source)}],
        uncertainty: "1 UTF8 byte = 1 input token is a reviewed assumption, not a billing guarantee; account observations remain unknown"};
      config.profile.maximumCostUsd = Math.max(...measurements.map((row: {utf8Bytes: number}) => Math.ceil(row.utf8Bytes * 0.000000042 * 1e12) / 1e12));
      (config.profile.qualification as Record<string, unknown>).profileConfigurationDigest = prepared.api.profiles.digestProviderProfileConfiguration(config.profile);
    }
    await bind(config); return config;
  }
try {
  for (const spec of precision.cases) {
    const caseDirectory = path.join(root, `precision-${spec.id}`);
    try {
      const value = await ready(`precision-${spec.id}`); value.limits!.requests = 21;
      value.budget!.priorRunUnknownReservedUsd = Number(precision.unknownUsd);
      let config: BootstrapConfig = value;
      if (spec.kind === "legacy-fixed") {
        config = {...value, schemaVersion: "1.0.0", budget: {totalLimitUsd: 0.15, verifiedPriorSpendUsd: 0, priorUnknownReservedUsd: Number(precision.unknownUsd), currentRemainingUsd: 0.15 - Number(precision.unknownUsd), observedAt: value.budget!.observedAt, validUntil: value.budget!.validUntil}};
        Reflect.deleteProperty(config, "reservationMode"); Reflect.deleteProperty(config, "estimator");
      } else if (spec.kind === "verified-upper-bound") {value.reservationMode = "verified-upper-bound"; value.estimator = null;}
      if (spec.kind === "legacy-fixed" || spec.kind === "verified-upper-bound") {
        config.prices = {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001}; config.profile!.maximumCostUsd = 0.001;
      } else {
        config.prices!.inputUsdPer1k = spec.priceNumberText === "NaN" ? NaN : spec.priceNumberText === "Infinity" ? Infinity : spec.priceNumberText === "-Infinity" ? -Infinity : Number(spec.priceNumberText);
        if (Number.isFinite(config.prices!.inputUsdPer1k)) assert.equal(Number(config.prices!.inputUsdPer1k.toString()), Number(spec.priceNumberText));
        const pico = spec.expectedMaxPicoUsd === null ? 0n : BigInt(spec.expectedMaxPicoUsd);
        config.profile!.maximumCostUsd = Number(pico <= BigInt(Number.MAX_SAFE_INTEGER) ? pico : BigInt(Number.MAX_SAFE_INTEGER)) / 1e12;
      }
      const prepared = await api.prepare(config);
      (config.profile!.qualification as Record<string, unknown>).profileConfigurationDigest = prepared.api.profiles.digestProviderProfileConfiguration(config.profile);
      await bind(config);
      const budgetBefore = JSON.stringify(config.budget);
      const syntheticUnknownLedger = JSON.stringify({schemaVersion: "2.0.0", runId: config.runId, configDigest: hash(JSON.stringify(config)), budgetScope: "run", initialRemainingUsd: 0.15 - Number(precision.unknownUsd), entries: [{requestId: "historical-unknown-sentinel", requestDigest: hash("historical synthetic unknown sentinel"), state: "unknown", reservedUsd: Number(precision.unknownUsd), actualCostUsd: null, estimatedCostUsd: null, dispatchState: "unknown", resultDigest: null}]});
      const ledgerFile = path.join(caseDirectory, "ledger.json"), lockFile = path.join(caseDirectory, "bootstrap.lock");
      await writeFile(ledgerFile, syntheticUnknownLedger, {flag: "wx"});
      const checked = await api.preflight(config, await api.prepare(config));
      await writeFile(path.join(caseDirectory, "preflight.json"), JSON.stringify(checked, null, 2) + "\n", {flag: "wx"});
      let blockedResult: Awaited<ReturnType<typeof api.run>> | null = null;
      if (spec.expectedStatus === "BLOCKED") {
        blockedResult = await api.run(config, {env: forbiddenEnv, executionKind: "offline-mock", fetcher: async () => {fetches++; assert.fail("PRECISION_PREFLIGHT_MUST_NOT_FETCH");}});
        await writeFile(path.join(caseDirectory, "blocked-return.json"), JSON.stringify(blockedResult, null, 2) + "\n", {flag: "wx"});
      }
      await writeFile(path.join(caseDirectory, "boundary-observation.json"), JSON.stringify({caseId: spec.id, phase: "preflight-only", actualReturn: checked, blockedRunReturn: blockedResult, classificationResponse: null, transportAttempts: fetches, environmentReads, credentialReads, ledgerBytesUnchanged: (await readFile(ledgerFile, "utf8")) === syntheticUnknownLedger, lockExists: await exists(lockFile), qualification: "NOT_RUN", selectedReadAppliedVerified: "NOT_RUN"}, null, 2) + "\n", {flag: "wx"});
      assert.equal(JSON.stringify(config.budget), budgetBefore); assert.equal(await readFile(ledgerFile, "utf8"), syntheticUnknownLedger);
      assert.equal(await exists(lockFile), false); assert.equal(environmentReads, 0); assert.equal(credentialReads, 0); assert.equal(fetches, 0);
      assert.equal(checked.status, spec.expectedStatus, spec.id);
      if (spec.expectedReason) {assert(checked.blocked.includes(spec.expectedReason), `${spec.id}:${spec.expectedReason}`); assert.equal(blockedResult!.status, "BLOCKED"); if (blockedResult!.status === "BLOCKED") assert(blockedResult!.blocked.includes(spec.expectedReason));}
      if (spec.id === "safe-equal") assert(!checked.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"), "Exactly MAX_SAFE pico is admitted by arithmetic; original .15 budget still blocks dispatch");
      if (spec.expectedStatus === "READY_FOR_OPERATOR_DISPATCH" || spec.id === "safe-equal") {
        assert.equal(checked.requestReservations.length, spec.expectedRows.length);
        let picoSum = 0n;
        for (let index = 0; index < spec.expectedRows.length; index++) {
          const expected = spec.expectedRows[index]!, actual = checked.requestReservations[index]!, pico = BigInt(expected.reservedPicoUsd);
          assert(pico <= BigInt(Number.MAX_SAFE_INTEGER)); assert.equal(actual.caseId, expected.caseId); assert.equal(actual.reservedUsd, Number(pico) / 1e12, `${spec.id}:${expected.caseId}`); picoSum += pico;
        }
        assert.equal(picoSum.toString(), spec.expectedSumPicoUsd);
      }
      if (spec.id === "half-pico") {assert.equal(spec.expectedSumPicoUsd, "1139275"); assert.notEqual(spec.expectedSumPicoUsd, oracle.fractionalRoundingFixture.invalidRoundAfterSummingPicoUsd);}
      completed.push(spec.id);
    } catch (error) {
      const observed = error instanceof Error ? error as Error & {code?: unknown; actual?: unknown; expected?: unknown; operator?: string} : null;
      const detail = {caseId: spec.id, errorType: observed?.name ?? "UnknownError", errorCode: typeof observed?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(observed.code) ? observed.code : "ASSERTION_OR_SETUP_FAILED",
        assertion: observed?.name === "AssertionError" ? {message: observed.message, actual: observed.actual ?? null, expected: observed.expected ?? null, operator: observed.operator ?? null} : null};
      // Assertion values here come only from fixed public synthetic fixtures. Arbitrary helper exception messages are not copied.
      failures.push(detail); await mkdir(caseDirectory, {recursive: true}); await writeFile(path.join(caseDirectory, "failure.json"), JSON.stringify(detail, null, 2) + "\n", {flag: "wx"});
    }
  }
  await writeFile(path.join(root, "precision-summary.json"), JSON.stringify({completed, failures, actualApiCalls: 0, actualCredentialLookups: 0, environmentReads, credentialReads, mockFetches: fetches, helper, oracleDigest: hash(oracleBytes.toString("utf8")), boundaryOracleDigest: hash(boundaryBytes.toString("utf8"))}, null, 2) + "\n", {flag: "wx"});
  assert.deepEqual(failures, [], "PRECISION_BOUNDARIES_FAILED; see preserved actual preflight and failure records");
  assert.equal(completed.length, precision.cases.length);
  console.log(JSON.stringify({status: "OFFLINE_PRECISION_REGRESSION_PASS", checks: completed, actualApiCalls: 0, actualCredentialLookups: 0, mockFetches: fetches, qualification: "NOT_RUN", hostLive: "NOT_RUN"}, null, 2));
} finally {
  const resolved = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), temporaryRoot); assert(path.basename(resolved).startsWith("ags-precision-regression-"));
  const exportBase = process.env.AGS_BOOTSTRAP_TEST_EVIDENCE_DIR;
  if (exportBase) {
    assert(path.isAbsolute(exportBase), "Evidence output must be an absolute task-owned directory");
    const relativeExport = path.relative(resolved, path.resolve(exportBase));
    assert(relativeExport === ".." || relativeExport.startsWith(`..${path.sep}`) || path.isAbsolute(relativeExport), "Evidence output must stay outside the owned temp source");
    await mkdir(exportBase, {recursive: true}); const destination = path.join(exportBase, path.basename(resolved));
    await cp(resolved, destination, {recursive: true, errorOnExist: true, force: false});
  }
  await rm(resolved, {recursive: true, force: true});
}
