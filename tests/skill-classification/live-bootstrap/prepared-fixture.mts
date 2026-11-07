import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {PreparationPurpose, PreparedBootstrapConfig} from "./bootstrap.mts";
import type {SkillClassificationRequestV1} from "../../../mcp-server/src/skill-classification/types.js";

type Api = typeof import("./bootstrap.mts");
// Runtime-resolved like bootstrap.mts below, so the type-checked .ts graph does not import .mts modules.
const {independentWireRows} = await import(new URL("./independent-wire-oracle.mts", import.meta.url).href) as {
  independentWireRows(repo: string, runId?: string): Promise<{caseId: string; requestDigest: string; inventoryDigest: string; wireDigest: string; utf8Bytes: number}[]>};
const {adjacentPrices, expectedPico} = await import(new URL("./precision-current-oracle.mts", import.meta.url).href) as {
  adjacentPrices(maxBytes: number): [number, number]; expectedPico(bytes: number, price: number): bigint};
export type EvidenceKind = keyof PreparedBootstrapConfig["evidence"];
export type IssuerExpiry = {kind: EvidenceKind; validUntil: string};
export const mockEnv = {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"};
export const hash = (bytes: string | Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
export function mockResponse(init?: RequestInit, modelRevision = "mock-model-revision"): Response {
  const wire = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({model: modelRevision,
    answers: Object.fromEntries(Object.keys(wire.questions).map(id => [id, {type: "noul", noul: 0}])),
    usage: {input_tokens: 0, output_tokens: 0}}), {status: 200});
}
export async function bindMockAuthorityAndEvidence(api: Api, config: PreparedBootstrapConfig, issuerExpiry?: IssuerExpiry): Promise<void> {
  await mkdir(config.outputDirectory, {recursive: true});
  config.currentAuthority ??= {scope: "single-run-directory", ownerId: "offline-fixture-owner", revision: "authority-1",
    budgetRevision: "budget-1", reference: {path: "authority.json", digest: hash("")}};
  for (const kind of Object.keys(config.evidence) as EvidenceKind[]) {
    if (kind === "hardTokenCaps") continue; // Fixed-per-call price needs no token-cap evidence.
    const record = api.createPreparationEvidence(config, kind,
      {verifiedBy: "offline-fixture-only", sourceRef: "synthetic-not-real-authority", preparedAt: config.profile!.preparedAt},
      issuerExpiry?.kind === kind ? {kind: "issuer", validUntil: issuerExpiry.validUntil} : {kind: "immutable-preparation"});
    const bytes = JSON.stringify(record);
    await writeFile(path.join(config.outputDirectory, `${kind}.json`), bytes);
    config.evidence[kind] = {path: `${kind}.json`, digest: hash(bytes)};
  }
  const authority = JSON.stringify({schemaVersion: "1.0.0", scope: "single-run-directory", runId: config.runId,
    outputDirectory: realpathSync(config.outputDirectory), ownerId: config.currentAuthority.ownerId,
    revision: config.currentAuthority.revision, budgetRevision: config.currentAuthority.budgetRevision,
    approved: true, cancelled: false, valuesDigest: api.evidenceValuesDigest(config, "operatorAuthorization")});
  await writeFile(path.join(config.outputDirectory, "authority.json"), authority);
  config.currentAuthority.reference = {path: "authority.json", digest: hash(authority)};
}
type FixtureOptions = {requests?: number; timeoutMs?: number; preparedAt?: string; issuerExpiry?: IssuerExpiry; sourcePurpose?: PreparationPurpose};
export type FixtureBinding = Readonly<Pick<SkillClassificationRequestV1, "inventoryDigest" | "taxonomyRevision">>;
type CreateProfile = Awaited<ReturnType<Api["prepare"]>>["api"]["evaluationConfig"]["createProviderEvaluationConfiguration"];

function mockConfig(repo: string, outputDirectory: string, runId: string, options: FixtureOptions) {
  const preparedAt = options.preparedAt ?? "2020-01-01T00:00:00.000Z";
  const config: PreparedBootstrapConfig = {schemaVersion: "3.0.0", runId, repo, outputDirectory,
    endpointEnv: "AGS_BOOTSTRAP_ENDPOINT", credentialEnv: "AGS_BOOTSTRAP_JEV_KEY",
    approvedEndpointDigest: hash(mockEnv.AGS_BOOTSTRAP_ENDPOINT), approvedRouteRef: "mock-only", approvalRef: "offline-test-not-approval",
    profile: null, reservationMode: "verified-upper-bound", estimator: null, currentAuthority: null,
    limits: {requests: options.requests ?? 2, inputBytes: 1048576, inputTokens: 100000, outputTokens: 10000,
      responseBytes: 128000, timeoutMs: options.timeoutMs ?? 10000, runUsd: 0.15},
    prices: {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001},
    budget: {scope: "run", runId, totalAuthorizationUsd: 5, allocatedUsd: 0.15, allocationRef: "offline-fixture-allocation",
      priorRunConfirmedSpendUsd: 0, priorRunUnknownReservedUsd: 0, accountBalanceUsd: null, accountPriorSpendUsd: null,
      accountUnknownReservedUsd: null, observedAt: preparedAt},
    evidence: {route: null, price: null, priorLedger: null, remaining: null, hardTokenCaps: null, operatorAuthorization: null}};
  return {config, preparedAt};
}

function mockProfile(config: PreparedBootstrapConfig, binding: FixtureBinding, preparedAt: string, createProfile: CreateProfile) {
  return createProfile({
    profileId: "mock-profile", providerKind: "jev", vendorId: "mock-vendor", modelId: "mock-model",
    modelRevision: "mock-model-revision", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true},
    approvedRouteRef: "mock-only", qualificationRevision: "mock-not-qualified", adapterRevision: "mock-adapter-v1",
    promptRevision: "mock-question-v1", maximumInputBytes: config.limits!.inputBytes,
    maximumOutputTokens: config.limits!.outputTokens, maximumCostUsd: 0.001, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}
  }, binding, preparedAt);
}

export async function readyMock(api: Api, repo: string, outputDirectory: string, runId: string, options: FixtureOptions = {}) {
  await mkdir(outputDirectory, {recursive: true});
  const {config, preparedAt} = mockConfig(repo, outputDirectory, runId, options);
  const prepared = await api.prepare(config, options.sourcePurpose);
  config.profile = mockProfile(config, prepared.inventory, preparedAt, prepared.api.evaluationConfig.createProviderEvaluationConfiguration);
  await bindMockAuthorityAndEvidence(api, config, options.issuerExpiry);
  return {config, prepared};
}

/** Fixture authoring only. The caller still uses the original run, which freshly prepares and validates this binding. */
export async function readyMockFromBinding(api: Api, repo: string, outputDirectory: string, runId: string,
  binding: FixtureBinding, createProfile: CreateProfile, options: FixtureOptions = {}) {
  await mkdir(outputDirectory, {recursive: true});
  const {config, preparedAt} = mockConfig(repo, outputDirectory, runId, options);
  config.profile = mockProfile(config, binding, preparedAt, createProfile);
  await bindMockAuthorityAndEvidence(api, config, options.issuerExpiry);
  return config;
}

const skillsCanonicalCache = new WeakMap<object, string>();
const canonicalizeFixtureValue = (item: unknown, skillsRef?: object, skillsCanonical?: string): string => {
  if (skillsCanonical !== undefined && item === skillsRef) return skillsCanonical;
  if (item === null || typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
  if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
  if (Array.isArray(item)) return `[${item.map(entry => canonicalizeFixtureValue(entry, skillsRef, skillsCanonical)).join(",")}]`;
  if (typeof item === "object" && item && Object.getPrototypeOf(item) === Object.prototype) {
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonicalizeFixtureValue((item as Record<string, unknown>)[key], skillsRef, skillsCanonical)}`).join(",")}}`;
  }
  throw new Error("INVALID_JSON_VALUE");
};

/** Fixture authoring only. Every original preflight/run still freshly reads and checks the real source. */
export function rebindPreparedFixture(prepared: Awaited<ReturnType<Api["prepare"]>>, runId: string) {
  const skillsRef = prepared.inventory.skills as object;
  let skillsCanonical = skillsCanonicalCache.get(skillsRef);
  if (!skillsCanonical) {
    skillsCanonical = canonicalizeFixtureValue(skillsRef);
    skillsCanonicalCache.set(skillsRef, skillsCanonical);
  }
  return {...prepared, requests: prepared.requests.map(({caseId, request: tpl}: {caseId: string; request: SkillClassificationRequestV1}) => {
    const id = `${runId}/${caseId}`;
    const body = {
      schemaVersion: tpl.schemaVersion,
      requestId: id,
      operationId: id,
      originalPrompt: tpl.originalPrompt,
      promptDigest: tpl.promptDigest,
      confirmedContext: {...tpl.confirmedContext},
      contextSources: [...tpl.contextSources],
      skills: skillsRef as SkillClassificationRequestV1["skills"],
      inventoryDigest: tpl.inventoryDigest,
      taxonomyRevision: tpl.taxonomyRevision,
      classificationCriteriaRef: tpl.classificationCriteriaRef,
    };
    const requestDigest = hash(canonicalizeFixtureValue(body, skillsRef, skillsCanonical));
    return {caseId, request: {...body, requestDigest}};
  })};
}

/** Synthetic reviewed-estimate fixture. Its wire observations configure admission; this is not a gold cost/quality oracle. */
export async function readyEstimateMock(api: Api, repo: string, outputDirectory: string, runId: string,
  options: Pick<FixtureOptions, "sourcePurpose"> = {}) {
  const {config, prepared} = await readyMock(api, repo, outputDirectory, runId, options);
  config.reservationMode = "reviewed-estimate";
  config.prices = {billingMode: "token", inputUsdPer1k: 0.000042, outputUsdPer1k: 0, fixedCallMaxUsd: 0};
  const configuration = structuredClone(config.profile!.configuration);
  let firstWire: {model: unknown; state: Record<string, unknown>; questions: unknown} | null = null;
  const measurements = prepared.requests.map(({caseId, request}: {caseId: string; request: SkillClassificationRequestV1}) => {
    const wireObj = firstWire
      ? {model: firstWire.model, state: {...firstWire.state, originalPrompt: request.originalPrompt}, questions: firstWire.questions}
      : (firstWire = prepared.api.providers.jevNoulWireAdapter.encode(request, configuration) as {model: unknown; state: Record<string, unknown>; questions: unknown});
    const wire = JSON.stringify(wireObj);
    return {caseId, requestDigest: request.requestDigest, wireDigest: hash(wire), utf8Bytes: Buffer.byteLength(wire)};
  });
  if (measurements.length !== 21) throw new Error("EXPECTED_21_WHOLE_ESTIMATE_MEASUREMENTS");
  const artifact = JSON.stringify({runId, inventoryDigest: prepared.inventory.inventoryDigest, measurements});
  const source = "Synthetic reviewed estimate only: one UTF8 byte assumed one input token; no provider billing or account authority.";
  await writeFile(path.join(outputDirectory, "estimate-input.json"), artifact);
  await writeFile(path.join(outputDirectory, "estimate-source.txt"), source);
  config.estimator = {method: "utf8-bytes-as-input-tokens-v1", inputArtifact: {path: "estimate-input.json", digest: hash(artifact)},
    sources: [{path: "estimate-source.txt", digest: hash(source)}], uncertainty: "Synthetic estimate assumption, not upper bound or settled charge"};
  // Exactly .000042 USD/1000 =42000 picoUSD per byte; input values configure the fixture, not an assertion on the product calculator.
  configuration.maximumCostUsd = Math.max(...measurements.map((row: {utf8Bytes: number}) => Number(BigInt(row.utf8Bytes) * 42000n) / 1e12));
  config.profile = prepared.api.evaluationConfig.createProviderEvaluationConfiguration(configuration, prepared.inventory, config.profile!.preparedAt);
  await bindMockAuthorityAndEvidence(api, config);
  return {config, prepared, measurements};
}

type CurrentWireRow = {caseId: string; requestDigest: string; wireDigest: string; utf8Bytes: number};
type PrecisionCaseRule = {id: string; kind: string; priceNumberText: string; expectedStatus: string; expectedReason: string | null};
type SyntheticCaseRule = {id: string; historicalId: string; requests: number; capUsd: string; unchangedUnknownUsd: string; historicalConfirmedUsd: string};
type BudgetPolicy = Record<string, unknown> & {rows: {caseId: string}[]; prices: {inputUsdPer1000Tokens: string; outputUsdPer1000Tokens: string;
  fixedCallUsd: string; assumedInputTokensPerUtf8Byte: string; usdPerByteNumerator: string; usdPerByteDenominator: string};
  syntheticOverBudgetCases: (SyntheticCaseRule & Record<string, unknown>)[]; fractionalRoundingFixture: Record<string, unknown> & {inputUsdPer1000Tokens: string}};
type PrecisionPolicy = Record<string, unknown> & {cases: PrecisionCaseRule[]};
const PICO_PER_USD = 1_000_000_000_000n;
// The reviewed price oracle may only advance by the smallest step that crosses its cap.
const SYNTHETIC_OVERRUN_PICO = 1000n;
const usdDecimal = (pico: bigint) => {
  assert(pico >= 0n);
  return `${pico / PICO_PER_USD}.${(pico % PICO_PER_USD).toString().padStart(12, "0")}`;
};
const decimalPico = (usd: string) => {
  const match = /^(\d+)\.(\d{12})$/u.exec(usd);
  assert(match, `TWELVE_PLACE_USD_REQUIRED:${usd}`);
  return BigInt(match[1]!) * PICO_PER_USD + BigInt(match[2]!);
};
const sumPico = (values: bigint[]) => values.reduce((sum, value) => sum + value, 0n);
const maxPico = (values: bigint[]) => values.reduce((max, value) => value > max ? value : max, 0n);

/**
 * Money and precision rules applied to the given current wire measurements. The frozen root oracles hold only policy
 * (prices, caps, case definitions); every byte-dependent expectation is recomputed here by exact integer arithmetic.
 */
export function deriveBudgetFixture(predecessor: BudgetPolicy, precision: PrecisionPolicy, wireRows: readonly CurrentWireRow[],
  current: {inventoryDigest: string; fixtureDigest: string; fixtureOracleDigest: string}) {
  // Case identity and order come from the frozen corpus oracle, never from the current measurement.
  assert.deepEqual(wireRows.map(row => row.caseId), predecessor.rows.map(row => row.caseId), "BUDGET_CASE_ORDER");
  assert.deepEqual([predecessor.prices.inputUsdPer1000Tokens, predecessor.prices.outputUsdPer1000Tokens, predecessor.prices.fixedCallUsd,
    predecessor.prices.assumedInputTokensPerUtf8Byte], ["0.000042", "0", "0", "1"], "BUDGET_PRICE_POLICY");
  const picoPerByteNumerator = BigInt(predecessor.prices.usdPerByteNumerator) * PICO_PER_USD;
  const picoPerByteDenominator = BigInt(predecessor.prices.usdPerByteDenominator);
  assert.equal(picoPerByteNumerator % picoPerByteDenominator, 0n);
  const picoPerByte = picoPerByteNumerator / picoPerByteDenominator;
  assert.equal(picoPerByte, 42000n);
  for (const row of wireRows) {
    assert(Number.isSafeInteger(row.utf8Bytes) && row.utf8Bytes > 0, `BUDGET_WIRE_BYTES:${row.caseId}`);
    assert.match(row.requestDigest, /^sha256:[a-f0-9]{64}$/u); assert.match(row.wireDigest, /^sha256:[a-f0-9]{64}$/u);
  }
  const rows = wireRows.map(({caseId, requestDigest, wireDigest, utf8Bytes}) => {
    const reserved = BigInt(utf8Bytes) * picoPerByte;
    return {caseId, requestDigest, wireDigest, utf8Bytes, reservedPicoUsd: reserved.toString(), reservedUsdDecimal: usdDecimal(reserved)};
  });
  const reserved = rows.map(row => BigInt(row.reservedPicoUsd));
  const total = sumPico(reserved), firstTwo = sumPico(reserved.slice(0, 2)), max = maxPico(reserved);
  const totals = {utf8Bytes: String(rows.reduce((sum, row) => sum + row.utf8Bytes, 0)), reservedPicoUsd: total.toString(),
    reservedUsdDecimal: usdDecimal(total), firstTwoPicoUsd: firstTwo.toString(), firstTwoUsdDecimal: usdDecimal(firstTwo),
    maxUtf8Bytes: String(Math.max(...rows.map(row => row.utf8Bytes))), maxReservedPicoUsd: max.toString()};
  // Synthetic over-budget: unknown and historical confirmed spend stay fixed; add confirmed spend only until the total
  // exceeds the cap by SYNTHETIC_OVERRUN_PICO. A current reservation already over the cap needs no addition.
  const syntheticOverBudgetCases = predecessor.syntheticOverBudgetCases.map(row => {
    assert(Number.isSafeInteger(row.requests) && row.requests > 0 && row.requests <= rows.length);
    assert.equal(row.id, `${row.historicalId}-current-oracle`);
    const cap = decimalPico(row.capUsd), unknown = decimalPico(row.unchangedUnknownUsd), historical = decimalPico(row.historicalConfirmedUsd);
    const requestReservation = sumPico(reserved.slice(0, row.requests));
    const oldTotal = unknown + historical + requestReservation;
    const additional = oldTotal > cap ? 0n : cap + SYNTHETIC_OVERRUN_PICO - oldTotal;
    const proposedTotal = oldTotal + additional;
    assert(proposedTotal > cap, `SYNTHETIC_CASE_NOT_OVER_BUDGET:${row.id}`);
    return {...row, currentRequestReservationUsd: usdDecimal(requestReservation), oldInputCurrentTotalUsd: usdDecimal(oldTotal),
      additionalSyntheticConfirmedUsd: usdDecimal(additional), proposedSyntheticConfirmedUsd: usdDecimal(historical + additional),
      proposedTotalPicoUsd: proposedTotal.toString(), proposedTotalUsd: usdDecimal(proposedTotal)};
  });
  // Fractional price: round up each request, never the sum.
  const fractionalPrice = Number(predecessor.fractionalRoundingFixture.inputUsdPer1000Tokens);
  const fractionalRows = rows.map(row => ({caseId: row.caseId, reservedPicoUsd: expectedPico(row.utf8Bytes, fractionalPrice).toString()}));
  const perRequestCeil = sumPico(fractionalRows.map(row => BigInt(row.reservedPicoUsd)));
  const roundAfterSumming = expectedPico(Number(totals.utf8Bytes), fractionalPrice);
  assert(perRequestCeil > roundAfterSumming, "PER_REQUEST_ROUNDING_REQUIRED");
  const fractionalRoundingFixture = {...predecessor.fractionalRoundingFixture, rows: fractionalRows,
    sumOfPerRequestCeilPicoUsd: perRequestCeil.toString(), invalidRoundAfterSummingPicoUsd: roundAfterSumming.toString(),
    differencePicoUsd: (perRequestCeil - roundAfterSumming).toString()};
  // The historical safe-boundary prices were fitted to old bytes; the current boundary is the nearest Number pair
  // around MAX_SAFE_INTEGER picoUSD for the current largest request.
  const [below, above] = adjacentPrices(Math.max(...rows.map(row => row.utf8Bytes)));
  const adjacent: Record<string, [string, number]> = {"safe-equal": ["current-adjacent-below", below], "safe-above": ["current-adjacent-above", above]};
  const fixedPico = 1_000_000_000n; // fixed-per-call controls reserve fixedCallMaxUsd 0.001
  const cases = precision.cases.map(original => {
    const [id, price] = adjacent[original.id] ?? [original.id, Number(original.priceNumberText)];
    const priceNumberText = adjacent[original.id] ? price.toString() : original.priceNumberText;
    const values = original.kind === "invalid-price" ? null
      : original.kind === "reviewed-estimate" ? rows.map(row => expectedPico(row.utf8Bytes, price))
      : rows.map(() => fixedPico);
    return {id, kind: original.kind, priceNumberText, expectedStatus: original.expectedStatus, expectedReason: original.expectedReason,
      expectedRows: values ? rows.map((row, index) => ({caseId: row.caseId, reservedPicoUsd: values[index]!.toString()})) : [],
      expectedSumPicoUsd: values ? sumPico(values).toString() : null, expectedMaxPicoUsd: values ? maxPico(values).toString() : null};
  });
  const oracle = {...predecessor, ...current, rows, totals, syntheticOverBudgetCases, fractionalRoundingFixture};
  return {oracle, precision: {...precision, cases}};
}

/** Current-tree rule fixture: never derive expected money from preflight or during a test. */
export async function loadCurrentBudgetFixture(repo: string) {
  // Root policy oracles stay frozen: prices, caps, corpus case order and precision case definitions.
  const oracleBytes = await readFile(new URL("./budget-wire-oracle.json", import.meta.url));
  const boundaryBytes = await readFile(new URL("./precision-boundary-oracle.json", import.meta.url));
  assert.equal(hash(oracleBytes), "sha256:f6ea158f65473b5aa08846196bbb54a02ca5db7fffaed39d0ba25c2f61148b56");
  assert.equal(hash(boundaryBytes), "sha256:618afb36e06a7372656e9a4139bf3f91e45f12d1487bac42e72f0994a7d2f835");
  const predecessor = JSON.parse(oracleBytes.toString("utf8")), precision = JSON.parse(boundaryBytes.toString("utf8"));
  // Current request/wire bytes come from the independent encoder over the current tree, not from product preflight.
  const independent = await independentWireRows(repo, predecessor.canonicalRunId);
  const fixtureBytes = await readFile(path.join(repo, "tests/skill-classification/fixtures.json"));
  const inventoryDigest = independent[0]!.inventoryDigest;
  assert(independent.every(row => row.inventoryDigest === inventoryDigest));
  const {oracle, precision: currentPrecision} = deriveBudgetFixture(predecessor, precision, independent,
    {inventoryDigest, fixtureDigest: hash(fixtureBytes), fixtureOracleDigest: JSON.parse(fixtureBytes.toString("utf8")).oracleDigest});
  return {oracleBytes, boundaryBytes, oracle, precision: currentPrecision,
    successorDigest: hash(JSON.stringify({oracle, precision: currentPrecision})), successorRevision: "ags-bootstrap-budget-current-tree-rules-r16"};
}

// Explicit authoring command captures only current public request/wire inputs. It neither runs nor qualifies a provider.
// Diagnostic only: tests derive expectations from independentWireRows and never invoke this mode.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.equal(process.argv[2], "--capture-budget-wire");
  assert.equal(process.argv.length, 4, "Usage: prepared-fixture.mts --capture-budget-wire OUTPUT_JSON");
  const repo = path.resolve(import.meta.dirname, "../../..");
  const api = await import(pathToFileURL(path.join(import.meta.dirname, "bootstrap.mts")).href) as Api;
  const {config, preparedAt} = mockConfig(repo, path.dirname(path.resolve(process.argv[3]!)), "full-21-015", {requests: 21});
  const prepared = await api.prepare(config);
  const profile = mockProfile(config, prepared.inventory, preparedAt, prepared.api.evaluationConfig.createProviderEvaluationConfiguration);
  const rows = prepared.requests.map(({caseId, request}: {caseId: string; request: SkillClassificationRequestV1}) => {
    const wire = JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, profile.configuration));
    return {caseId, requestDigest: request.requestDigest, wireDigest: hash(wire), utf8Bytes: Buffer.byteLength(wire)};
  });
  await writeFile(path.resolve(process.argv[3]!), JSON.stringify({inventoryDigest: prepared.inventory.inventoryDigest,
    fixtureDigest: prepared.fixtureFileDigest, fixtureOracleDigest: prepared.corpus.oracleDigest, rows}, null, 2) + "\n", {flag: "wx"});
}
