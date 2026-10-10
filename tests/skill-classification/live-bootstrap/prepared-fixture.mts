import {createHash} from "node:crypto";
import {mkdir, writeFile} from "node:fs/promises";
import {realpathSync} from "node:fs";
import path from "node:path";
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
export async function readyMock(api: Api, repo: string, outputDirectory: string, runId: string,
  options: {requests?: number; timeoutMs?: number; preparedAt?: string; issuerExpiry?: IssuerExpiry} = {}) {
  await mkdir(outputDirectory, {recursive: true});
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
  const prepared = await api.prepare(config);
  config.profile = prepared.api.evaluationConfig.createProviderEvaluationConfiguration({
    profileId: "mock-profile", providerKind: "jev", vendorId: "mock-vendor", modelId: "mock-model",
    modelRevision: "mock-model-revision", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true},
    approvedRouteRef: "mock-only", qualificationRevision: "mock-not-qualified", adapterRevision: "mock-adapter-v1",
    promptRevision: "mock-question-v1", maximumInputBytes: config.limits!.inputBytes,
    maximumOutputTokens: config.limits!.outputTokens, maximumCostUsd: 0.001, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}
  }, prepared.inventory, preparedAt);
  await bindMockAuthorityAndEvidence(api, config, options.issuerExpiry);
  return {config, prepared};
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
