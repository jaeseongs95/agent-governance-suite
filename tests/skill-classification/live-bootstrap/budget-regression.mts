import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp, mkdir, readFile, writeFile, rm, cp} from "node:fs/promises";
import {spawn} from "node:child_process";
import os from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
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
type ReservationRow = {caseId: string; reservedUsd: number};

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
  // UNAPPLIED proposal: independent ROOT r2 synthetic wire oracle SHA is fixed; integration/execution still requires approval.
  // It must come from reviewed wire bytes/order/price, never from preflight requestReservations.
  const oracleBytes = await readFile(path.join(import.meta.dirname, "budget-wire-oracle.json"));
  assert.equal(hash(oracleBytes.toString("utf8")), "sha256:f6ea158f65473b5aa08846196bbb54a02ca5db7fffaed39d0ba25c2f61148b56");
  const oracle = JSON.parse(oracleBytes.toString("utf8")) as BudgetWireOracle;
  assert.equal(oracle.schemaVersion, "1.0.0"); assert.equal(oracle.canonicalRunId, "full-21-015");
  assert.equal(oracle.rows.length, 21); assert.equal(new Set(oracle.rows.map((row: OracleRow) => row.caseId)).size, 21);
  assert.equal(typeof oracle.modelId, "string"); // ROOT r2 oracle explicit model binding; r1 has no model field.
  assert.equal(oracle.prices.currency, "USD");
  assert.deepEqual([oracle.prices.inputUsdPer1000Tokens, oracle.prices.outputUsdPer1000Tokens, oracle.prices.fixedCallUsd,
    oracle.prices.assumedInputTokensPerUtf8Byte, oracle.prices.usdPerByteNumerator, oracle.prices.usdPerByteDenominator], ["0.000042", "0", "0", "1", "42", "1000000000"]);
  const frozenPrices = {billingMode: "token", inputUsdPer1k: Number(oracle.prices.inputUsdPer1000Tokens), outputUsdPer1k: Number(oracle.prices.outputUsdPer1000Tokens), fixedCallMaxUsd: Number(oracle.prices.fixedCallUsd)};
  const frozenWireRows = oracle.rows.map(({caseId, wireDigest, utf8Bytes}: Pick<OracleRow, "caseId" | "wireDigest" | "utf8Bytes">) => ({caseId, wireDigest, utf8Bytes}));
  const assertFrozenReservations = (actualRows: readonly ReservationRow[], expectedRows: readonly Pick<OracleRow, "caseId" | "reservedPicoUsd">[] = oracle.rows) => {
    assert.equal(actualRows.length, expectedRows.length);
    let validatedExpectedPicoSum = 0n;
    for (let index = 0; index < expectedRows.length; index++) {
      const expected = expectedRows[index]!, actual = actualRows[index]!, pico = BigInt(expected.reservedPicoUsd);
      assert(pico >= 0n && pico <= BigInt(Number.MAX_SAFE_INTEGER), "Expected picoUSD must be exactly representable before Number conversion");
      assert.equal(actual.caseId, expected.caseId);
      assert.equal(actual.reservedUsd, Number(pico) / 1e12, "INDEPENDENT_EXACT_FROZEN_REQUEST_RESERVATION");
      validatedExpectedPicoSum += pico;
    }
    assert(validatedExpectedPicoSum <= BigInt(Number.MAX_SAFE_INTEGER)); return validatedExpectedPicoSum;
  };
  // Independent exact rational: USD .000042/1000 = 42000 picoUSD per byte.
  const frozenFullUsd = Number(oracle.rows.reduce((sum: bigint, row: OracleRow) => {
    assert(Number.isSafeInteger(row.utf8Bytes) && row.utf8Bytes > 0); return sum + BigInt(row.utf8Bytes) * 42000n;
  }, 0n)) / 1e12;
  const historicalUnknownUsd = 0.1204098, historicalPilotUnknownUsd = 0.005734722;
  const historicalBatchPriorUsd = 0.03, historicalConfirmedBaseUsd = 0.08;
  const syntheticConfirmedUsd = (historicalId: string, capUsd: number, unknownUsd: number) => {
    const row = oracle.syntheticOverBudgetCases.find(item => item.historicalId === historicalId);
    assert(row); assert.equal(row.id, `${historicalId}-current-oracle`);
    assert.equal(Number(row.capUsd), capUsd); assert.equal(Number(row.unchangedUnknownUsd), unknownUsd);
    assert.equal(Number(row.historicalConfirmedUsd), historicalId === "confirmed-plus-unknown" ? historicalConfirmedBaseUsd : 0);
    const fixed = Number(row.proposedSyntheticConfirmedUsd); assert(Number.isFinite(fixed) && fixed >= Number(row.historicalConfirmedUsd));
    return fixed; // Exact reviewed decimal input, no binary-float boundary subtraction.
  };
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
    const normal = await ready("unknown-account"); const prepared = await api.prepare(normal);
    const checked = await api.preflight(normal, prepared); assert.equal(checked.status, "READY_FOR_OPERATOR_DISPATCH", "R11_RUN_ALLOCATION_015_ACCEPTED");
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

    const full = await ready("full-21-015"); full.limits!.requests = 21; await bind(full);
    const fullChecked = await api.preflight(full, await api.prepare(full)); assert.equal(fullChecked.status, "READY_FOR_OPERATOR_DISPATCH");
    const fullValidatedPico = assertFrozenReservations(fullChecked.requestReservations);
    // A mutated reservation return must be rejected by the independent checker, not mislabeled as helper BLOCKED.
    const corruptReservations = structuredClone(fullChecked.requestReservations); corruptReservations[0]!.reservedUsd += 0.5e-12;
    assert.throws(() => assertFrozenReservations(corruptReservations), {code: "ERR_ASSERTION"});
    const fullReservation = Number(fullValidatedPico) / 1e12;
    assert.equal(fullReservation, frozenFullUsd, "FULL_21_FROZEN_SYNTHETIC_WIRE_RESERVATION");
    let fullCalls = 0;
    const fullResult = await api.run(full, {env, executionKind: "offline-mock", fetcher: async (_url, init) => {fullCalls++; return response(init);}});
    if (fullResult.status !== "RAW_EVALUATION_RECORDED") throw new Error("Expected full mocked run");
    assert.equal(fullCalls, 21); assert.equal(fullResult.transportAttempts, 21); assert.equal(fullResult.qualificationStatus, "NOT_RUN");
    assert.equal(fullResult.selectedReadAppliedVerified, "NOT_RUN");
    assert(fullResult.ledger.entries.every(entry => entry.state === "unknown" && entry.actualCostUsd === null));
    const fullLedgerPico = assertFrozenReservations(fullResult.ledger.entries.map((entry, index) => {
      assert.equal(entry.requestDigest, oracle.rows[index]!.requestDigest, "Full canonical run ledger binding");
      return {caseId: oracle.rows[index]!.caseId, reservedUsd: entry.reservedUsd};
    }));
    assert.equal(fullLedgerPico, fullValidatedPico);
    const aggregate = await ready("pilot-plus-21"); aggregate.limits!.requests = 21; aggregate.budget!.priorRunUnknownReservedUsd = historicalPilotUnknownUsd; await bind(aggregate);
    const aggregateChecked = await api.preflight(aggregate, await api.prepare(aggregate));
    assert.equal(aggregateChecked.status, "READY_FOR_OPERATOR_DISPATCH");
    const aggregatePico = assertFrozenReservations(aggregateChecked.requestReservations), preservedPilotPico = 5734722000n;
    assert.equal(aggregate.budget!.priorRunUnknownReservedUsd, Number(preservedPilotPico) / 1e12);
    assert.equal(aggregatePico, fullValidatedPico);
    const pilotPlusFull = Number(preservedPilotPico + aggregatePico) / 1e12;
    assert(pilotPlusFull <= 0.15); assert.equal(aggregate.budget!.accountBalanceUsd, null);
    checks.push(".15 allocation admits frozen synthetic full21; historical pilot unknown is preserved; historical .1204098/.126144522 and original FAIL remain in frozen Git/evidence");

    let forbiddenReads = 0, forbiddenCalls = 0;
    const forbiddenEnv = new Proxy({}, {get: () => {forbiddenReads++; assert.fail("R11_NO_ENV_LOOKUP_BEFORE_BOUNDARY_BLOCK");}});
    for (const [id, change, code] of [
      ["wrong-run", (c: RunConfig) => {c.budget!.runId = "different-run";}, "RUN_ALLOCATION_UNVERIFIED"],
      ["wrong-scope", (c: RunConfig) => {Object.assign(c.budget!, {scope: "account"});}, "RUN_ALLOCATION_UNVERIFIED"],
      ["wrong-mode", (c: RunConfig) => {Object.assign(c, {reservationMode: "automatic"});}, "RESERVATION_MODE_INVALID"],
      ["wrong-estimator", (c: RunConfig) => {Object.assign(c.estimator!, {method: "unreviewed-byte-rate"});}, "ESTIMATE_PLAN_MISSING"],
      ["over-allocation", (c: RunConfig) => {c.budget!.allocatedUsd = 0.151;}, "RUN_ALLOCATION_UNVERIFIED"],
      ["run-exceeds-allocation", (c: RunConfig) => {c.limits!.runUsd = 0.151;}, "RUN_ALLOCATION_UNVERIFIED"],
      ["prior-unknown", (c: RunConfig) => {c.budget!.priorRunUnknownReservedUsd = 0.149;}, "RUN_BUDGET_INSUFFICIENT"],
      ["confirmed-plus-unknown-current-oracle", (c: RunConfig) => {c.budget!.priorRunUnknownReservedUsd = 0.06; c.budget!.priorRunConfirmedSpendUsd = syntheticConfirmedUsd("confirmed-plus-unknown", 0.15, 0.06);}, "RUN_BUDGET_INSUFFICIENT"],
      // New synthetic inputs: original unknown/pilot and caps unchanged; add confirmed spend so total exceeds allocation by 1000 picoUSD (>1 picoUSD tolerance).
      ["uncovered-batch-current-oracle", (c: RunConfig) => {c.limits!.requests = 21; c.budget!.priorRunUnknownReservedUsd = historicalBatchPriorUsd; c.budget!.priorRunConfirmedSpendUsd = syntheticConfirmedUsd("uncovered-batch", 0.15, historicalBatchPriorUsd);}, "RUN_BUDGET_INSUFFICIENT"],
      ["pilot-plus-full-121-current-oracle", (c: RunConfig) => {c.limits!.requests = 21; c.budget!.allocatedUsd = 0.121; c.limits!.runUsd = 0.121; c.budget!.priorRunUnknownReservedUsd = historicalPilotUnknownUsd; c.budget!.priorRunConfirmedSpendUsd = syntheticConfirmedUsd("pilot-plus-full-121", 0.121, historicalPilotUnknownUsd);}, "RUN_BUDGET_INSUFFICIENT"],
      ["historical-full-unknown-plus-current", (c: RunConfig) => {c.limits!.requests = 21; c.budget!.priorRunUnknownReservedUsd = historicalUnknownUsd;}, "RUN_BUDGET_INSUFFICIENT"],
      ["changed-price-old-evidence", (c: RunConfig) => {c.prices!.inputUsdPer1k = 0.000084;}, "EVIDENCE_UNBOUND:price"],
      ["changed-reservation-cap", (c: RunConfig) => {c.profile!.maximumCostUsd = Number(c.profile!.maximumCostUsd) / 2; (c.profile!.qualification as Record<string, unknown>).profileConfigurationDigest = prepared.api.profiles.digestProviderProfileConfiguration(c.profile);}, "PROFILE_COST_BOUND_MISMATCH"],
      ["old-lower-allocation", (c: RunConfig) => {c.limits!.requests = 21; c.budget!.allocatedUsd = 0.06; c.limits!.runUsd = 0.06;}, "RUN_BUDGET_INSUFFICIENT"],
      ["too-many", (c: RunConfig) => {c.limits!.requests = 22;}, "FINITE_LIMITS_MISSING"],
      ["allocation-six", (c: RunConfig) => {c.budget!.totalAuthorizationUsd = 6;}, "BUDGET_HARD_LIMIT_USD_5"],
      ["missing-review", (c: RunConfig) => {c.evidence.operatorAuthorization = null;}, "EVIDENCE_MISSING:operatorAuthorization"],
      ["input-unbound", (c: RunConfig) => {c.estimator!.inputArtifact.digest = hash("wrong");}, "ESTIMATE_SOURCE_OR_INPUT_UNBOUND"],
      ["source-unbound", (c: RunConfig) => {c.estimator!.sources[0]!.digest = hash("wrong source");}, "ESTIMATE_SOURCE_OR_INPUT_UNBOUND"],
    ] as const) {
      const config = await ready(id); change(config); if (id !== "missing-review" && id !== "changed-price-old-evidence") await bind(config);
      const result = await api.run(config, {env: forbiddenEnv, executionKind: "offline-mock", fetcher: async () => {forbiddenCalls++; throw new Error("Forbidden call");}});
      await writeFile(path.join(config.outputDirectory, "blocked-return.json"), JSON.stringify(result, null, 2) + "\n", {flag: "wx"});
      assert.equal(result.status, "BLOCKED", `R11_BOUNDARY_BLOCKED:${id}`); assert(result.blocked.includes(code), `${id}:${code}`);
      if (id === "changed-price-old-evidence") assert(result.blocked.includes("EVIDENCE_UNBOUND:operatorAuthorization"));
    }
    assert.equal(forbiddenReads, 0); assert.equal(forbiddenCalls, 0); checks.push("wrong run / >.15 / prior unknown / insufficient .06 / >USD5 / absent review / changed input artifact block before ENV and dispatch");
    // Rebind byte hashes/operator evidence so each fault exercises exact semantic input binding, not merely a stale file hash.
    for (const mode of ["byte-length", "same-length-wire-digest", "case-missing", "case-duplicate", "case-order", "invented-reservation-field"] as const) {
      const config = await ready(`input-${mode}`);
      const file = path.join(config.outputDirectory, "inputs.json"), artifact = JSON.parse(await readFile(file, "utf8"));
      if (mode === "byte-length") artifact.measurements[0].utf8Bytes++;
      if (mode === "same-length-wire-digest") {
        const actual = await api.prepare(config);
        const actualWire = JSON.stringify(actual.api.providers.jevNoulWireAdapter.encode(actual.requests[0].request, config.profile));
        const differentWire = actualWire.replace('"model":"mock-model"', '"model":"fake-model"');
        assert.notEqual(differentWire, actualWire); assert.equal(Buffer.byteLength(differentWire), Buffer.byteLength(actualWire));
        artifact.measurements[0].wireDigest = hash(differentWire); // Profile and actual prepared wire remain unchanged.
      }
      if (mode === "case-missing") artifact.measurements.pop();
      if (mode === "case-duplicate") artifact.measurements[1] = structuredClone(artifact.measurements[0]);
      if (mode === "case-order") [artifact.measurements[0], artifact.measurements[1]] = [artifact.measurements[1], artifact.measurements[0]];
      if (mode === "invented-reservation-field") artifact.measurements[0].reservedUsd = 0;
      const changed = JSON.stringify(artifact); await writeFile(file, changed); config.estimator!.inputArtifact.digest = hash(changed); await bind(config);
      const result = await api.run(config, {env: forbiddenEnv, executionKind: "offline-mock", fetcher: async () => {forbiddenCalls++; throw new Error("Forbidden call");}});
      await writeFile(path.join(config.outputDirectory, "blocked-return.json"), JSON.stringify(result, null, 2) + "\n", {flag: "wx"});
      assert.equal(result.status, "BLOCKED"); assert(result.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"), mode);
    }
    assert.equal(forbiddenReads, 0); assert.equal(forbiddenCalls, 0);
    checks.push("rebound input artifacts still reject length/content/digest/case omission/duplicate/order/invented reservation before ENV or fetch");

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
}
