import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile, rm} from "node:fs/promises";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import type {BootstrapConfig} from "./bootstrap.mts";

type RunConfig = Extract<BootstrapConfig, {schemaVersion: "2.0.0"}>;
const repo = path.resolve(process.argv[2]!);
const helper = path.resolve(process.argv[3]!);
const api = await import(pathToFileURL(helper).href) as typeof import("./bootstrap.mts");
const hash = (bytes: string) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const env = {AGS_BOOTSTRAP_ENDPOINT: "https://mock.invalid/classify", AGS_BOOTSTRAP_JEV_KEY: "test-only-not-real"};
const response = (init: RequestInit | undefined, inputTokens: number | null = 100) => {
  const wire = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({model: "mock-revision", answers: Object.fromEntries(Object.keys(wire.questions).map(id => [id, {type: "noul", noul: 0}])),
    usage: {input_tokens: inputTokens, output_tokens: 100}}), {status: 200});
};
if (process.argv[4] === "worker") {
  const config = JSON.parse(await readFile(process.argv[5]!, "utf8")); let calls = 0;
  try {
    const result = await api.run(config, {executionKind: "offline-mock", env, fetcher: async (_url, init) => {calls++; return response(init);}});
    console.log(JSON.stringify({winner: result.status === "RAW_EVALUATION_RECORDED", calls}));
  } catch (error) {console.log(JSON.stringify({winner: false, calls, error: (error as NodeJS.ErrnoException).code ?? "RUN_REJECTED"}));}
} else {
  const root = await mkdtemp(path.join(os.tmpdir(), "ags-budget-regression-"));
  const checks: string[] = [];
  async function bind(config: RunConfig) {
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
      limits: {requests: 2, inputBytes: 1048576, inputTokens: 300000, outputTokens: 10000, responseBytes: 128000, timeoutMs: 1000, runUsd: 0.06},
      prices: estimate ? {billingMode: "token", inputUsdPer1k: 0.000042, outputUsdPer1k: 0, fixedCallMaxUsd: 0} : {billingMode: "fixed-per-call", inputUsdPer1k: 0, outputUsdPer1k: 0, fixedCallMaxUsd: 0.001},
      budget: {scope: "run", runId, totalAuthorizationUsd: 5, allocatedUsd: 0.06, allocationRef: "offline-mock-allocation", priorRunConfirmedSpendUsd: 0,
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
    const normal = await ready("unknown-account"); const prepared = await api.prepare(normal);
    const checked = await api.preflight(normal, prepared); assert.equal(checked.status, "READY_FOR_OPERATOR_DISPATCH");
    assert.equal(checked.billingGuarantee, "NOT_VERIFIED"); assert.deepEqual(checked.accountObservation, {balanceUsd: null, priorSpendUsd: null, unknownReservedUsd: null});
    let calls = 0;
    const normalResult = await api.run(normal, {env, executionKind: "offline-mock", fetcher: async (_url, init) => {
      calls++; const persisted = JSON.parse(await readFile(path.join(normal.outputDirectory, "ledger.json"), "utf8"));
      assert.equal(persisted.entries.length, calls); assert.equal(persisted.entries.at(-1).state, "reserved"); return response(init);
    }});
    assert.equal(normalResult.status, "RAW_EVALUATION_RECORDED"); if (normalResult.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected raw record");
    assert.equal(calls, 2); assert(normalResult.ledger.entries.every((row, index) => row.state === "unknown" && row.actualCostUsd === null && row.reservedUsd === checked.requestReservations[index]!.reservedUsd), "USAGE_ESTIMATE_MUST_NOT_CLEAR_UNKNOWN_RESERVATION");
    assert(Math.abs(normalResult.ledger.entries[0]!.estimatedCostUsd! - 0.0000042) < 1e-12);
    checks.push("run allocation allows unknown account; reservation persisted before mock fetch; usage estimate never clears unknown reservation");

    let forbiddenReads = 0, forbiddenCalls = 0;
    const forbiddenEnv = new Proxy({}, {get: () => {forbiddenReads++; throw new Error("Forbidden ENV lookup");}});
    for (const [id, change, code] of [
      ["wrong-run", (c: RunConfig) => {c.budget!.runId = "different-run";}, "RUN_ALLOCATION_UNVERIFIED"],
      ["wrong-scope", (c: RunConfig) => {Object.assign(c.budget!, {scope: "account"});}, "RUN_ALLOCATION_UNVERIFIED"],
      ["wrong-mode", (c: RunConfig) => {Object.assign(c, {reservationMode: "automatic"});}, "RESERVATION_MODE_INVALID"],
      ["wrong-estimator", (c: RunConfig) => {Object.assign(c.estimator!, {method: "unreviewed-byte-rate"});}, "ESTIMATE_PLAN_MISSING"],
      ["over-allocation", (c: RunConfig) => {c.budget!.allocatedUsd = 0.061;}, "RUN_ALLOCATION_UNVERIFIED"],
      ["prior-unknown", (c: RunConfig) => {c.budget!.priorRunUnknownReservedUsd = 0.059;}, "RUN_BUDGET_INSUFFICIENT"],
      ["uncovered-batch", (c: RunConfig) => {c.limits!.requests = 21;}, "RUN_BUDGET_INSUFFICIENT"],
      ["too-many", (c: RunConfig) => {c.limits!.requests = 22;}, "FINITE_LIMITS_MISSING"],
      ["allocation-six", (c: RunConfig) => {c.budget!.totalAuthorizationUsd = 6;}, "BUDGET_HARD_LIMIT_USD_5"],
      ["missing-review", (c: RunConfig) => {c.evidence.operatorAuthorization = null;}, "EVIDENCE_MISSING:operatorAuthorization"],
      ["input-unbound", (c: RunConfig) => {c.estimator!.inputArtifact.digest = hash("wrong");}, "ESTIMATE_SOURCE_OR_INPUT_UNBOUND"],
      ["source-unbound", (c: RunConfig) => {c.estimator!.sources[0]!.digest = hash("wrong source");}, "ESTIMATE_SOURCE_OR_INPUT_UNBOUND"],
    ] as const) {
      const config = await ready(id); change(config); if (id !== "missing-review") await bind(config);
      const result = await api.run(config, {env: forbiddenEnv, executionKind: "offline-mock", fetcher: async () => {forbiddenCalls++; throw new Error("Forbidden call");}});
      assert.equal(result.status, "BLOCKED"); assert(result.blocked.includes(code), `${id}:${code}`);
    }
    assert.equal(forbiddenReads, 0); assert.equal(forbiddenCalls, 0); checks.push("wrong run / >.06 / prior unknown / >USD5 / absent review / changed input artifact block before ENV and dispatch");

    for (const [id, fetcher, expected] of [
      ["auth", async () => new Response("", {status: 401}), "AUTH_UNAVAILABLE"],
      ["billing", async () => new Response("", {status: 402}), "BILLING_OR_BALANCE_UNAVAILABLE"],
      ["balance", async () => new Response("", {status: 402}), "BILLING_OR_BALANCE_UNAVAILABLE"],
      ["rate", async () => new Response("", {status: 429}), "RATE_LIMITED"],
      ["transport", async () => {throw new Error("offline transport");}, "TRANSPORT_UNAVAILABLE"],
      ["usage-unknown", async (_url: unknown, init: RequestInit | undefined) => response(init, null), "OBSERVED_CAP_VIOLATION"],
      ["predicted-overrun", async (_url: unknown, init: RequestInit | undefined) => response(init, 200000), "OBSERVED_CAP_VIOLATION"],
    ] as const) {
      const config = await ready(id); let attempts = 0, keyReads = 0;
      const fakeEnvironment = {AGS_BOOTSTRAP_ENDPOINT: env.AGS_BOOTSTRAP_ENDPOINT, get AGS_BOOTSTRAP_JEV_KEY() {keyReads++; return env.AGS_BOOTSTRAP_JEV_KEY;}};
      const result = await api.run(config, {env: fakeEnvironment, executionKind: "offline-mock", fetcher: async (url, init) => {attempts++; return fetcher(url, init);}});
      if (result.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected stopped record");
      assert.equal(attempts, 1); assert.equal(result.stopReason, expected); assert.equal(result.ledger.entries[0]!.state, "unknown");
      assert.equal(keyReads, 1, "NO_SECOND_CREDENTIAL_LOOKUP_AFTER_ERROR");
      assert.equal(result.ledger.entries[0]!.reservedUsd, result.requestReservations[0]!.reservedUsd);
      if (id === "predicted-overrun") assert(Math.abs(result.ledger.entries[0]!.estimatedCostUsd! - 0.0084) < 1e-12);
    }
    checks.push("auth/billing/balance/rate/transport/unknown usage/prediction overrun stop after one attempt and retain unknown reservation");

    const timeout = await ready("timeout-late"); timeout.limits!.timeoutMs = 10; await bind(timeout);
    let timeoutCalls = 0, release: ((value: Response) => void) | undefined, lateInit: RequestInit | undefined;
    const timeoutResult = await api.run(timeout, {env, executionKind: "offline-mock", fetcher: async (_url, init) => {
      timeoutCalls++; lateInit = init; return new Promise<Response>(resolve => {release = resolve;});
    }});
    if (timeoutResult.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected timeout record");
    assert.equal(timeoutCalls, 1); assert.equal(timeoutResult.stopReason, "DISPATCH_TIMEOUT_UNKNOWN");
    assert.equal(timeoutResult.ledger.entries[0]!.state, "unknown");
    const beforeLateResponse = await readFile(path.join(timeout.outputDirectory, "ledger.json"), "utf8");
    release!(response(lateInit)); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(await readFile(path.join(timeout.outputDirectory, "ledger.json"), "utf8"), beforeLateResponse);
    assert.equal(timeoutCalls, 1); checks.push("timeout then late successful response preserves unknown ledger, zero resend or late settlement");

    const expired = await ready("run-expiry"); let clock = Date.now(), expiryCalls = 0, credentialReads = 0;
    const expiry = Date.parse(expired.budget!.validUntil);
    const expiryResult = await api.run(expired, {executionKind: "offline-mock", now: () => clock,
      env: {AGS_BOOTSTRAP_ENDPOINT: env.AGS_BOOTSTRAP_ENDPOINT, get AGS_BOOTSTRAP_JEV_KEY() {credentialReads++; return env.AGS_BOOTSTRAP_JEV_KEY;}},
      fetcher: async (_url, init) => {expiryCalls++; clock = expiry; return response(init);}});
    if (expiryResult.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected expiry record");
    assert.equal(expiryCalls, 1); assert.equal(credentialReads, 1); assert.equal(expiryResult.stopReason, "BOUND_EVIDENCE_EXPIRED");
    checks.push("run evidence expiry keeps first unknown, second credential lookup and fetch zero");

    const claim = await ready("independent-claim", false); claim.limits!.requests = 1; await bind(claim);
    const configFile = path.join(root, "claim-config.json"); await writeFile(configFile, JSON.stringify(claim));
    const worker = () => new Promise<{winner: boolean; calls: number}>((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(import.meta.url), repo, helper, "worker", configFile], {cwd: repo, shell: false});
      let stdout = "", stderr = ""; child.stdout.on("data", chunk => {stdout += chunk;}); child.stderr.on("data", chunk => {stderr += chunk;});
      child.on("error", reject); child.on("close", exit => {if (exit !== 0) reject(new Error(`Worker ${exit}: ${stderr}`)); else resolve(JSON.parse(stdout));});
    });
    const claims = await Promise.all([worker(), worker()]); assert.equal(claims.filter(row => row.winner).length, 1); assert.equal(claims.reduce((sum, row) => sum + row.calls, 0), 1);
    checks.push("independent child processes compete for persistent wx claim: one winner, one mock fetch, no retry");
    console.log(JSON.stringify({status: "OFFLINE_RUN_BUDGET_PASS", checks, claimResults: claims, actualApiCalls: 0, actualCredentialLookups: 0, qualification: "NOT_RUN", linuxLive: "NOT_RUN"}, null, 2));
  } finally {
    const resolved = path.resolve(root); assert.equal(path.dirname(resolved), path.resolve(os.tmpdir())); assert(path.basename(resolved).startsWith("ags-budget-regression-"));
    await rm(resolved, {recursive: true, force: true});
  }
}
