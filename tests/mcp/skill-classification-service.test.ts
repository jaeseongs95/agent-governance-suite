import {afterEach, describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {ClassificationProviderError, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
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
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 50}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}, nativeAllowances: {vendor: {approvalRef: "fixture-quota", remainingCalls: 2}}});
  const evaluation = (req: SkillClassificationRequestV1 = request): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req) => evaluation(req))});
  const jev = provider(), vendor = provider();
  const service = new SkillClassificationService({providers: {jev, vendor}, budget});
  return {input, budget, evaluation, jev, vendor, service, profile};
}
afterEach(() => vi.useRealTimers());
// Explicit synthetic requalification for tests of a different boundary; never production quality evidence.
function requalifyFixtureProfile(profile: ProviderProfile, revision: string) {
  profile.qualificationRevision = revision;
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
}
describe("fixed-profile classification service", () => {
  it("SS19/39 OFF never looks up JEV credentials and passes exactly the fixed vendor profile", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    const result = await f.service.classify(f.input);
    expect(result.response.status).toBe("SUCCESS");
    expect(f.jev.availability).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled();
    expect(f.vendor.classify).toHaveBeenCalledWith(f.input.request, f.input.registry.profiles[1], expect.any(AbortSignal));
    expect(result.attempts.map(a => [a.modelId, a.reasoningEffort])).toEqual([["vendor-fixed", "low"]]);
    expect(result).not.toHaveProperty("agentSelectedSkillIds");
  });
  it("SS21 ON uses JEV alone without injecting a final AGENT selection", async () => {
    const f = fixture(); const result = await f.service.classify(f.input);
    expect(result.response.judgments[0]?.skillId).toBe("review"); expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it.each(["AUTH_UNAVAILABLE", "RATE_LIMITED", "API_UNAVAILABLE", "PROVIDER_RESPONSE_TOO_LARGE"])("SS28/30/32 %s falls back at most once with no JEV retry", async code => {
    const tooLarge = code === "PROVIDER_RESPONSE_TOO_LARGE";
    const f = fixture(); vi.mocked(f.jev.classify).mockRejectedValue(new ClassificationProviderError(code, tooLarge ? "unknown" : "started", tooLarge));
    const result = await f.service.classify(f.input);
    expect(result.response.status).toBe("SUCCESS"); expect(result.attempts.map(a => a.errorCode)).toEqual([code, null]);
    expect(f.jev.classify).toHaveBeenCalledTimes(1); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot().reservations).toHaveLength(1);
    if (tooLarge) expect(result.attempts[0]).toMatchObject({status: "INVALID", dispatchState: "unknown", usage: {actualCostUsd: null}});
  });
  it("SS30 missing key availability uses the current vendor without sending JEV", async () => {
    const f = fixture(); vi.mocked(f.jev.availability).mockResolvedValue({available: false, approved: true, routeKind: "remote", reasonCode: "CREDENTIAL_UNAVAILABLE"});
    expect((await f.service.classify(f.input)).response.status).toBe("SUCCESS"); expect(f.jev.classify).not.toHaveBeenCalled(); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
  });
  it("SS31 ignores late JEV completion and retains unknown JEV cost separately", async () => {
    vi.useFakeTimers(); const f = fixture(); let release!: (value: ProviderEvaluation) => void;
    vi.mocked(f.jev.classify).mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.service.classify(f.input); await vi.advanceTimersByTimeAsync(51);
    const result = await pending;
    expect(result.response.status).toBe("SUCCESS"); expect(result.attempts[0]).toMatchObject({timedOut: true, dispatchState: "unknown", status: "UNCERTAIN", usage: {actualCostUsd: null}});
    expect(f.budget.snapshot()).toMatchObject({limits: {jev: {spentUsd: 0}, "vendor:current-vendor": {spentUsd: 0.1}}, reservations: [{bucket: "jev", maximumUsd: 0.4}]});
    const saved = JSON.stringify(result); release(f.evaluation()); await Promise.resolve(); await Promise.resolve();
    expect(JSON.stringify(result)).toBe(saved); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    expect((await f.service.classify(f.input)).attempts).toEqual(result.attempts); expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  it("SS31 pre-dispatch timeout costs zero and never sends after availability resolves", async () => {
    vi.useFakeTimers(); const f = fixture(); let available!: () => void;
    vi.mocked(f.jev.availability).mockImplementation(() => new Promise(resolve => {available = () => resolve({available: true, approved: true, routeKind: "remote", reasonCode: null});}));
    const pending = f.service.classify(f.input); await vi.advanceTimersByTimeAsync(51); const result = await pending;
    expect(result.attempts[0]).toMatchObject({dispatchState: "not-started", timedOut: true, reservedCostUsd: 0});
    available(); await Promise.resolve(); await Promise.resolve(); expect(f.jev.classify).not.toHaveBeenCalled();
  });
  it("SS31 an actual native adapter timeout retains its dispatch/cost uncertainty", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    vi.mocked(f.vendor.availability).mockResolvedValue({available: true, approved: true, routeKind: "native", reasonCode: null});
    vi.mocked(f.vendor.classify).mockRejectedValue(new ClassificationProviderError("NATIVE_TIMEOUT", "unknown"));
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({timedOut: true, errorCode: "NATIVE_TIMEOUT", status: "UNCERTAIN", dispatchState: "unknown", usage: {actualCostUsd: null}});
    expect(f.budget.snapshot().reservations).toHaveLength(1); expect(result.response.status).toBe("UNCERTAIN");
  });
  it("SS32 concurrent and completed identical submissions share one transport result", async () => {
    const f = fixture(); const [a, b] = await Promise.all([f.service.classify(f.input), f.service.classify(f.input)]);
    expect(a).toEqual(b); expect(await f.service.classify(f.input)).toEqual(a); expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  it("SS32 rejects a changed digest or reused request ID without contaminating the first result", async () => {
    const f = fixture(); const result = await f.service.classify(f.input);
    const changed = {...f.input, request: createClassificationRequest({requestId: "request", operationId: "operation", originalPrompt: "설명만", inventory: {skills: f.input.request.skills, inventoryDigest: f.input.request.inventoryDigest, taxonomyRevision: "taxonomy", issues: []}, classificationCriteriaRef: "criteria"})};
    expect((await f.service.classify(changed)).response.error?.code).toBe("OPERATION_DIGEST_CONFLICT");
    changed.request = createClassificationRequest({requestId: "request", operationId: "other", originalPrompt: "설명만", inventory: {skills: f.input.request.skills, inventoryDigest: f.input.request.inventoryDigest, taxonomyRevision: "taxonomy", issues: []}, classificationCriteriaRef: "criteria"});
    expect((await f.service.classify(changed)).response.error?.code).toBe("REQUEST_ID_CONFLICT");
    expect(await f.service.classify(f.input)).toEqual(result); expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  it("SS32 bounded lifetime cache rejects new operations and preserves completed dedup records", async () => {
    const f = fixture(); const service = new SkillClassificationService({providers: {jev: f.jev, vendor: f.vendor}, budget: f.budget, maxOperations: 1});
    const result = await service.classify(f.input);
    const other = {...f.input, request: createClassificationRequest({requestId: "other", operationId: "other", originalPrompt: "다른 검토", inventory: {skills: f.input.request.skills, inventoryDigest: f.input.request.inventoryDigest, taxonomyRevision: "taxonomy", issues: []}, classificationCriteriaRef: "criteria"})};
    expect((await service.classify(other)).response.error?.code).toBe("OPERATION_CAPACITY_EXCEEDED");
    expect(await service.classify(f.input)).toEqual(result); expect(f.jev.classify).toHaveBeenCalledTimes(1);
  });
  it.each(["configRevision", "profileRevision", "taskRevision", "inventoryDigest", "requestDigest"] as const)("SS24/25 fences changed %s before accepting delayed responses", async field => {
    const f = fixture(); let release!: (value: ProviderEvaluation) => void;
    const snapshot = {taskRevision: f.input.request.confirmedContext.taskRevision, configRevision: "c1", profileRevision: "pr1", inventoryDigest: f.input.request.inventoryDigest, requestDigest: f.input.request.requestDigest, cancelled: false};
    f.input.getCurrentSnapshot = () => snapshot;
    vi.mocked(f.jev.classify).mockImplementation(() => new Promise(resolve => {release = resolve;}));
    const pending = f.service.classify(f.input);
    await vi.waitFor(() => expect(f.jev.classify).toHaveBeenCalledTimes(1)); snapshot[field] = "changed"; release(f.evaluation());
    expect((await pending).response.error?.code).toBe("STALE_CLASSIFICATION"); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS24 snapshots freeze profile mutation before transmission", async () => {
    const f = fixture(); const pending = f.service.classify(f.input); f.input.registry.profiles[0]!.modelId = "premium";
    const result = await pending; expect(result.attempts[0]?.modelId).toBe("jev-fixed");
  });
  it.each(["effort", "adapter", "policy", "options"])("PRE stale JEV %s never starts availability/credentials and preserves valid vendor fallback ON/OFF", async change => {
    for (const enabled of [true, false]) {
      const f = fixture(); f.input.config.jevEnabled = enabled; const jev = f.input.registry.profiles[0]!;
      if (change === "effort") {jev.reasoningEffort = "low"; jev.supportedOptions.reasoningEfforts.push("low");}
      if (change === "adapter") jev.adapterRevision = "a2";
      if (change === "policy") jev.judgmentPolicy = {neededAt: 0.9, notNeededAt: 0.1};
      if (change === "options") jev.supportedOptions.reasoningEfforts.push("low");
      const result = await f.service.classify(f.input);
      expect(result.response.status).toBe("SUCCESS"); expect(result.attempts.map(a => a.providerKind)).toEqual(["vendor"]);
      expect(f.jev.availability).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled(); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    }
  });
  it("PRE a lower supported vendor effort with old PASS cannot make any provider call", async () => {
    const f = fixture(); f.input.config.jevEnabled = false; const vendor = f.input.registry.profiles[1]!;
    vendor.reasoningEffort = "high"; vendor.supportedOptions.reasoningEfforts = ["low", "high"]; requalifyFixtureProfile(vendor, "synthetic-high-vendor");
    vendor.reasoningEffort = "low"; // Preserve old fingerprint: this is the adversarial reuse, not requalification.
    expect((await f.service.classify(f.input)).response.error?.code).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
    expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS33 egress block rejects both remote paths; native structured route remains independent of OFF", async () => {
    const f = fixture(); f.input.config.externalClassificationAllowed = false;
    expect((await f.service.classify(f.input)).response.error?.code).toBe("EXTERNAL_CLASSIFICATION_BLOCKED"); expect(f.jev.classify).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
    const native = fixture(); native.input.config.jevEnabled = false; native.input.config.externalClassificationAllowed = false;
    vi.mocked(native.vendor.availability).mockResolvedValue({available: true, approved: true, routeKind: "native", reasonCode: null});
    expect((await native.service.classify(native.input)).response.status).toBe("SUCCESS"); expect(native.vendor.classify).toHaveBeenCalledTimes(1);
  });
  it.each(["COST_UNKNOWN", "PROFILE_UNQUALIFIED", "QUALIFICATION_EXPIRED", "UNSUPPORTED_OPTIONS"])("SS39 %s blocks before availability/transport", async code => {
    const f = fixture(); f.input.config.jevEnabled = false; const p = f.input.registry.profiles[1]!;
    if (code === "COST_UNKNOWN") p.maximumCostUsd = null;
    if (code === "PROFILE_UNQUALIFIED") p.qualification.status = "NOT_RUN";
    if (code === "QUALIFICATION_EXPIRED") p.qualification.validUntil = "2000-01-01T00:00:00Z";
    if (code === "UNSUPPORTED_OPTIONS") p.supportedOptions.reasoningEfforts = [null];
    if (code === "COST_UNKNOWN" || code === "UNSUPPORTED_OPTIONS") requalifyFixtureProfile(p, `synthetic-${code}`);
    expect((await f.service.classify(f.input)).response.error?.code).toBe(code); expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS27/30 malformed and incomplete JEV judgments produce INVALID and vendor fallback", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockResolvedValue({...f.evaluation(), response: {...f.evaluation().response, judgments: []}});
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({status: "INVALID", errorCode: "INVALID_PROVIDER_RESPONSE"}); expect(result.response.status).toBe("SUCCESS");
  });
  it("SS28 native/custom ports also obey the full meaningful-input ceiling before availability", async () => {
    const f = fixture(); f.input.config.jevEnabled = false; f.input.registry.profiles[1]!.maximumInputBytes = 1;
    requalifyFixtureProfile(f.input.registry.profiles[1]!, "synthetic-input-ceiling");
    expect((await f.service.classify(f.input)).response.error?.code).toBe("INPUT_TOO_LONG"); expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS28 known output over the fixed ceiling is rejected while actual cost remains accounted", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockResolvedValue({...f.evaluation(), usage: {...f.evaluation().usage, outputTokens: 1001}});
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({status: "INVALID", errorCode: "OUTPUT_TOO_LONG", usage: {outputTokens: 1001, actualCostUsd: 0.1}});
    expect(result.response.status).toBe("SUCCESS"); expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1);
  });
  it("SS33 nonfinite usage is rejected; secret exception text is omitted", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockResolvedValue({...f.evaluation(), usage: {...unknownUsage(), actualCostUsd: Number.NaN}});
    vi.mocked(f.vendor.classify).mockRejectedValue(new Error("SECRET_SENTINEL token=private"));
    const result = await f.service.classify(f.input); expect(result.attempts[0]?.errorCode).toBe("INVALID_PROVIDER_USAGE"); expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
    expect(f.budget.snapshot().reservations).toHaveLength(2);
  });
  it("SS33 typed adapter exception codes cannot disclose credentials or arbitrary body details", async () => {
    const f = fixture(); f.input.config.jevEnabled = false; vi.mocked(f.vendor.classify).mockRejectedValue(new ClassificationProviderError("SECRET_SENTINEL private", "started"));
    const result = await f.service.classify(f.input); expect(result.response.error).toMatchObject({code: "PROVIDER_UNAVAILABLE", dispatchState: "started"}); expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL");
  });
  it("SS33 JEV cap/prior spending and pending reservations are independent of vendor budget", () => {
    const f = fixture(); const budget = new InMemoryClassificationBudget({jev: {limitUsd: 100, spentUsd: 4.5}, vendors: {"current-vendor": {limitUsd: 1, spentUsd: 0}}});
    expect(budget.reserve(f.profile("jev"), "a", 0.4)).toBe(true); expect(budget.reserve(f.profile("jev"), "b", 0.4)).toBe(false);
    budget.settle("a", null, "unknown"); expect(budget.reserve(f.profile("jev"), "c", 0.4)).toBe(false);
    expect(budget.reserve(f.profile("vendor"), "v", 0.4)).toBe(true); budget.settle("v", 0.1, "started");
    expect(budget.snapshot().limits["vendor:current-vendor"]?.spentUsd).toBe(0.1);
  });
  it("SS33 unknown prior balance blocks calls rather than granting zero-cost authorization", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: null}, vendors: {"current-vendor": {limitUsd: null, spentUsd: null}}});
    const service = new SkillClassificationService({providers: {vendor: f.vendor}, budget});
    expect((await service.classify(f.input)).response.error?.code).toBe("BUDGET_UNAVAILABLE"); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
  it("SS33 native cash zero still requires a separate confirmed allowance, never inferred from subscription", () => {
    const f = fixture(); const p = f.profile("vendor"); p.maximumCostUsd = 0;
    requalifyFixtureProfile(p, "synthetic-native-known-zero-cash");
    const missing = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}});
    expect(missing.reserve(p, "none", 0, "native")).toBe(false);
    const budget = new InMemoryClassificationBudget({jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {vendor: {approvalRef: "confirmed-calls", remainingCalls: 1}}});
    expect(budget.reserve(p, "one", 0, "native")).toBe(true); expect(budget.reserve(p, "two", 0, "native")).toBe(false);
    budget.settle("one", null, "unknown"); expect(budget.reserve(p, "three", 0, "native")).toBe(false);
    budget.settle("one", 0, "started"); expect(budget.snapshot().nativeAllowances.vendor?.remainingCalls).toBe(0);
    expect(budget.reserve(p, "four", 0, "native")).toBe(false);
  });
  it("SS33 observed cost over the qualified ceiling invalidates further use of that ceiling", () => {
    const f = fixture(); const p = f.profile("jev"); expect(f.budget.reserve(p, "first", 0.4)).toBe(true);
    f.budget.settle("first", 0.5, "started"); expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.5);
    expect(f.budget.snapshot().invalidCostCeilings).toEqual(["jev"]); expect(f.budget.reserve(p, "second", 0.4)).toBe(false);
    expect(f.budget.reserve(f.profile("vendor"), "separate", 0.4)).toBe(true);
  });
  it("SS33 cost ceiling overrun is explicit in its attempt and retains actual spending", async () => {
    const f = fixture(); vi.mocked(f.jev.classify).mockResolvedValue({...f.evaluation(), usage: {...f.evaluation().usage, actualCostUsd: 0.5}});
    const result = await f.service.classify(f.input); expect(result.attempts[0]).toMatchObject({errorCode: "COST_CEILING_EXCEEDED", reservedCostUsd: 0.4, usage: {actualCostUsd: 0.5}});
    expect(result.response.status).toBe("SUCCESS"); expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.5); expect(f.budget.snapshot().invalidCostCeilings).toEqual(["jev"]);
  });
  it("SS24 cancellation stops fallback without claiming unknown call was uncharged", async () => {
    const f = fixture(); const controller = new AbortController(); f.input.signal = controller.signal;
    vi.mocked(f.jev.classify).mockImplementation(() => new Promise(() => {}));
    const pending = f.service.classify(f.input); await vi.waitFor(() => expect(f.jev.classify).toHaveBeenCalledTimes(1)); controller.abort();
    const result = await pending; expect(result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(f.vendor.classify).not.toHaveBeenCalled(); expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
});
