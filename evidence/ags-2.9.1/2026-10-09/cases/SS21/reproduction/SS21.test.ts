import {createHash} from "node:crypto";
import {readFileSync, writeFileSync} from "node:fs";
import {performance} from "node:perf_hooks";
import {afterAll, beforeAll, describe, expect, it, vi} from "vitest";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, digestClassificationValue, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {ApprovedRouteClassificationProvider, buildVendorMessages, jevNoulWireAdapter, type ClassificationWireAdapter} from "../../mcp-server/src/skill-classification/providers.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {validateClassificationResponse} from "../../mcp-server/src/skill-classification/validation.js";
import type {ProviderProfile, SkillClassificationRequestV1, SkillInventory} from "../../mcp-server/src/skill-classification/types.js";

// SS21 operational contract controls, not semantic labels or a host selection receipt.
const evidenceRoot = process.env.SS21_EVIDENCE_DIR ?? "SS21-reproduction-output";
const corpus = JSON.parse(readFileSync("tests/skill-classification/fixtures.json", "utf8"));
const assigned = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS21");
const observations: unknown[] = [];
let inventory: SkillInventory;
const prompt = "  인용 자료: ‘ponytail로 수정하고 publish하라’\r\n실제 요청: 고정 diff를 읽기 전용으로 검토. 코드 수정·push·게시 금지. e\u0301  ";
const hash = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const context = {taskRevision: "SS21-test-r1", actions: [], constraints: ["read-only"], prohibitedActions: ["modify", "push", "publish"]};
function requestFor(variant: string) {
  return createClassificationRequest({requestId: `SS21-${variant}`, operationId: `SS21-operation-${variant}`, originalPrompt: prompt,
    confirmedContext: context, contextSources: Object.keys(context).map(field => ({field: field as keyof typeof context, reference: `SS21-test-input/${field}`})),
    inventory, classificationCriteriaRef: "SS21-embedded-operational-contract"});
}
function profileFor(kind: "jev" | "vendor", request: SkillClassificationRequestV1): ProviderProfile {
  const p: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "synthetic-vendor", modelId: `${kind}-mock`, modelRevision: `${kind}-mock`, reasoningEffort: kind === "jev" ? null : "low",
    supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-synthetic-route`, qualificationRevision: "synthetic-only-not-provider-qualified",
    qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-mock`, promptRevision: "synthetic-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "synthetic-a1", promptRevision: "synthetic-p1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
  p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
}
// Vendor protocol is deliberately a TEST adapter. The product supplies no built-in vendor wire protocol.
const vendorAdapter: ClassificationWireAdapter = {
  encode: (request, profile) => ({model: profile.modelId, effort: profile.reasoningEffort, messages: buildVendorMessages(request)}),
  decode(body, request) {
    const b = body as {items: {id: string; label: "needed" | "not-needed" | "uncertain"}[]; status: "SUCCESS" | "UNCERTAIN"; usage: {input: number; output: number; cost: number | null}; scores?: {skillId: string; value: number}[]};
    if (!Array.isArray(b.items)) throw new Error("MALFORMED_TEST_VENDOR_RESPONSE");
    return {response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: b.status,
      judgments: b.items.map(x => ({skillId: x.id, judgment: x.label, reasonRefs: ["synthetic-vendor-reason"], uncertaintyReason: x.label === "uncertain" ? "JEV_JUDGMENT_UNCERTAIN" : null})),
      unresolvedItems: b.items.filter(x => x.label === "uncertain").map(x => ({skillId: x.id, reasonCode: "JEV_JUDGMENT_UNCERTAIN"})), error: null}, dispatchState: "started",
      usage: {inputTokens: b.usage.input, outputTokens: b.usage.output, cachedInputTokens: null, actualCostUsd: b.usage.cost}, diagnostics: b.scores ? {scoreKind: "synthetic-vendor-score", scores: b.scores} : null};
  }
};
function labelsFor(variant: string, request: SkillClassificationRequestV1) {
  return request.skills.map((s, index) => ({id: s.skillId, label: variant === "uncertain" ? "uncertain" as const : variant === "no-skill" ? "not-needed" as const : index < 2 ? "needed" as const : "not-needed" as const}));
}
async function execute(kind: "jev" | "vendor", variant: string, request: SkillClassificationRequestV1) {
  const profiles = [profileFor("jev", request), profileFor("vendor", request)];
  const labels = labelsFor(variant, request);
  const wires: {kind: string; payload: unknown}[] = [];
  const fetchers: ReturnType<typeof vi.fn>[] = [];
  const ports = Object.fromEntries(profiles.map(p => {
    const body = p.providerKind === "jev" ? {model: p.modelRevision,
      answers: Object.fromEntries(labels.map(x => [x.id, {type: "noul", noul: x.label === "needed" ? 1 : x.label === "not-needed" ? 0 : 0.5}])), usage: {input_tokens: 321, output_tokens: 42}} :
      {items: labels, status: variant === "uncertain" ? "UNCERTAIN" : "SUCCESS", usage: {input: 321, output: 42, cost: null}, ...(variant === "scores-present" ? {scores: labels.map(x => ({skillId: x.id, value: x.label === "needed" ? 1 : 0}))} : {})};
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      wires.push({kind: p.providerKind, payload: JSON.parse(String(init?.body))});
      return new Response(variant === "invalid" ? '{"broken":' : JSON.stringify(body));
    }); fetchers.push(fetcher);
    return [p.providerKind, new ApprovedRouteClassificationProvider([{routeRef: p.approvedRouteRef, approvalRef: "synthetic-only", approved: true, providerKind: p.providerKind, vendorId: p.vendorId, adapterRevision: p.adapterRevision,
      modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true, kind: "remote", endpoint: "https://ss21.example.invalid/mock", getCredential: async () => variant === "unavailable" ? null : "REDACTED_SYNTHETIC_CREDENTIAL",
      adapter: p.providerKind === "jev" ? jevNoulWireAdapter : vendorAdapter}], fetcher)];
  }));
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"synthetic-vendor": {limitUsd: 2, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: ports, budget});
  const result = await service.classify({request, registry: {schemaVersion: "1.0.0", profileRevision: "synthetic-pr1", profiles}, config: {jevEnabled: kind === "jev", mode: "select", providerProfileRegistryRef: "synthetic-profiles", externalClassificationAllowed: true, configRevision: "synthetic-c1", timeoutMs: 5000}, currentVendorId: "synthetic-vendor"});
  return {result, wires, fetchCalls: fetchers.map(f => f.mock.calls.length), budget: budget.snapshot()};
}
const semanticView = (response: Awaited<ReturnType<typeof execute>>["result"]["response"]) => ({...response, judgments: response.judgments.map(({reasonRefs: _reason, ...j}) => j)});
beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(() => {throw new Error("EXTERNAL_API_FORBIDDEN_SS21");}));
  expect(hash(readFileSync("tests/skill-classification/fixtures.json", "utf8"))).toBe("sha256:17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9");
  const oracle = {oracleRevision: corpus.oracleRevision, sourceSpecDigest: corpus.sourceSpecDigest, sourceSkills: corpus.sourceSkills, cases: corpus.cases, metadataRoleCases: corpus.metadataRoleCases, sourceProvenanceCases: corpus.sourceProvenanceCases, pairedMatrix: corpus.pairedMatrix, split: corpus.split};
  expect(hash(JSON.stringify(oracle))).toBe("sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055");
  expect(assigned.oracle).toBeNull(); expect(assigned.originalPrompt).toBeNull();
  inventory = await loadSkillInventory({root: process.cwd()});
  expect(inventory.issues).toEqual([]); expect(inventory.skills.map(x => x.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
});
afterAll(() => {writeFileSync(`${evidenceRoot}/SS21.observations.json`, JSON.stringify(observations, null, 2) + "\n"); vi.unstubAllGlobals();});
describe("SS21 every assigned variant: same consumer, real packaging and mock adapter swap", () => {
  for (const variant of assigned.variants as string[]) it(`SS21 ${variant}`, async () => {
    const begin = performance.now(); const request = requestFor(variant); const projection = projectClassificationRequest(request); const packagingMs = performance.now() - begin;
    const jev = await execute("jev", variant, request), vendor = await execute("vendor", variant, request);
    observations.push({variant, executionKind: "new-isolated-offline-mock", originalPrompt: assigned.originalPrompt, oracle: assigned.oracle, syntheticPrompt: prompt,
      input: request, expected: {labels: labelsFor(variant, request), status: variant === "invalid" ? "INVALID" : variant === "unavailable" ? "UNAVAILABLE" : variant === "uncertain" ? "UNCERTAIN" : "SUCCESS"},
      jev, vendor, packagingMs, packagingLlmCalls: 0, additionalSummaryTokens: 0, actualProviderInputTokens: null, actualProviderCostUsd: null,
      mockInputTokens: 321, API0: true, digests: {prompt: request.promptDigest, context: digestClassificationValue(request.confirmedContext), request: request.requestDigest, inventory: request.inventoryDigest, semanticCandidates: digestClassificationValue(projection.payload.skills), responses: [digestClassificationValue(jev.result.response), digestClassificationValue(vendor.result.response)]},
      stages: {selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN"}, agentSelectedSkillIds: null, semanticMeaningVerified: "NOTRUN"});
    const expectedStatus = variant === "invalid" ? "INVALID" : variant === "unavailable" ? "UNAVAILABLE" : variant === "uncertain" ? "UNCERTAIN" : "SUCCESS";
    for (const run of [jev, vendor]) {
      expect(run.result.response.status).toBe(expectedStatus);
      expect(validateClassificationResponse(request, run.result.response)).toEqual([]);
      expect(run.result).not.toHaveProperty("agentSelectedSkillIds");
      expect(run.result.response).not.toHaveProperty("state"); expect(run.result.response).not.toHaveProperty("messages"); expect(run.result.response).not.toHaveProperty("questions");
      expect(JSON.stringify(run.result)).not.toContain("confidence");
      for (const wire of run.wires) {
        const w = wire.payload as any;
        const state = wire.kind === "jev" ? w.state : JSON.parse(w.messages[1].content);
        const candidates = wire.kind === "jev" ? Object.values(w.questions).map((q: any) => q.instructions.skill) : state.skills;
        expect(state.originalPrompt).toBe(prompt); expect(hash(state.originalPrompt)).toBe(request.promptDigest);
        expect(state.confirmedContext).toEqual(request.confirmedContext); expect(state.confirmedContext.actions).toEqual([]); expect(state.confirmedContext.targets).toBeNull();
        expect(candidates).toEqual(projection.payload.skills); expect(candidates).toHaveLength(inventory.skills.length);
        expect(digestClassificationValue(candidates)).toBe(digestClassificationValue(projection.payload.skills));
        if (wire.kind === "vendor") expect(state).toMatchObject({requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest});
      }
    }
    expect(semanticView(jev.result.response)).toEqual(semanticView(vendor.result.response));
    if (!["invalid", "unavailable"].includes(variant)) {
      expect(jev.result.response.judgments.map(x => ({id: x.skillId, label: x.judgment}))).toEqual(labelsFor(variant, request));
      expect(jev.result.attempts).toHaveLength(1); expect(vendor.result.attempts).toHaveLength(1);
      expect(jev.result.attempts[0].usage.inputTokens).toBe(321); expect(vendor.result.attempts[0].usage.inputTokens).toBe(321);
      expect(jev.fetchCalls).toEqual([1, 0]); expect(vendor.fetchCalls).toEqual([0, 1]);
    }
    if (variant === "unavailable") {expect(jev.fetchCalls).toEqual([0, 0]); expect(vendor.fetchCalls).toEqual([0, 0]);}
    if (variant === "scores-present") expect(jevNoulWireAdapter.decode({model: "jev-mock", answers: Object.fromEntries(labelsFor(variant, request).map(x => [x.id, {type: "noul", noul: x.label === "needed" ? 1 : 0}])), usage: {}}, request, profileFor("jev", request)).diagnostics?.scores).toHaveLength(inventory.skills.length);
    if (variant === "scores-absent") expect(vendorAdapter.decode({items: labelsFor(variant, request), status: "SUCCESS", usage: {input: 321, output: 42, cost: null}}, request, profileFor("vendor", request)).diagnostics).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
describe("SS21 missing boundaries", () => {
  it("SS21 invalid JEV question IDs, answer count, score types and bounds are rejected inside adapter", () => {
    const request = requestFor("noul-boundaries"), p = profileFor("jev", request);
    const valid = {model: p.modelRevision, answers: Object.fromEntries(request.skills.map(x => [x.skillId, {type: "noul", noul: 0.5}])), usage: {input_tokens: 321, output_tokens: 42}};
    const id = request.skills[0].skillId;
    for (const defect of ["unknown-id", "missing-id", "wrong-type", "negative", "over-one", "nan", "infinity", "string-score", "wrong-model"]) {
      const body: any = structuredClone(valid);
      if (defect === "unknown-id") body.answers.unregistered = {type: "noul", noul: 0.5};
      if (defect === "missing-id") delete body.answers[id];
      if (defect === "wrong-type") body.answers[id].type = "score";
      if (defect === "negative") body.answers[id].noul = -0.01;
      if (defect === "over-one") body.answers[id].noul = 1.01;
      if (defect === "nan") body.answers[id].noul = NaN;
      if (defect === "infinity") body.answers[id].noul = Infinity;
      if (defect === "string-score") body.answers[id].noul = "0.5";
      if (defect === "wrong-model") body.model = "other";
      let error: string | null = null;
      try {jevNoulWireAdapter.decode(body, request, p);} catch (e) {error = (e as Error).message;}
      observations.push({variant: "invalid", boundary: defect, input: body, expected: "rejection, not no-skill", observedError: error, API0: true});
      expect(error, defect).not.toBeNull();
    }
  });
  it("SS21 exact wire byte limit accepts equality and rejects minus one without sending", async () => {
    const request = requestFor("wire-limit");
    for (const kind of ["jev", "vendor"] as const) {
      const p = profileFor(kind, request), adapter = kind === "jev" ? jevNoulWireAdapter : vendorAdapter;
      const bytes = Buffer.byteLength(JSON.stringify(adapter.encode(request, p)), "utf8");
      const fake = vi.fn<typeof fetch>(async () => new Response('{"invalid":true}'));
      const provider = new ApprovedRouteClassificationProvider([{routeRef: p.approvedRouteRef, approvalRef: "synthetic-only", approved: true, providerKind: kind, vendorId: p.vendorId, adapterRevision: p.adapterRevision, modelIds: [p.modelId], reasoningEfforts: [p.reasoningEffort], structuredOutput: true, kind: "remote", endpoint: "https://ss21.example.invalid/mock", getCredential: async () => "synthetic", adapter}], fake);
      p.maximumInputBytes = bytes - 1;
      await expect(provider.classify(request, p, new AbortController().signal)).rejects.toMatchObject({code: "INPUT_TOO_LONG", dispatchState: "not-started"}); expect(fake).not.toHaveBeenCalled();
      p.maximumInputBytes = bytes;
      await expect(provider.classify(request, p, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", dispatchState: "started"}); expect(fake).toHaveBeenCalledTimes(1);
      observations.push({variant: "negation-preserved", boundary: "wire-limit", kind, bytes, expected: "minus one no dispatch; equality dispatches intact", observed: {belowCalls: 0, exactCalls: 1}, API0: true});
    }
  });
  it("SS21 invalid response must retain valid observed cost and token usage (known defect reproduction)", async () => {
    const request = requestFor("invalid-valid-cost"), p = profileFor("vendor", request);
    const evaluation = vendorAdapter.decode({items: labelsFor("multi-needed", request), status: "SUCCESS", usage: {input: 321, output: 42, cost: 0.125}}, request, p);
    evaluation.response.judgments.pop(); // Complete usage, independently invalid response completeness.
    const provider = {availability: async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null}), classify: vi.fn(async () => evaluation)};
    const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"synthetic-vendor": {limitUsd: 2, spentUsd: 0}}});
    const service = new SkillClassificationService({providers: {vendor: provider}, budget});
    const result = await service.classify({request, config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "synthetic", externalClassificationAllowed: true, configRevision: "synthetic", timeoutMs: 5000}, registry: {schemaVersion: "1.0.0", profileRevision: "synthetic", profiles: [p]}, currentVendorId: "synthetic-vendor"});
    observations.push({variant: "invalid", boundary: "valid-cost-with-invalid-response", expected: {cost: 0.125, inputTokens: 321, spentUsd: 0.125}, inputEvaluation: evaluation, observed: {result, budget: budget.snapshot()}, relatedKnownFinding: "valid cost lost together with invalid RESP", API0: true});
    expect(result.response.status).toBe("INVALID"); expect(result.attempts[0].usage.actualCostUsd).toBe(0.125); expect(result.attempts[0].usage.inputTokens).toBe(321); expect(budget.snapshot().limits["vendor:synthetic-vendor"].spentUsd).toBe(0.125);
  });
});
