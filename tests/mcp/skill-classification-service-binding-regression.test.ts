import {describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// TD-002/004, CONC-CANCEL-004, DIST-IDEMPOTENCY-002/RETRY-003/ORDER-004.
// Public service boundary; fake transport/clock only. Provider-live/host selection are NOT_RUN here.
function fixture() {
  const request = createClassificationRequest({requestId: "request", operationId: "operation", originalPrompt: "읽기 전용, 수정 금지. 검토만 해라.",
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경분 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low",
    supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`, qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 2000}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {vendor: {approvalRef: "fixture-quota", remainingCalls: 2}}});
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req) => evaluation(req))});
  const jev = provider(), vendor = provider();
  const service = new SkillClassificationService({providers: {jev, vendor}, budget});
  return {input, budget, evaluation, jev, vendor, service, profile};
}


// Test-engineering TD-002/004/005, TP-001/002/003/004.
// Same tests run RED on fixed base then GREEN on root's source changes.
// Public service boundary, API/Claude calls 0. Qualification and usage are synthetic.
const bindingCases = ["config JEV OFF", "config external OFF", "config timeout", "config registry reference", "profile model", "profile cost ceiling", "profile input ceiling", "profile output ceiling", "qualification status", "qualification expiry record"] as const;
function reverseKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseKeys) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseKeys(item)])) as T;
  return value;
}
describe("public service canonical cache binding regression (API0)", () => {
  it.each(bindingCases)("B01 same-revision %s conflicts without resend", async change => {
    const f = fixture(), before = await f.service.classify(f.input), changed = structuredClone(f.input);
    if (change === "config JEV OFF") changed.config.jevEnabled = false;
    if (change === "config external OFF") changed.config.externalClassificationAllowed = false;
    if (change === "config timeout") changed.config.timeoutMs += 1;
    if (change === "config registry reference") changed.config.providerProfileRegistryRef = "profiles-other";
    if (change === "profile model") changed.registry.profiles[0]!.modelId = "jev-other";
    if (change === "profile cost ceiling") changed.registry.profiles[0]!.maximumCostUsd = 0.2;
    if (change === "profile input ceiling") changed.registry.profiles[0]!.maximumInputBytes += 1;
    if (change === "profile output ceiling") changed.registry.profiles[0]!.maximumOutputTokens += 1;
    if (change === "qualification status") changed.registry.profiles[0]!.qualification.status = "FAIL";
    if (change === "qualification expiry record") changed.registry.profiles[0]!.qualification.validUntil = "2098-01-01T00:00:00Z";
    const result = await f.service.classify(changed);
    expect(result.response.error?.code).toBe("OPERATION_DIGEST_CONFLICT");
    expect(result.response.status).toBe("INVALID");
    expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).not.toHaveBeenCalled();
    expect(await f.service.classify(f.input)).toEqual(before);
  });
  it("B02 JSON key order only remains deduplicated", async () => {
    const f = fixture(), before = await f.service.classify(f.input);
    const reordered = reverseKeys(structuredClone(f.input));
    expect(Object.keys(reordered.config)).not.toEqual(Object.keys(f.input.config));
    expect(await f.service.classify(reordered)).toEqual(before);
    expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("B03 mutating caller-owned input immediately cannot change an already claimed flight", async () => {
    const f = fixture(), original = structuredClone(f.input), pending = f.service.classify(f.input);
    f.input.config.jevEnabled = false; f.input.config.externalClassificationAllowed = false;
    f.input.registry.profiles[0]!.modelId = "caller-mutated-model";
    f.input.registry.profiles[0]!.maximumCostUsd = 0;
    f.input.request.originalPrompt = "caller-mutated-invalid-request";
    const result = await pending;
    expect(result.response.status).toBe("SUCCESS");
    expect(result.config).toEqual(original.config); expect(result.request).toEqual(original.request);
    expect(f.jev.classify).toHaveBeenCalledWith(original.request, original.registry.profiles[0], expect.any(AbortSignal), expect.any(Function));
    expect(await f.service.classify(original)).toEqual(result);
    expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("B04 completed cache expires with the qualification clock without resend", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    const until = Date.parse(f.input.registry.profiles[1]!.qualification.validUntil); let now = until - 1;
    const service = new SkillClassificationService({providers:{jev:f.jev, vendor:f.vendor}, budget:f.budget, now:() => now});
    expect((await service.classify(f.input)).response.status).toBe("SUCCESS");
    now = until;
    const result = await service.classify(f.input);
    expect(result.response.error?.code).toBe("QUALIFICATION_EXPIRED");
    expect(result.response.status).not.toBe("SUCCESS");
    expect(f.vendor.availability).toHaveBeenCalledTimes(1); expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(f.jev.classify).not.toHaveBeenCalled();
  });
  it("B05 new operation at qualification deadline blocks before transport", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    const until = Date.parse(f.input.registry.profiles[1]!.qualification.validUntil);
    const service = new SkillClassificationService({providers:{jev:f.jev, vendor:f.vendor}, budget:f.budget, now:() => until});
    const result = await service.classify(f.input);
    expect(result.response.error?.code).toBe("QUALIFICATION_EXPIRED");
    expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled();
  });
});
