import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {prepare, preflight, run, evidenceValuesDigest, type BootstrapConfig} from "./bootstrap.mts";

const repo = path.resolve(process.argv[2]!);
assert(process.argv[2], "Usage: contract-selfcheck.mts REPO");
const root = await mkdtemp(path.join(os.tmpdir(), "ags-bootstrap-contract-"));
const hash = (data: string) => `sha256:${createHash("sha256").update(data).digest("hex")}`;
type LegacyConfig = Extract<BootstrapConfig, {schemaVersion: "1.0.0"}>;
const config = (runId: string): LegacyConfig => ({schemaVersion: "1.0.0", runId, repo, outputDirectory: path.join(root, runId),
  endpointEnv: "AGS_BOOTSTRAP_ENDPOINT", credentialEnv: "AGS_BOOTSTRAP_JEV_KEY", approvedEndpointDigest: null, approvedRouteRef: null, approvalRef: null,
  profile: null, limits: null, prices: null, budget: null,
  evidence: {route: null, price: null, priorLedger: null, remaining: null, hardTokenCaps: null, operatorAuthorization: null}});
async function mockedEvidence(value: BootstrapConfig) {
  await mkdir(value.outputDirectory, {recursive: true});
  for (const kind of Object.keys(value.evidence) as (keyof BootstrapConfig["evidence"])[]) {
    if (kind === "hardTokenCaps" && value.prices?.billingMode === "fixed-per-call") continue;
    const record = {schemaVersion: "1.0.0", kind, verifiedBy: "offline-contract-fixture-only", sourceRef: "synthetic-not-real-approval-or-price",
      validUntil: new Date(Date.now() + 60000).toISOString(), valuesDigest: evidenceValuesDigest(value, kind)};
    const bytes = JSON.stringify(record); const relative = `${kind}.json`;
    await writeFile(path.join(value.outputDirectory, relative), bytes);
    value.evidence[kind] = {path: relative, digest: hash(bytes)};
  }
}
async function readyMock(runId: string, timeoutMs = 1000) {
  const value = config(runId); const initial = await prepare(value);
  value.approvedEndpointDigest = hash("https://mock.invalid/classify"); value.approvedRouteRef = "mock-only"; value.approvalRef = "offline-test-not-approval";
  value.limits = {requests: 21, inputBytes: 1024 * 1024, inputTokens: 100000, outputTokens: 10000, responseBytes: 128000, timeoutMs, runUsd: 1};
  value.prices = {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001};
  value.budget = {totalLimitUsd: 1, verifiedPriorSpendUsd: 0, priorUnknownReservedUsd: 0, currentRemainingUsd: 1,
    observedAt: new Date(Date.now() - 1000).toISOString(), validUntil: new Date(Date.now() + 60000).toISOString()};
  value.profile = {profileId: "mock-profile", providerKind: "jev", vendorId: "mock-vendor", modelId: "mock-model", modelRevision: "mock-model-revision",
    reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: value.approvedRouteRef,
    qualificationRevision: "mock-not-qualified", qualification: {status: "NOT_RUN", inventoryDigest: initial.inventory.inventoryDigest,
      taxonomyRevision: initial.inventory.taxonomyRevision, modelRevision: "mock-model-revision", promptRevision: "mock-question-v1",
      validUntil: new Date(Date.now() + 60000).toISOString(), profileConfigurationDigest: ""}, adapterRevision: "mock-adapter-v1", promptRevision: "mock-question-v1",
    maximumInputBytes: value.limits.inputBytes, maximumOutputTokens: value.limits.outputTokens, maximumCostUsd: 0.001, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
  (value.profile.qualification as Record<string, unknown>).profileConfigurationDigest = initial.api.profiles.digestProviderProfileConfiguration(value.profile);
  await mockedEvidence(value);
  return value;
}
const passed: string[] = [];
try {
  const absent = config("missing-evidence"); const prepared = await prepare(absent);
  assert.equal(prepared.requests.length, 21); assert.equal(prepared.cases.filter((row: any) => row.oracle !== null).length, 18);
  assert.equal(new Set(prepared.requests.map((row: any) => row.request.operationId)).size, 21);
  for (const row of prepared.requests) {
    assert.equal(row.request.classificationCriteriaRef, "skills/orchestrator/references/skill-classification.md");
    assert.equal(row.request.originalPrompt, prepared.cases.find((item: any) => item.caseId === row.caseId).originalPrompt);
    assert.equal(row.request.skills.length, prepared.inventory.skills.length);
    assert.deepEqual(Object.keys(row).sort(), ["caseId", "request"]);
    assert(!Object.hasOwn(row.request, "oracle"));
  }
  let environmentReads = 0, actualCalls = 0;
  const env = new Proxy({}, {get: () => {environmentReads++; throw new Error("Forbidden credential lookup");}});
  const blocked = await run(absent, {env, fetcher: async () => {actualCalls++; throw new Error("Forbidden call");}, executionKind: "offline-mock"});
  assert.equal(blocked.status, "BLOCKED"); assert.equal(environmentReads, 0); assert.equal(actualCalls, 0);
  assert(blocked.blocked.includes("CURRENT_LEDGER_OR_REMAINING_UNVERIFIED")); passed.push("missing evidence blocks before environment/transport access");

  const value = await readyMock("all-public-fixtures");
  const input = await prepare(value); assert.equal((await preflight(value, input)).status, "READY_FOR_OPERATOR_DISPATCH");
  let calls = 0;
  const fetcher: typeof fetch = async (_url, init) => {
    calls++; const body = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
    assert.equal(Object.keys(body.questions).length, input.inventory.skills.length);
    assert(!Object.hasOwn(body.state, "oracle")); assert(!Object.hasOwn(body.state, "familyId"));
    assert(Object.values(body.questions).every((row: any) => !Object.hasOwn(row.instructions.skill, "sourceRefs")));
    assert(input.cases.some((row: any) => row.originalPrompt === body.state.originalPrompt));
    return new Response(JSON.stringify({model: "mock-model-revision", answers: Object.fromEntries(Object.keys(body.questions).map((id, index) => [id, {type: "noul", noul: index === 0 ? 0.9 : index === 1 ? 0.5 : 0}])), usage: {input_tokens: 100, output_tokens: 100}}), {status: 200});
  };
  const result = await run(value, {fetcher, env: {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"}, executionKind: "offline-mock"});
  if (result.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected mocked raw evaluation");
  assert.equal(calls, 21); assert.equal(result.transportAttempts, 21); assert.equal(result.qualificationStatus, "NOT_RUN");
  assert.equal(result.selectedReadAppliedVerified, "NOT_RUN"); assert.notEqual(result.raw.verdict, "PASS");
  assert.equal(result.observationRevision, "2.0.0"); assert.equal(result.observations.length, 21);
  for (const observation of result.observations as any[]) {
    const record = JSON.parse(await readFile(path.join(value.outputDirectory, `${observation.caseId}.raw.json`), "utf8"));
    assert.equal(observation.kind, "classification");
    assert.deepEqual(observation.classificationResponse, record.response, "R14_PRODUCER_FULL_RESPONSE_PRESERVED");
    assert.equal(observation.classificationResponse.status, "PARTIAL");
    assert.equal(observation.classificationResponse.judgments.filter((row: any) => row.judgment === "needed").length, 1);
    assert.equal(observation.classificationResponse.unresolvedItems.length, 1);
    assert(!Object.hasOwn(observation, "selectionStatus") && !Object.hasOwn(observation, "agentSelectedSkillIds") && !Object.hasOwn(observation, "hostReceipt"), "R14_RAW_IS_NOT_SELECTION");
  }
  assert(result.ledger.entries.every((entry: any) => entry.state === "unknown" && entry.actualCostUsd === null && entry.reservedUsd === 0.001), "LEGACY_UNKNOWN_RESERVATION_PRESERVED");
  const text = await readFile(path.join(value.outputDirectory, "report.json"), "utf8"); assert(!text.includes("test-only-not-a-real-key"));
  await assert.rejects(() => run(value, {fetcher, executionKind: "offline-mock"})); assert.equal(calls, 21);
  passed.push("21 one-attempt public wires, no labels/secret logging, unknown cost reservations retained, no synthetic qualification PASS or duplicate run");

  const outputPriced = await readyMock("priced-output");
  outputPriced.prices = {billingMode: "token", inputUsdPer1k: 0, outputUsdPer1k: 0.0001, fixedCallMaxUsd: 0};
  outputPriced.evidence.hardTokenCaps = null;
  const outputBlocked = await preflight(outputPriced, await prepare(outputPriced));
  assert(outputBlocked.blocked.includes("OUTPUT_CAP_UNVERIFIED"));
  passed.push("priced output without verified route-side token cap blocks; verified fixed-call upper bound needs no output billing cap");
  const inputOnly = await readyMock("input-only-price");
  inputOnly.prices = {billingMode: "token", inputUsdPer1k: 0.00001, outputUsdPer1k: 0, fixedCallMaxUsd: 0};
  await mockedEvidence(inputOnly);
  assert.equal((await preflight(inputOnly, await prepare(inputOnly))).status, "READY_FOR_OPERATOR_DISPATCH");
  inputOnly.evidence.hardTokenCaps = null;
  assert((await preflight(inputOnly, await prepare(inputOnly))).blocked.includes("INPUT_BILLING_CAP_UNVERIFIED"));
  passed.push("verified input-only price accepts without output billing cap and blocks when input billing cap is absent");

  for (const [id, change, expected] of [
    ["total-six", (value: LegacyConfig) => {value.budget!.totalLimitUsd = 6;}, "BUDGET_HARD_LIMIT_USD_5"],
    ["run-six", (value: BootstrapConfig) => {value.limits!.runUsd = 6;}, "BUDGET_HARD_LIMIT_USD_5"],
    ["prior-reserve-over", (value: LegacyConfig) => {value.budget = {...value.budget!, totalLimitUsd: 5, verifiedPriorSpendUsd: 3, priorUnknownReservedUsd: 2, currentRemainingUsd: 1};}, "CURRENT_LEDGER_OR_REMAINING_UNVERIFIED"],
  ] as const) {
    const excess = await readyMock(id); change(excess); await mockedEvidence(excess);
    const refused = await run(excess, {env, fetcher: async () => {actualCalls++; throw new Error("Forbidden call");}, executionKind: "offline-mock"});
    assert.equal(refused.status, "BLOCKED"); assert(refused.blocked.includes(expected));
  }
  assert.equal(environmentReads, 0); assert.equal(actualCalls, 0);
  passed.push("USD5 includes prior spend and unknown reservations; total6/run6/oversubscribed prior ledger block before env/dispatch");

  const timed = await readyMock("timeout-no-resend", 10); let timeoutCalls = 0;
  const timeoutResult = await run(timed, {fetcher: async () => {timeoutCalls++; return new Promise<Response>(() => {});},
    env: {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"}, executionKind: "offline-mock"});
  if (timeoutResult.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected mocked timeout record");
  assert.equal(timeoutCalls, 1); assert.equal(timeoutResult.transportAttempts, 1);
  assert.equal(timeoutResult.ledger.entries[0].state, "unknown"); assert.equal(timeoutResult.ledger.entries[0].reservedUsd, 0.001);
  assert.equal(timeoutResult.raw.executed, 1); passed.push("timeout stops after one attempt and holds unknown reservation");
  assert.equal(timeoutResult.observations[0].classificationResponse, null);
  assert.equal(timeoutResult.observations[0].producerDiagnostics.errorCode, "DISPATCH_TIMEOUT_UNKNOWN");
  let observationFaultCalls = 0;
  for (const [id, response, expected] of [["r14-malformed", new Response("{}", {status: 200}), "INVALID_PROVIDER_RESPONSE"],
    ["r14-http-error", new Response("{}", {status: 503}), "API_UNAVAILABLE"]] as const) {
    const fault = await readyMock(id);
    const failed = await run(fault, {fetcher: async () => {observationFaultCalls++; return response;},
      env: {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"}, executionKind: "offline-mock"});
    if (failed.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected observation fault record");
    assert.equal(failed.transportAttempts, 1); assert.equal(failed.stopReason, expected);
    assert.equal(failed.observations[0].classificationResponse, null);
    assert.equal(failed.observations[0].producerDiagnostics.errorCode, expected, "R14_PRODUCER_ABSENT_DIAGNOSTIC_PRESERVED");
    assert.equal(failed.observations[0].producerDiagnostics.dispatchState, "started");
  }
  const validFailure = await readyMock("r14-valid-common-error");
  validFailure.limits!.requests = 1; await mockedEvidence(validFailure);
  const adapter = input.api.providers.jevNoulWireAdapter;
  const originalDecode = adapter.decode;
  try {
    // Private protocol fixture only; the shared production adapter is restored even on assertion failure.
    adapter.decode = (...args: Parameters<typeof originalDecode>) => {
      const decoded = originalDecode(...args);
      return {...decoded, response: {...decoded.response, status: "UNAVAILABLE", judgments: [], unresolvedItems: [],
        error: {code: "MOCK_COMMON_UNAVAILABLE", retryable: true, dispatchState: "unknown"}}};
    };
    const failure = await run(validFailure, {fetcher: async (_url, init) => {
      observationFaultCalls++; const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({model: "mock-model-revision", answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, {type: "noul", noul: 0}])),
        usage: {input_tokens: 100, output_tokens: 100}}), {status: 200});
    }, env: {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-a-real-key"}, executionKind: "offline-mock"});
    if (failure.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected valid common error observation");
    const raw = JSON.parse(await readFile(path.join(validFailure.outputDirectory, `${failure.observations[0].caseId}.raw.json`), "utf8"));
    assert.deepEqual(failure.observations[0].classificationResponse, raw.response, "R14_PRODUCER_VALID_ERROR_RESPONSE_PRESERVED");
    const preserved = failure.observations[0].classificationResponse;
    assert(preserved !== null && preserved.error !== null);
    assert.equal(preserved.error.dispatchState, "unknown");
    assert.equal(preserved.judgments.length, 0);
    assert.equal(failure.observations[0].state, "BLOCKED"); assert.equal(failure.raw.blocked, 1);
    assert.equal(failure.transportAttempts, 1); assert.equal(failure.ledger.entries[0].state, "unknown");
  } finally {adapter.decode = originalDecode;}
  passed.push("R14 actual producer preserves full PARTIAL/common error binding and absent/malformed/timeout diagnostics without selection claims");
  console.log(JSON.stringify({status: "OFFLINE_CONTRACT_PASS", proofKind: "offline-mock", actualApiCalls: 0, actualCredentialLookups: 0,
    mockTransportCalls: calls + timeoutCalls, mockObservationFaultCalls: observationFaultCalls, publicPrompts: prepared.requests.length, scoredSemanticCases: 18, checks: passed, profileQualification: "NOT_RUN", hostLive: "NOT_RUN"}, null, 2));
} finally {
  const resolved = path.resolve(root), temporaryRoot = path.resolve(os.tmpdir());
  assert.equal(path.dirname(resolved), temporaryRoot, "Recursive cleanup must remain in the designated OS temp directory");
  assert(path.basename(resolved).startsWith("ags-bootstrap-contract-") && resolved !== temporaryRoot, "Cleanup target must be the owned test directory");
  await rm(resolved, {recursive: true, force: true});
}
