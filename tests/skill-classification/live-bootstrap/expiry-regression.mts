import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {pathToFileURL} from "node:url";
import type {BootstrapConfig} from "./bootstrap.mts";

const repo = path.resolve(process.argv[2]!);
const helperFile = path.resolve(process.argv[3]!);
const api = await import(pathToFileURL(helperFile).href) as typeof import("./bootstrap.mts");
const root = await mkdtemp(path.join(os.tmpdir(), "ags-bootstrap-expiry-"));
const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const boundaries = ["route", "price", "operatorAuthorization", "remaining", "priorLedger", "hardTokenCaps", "budget"] as const;
async function fixture(kind: typeof boundaries[number], suffix = "") {
  const start = Date.now(), deadline = start + 10000, later = start + 60000;
  const outputDirectory = path.join(root, kind + suffix); await mkdir(outputDirectory);
  const config: BootstrapConfig = {schemaVersion: "1.0.0", runId: `expiry-${kind.toLowerCase()}`, repo, outputDirectory,
    endpointEnv: "AGS_BOOTSTRAP_ENDPOINT", credentialEnv: "AGS_BOOTSTRAP_JEV_KEY", approvedEndpointDigest: hash("https://mock.invalid/classify"), approvedRouteRef: "mock-route", approvalRef: "mock-only",
    limits: {requests: 2, inputBytes: 1048576, inputTokens: 100000, outputTokens: 10000, responseBytes: 128000, timeoutMs: 1000, runUsd: 1},
    prices: kind === "hardTokenCaps" ? {billingMode: "token", inputUsdPer1k: 0.00001, outputUsdPer1k: 0, fixedCallMaxUsd: 0} : {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001},
    budget: {totalLimitUsd: 1, verifiedPriorSpendUsd: 0, priorUnknownReservedUsd: 0, currentRemainingUsd: 1, observedAt: new Date(start - 1000).toISOString(), validUntil: new Date(kind === "budget" ? deadline : later).toISOString()},
    profile: null, evidence: {route: null, price: null, priorLedger: null, remaining: null, hardTokenCaps: null, operatorAuthorization: null}};
  const prepared = await api.prepare(config);
  config.profile = {profileId: "mock-profile", providerKind: "jev", vendorId: "mock-vendor", modelId: "mock-model", modelRevision: "mock-model-revision", reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: config.approvedRouteRef, qualificationRevision: "mock-not-qualified",
    qualification: {status: "NOT_RUN", inventoryDigest: prepared.inventory.inventoryDigest, taxonomyRevision: prepared.inventory.taxonomyRevision, modelRevision: "mock-model-revision", promptRevision: "mock-question-v1", validUntil: new Date(later).toISOString(), profileConfigurationDigest: ""},
    adapterRevision: "mock-adapter-v1", promptRevision: "mock-question-v1", maximumInputBytes: config.limits!.inputBytes, maximumOutputTokens: config.limits!.outputTokens, maximumCostUsd: 0.001, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
  (config.profile.qualification as Record<string, unknown>).profileConfigurationDigest = prepared.api.profiles.digestProviderProfileConfiguration(config.profile);
  for (const name of Object.keys(config.evidence) as (keyof BootstrapConfig["evidence"])[]) {
    if (name === "hardTokenCaps" && kind !== name) continue;
    const record = {schemaVersion: "1.0.0", kind: name, verifiedBy: "offline-mock-only", sourceRef: "synthetic-not-authority",
      validUntil: new Date(kind === name ? deadline : later).toISOString(), valuesDigest: api.evidenceValuesDigest(config, name)};
    const text = JSON.stringify(record); await writeFile(path.join(outputDirectory, `${name}.json`), text);
    config.evidence[name] = {path: `${name}.json`, digest: hash(text)};
  }
  return {config, start, deadline};
}
const records: unknown[] = [];
try {
  for (const kind of boundaries) {
    const {config, start, deadline} = await fixture(kind); let clock = start, calls = 0;
    const result = await api.run(config, {now: () => clock, executionKind: "offline-mock",
      env: {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"},
      fetcher: async (_url, init) => {
        calls++; const body = JSON.parse(String(init?.body));
        clock = deadline; // Expire before this first normal response returns; no global clock mutation or sleep.
        return new Response(JSON.stringify({model: "mock-model-revision", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, {type: "noul", noul: 0}])), usage: {input_tokens: 100, output_tokens: 100}}), {status: 200});
      }});
    assert.equal(calls, 1, "NO_SECOND_FETCH_AFTER_BOUND_EVIDENCE_EXPIRY");
    if (result.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected expiry raw record");
    assert.equal(result.stopReason, "BOUND_EVIDENCE_EXPIRED");
    assert.equal(result.validatedEvidenceDeadlineMs, deadline);
    assert.equal(result.requestsReserved, 1);
    assert.equal(result.ledger.entries[0]!.state, "unknown");
    assert.equal(result.ledger.entries[0]!.reservedUsd, 0.001);
    assert.equal(result.ledger.entries[0]!.actualCostUsd, null);
    records.push({kind, minimumDeadlineMs: deadline, mockFetches: calls, secondFetch: false, firstUnknownReservedUsd: 0.001, stopReason: result.stopReason});
  }
  // Model expiry during the awaited credential handoff, after reservation but before fetch.
  const {config, start, deadline} = await fixture("price", "-credential-gap");
  let clock = start, calls = 0;
  const environment = {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", get AGS_BOOTSTRAP_JEV_KEY() {clock = deadline; return "test-only-not-a-real-key";}};
  const gap = await api.run(config, {now: () => clock, env: environment, executionKind: "offline-mock", fetcher: async () => {calls++; throw new Error("Expired dispatch forbidden");}});
  assert.equal(calls, 0, "NO_FETCH_AFTER_CREDENTIAL_AWAIT_EXPIRY");
  if (gap.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected credential-gap record");
  assert.equal(gap.stopReason, "BOUND_EVIDENCE_EXPIRED");
  assert.equal(gap.ledger.entries[0]!.dispatchState, "not-started");
  records.push({kind: "credential-await-gap", mockFetches: 0, stopReason: gap.stopReason});
  console.log(JSON.stringify({status: "OFFLINE_EXPIRY_REGRESSION_PASS", actualApiCalls: 0, actualCredentialLookups: 0, globalClockChanged: false, realSleeps: 0, records}, null, 2));
} finally {
  const resolved = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), temporaryRoot); assert(path.basename(resolved).startsWith("ags-bootstrap-expiry-"));
  await rm(resolved, {recursive: true, force: true});
}
