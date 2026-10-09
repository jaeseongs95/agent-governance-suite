import {describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ClassificationUsage, ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// Public service regression: only provider transport is mocked. No real API or host.
let sequence = 0;
function fixture() {
  const id = `service-usage-regression-${++sequence}`;
  const inventory = {skills: [{skillId: "review", version: "1", description: "read-only review", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"b".repeat(64)}`, taxonomyRevision: "usage-regression"};
  const request = (suffix: string) => createClassificationRequest({requestId: `${id}-request-${suffix}`, operationId: `${id}-operation-${suffix}`, originalPrompt: "검토만 하라. 수정 금지.", inventory, classificationCriteriaRef: "usage-regression-criteria"});
  const first = request("first");
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const p: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low", supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-approved`, qualificationRevision: "synthetic-usage-q1", qualification: {status: "PASS", inventoryDigest: first.inventoryDigest, taxonomyRevision: first.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "usage-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "usage-a1", promptRevision: "usage-p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    p.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(p); return p;
  };
  const input: ClassificationServiceInput = {request: first, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "usage-regression-profiles", externalClassificationAllowed: true, configRevision: "usage-c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "usage-pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const evaluation = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["mock-only"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async req => evaluation(req))});
  const jev = provider(), vendor = provider();
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 0.8, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {jev, vendor}, budget, now: () => Date.UTC(2026, 9, 9)});
  return {input, request, evaluation, jev, vendor, budget, service};
}

function malformedResponse(f: ReturnType<typeof fixture>, cost: number) {
  vi.mocked(f.jev.classify).mockImplementation(async req => {
    const evaluation = f.evaluation(req); evaluation.response.judgments = []; evaluation.usage.actualCostUsd = cost; return evaluation;
  });
}

describe("independent actual cost survives classification validation failures", () => {
  it("USAGE01 malformed RESP settles valid known cost instead of retaining a maximum reservation", async () => {
    const f = fixture(); malformedResponse(f, 0.1); const result = await f.service.classify(f.input);
    expect(result.attempts[0]).toMatchObject({errorCode: "INVALID_PROVIDER_RESPONSE", usage: {actualCostUsd: 0.1}});
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1); expect(f.budget.snapshot().reservations).toEqual([]);
    expect(result.response.status).toBe("SUCCESS"); // The independently billed vendor fallback.
  });
  it("USAGE02 malformed RESP known overrun invalidates ceiling and blocks next dispatch", async () => {
    const f = fixture(); malformedResponse(f, 0.7); const first = await f.service.classify(f.input);
    expect(first.attempts[0]?.errorCode).toBe("INVALID_PROVIDER_RESPONSE");
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.7); expect(f.budget.snapshot().invalidCostCeilings).toEqual(["jev"]);
    const next = await f.service.classify({...f.input, request: f.request("next")});
    expect(next.attempts[0]?.errorCode).toBe("BUDGET_UNAVAILABLE"); expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  const invalidTokens: {name: string; usage: Partial<ClassificationUsage>}[] = [
    {name: "nonfinite input tokens", usage: {inputTokens: NaN}},
    {name: "negative output tokens", usage: {outputTokens: -1}},
    {name: "unsafe integer cached tokens", usage: {cachedInputTokens: Number.MAX_SAFE_INTEGER + 1}},
    {name: "cached tokens exceed input", usage: {inputTokens: 1, cachedInputTokens: 2}},
  ];
  it.each(invalidTokens)("USAGE03 $name still settles independently valid actualCostUsd", async ({usage}) => {
    const f = fixture(); vi.mocked(f.jev.classify).mockImplementation(async req => ({...f.evaluation(req), usage: {...unknownUsage(), ...usage, actualCostUsd: 0.1}}));
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({errorCode: "INVALID_PROVIDER_USAGE", usage: {actualCostUsd: 0.1}});
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  it("USAGE04 invalid diagnostics still settles independently valid actualCostUsd", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockImplementation(async req => ({...f.evaluation(req), diagnostics: {scoreKind: "mock", scores: [{skillId: "review", value: NaN}]}}));
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({errorCode: "INVALID_PROVIDER_USAGE", usage: {actualCostUsd: 0.1}});
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  it.each([null, NaN, -0.1, Infinity])("USAGE05 unknown or invalid dispatched actualCostUsd=%s retains conservative reservation", async cost => {
    const f = fixture(); vi.mocked(f.jev.classify).mockImplementation(async req => ({...f.evaluation(req), usage: {...unknownUsage(), actualCostUsd: cost}}));
    const result = await f.service.classify(f.input); const attempt = result.attempts[0]!;
    expect(attempt.usage.actualCostUsd).toBeNull(); expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0);
    expect(f.budget.snapshot().reservations).toMatchObject([{bucket: "jev", maximumUsd: 0.4}]);
    expect(attempt.errorCode).toBe(cost === null ? null : "INVALID_PROVIDER_USAGE");
    expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  it("USAGE06 valid RESP known cost ceiling mismatch settles and blocks next dispatch", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockImplementation(async req => ({...f.evaluation(req), usage: {...unknownUsage(), actualCostUsd: 0.7}}));
    const first = await f.service.classify(f.input); expect(first.attempts[0]).toMatchObject({errorCode: "COST_CEILING_EXCEEDED", usage: {actualCostUsd: 0.7}});
    const next = await f.service.classify({...f.input, request: f.request("next")});
    expect(next.attempts[0]?.errorCode).toBe("BUDGET_UNAVAILABLE"); expect(f.jev.classify).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.7); expect(f.budget.snapshot().invalidCostCeilings).toEqual(["jev"]);
  });
  it("USAGE07 simultaneous and completed identical malformed RESP submissions bill once", async () => {
    const f = fixture(); malformedResponse(f, 0.1);
    const [first, duplicate] = await Promise.all([f.service.classify(f.input), f.service.classify(f.input)]);
    const completed = await f.service.classify(f.input); expect(duplicate).toEqual(first); expect(completed).toEqual(first);
    expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1); expect(f.budget.snapshot().limits["vendor:current-vendor"]?.spentUsd).toBe(0.1);
    expect(f.budget.snapshot().reservations).toEqual([]);
  });
});
