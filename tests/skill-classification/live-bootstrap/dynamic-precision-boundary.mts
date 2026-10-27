import assert from "node:assert/strict";
import {mkdtemp, rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as api from "./bootstrap.mts";
import {bindMockAuthorityAndEvidence, readyEstimateMock} from "./prepared-fixture.mts";

import {adjacentPrices, expectedPico} from "./precision-current-oracle.mts";
import {independentWireRows} from "./independent-wire-oracle.mts";

const repo = path.resolve(process.argv[2] ?? "."), root = await mkdtemp(path.join(os.tmpdir(), "ags-current-precision-"));
try {
  const {config, prepared, measurements} = await readyEstimateMock(api, repo, root, "dynamic-current-precision");
  assert.equal(measurements.length, 21);
  const independent = await independentWireRows(repo, "dynamic-current-precision");
  assert.deepEqual(measurements, independent.map(({caseId,requestDigest,wireDigest,utf8Bytes}) => ({caseId,requestDigest,wireDigest,utf8Bytes})), "INDEPENDENT_PRECISION_WIRE");
  const maxBytes = Math.max(...independent.map(m => m.utf8Bytes));
  const [below, above] = adjacentPrices(maxBytes);
  assert(expectedPico(maxBytes, below) <= BigInt(Number.MAX_SAFE_INTEGER));
  assert(expectedPico(maxBytes, above) > BigInt(Number.MAX_SAFE_INTEGER));
  config.limits!.requests = 21;
  let envReads = 0, calls = 0;
  for (const [kind, price] of [["below", below], ["above", above]] as const) {
    config.prices!.inputUsdPer1k = price;
    const maxPico = expectedPico(maxBytes, price);
    const configuration = structuredClone(config.profile!.configuration);
    configuration.maximumCostUsd = Number(maxPico <= BigInt(Number.MAX_SAFE_INTEGER) ? maxPico : BigInt(Number.MAX_SAFE_INTEGER)) / 1e12;
    config.profile = prepared.api.evaluationConfig.createProviderEvaluationConfiguration(configuration, prepared.inventory, config.profile!.preparedAt);
    await bindMockAuthorityAndEvidence(api, config);
    const check = await api.preflight(config, await api.prepare(config));
    assert.equal(check.status, "BLOCKED", `${kind} original .15 budget`);
    if (check.status !== "BLOCKED") throw new Error("Expected blocked preflight");
    if (kind === "below") {
      assert(!check.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"));
      assert(check.blocked.includes("RUN_BUDGET_INSUFFICIENT"));
      assert.equal(check.requestReservations.length, 21);
      for (let i = 0; i < 21; i++) {
        const expected = expectedPico(independent[i]!.utf8Bytes, price);
        assert.equal(check.requestReservations[i]!.caseId, independent[i]!.caseId);
        assert.equal(check.requestReservations[i]!.reservedUsd, Number(expected) / 1e12);
      }
    } else assert(check.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"));
    const result = await api.run(config, {executionKind: "offline-mock", env: new Proxy({}, {get() {envReads++; throw new Error("UNEXPECTED_ENV");}}),
      fetcher: async () => {calls++; throw new Error("UNEXPECTED_FETCH");}});
    assert.equal(result.status, "BLOCKED");
  }
  assert.equal(envReads, 0); assert.equal(calls, 0);
  console.log(JSON.stringify({status: "DYNAMIC_PRECISION_PARTIAL_PASS", count: measurements.length, maxBytes,
    below: below.toString(), belowPico: expectedPico(maxBytes, below).toString(), above: above.toString(), abovePico: expectedPico(maxBytes, above).toString(), actualApiCalls: 0, actualCredentialLookups: 0}));
} finally {await rm(root, {recursive: true, force: true});}
