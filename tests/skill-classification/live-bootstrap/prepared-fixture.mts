import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {PreparedBootstrapConfig} from "./bootstrap.mts";
import type {SkillClassificationRequestV1} from "../../../mcp-server/src/skill-classification/types.js";

type Api = typeof import("./bootstrap.mts");
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
type FixtureOptions = {requests?: number; timeoutMs?: number; preparedAt?: string; issuerExpiry?: IssuerExpiry};
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
  const prepared = await api.prepare(config);
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

/** Fixture authoring only. Every original preflight/run still freshly reads and checks the real source. */
export function rebindPreparedFixture(prepared: Awaited<ReturnType<Api["prepare"]>>, runId: string) {
  return {...prepared, requests: prepared.cases.map((row: {caseId: string; originalPrompt: string}) => ({caseId: row.caseId,
    request: prepared.api.request.createClassificationRequest({requestId: `${runId}/${row.caseId}`, operationId: `${runId}/${row.caseId}`,
      originalPrompt: row.originalPrompt, inventory: prepared.inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"})}))};
}

/** Synthetic reviewed-estimate fixture. Its wire observations configure admission; this is not a gold cost/quality oracle. */
export async function readyEstimateMock(api: Api, repo: string, outputDirectory: string, runId: string) {
  const {config, prepared} = await readyMock(api, repo, outputDirectory, runId);
  config.reservationMode = "reviewed-estimate";
  config.prices = {billingMode: "token", inputUsdPer1k: 0.000042, outputUsdPer1k: 0, fixedCallMaxUsd: 0};
  const configuration = structuredClone(config.profile!.configuration);
  const measurements = prepared.requests.map(({caseId, request}: {caseId: string; request: SkillClassificationRequestV1}) => {
    const wire = JSON.stringify(prepared.api.providers.jevNoulWireAdapter.encode(request, configuration));
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

/** Frozen input successor only: never derive expected money from preflight or during a test. */
export async function loadCurrentBudgetFixture(repo: string) {
  const oracleBytes = await readFile(new URL("./budget-wire-oracle.json", import.meta.url));
  const boundaryBytes = await readFile(new URL("./precision-boundary-oracle.json", import.meta.url));
  const successorBytes = await readFile(new URL("./budget-wire-source-successor.json", import.meta.url));
  assert.equal(hash(oracleBytes), "sha256:f6ea158f65473b5aa08846196bbb54a02ca5db7fffaed39d0ba25c2f61148b56");
  assert.equal(hash(boundaryBytes), "sha256:618afb36e06a7372656e9a4139bf3f91e45f12d1487bac42e72f0994a7d2f835");
  assert.equal(hash(successorBytes), "sha256:7efc9900460ab5addeed97cbfa6cf0ea521f4221336b3ca61eef02c74cb43cb5");
  const predecessor = JSON.parse(oracleBytes.toString("utf8")), precision = JSON.parse(boundaryBytes.toString("utf8"));
  const successor = JSON.parse(successorBytes.toString("utf8"));
  assert.equal(successor.revision, "ags-bootstrap-budget-source-binding-r01");
  assert.equal(successor.parentBudgetDigest, hash(oracleBytes));
  assert.equal(successor.parentPrecisionDigest, hash(boundaryBytes));
  assert.equal(successor.fixtureDigest, hash(await readFile(path.join(repo, "tests/skill-classification/fixtures.json"))));
  assert.deepEqual(successor.rows.map((row: {caseId: string}) => row.caseId), predecessor.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(successor.precisionCases.map((row: {id: string}) => row.id), precision.cases.map((row: {id: string}) => row.id));
  const oracle = {...predecessor, inventoryDigest: successor.inventoryDigest, fixtureDigest: successor.fixtureDigest,
    fixtureOracleDigest: successor.fixtureOracleDigest, rows: successor.rows, totals: successor.totals,
    syntheticOverBudgetCases: predecessor.syntheticOverBudgetCases.map((row: {id: string}, index: number) => {
      assert.equal(successor.syntheticOverBudgetCases[index].id, row.id);
      return {...row, ...successor.syntheticOverBudgetCases[index]};
    }), fractionalRoundingFixture: {...predecessor.fractionalRoundingFixture, ...successor.fractionalRoundingFixture}};
  return {oracleBytes, boundaryBytes, oracle, precision: {...precision,
    cases: precision.cases.map((row: {id: string}, index: number) => ({...row, ...successor.precisionCases[index]}))},
  successorDigest: hash(successorBytes), successorRevision: successor.revision};
}

// Explicit authoring command captures only current public request/wire inputs. It neither runs nor qualifies a provider.
// Independent rational expectations are reviewed and frozen in the successor; tests never invoke this mode.
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
