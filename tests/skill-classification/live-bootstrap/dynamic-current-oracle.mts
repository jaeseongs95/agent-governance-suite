import assert from "node:assert/strict";
import {mkdtemp, readFile, readdir, rm} from "node:fs/promises";
import {createHash} from "node:crypto";
import path from "node:path";
import os from "node:os";
import * as api from "./bootstrap.mts";
import {readyEstimateMock, bindMockAuthorityAndEvidence, mockEnv, mockResponse} from "./prepared-fixture.mts";
import {independentWireRows} from "./independent-wire-oracle.mts";

type Provider = {capabilities:string[]; phase:string; phaseOrder:number; requiredInputArtifacts:string[]; producedArtifacts:string[]; inputBindings:unknown; gate:unknown; preconditions?:string[]};
type Entry = {skillId:string; enabled:boolean; providers:Provider[]};
type SourceSpan = {path:string; digest:string; startLine:number; endLine:number; startByte?:number; endByte?:number};

// Independent exact oracle for the frozen synthetic rate: .000042 USD/1000 = 42000 picoUSD/byte.
function expectedPico(bytes: number): bigint {
  assert(Number.isSafeInteger(bytes) && bytes > 0);
  return BigInt(bytes) * 42000n;
}
function validateReservations(expected: {caseId: string; pico: bigint}[], actual: {caseId: string; reservedUsd: number}[]) {
  assert.equal(actual.length, expected.length);
  for (let i = 0; i < expected.length; i++) {
    assert(expected[i]!.pico <= BigInt(Number.MAX_SAFE_INTEGER));
    assert.equal(actual[i]!.caseId, expected[i]!.caseId);
    assert.equal(actual[i]!.reservedUsd, Number(expected[i]!.pico) / 1e12, "INDEPENDENT_RESERVATION_PRICE");
  }
}
const repo = path.resolve(process.argv[2] ?? ".");
const root = await mkdtemp(path.join(os.tmpdir(), "ags-dynamic-oracle-"));
try {
  const {config, prepared, measurements} = await readyEstimateMock(api, repo, root, "dynamic-current-inventory");
  const dirs = (await readdir(path.join(repo, "skills"), {withFileTypes: true})).filter(d => d.isDirectory()).map(d => d.name).sort();
  const inventoryIds = prepared.inventory.skills.map(s => s.skillId).sort();
  assert.deepEqual(inventoryIds, dirs, "INVENTORY_SOURCE_MEMBERSHIP");
  assert.equal(new Set(inventoryIds).size, inventoryIds.length);
  // Read source metadata independently of the product inventory/request projection.
  const registry = JSON.parse(await readFile(path.join(repo, "skills/registry.json"), "utf8"));
  const registryById = new Map<string, Entry>(registry.skills.map((skill: Entry) => [skill.skillId, skill]));
  const sourceMetadata = new Map(await Promise.all(dirs.map(async id => [id, JSON.parse(await readFile(path.join(repo, "skills", id, "classification.json"), "utf8"))] as const)));
  // Independently resolve cited source spans and registry projections, not the product inventory.
  async function spans(values: SourceSpan[]) {
    const out: string[] = [];
    for (const span of values) {
      const bytes = await readFile(path.join(repo, span.path));
      assert.equal(`sha256:${createHash("sha256").update(bytes).digest("hex")}`, span.digest);
      const selected = Buffer.from(bytes.toString("utf8").split(/\r?\n/).slice(span.startLine - 1, span.endLine).join("\n"));
      const value = (span.startByte === undefined ? selected : selected.subarray(span.startByte, span.endByte)).toString("utf8").trim();
      if (!out.includes(value)) out.push(value);
    }
    return out;
  }
  const sourceProjection = new Map(await Promise.all(dirs.map(async id => {
    const meta = sourceMetadata.get(id)!; const entry = registryById.get(id);
    const applicability = await spans(meta.applicability), exclusions = await spans(meta.exclusions);
    for (const provider of entry?.providers ?? []) for (const precondition of provider.preconditions ?? []) {
      const value = JSON.stringify({phase: provider.phase, capabilities: provider.capabilities, precondition});
      if (!applicability.includes(value)) applicability.push(value);
    }
    return [id, {applicability, exclusions, enabled: entry?.enabled ?? true,
      capabilities: entry ? [...new Set(entry.providers.flatMap((provider: Provider) => provider.capabilities))] : meta.capabilities,
      phases: entry?.providers.flatMap((provider: Provider) => provider.capabilities.map((capability: string) => ({capability, phase: provider.phase, phaseOrder: provider.phaseOrder, requiredInputArtifacts: provider.requiredInputArtifacts, producedArtifacts: provider.producedArtifacts, inputBindings: provider.inputBindings, gate: provider.gate}))) ?? []}] as const;
  })));
  assert.equal(measurements.length, 21);
  const independent = await independentWireRows(repo, "dynamic-current-inventory");
  assert.equal(prepared.inventory.inventoryDigest, independent[0]!.inventoryDigest, "INDEPENDENT_INVENTORY_DIGEST");
  const expected = prepared.requests.map(({caseId, request}, index) => {
    const wire = prepared.api.providers.jevNoulWireAdapter.encode(request, config.profile!.configuration) as {questions: Record<string, {instructions: {skill: Record<string, unknown>}}>};
    assert.deepEqual(Object.keys(wire.questions).sort(), dirs, "WIRE_SOURCE_MEMBERSHIP");
    for (const skill of request.skills) {
      const expectedSkill = structuredClone(skill);
      Reflect.deleteProperty(expectedSkill, "sourceRefs"); Reflect.deleteProperty(expectedSkill, "sourceMap");
      assert.deepEqual(wire.questions[skill.skillId]!.instructions.skill, expectedSkill, "WIRE_SKILL_SEMANTICS");
      const actual = wire.questions[skill.skillId]!.instructions.skill;
      const metadata = sourceMetadata.get(skill.skillId)!;
      for (const field of ["actions", "targets", "constraints", "dependencies"] as const) assert.deepEqual(actual[field], metadata[field], `WIRE_SOURCE_${field}:${skill.skillId}`);
      const projection = sourceProjection.get(skill.skillId)!;
      for (const field of ["applicability", "exclusions", "enabled", "capabilities", "phases"] as const) assert.deepEqual(actual[field], projection[field], `WIRE_SOURCE_${field}:${skill.skillId}`);
    }
    const gold = independent[index]!;
    assert.equal(caseId, gold.caseId, "INDEPENDENT_CASE_ORDER");
    assert.equal(request.requestDigest, gold.requestDigest, "INDEPENDENT_REQUEST_DIGEST");
    assert.equal(`sha256:${createHash("sha256").update(JSON.stringify(wire)).digest("hex")}`, gold.wireDigest, "INDEPENDENT_WIRE_DIGEST");
    assert.equal(Buffer.byteLength(JSON.stringify(wire)), gold.utf8Bytes, "INDEPENDENT_WIRE_LENGTH");
    return {caseId, pico: expectedPico(gold.utf8Bytes)};
  });
  config.limits!.requests = 21;
  await bindMockAuthorityAndEvidence(api, config);
  const checked = await api.preflight(config, await api.prepare(config));
  const total = expected.reduce((sum, row) => sum + row.pico, 0n);
  validateReservations(expected, checked.requestReservations);
  const wrong = structuredClone(checked.requestReservations); wrong[0]!.reservedUsd += 0.5;
  assert.throws(() => validateReservations(expected, wrong));
  if (total <= 150000000000n) {
    assert.equal(checked.status, "READY_FOR_OPERATOR_DISPATCH");
    let dispatched = 0, mismatch = false;
    const run = await api.run(config, {executionKind:"offline-mock", env:mockEnv, fetcher:async (_url, init) => {
      const gold = independent[dispatched++]; const body = typeof init?.body === "string" ? init.body : "";
      if (!gold || Buffer.byteLength(body) !== gold.utf8Bytes || `sha256:${createHash("sha256").update(body).digest("hex")}` !== gold.wireDigest) mismatch = true;
      return mockResponse(init);
    }});
    assert.equal(mismatch, false, "INDEPENDENT_DISPATCH_WIRE");
    assert.equal(run.status, "RAW_EVALUATION_RECORDED", "INDEPENDENT_DISPATCH_RUN");
    assert.equal(dispatched, independent.length, "INDEPENDENT_DISPATCH_COUNT");
  } else {
    assert.equal(checked.status, "BLOCKED");
    assert(checked.blocked.includes("RUN_BUDGET_INSUFFICIENT"));
  }
  const allocated = config.budget!.allocatedUsd, runLimit = config.limits!.runUsd;
  config.budget!.allocatedUsd = 0.000001; config.limits!.runUsd = 0.000001;
  await bindMockAuthorityAndEvidence(api, config);
  let budgetCalls = 0, budgetEnvReads = 0;
  const budgetBlocked = await api.run(config, {executionKind: "offline-mock", env: new Proxy({}, {get() {budgetEnvReads++; throw new Error("UNEXPECTED_ENV_READ");}}),
    fetcher: async () => {budgetCalls++; throw new Error("UNEXPECTED_FETCH");}});
  assert.equal(budgetBlocked.status, "BLOCKED");
  if (budgetBlocked.status !== "BLOCKED") throw new Error("Expected blocked insufficient budget");
  assert(budgetBlocked.blocked.includes("RUN_BUDGET_INSUFFICIENT"));
  assert.equal(budgetCalls, 0); assert.equal(budgetEnvReads, 0);
  config.budget!.allocatedUsd = allocated; config.limits!.runUsd = runLimit;
  config.estimator!.inputArtifact.digest = "sha256:" + "0".repeat(64);
  await bindMockAuthorityAndEvidence(api, config);
  let calls = 0, envReads = 0;
  const blocked = await api.run(config, {executionKind: "offline-mock", env: new Proxy({}, {get() {envReads++; throw new Error("UNEXPECTED_ENV_READ");}}),
    fetcher: async () => {calls++; throw new Error("UNEXPECTED_FETCH");}});
  assert.equal(blocked.status, "BLOCKED");
  if (blocked.status !== "BLOCKED") throw new Error("Expected blocked stale estimate");
  assert(blocked.blocked.includes("ESTIMATE_SOURCE_OR_INPUT_UNBOUND"));
  assert.equal(calls, 0); assert.equal(envReads, 0);
  console.log(JSON.stringify({status: "DYNAMIC_CURRENT_ORACLE_PARTIAL_PASS", cases: expected.length, inventory: dirs.length, sumPico: total.toString(), actualApiCalls: 0, actualCredentialLookups: 0}));
} finally {await rm(root, {recursive: true, force: true});}
