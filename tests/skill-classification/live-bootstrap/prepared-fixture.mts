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
export async function readyEstimateMock(api: Api, repo: string, outputDirectory: string, runId: string) {
  const {config, prepared} = await readyMock(api, repo, outputDirectory, runId);
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

/** Frozen input successor only: never derive expected money from preflight or during a test. */
export async function loadCurrentBudgetFixture(repo: string, bindRegistry = true) {
  const oracleBytes = await readFile(new URL("./budget-wire-oracle.json", import.meta.url));
  const boundaryBytes = await readFile(new URL("./precision-boundary-oracle.json", import.meta.url));
  const successorBytes = await readFile(new URL("./budget-wire-source-successor.json", import.meta.url));
  assert.equal(hash(oracleBytes), "sha256:f6ea158f65473b5aa08846196bbb54a02ca5db7fffaed39d0ba25c2f61148b56");
  assert.equal(hash(boundaryBytes), "sha256:618afb36e06a7372656e9a4139bf3f91e45f12d1487bac42e72f0994a7d2f835");
  assert.equal(hash(successorBytes), "sha256:580819f41a2f61621cf09f6a6357b1cd21b138ee775752455e49d74c68213dfe");
  const predecessor = JSON.parse(oracleBytes.toString("utf8")), precision = JSON.parse(boundaryBytes.toString("utf8"));
  const successor = JSON.parse(successorBytes.toString("utf8"));
  assert.equal(successor.revision, "ags-bootstrap-budget-host-source-binding-r03");
  assert.equal(successor.parentBudgetDigest, hash(oracleBytes));
  assert.equal(successor.parentPrecisionDigest, hash(boundaryBytes));
  assert.deepEqual(successor.rows.map((row: {caseId: string}) => row.caseId), predecessor.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(successor.precisionCases.map((row: {id: string}) => row.id), precision.cases.map((row: {id: string}) => row.id));
  // D280 changes inventory/request bindings only; preserve every frozen money and byte-length expectation.
  const registryBytes = await readFile(new URL("./budget-wire-registry-successor.json", import.meta.url));
  assert.equal(hash(registryBytes), "sha256:d91aa491dc94817d44fe61eb2fd6f488e963687a6d88172c4719168ac41a2111");
  const registrySuccessor = JSON.parse(registryBytes.toString("utf8"));
  assert.equal(registrySuccessor.revision, "ags-bootstrap-budget-registry-binding-r04");
  assert.equal(registrySuccessor.parentSourceDigest, hash(successorBytes));
  assert.equal(registrySuccessor.fixtureDigest, successor.fixtureDigest);
  assert.equal(registrySuccessor.fixtureOracleDigest, successor.fixtureOracleDigest);
  assert.equal(registrySuccessor.rows.length, successor.rows.length);
  // The historical registry binding remains intact; r05 binds current inputs to
  // independently calculated frozen reservations, without consulting preflight.
  const solidBytes = await readFile(new URL("./budget-wire-solid-successor.json", import.meta.url));
  assert.equal(hash(solidBytes), "sha256:25f4eb5d8d5a2449d48b2ef39872ab800e256d8c828c0ead23eef427a9d31ae6");
  const solid = JSON.parse(solidBytes.toString("utf8"));
  assert.equal(solid.revision, "ags-bootstrap-budget-solid-binding-r05");
  assert.equal(solid.parentRegistryDigest, hash(registryBytes));
  assert.equal(solid.fixtureDigest, successor.fixtureDigest);
  assert.equal(solid.fixtureOracleDigest, successor.fixtureOracleDigest);
  assert.equal(solid.rows.length, successor.rows.length);
  // r05 stays frozen history. r06 binds the skill policy wording and prompt-engineering sources
  // to a new official capture and independently calculated reservations, without consulting preflight.
  const policyBytes = await readFile(new URL("./budget-wire-skill-policy-successor.json", import.meta.url));
  assert.equal(hash(policyBytes), "sha256:c1f3efa8bc1844c5353d6a03854f6917fbedcaabbb5b79aa737a3b3f2cc998b9");
  const policy = JSON.parse(policyBytes.toString("utf8"));
  assert.equal(policy.revision, "ags-bootstrap-budget-skill-policy-binding-r06");
  assert.equal(policy.parentSolidDigest, hash(solidBytes));
  assert.equal(policy.rows.length, successor.rows.length);
  assert.deepEqual(policy.precisionCases.map((row: {id: string}) => row.id), solid.precisionCases.map((row: {id: string}) => row.id));
  // r06 remains frozen. r07 binds the midtask source/inventory change to designated-server
  // wire observations and independent rational expectations, never product preflight output.
  const midtaskBytes = await readFile(new URL("./budget-wire-midtask-successor.json", import.meta.url));
  assert.equal(hash(midtaskBytes), "sha256:6a94e78f76801c0b3ceade0c04dee4dfedebbc9ca0071f3c0c6c2b6d2db4e5c0");
  const midtask = JSON.parse(midtaskBytes.toString("utf8"));
  assert.equal(midtask.revision, "ags-bootstrap-budget-midtask-source-binding-r07");
  assert.equal(midtask.parentSkillPolicyDigest, hash(policyBytes));
  if (bindRegistry) assert.equal(midtask.registryDigest, hash(await readFile(path.join(repo, "skills/registry.json"))));
  assert.equal(midtask.fixtureDigest, "sha256:188d2f6b0bbc5ab1ac3931e70387f731ca85c463df0e177113d1b724403446bb");
  assert.deepEqual(midtask.rows.map((row: {caseId: string}) => row.caseId), policy.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(midtask.precisionCases.map((row: {id: string}) => row.id), policy.precisionCases.map((row: {id: string}) => row.id));
  // r07 remains frozen. r08 binds the governance-behavior source successor to its designated-CI
  // wire capture and independent integer reservations; historical prices, caps and precision inputs remain intact.
  const governanceBytes = await readFile(new URL("./budget-wire-governance-behavior-successor.json", import.meta.url));
  assert.equal(hash(governanceBytes), "sha256:a4bbf0573b0d927e373608a945721a43ec9bef624f800eb202903ef88164b155");
  const governance = JSON.parse(governanceBytes.toString("utf8"));
  assert.equal(governance.revision, "ags-bootstrap-budget-governance-behavior-source-binding-r08");
  assert.equal(governance.sourceCommit, "623a31695adcaa581a0ada978e565531460c7d9a");
  assert.equal(governance.parentMidtaskDigest, hash(midtaskBytes));
  if (bindRegistry) assert.equal(governance.registryDigest, hash(await readFile(path.join(repo, "skills/registry.json"))));
  const fixtureBytes = await readFile(path.join(repo, "tests/skill-classification/fixtures.json"));
  // r08의 원 입력은 동결한다. 현재 입력은 아래 r10 원측정에 결속한다.
  assert.equal(governance.fixtureDigest, "sha256:d3490862893ee85f13dbee39ad992498bf7a76360c898d30d8089e5e485c1b88");
  const currentFixture = JSON.parse(fixtureBytes.toString("utf8"));
  assert.equal(governance.fixtureOracleDigest, "sha256:e48f0d37e8675f046a00648451fc3086753af97d663ca4a0aa18b8fdad386666");
  assert.deepEqual(governance.rows.map((row: {caseId: string}) => row.caseId), midtask.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(governance.inheritedFields, ["precisionCases", "syntheticOverBudgetCases", "fractionalRoundingFixture"]);
  let capturedPicoUsd = 0n, maxCapturedPicoUsd = 0n, capturedUtf8Bytes = 0;
  for (const row of governance.rows as {utf8Bytes: number; reservedPicoUsd: string}[]) {
    const picoUsd = BigInt(row.reservedPicoUsd);
    assert.equal(picoUsd, BigInt(row.utf8Bytes) * 42000n);
    capturedPicoUsd += picoUsd; capturedUtf8Bytes += row.utf8Bytes;
    if (picoUsd > maxCapturedPicoUsd) maxCapturedPicoUsd = picoUsd;
  }
  assert.equal(governance.totals.utf8Bytes, String(capturedUtf8Bytes));
  assert.equal(governance.totals.reservedPicoUsd, capturedPicoUsd.toString());
  const firstTwoPicoUsd = governance.rows.slice(0, 2).reduce((sum: bigint, row: {reservedPicoUsd: string}) => sum + BigInt(row.reservedPicoUsd), 0n);
  assert.equal(governance.totals.firstTwoPicoUsd, firstTwoPicoUsd.toString());
  assert.equal(governance.totals.firstTwoUsdDecimal, "0.010488534000");
  assert.equal(governance.totals.reservedUsdDecimal, "0.110123916000");
  assert.equal(governance.totals.maxUtf8Bytes, "124951");
  assert.equal(governance.totals.maxReservedPicoUsd, maxCapturedPicoUsd.toString());
  assert.equal(maxCapturedPicoUsd.toString(), "5247942000");
  // r08 remains frozen. D0341 intentionally changed recovery-deliberation source text and its
  // classification bindings. The exact r09 wire capture is cross-checked by an independent encoder.
  const recoveryBytes = await readFile(new URL("./budget-wire-recovery-deliberation-successor.json", import.meta.url));
  assert.equal(hash(recoveryBytes), "sha256:3e38f4346d6894a891270483a8240ca2846ffb1a0a793eeb12f6742ac13dce51");
  const recovery = JSON.parse(recoveryBytes.toString("utf8"));
  assert.equal(recovery.revision, "ags-bootstrap-budget-recovery-deliberation-source-binding-r09");
  assert.equal(recovery.sourceCommit, "8221fffd3bb65962ecb6be796e0fa6f2b588ce45");
  assert.equal(recovery.parentGovernanceBehaviorDigest, hash(governanceBytes));
  if (bindRegistry) assert.equal(recovery.registryDigest, hash(await readFile(path.join(repo, "skills/registry.json"))));
  assert.equal(recovery.fixtureDigest, governance.fixtureDigest);
  assert.equal(recovery.fixtureOracleDigest, governance.fixtureOracleDigest);
  assert.deepEqual(recovery.rows.map((row: {caseId: string}) => row.caseId), governance.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(recovery.inheritedFields, governance.inheritedFields);
  let recoveryPicoUsd = 0n, maxRecoveryPicoUsd = 0n, recoveryUtf8Bytes = 0;
  for (const row of recovery.rows as {utf8Bytes: number; reservedPicoUsd: string}[]) {
    const picoUsd = BigInt(row.reservedPicoUsd);
    assert.equal(picoUsd, BigInt(row.utf8Bytes) * 42000n);
    recoveryPicoUsd += picoUsd; recoveryUtf8Bytes += row.utf8Bytes;
    if (picoUsd > maxRecoveryPicoUsd) maxRecoveryPicoUsd = picoUsd;
  }
  assert.equal(recovery.totals.utf8Bytes, String(recoveryUtf8Bytes));
  assert.equal(recovery.totals.reservedPicoUsd, recoveryPicoUsd.toString());
  const recoveryFirstTwo = recovery.rows.slice(0, 2).reduce((sum: bigint, row: {reservedPicoUsd: string}) => sum + BigInt(row.reservedPicoUsd), 0n);
  assert.equal(recovery.totals.firstTwoPicoUsd, recoveryFirstTwo.toString());
  assert.equal(recovery.totals.firstTwoUsdDecimal, "0.010494246000");
  assert.equal(recovery.totals.reservedUsdDecimal, "0.110183892000");
  assert.equal(recovery.totals.maxUtf8Bytes, "125019");
  assert.equal(recovery.totals.maxReservedPicoUsd, maxRecoveryPicoUsd.toString());
  assert.equal(maxRecoveryPicoUsd.toString(), "5250798000");
  // r09도 보존한다. 실제·독립 인코더가 일치한 지정 CI의 r10만 현재 전송 입력으로 쓴다.
  const invocationBytes = await readFile(new URL("./budget-wire-orchestrator-invocation-successor.json", import.meta.url));
  assert.equal(hash(invocationBytes), "sha256:f9bdab55ab00309ea04096d6d8665e64165d1eb897057dc5898f553cff854fc2");
  const invocation = JSON.parse(invocationBytes.toString("utf8"));
  assert.equal(invocation.revision, "ags-bootstrap-budget-orchestrator-invocation-source-binding-r10");
  assert.equal(invocation.sourceCommit, "9da7022d2f3bffdbea50865b841640733643e25d");
  assert.equal(invocation.parentRecoveryDeliberationDigest, hash(recoveryBytes));
  if (bindRegistry) assert.equal(invocation.registryDigest, hash(await readFile(path.join(repo, "skills/registry.json"))));
  assert.equal(invocation.fixtureDigest, hash(fixtureBytes));
  assert.equal(invocation.fixtureOracleDigest, currentFixture.oracleDigest);
  assert.deepEqual(invocation.rows.map((row: {caseId: string}) => row.caseId), recovery.rows.map((row: {caseId: string}) => row.caseId));
  assert.deepEqual(invocation.inheritedFields, recovery.inheritedFields);
  let invocationPicoUsd = 0n, maxInvocationPicoUsd = 0n, invocationUtf8Bytes = 0;
  for (const row of invocation.rows as {utf8Bytes: number; reservedPicoUsd: string}[]) {
    const picoUsd = BigInt(row.reservedPicoUsd);
    assert.equal(picoUsd, BigInt(row.utf8Bytes) * 42000n);
    invocationPicoUsd += picoUsd; invocationUtf8Bytes += row.utf8Bytes;
    if (picoUsd > maxInvocationPicoUsd) maxInvocationPicoUsd = picoUsd;
  }
  assert.equal(invocation.totals.utf8Bytes, String(invocationUtf8Bytes));
  assert.equal(invocation.totals.reservedPicoUsd, invocationPicoUsd.toString());
  const invocationFirstTwo = invocation.rows.slice(0, 2).reduce((sum: bigint, row: {reservedPicoUsd: string}) => sum + BigInt(row.reservedPicoUsd), 0n);
  assert.equal(invocation.totals.firstTwoPicoUsd, invocationFirstTwo.toString());
  assert.equal(invocation.totals.firstTwoUsdDecimal, "0.010549686000");
  assert.equal(invocation.totals.reservedUsdDecimal, "0.110766012000");
  assert.equal(invocation.totals.maxUtf8Bytes, "125679");
  assert.equal(invocation.totals.maxReservedPicoUsd, maxInvocationPicoUsd.toString());
  assert.equal(maxInvocationPicoUsd.toString(), "5278518000");
  const currentRows = successor.rows.map((row: {caseId: string; utf8Bytes: number}, index: number) => {
    const historical = registrySuccessor.rows[index];
    assert.equal(historical.caseId, row.caseId);
    assert.equal(historical.utf8Bytes, row.utf8Bytes);
    assert.equal(solid.rows[index].caseId, row.caseId);
    assert.equal(midtask.rows[index].caseId, row.caseId);
    const current = invocation.rows[index];
    assert.equal(current.caseId, row.caseId);
    return {...row, ...current};
  });
  const oracle = {...predecessor, inventoryDigest: invocation.inventoryDigest, fixtureDigest: invocation.fixtureDigest,
    fixtureOracleDigest: invocation.fixtureOracleDigest, rows: currentRows, totals: invocation.totals,
    syntheticOverBudgetCases: predecessor.syntheticOverBudgetCases.map((row: {id: string}, index: number) => {
      assert.equal(successor.syntheticOverBudgetCases[index].id, row.id);
      assert.equal(solid.syntheticOverBudgetCases[index].id, row.id);
      assert.equal(policy.syntheticOverBudgetCases[index].id, row.id);
      assert.equal(midtask.syntheticOverBudgetCases[index].id, row.id);
      return {...row, ...midtask.syntheticOverBudgetCases[index]};
    }), fractionalRoundingFixture: {...predecessor.fractionalRoundingFixture, ...midtask.fractionalRoundingFixture}};
  return {oracleBytes, boundaryBytes, oracle, precision: {...precision,
    cases: precision.cases.map((row: {id: string}, index: number) => ({...row, ...midtask.precisionCases[index]}))},
  successorDigest: hash(invocationBytes), successorRevision: invocation.revision};
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
