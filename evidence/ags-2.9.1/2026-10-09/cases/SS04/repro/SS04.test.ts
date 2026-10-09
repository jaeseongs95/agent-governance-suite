import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from "vitest";
import {scoreCase, aggregate, oracleDigest, sameSet, type Observation} from "../skill-classification/evaluation.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {RuntimeSkillClassificationGateway, readClassificationRuntime} from "../../mcp-server/src/skill-classification/gateway.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {validateClassificationResponse} from "../../mcp-server/src/skill-classification/validation.js";
import {unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import type {ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// Only SS04 is executed. Mock recommendations are scorer inputs, never AGENT selections.
const root = process.cwd();
const corpus = JSON.parse(readFileSync(`${root}/tests/skill-classification/fixtures.json`, "utf8"));
const fixture = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS04");
const R = ["cs-engineering", "test-engineering", "orchestrator"];
const records: unknown[] = [];
const sha = (bytes: string | Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
let inventory: Awaited<ReturnType<typeof loadSkillInventory>>;
let networkAttempts = 0;
beforeAll(async () => {
  vi.stubGlobal("fetch", () => {networkAttempts++; throw new Error("SS04_NETWORK_FORBIDDEN");});
  inventory = await loadSkillInventory({root});
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  writeFileSync("SS04-output/isolated-observations.json", JSON.stringify({caseId: "SS04", executionKind: "offline-mock", networkAttempts, API0: true,
    originalPrompt: fixture.originalPrompt, sourceSpec: fixture.sourceSpec, oracle: fixture.oracle, frozenVariants: fixture.variants,
    actualHostObservation: {skillIds: null, hostReceipt: null, selected: "NOT_RUN", read: "NOT_RUN", applied: "NOT_RUN", verified: "NOT_RUN"}, records}, null, 2));
  vi.unstubAllGlobals();
});
function observation(skillIds: string[] | null, extra: Partial<Observation> = {}): Observation {
  return {caseId: "SS04", layer: "combined", state: "PASS", skillIds, selectionStatus: skillIds === null ? "NEEDS_INPUT" : "SELECTED",
    reasonCodes: [], selectionReasons: [], executionKind: "offline-mock", host: null, hostReceipt: null,
    requestDigest: "offline-ss04", inventoryDigest: "offline-inventory", conditionDigest: "offline-condition",
    stageEvidence: {read: false, applied: false, verified: false}, ...extra};
}
function request(suffix: string, context: Record<string, unknown> = {}, sources: {field: string; reference: string}[] = []) {
  return createClassificationRequest({requestId: `SS04-${suffix}`, operationId: `SS04-${suffix}`, originalPrompt: fixture.originalPrompt,
    inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md", confirmedContext: context, contextSources: sources as never});
}
const controls = [
  {id: "base-R", input: R, expected: "PASS"},
  {id: "base-R-plus-allowed-P", input: [...R, "ponytail"], expected: "PASS"},
  ...R.map(id => ({id: `omit-${id}`, input: R.filter(x => x !== id), expected: "FAIL"})),
  ...["code-review", "software-security-auditor", "korean-prose-editor"].map(id => ({id: `extra-${id}`, input: [...R, id], expected: "FAIL"})),
  {id: "unadjudicated-extra", input: [...R, "mutation-risk-preflight"], expected: "REVIEW_REQUIRED"},
  {id: "unknown-alias", input: [...R, "CS"], expected: "FAIL"},
  {id: "select-all", input: corpus.inventorySkillIds, expected: "FAIL"},
  {id: "abstain-unknown-db", input: null, expected: "FAIL"},
  {id: "empty-selection", input: [], expected: "FAIL"},
  {id: "not-run", input: null, expected: "NOT_RUN", extra: {state: "NOT_RUN"}},
  {id: "blocked", input: null, expected: "BLOCKED", extra: {state: "BLOCKED"}},
  {id: "selected-without-host-receipt", input: R, expected: "FAIL", extra: {layer: "selected"}},
] as const;
describe("SS04 base and isolated scorer boundaries", () => {
  it("binds fixed fixture, frozen oracle, all SS04 source references and embedded specification", () => {
    expect(sha(readFileSync(`${root}/tests/skill-classification/fixtures.json`))).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
    expect(oracleDigest(corpus)).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
    expect(fixture.variants).toEqual(["base"]); expect(fixture.oracle.required).toEqual(R);
    expect(fixture.oracle.allowed).toEqual(["ponytail"]); expect(fixture.oracle.allowedConditions).toEqual({});
    expect(fixture.sourceSpec.fields["금지추천 또는 행동"]).toContain("운영 DB 변경 승인");
    for (const ref of fixture.oracle.sourceRefs) expect(sha(readFileSync(`${root}/${ref.path}`))).toBe(ref.digest);
    records.push({id: "base-binding", input: fixture.originalPrompt, expected: {required: R, allowed: ["ponytail"], variants: ["base"]}, observed: fixture.oracle, status: "PASS"});
  });
  for (const control of controls) it(`scorer ${control.id}`, () => {
    const input = observation(control.input === null ? null : [...control.input], "extra" in control ? control.extra as Partial<Observation> : {});
    const observed = scoreCase(fixture, input, corpus.inventorySkillIds);
    records.push({id: control.id, parentVariant: "base", input, expected: control.expected, observed});
    expect(observed.verdict).toBe(control.expected);
  });
  it("keeps absent observation NOT_RUN and null distinct from empty", () => {
    expect(scoreCase(fixture, undefined, corpus.inventorySkillIds).verdict).toBe("NOT_RUN");
    expect(sameSet(null, [])).toBe(false);
    const observed = aggregate([fixture], [], "selected", corpus.inventorySkillIds);
    expect(observed.notRun).toBe(1); expect(observed.coverage).toBe(0);
    expect(observed.stageCoverage).toEqual({read: 0, applied: 0, verified: 0});
    records.push({id: "absent-host-observation", input: null, expected: "NOT_RUN", observed});
  });
});
describe("SS04 original prompt and discovery boundaries", () => {
  it("preserves exact prohibition, whole inventory and unknown context without source/oracle leakage", () => {
    expect(inventory.issues).toEqual([]); expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
    const req = request("base"); const projected = projectClassificationRequest(req);
    expect(projected.payload.originalPrompt).toBe(fixture.originalPrompt);
    expect(projected.payload.originalPrompt).toContain("Do not migrate the production database.");
    expect(Object.values(projected.payload.confirmedContext).every(v => v === null)).toBe(true);
    expect(projected.payload.skills).toHaveLength(corpus.inventorySkillIds.length);
    expect(projected.payload.skills.every(s => !("sourceRefs" in s) && !("sourceMap" in s))).toBe(true);
    expect(projected.payload).not.toHaveProperty("oracle"); expect(projected.payload).not.toHaveProperty("sourceSpec");
    records.push({id: "base-request-projection", input: req, expected: "exact original prompt, all inventory, unknown nulls, no oracle", observed: projected});
  });
  it("confirmed empty actions stay empty; unknown actions stay null", () => {
    const empty = projectClassificationRequest(request("empty-actions", {actions: []}, [{field: "actions", reference: "SS04 isolated confirmed-empty control"}])).payload;
    const unknown = projectClassificationRequest(request("unknown-actions")).payload;
    expect(empty.confirmedContext.actions).toEqual([]); expect(unknown.confirmedContext.actions).toBeNull();
    records.push({id: "context-null-vs-empty", expected: {empty: [], unknown: null}, observed: {empty: empty.confirmedContext.actions, unknown: unknown.confirmedContext.actions}});
  });
  it("rejects too-small input byte limit with no omitted ranges", () => {
    const req = request("size"); const full = projectClassificationRequest(req);
    let observed: unknown;
    try {projectClassificationRequest(req, full.payloadBytes - 1);} catch (e) {observed = {message: (e as Error).message, omittedRanges: (e as {omittedRanges: unknown}).omittedRanges};}
    records.push({id: "no-truncation", expected: {message: "INPUT_TOO_LONG", omittedRanges: []}, observed});
    expect(observed).toEqual({message: "INPUT_TOO_LONG", omittedRanges: []});
  });
  it("unconfigured gateway remains unavailable with selected null and zero provider calls", async () => {
    const runtime = await readClassificationRuntime(undefined, root);
    const service = new SkillClassificationService({providers: {}, budget: new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}})});
    const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => runtime});
    const req = request("unconfigured");
    const observed = await gateway.classify({schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId,
      originalPrompt: req.originalPrompt, confirmedContext: req.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [],
      vendorContext: {vendorId: "current-vendor-unobserved", reference: "offline-only"}, publicSynthetic: true});
    records.push({id: "unconfigured-gateway", expected: {error: "PROFILE_UNAVAILABLE", selected: null}, observed});
    expect(observed).toMatchObject({agentSelectedSkillIds: null, selectionStatus: "PROPOSED", result: {response: {status: "UNAVAILABLE", error: {code: "PROFILE_UNAVAILABLE"}}, attempts: []}});
    expect(networkAttempts).toBe(0);
  });
});
function mockService(suffix: string, selected = R) {
  const req = request(suffix);
  const profile: ProviderProfile = {profileId: "ss04-offline-vendor", providerKind: "vendor", vendorId: "offline-vendor", modelId: "mock-fixed", modelRevision: "mock-fixed", reasoningEffort: "low",
    supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "offline-fixture-route", qualificationRevision: "offline-q1",
    qualification: {status: "PASS", inventoryDigest: req.inventoryDigest, taxonomyRevision: req.taxonomyRevision, modelRevision: "mock-fixed", promptRevision: "offline-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "offline-a1", promptRevision: "offline-p1", maximumInputBytes: 1024 * 1024, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const evaluation = (r: SkillClassificationRequestV1) => ({response: {schemaVersion: "1.0.0" as const, requestId: r.requestId, operationId: r.operationId, requestDigest: r.requestDigest, inventoryDigest: r.inventoryDigest,
    status: "SUCCESS" as const, judgments: r.skills.map(s => ({skillId: s.skillId, judgment: selected.includes(s.skillId) ? "needed" as const : "not-needed" as const, reasonRefs: ["offline-controlled-response"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started" as const, diagnostics: null});
  const provider = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (r: SkillClassificationRequestV1) => evaluation(r))};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0, spentUsd: 0}, vendors: {"offline-vendor": {limitUsd: 2, spentUsd: 0}}});
  const input = {request: req, config: {jevEnabled: false, mode: "select" as const, providerProfileRegistryRef: "offline-fixture", externalClassificationAllowed: true, configRevision: "offline-c1", timeoutMs: 1000},
    registry: {schemaVersion: "1.0.0" as const, profileRevision: "offline-pr1", profiles: [profile]}, currentVendorId: "offline-vendor"};
  return {req, profile, evaluation, provider, budget, input, service: new SkillClassificationService({providers: {vendor: provider}, budget})};
}
describe("SS04 service controls with in-process provider only", () => {
  for (const P of [false, true]) it(`passes controlled R${P ? '+P' : ''} response without creating AGENT selection`, async () => {
    const f = mockService(`valid-${P}`, P ? [...R, "ponytail"] : R);
    const result = await f.service.classify(f.input);
    expect(validateClassificationResponse(f.req, result.response)).toEqual([]);
    const skillIds = result.response.judgments.filter(x => x.judgment === "needed").map(x => x.skillId);
    expect(scoreCase(fixture, observation(skillIds), corpus.inventorySkillIds).verdict).toBe("PASS");
    expect(f.provider.classify).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot().limits["vendor:offline-vendor"].spentUsd).toBe(0.1);
    records.push({id: `service-controlled-R${P ? '-plus-P' : ''}`, input: f.req.originalPrompt, expected: "valid response, not final selection", observed: result});
  });
  it("concurrent duplicate SS04 operation joins one provider invocation", async () => {
    const f = mockService("duplicate");
    const [a, b] = await Promise.all([f.service.classify(f.input), f.service.classify(f.input)]);
    expect(a).toEqual(b); expect(f.provider.classify).toHaveBeenCalledTimes(1);
    records.push({id: "duplicate-same-operation", expected: {mockProviderCalls: 1}, observed: {mockProviderCalls: f.provider.classify.mock.calls.length}});
  });
});
describe("SS04 known defect reproductions; red is retained", () => {
  it("retains valid known cost when SS04 RESP misses a candidate", async () => {
    const f = mockService("invalid-resp-valid-cost");
    f.provider.classify.mockImplementation(async r => {const e = f.evaluation(r); e.response.judgments = e.response.judgments.filter(j => j.skillId !== "cs-engineering"); return e;});
    const result = await f.service.classify(f.input); const ledger = f.budget.snapshot();
    records.push({id: "known-valid-cost-lost-with-invalid-RESP", input: {originalPrompt: f.req.originalPrompt, removedJudgment: "cs-engineering", providerActualCostUsd: 0.1},
      expected: {status: "INVALID", actualCostUsd: 0.1, spentUsd: 0.1}, observed: {result, ledger}, rootCause: "existing invalid RESP valid-cost-loss finding"});
    expect(result.response.status).toBe("INVALID");
    expect(result.attempts[0].usage.actualCostUsd, "valid known cost must survive response validation failure").toBe(0.1);
    expect(ledger.limits["vendor:offline-vendor"].spentUsd).toBe(0.1);
  });
  it("rechecks cancellation immediately after reservation before SS04 dispatch", async () => {
    const f = mockService("cancel-at-reservation");
    let cancelled = false; const reserve = f.budget.reserve.bind(f.budget);
    vi.spyOn(f.budget, "reserve").mockImplementation((...args) => {const ok = reserve(...args); cancelled = true; return ok;});
    const result = await f.service.classify({...f.input, getCurrentSnapshot: () => ({taskRevision: null, configRevision: f.input.config.configRevision, profileRevision: f.input.registry.profileRevision,
      inventoryDigest: f.req.inventoryDigest, requestDigest: f.req.requestDigest, cancelled})});
    records.push({id: "known-predispatch-recheck-gap", input: {originalPrompt: f.req.originalPrompt, cancellationBoundary: "during reserve, before classify"},
      expected: {mockProviderCalls: 0, error: "STALE_CLASSIFICATION"}, observed: {mockProviderCalls: f.provider.classify.mock.calls.length, result}, rootCause: "existing concurrency pre-dispatch recheck gap"});
    expect(result.response.error?.code).toBe("STALE_CLASSIFICATION");
    expect(f.provider.classify, "cancellation at reservation must prevent provider dispatch").toHaveBeenCalledTimes(0);
  });
});
