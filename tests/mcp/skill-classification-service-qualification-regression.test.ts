import {afterEach, describe, expect, it, vi} from "vitest";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderAvailability, ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// Fixed epoch and promise gates isolate qualification time from elapsed test-runner time.
// The real service/cache/budget execute. Provider ports are synthetic: real API/Claude/host are NOT_RUN.
const START = 1_700_000_000_000;
const DEADLINE = START + 1000;
const available: ProviderAvailability = {available: true, approved: true, routeKind: "remote", reasonCode: null};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {resolve = done;});
  return {promise, resolve};
}
function availabilityGate(provider: SkillClassificationProviderPort) {
  const entered = deferred<void>(), release = deferred<ProviderAvailability>();
  vi.mocked(provider.availability).mockImplementation(async () => {entered.resolve(); return release.promise;});
  return {entered: entered.promise, release: (value = available) => release.resolve(value)};
}
function fixture(jevEnabled = false) {
  let clock = START;
  const request = createClassificationRequest({requestId: "expiry-request", operationId: "expiry-operation", originalPrompt: "읽기 전용 검토. 수정은 금지한다.",
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"b".repeat(64)}`, taxonomyRevision: "expiry-taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: `expiry-${kind}`, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low",
      supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-approved`, qualificationRevision: "synthetic-expiry-q1",
      qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "expiry-p1", validUntil: new Date(DEADLINE).toISOString(), profileConfigurationDigest: ""},
      adapterRevision: "expiry-a1", promptRevision: "expiry-p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const evaluation = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["synthetic-expiry"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {inputTokens: 10, outputTokens: 10, cachedInputTokens: 0, actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const provider = (): SkillClassificationProviderPort => ({availability: vi.fn(async () => available), classify: vi.fn(async req => evaluation(req))});
  const jev = provider(), vendor = provider();
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}});
  const reserve = vi.spyOn(budget, "reserve"), settle = vi.spyOn(budget, "settle");
  const input: ClassificationServiceInput = {request, config: {jevEnabled, mode: "select", providerProfileRegistryRef: "synthetic-profiles", externalClassificationAllowed: true, configRevision: "expiry-c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0", profileRevision: "expiry-pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const service = new SkillClassificationService({providers: {jev, vendor}, budget, now: () => clock});
  return {input, jev, vendor, budget, reserve, settle, service, setClock: (value: number) => {clock = value;}};
}
function expectNoBudgetMutation(f: ReturnType<typeof fixture>) {
  expect(f.reserve, "expired/pending profile must not reserve cash").not.toHaveBeenCalled();
  expect(f.settle).not.toHaveBeenCalled();
  expect(f.budget.snapshot()).toMatchObject({limits: {jev: {spentUsd: 0}, "vendor:current-vendor": {spentUsd: 0}}, reservations: []});
}
afterEach(() => vi.useRealTimers());

describe("qualification freshness across availability and cached operations", () => {
  it.each([0, 1])("QUAL-AVAIL vendor expiration at deadline+%i forbids reservation and dispatch", async offset => {
    const f = fixture(), gate = availabilityGate(f.vendor);
    const pending = f.service.classify(f.input); await gate.entered;
    f.setClock(DEADLINE + offset); gate.release();
    const result = await pending;
    expectNoBudgetMutation(f);
    expect(f.vendor.classify).not.toHaveBeenCalled();
    expect(result.response.status).toBe("UNAVAILABLE"); expect(result.response.error?.code).toBe("QUALIFICATION_EXPIRED");
    expect(result.attempts[0]).toMatchObject({dispatchState: "not-started", reservedCostUsd: 0});
  });

  it.each([0, 1])("QUAL-FALLBACK JEV expiration at deadline+%i uses only still-qualified fixed vendor", async offset => {
    const f = fixture(true), gate = availabilityGate(f.jev);
    f.input.registry.profiles[1]!.qualification.validUntil = new Date(DEADLINE + 10_000).toISOString();
    const pending = f.service.classify(f.input); await gate.entered;
    f.setClock(DEADLINE + offset); gate.release();
    const result = await pending;
    expect(f.jev.classify).not.toHaveBeenCalled(); expect(f.vendor.classify).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(1); expect(f.reserve.mock.calls[0]![0].providerKind).toBe("vendor");
    expect(result.response.status).toBe("SUCCESS");
    expect(result.attempts.map(row => [row.providerKind, row.errorCode, row.reservedCostUsd])).toEqual([["jev", "QUALIFICATION_EXPIRED", 0], ["vendor", null, 0.4]]);
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0);
  });

  it.each([0, 1])("QUAL-FALLBACK-WAIT fixed vendor expires at deadline+%i during its own availability", async offset => {
    const f = fixture(true), jevGate = availabilityGate(f.jev), vendorGate = availabilityGate(f.vendor);
    const pending = f.service.classify(f.input); await jevGate.entered;
    f.setClock(DEADLINE - 1); jevGate.release({...available, available: false, reasonCode: "CREDENTIAL_UNAVAILABLE"});
    await vendorGate.entered; f.setClock(DEADLINE + offset); vendorGate.release();
    const result = await pending;
    expectNoBudgetMutation(f); expect(f.jev.classify).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
    expect(result.response.error?.code).toBe("QUALIFICATION_EXPIRED"); expect(result.response.status).not.toBe("SUCCESS");
  });

  it("QUAL-FALLBACK-CURRENT expiration before selecting fallback also prevents vendor availability", async () => {
    const f = fixture(true), gate = availabilityGate(f.jev);
    const pending = f.service.classify(f.input); await gate.entered;
    f.setClock(DEADLINE); gate.release({...available, available: false, reasonCode: "CREDENTIAL_UNAVAILABLE"});
    const result = await pending;
    expectNoBudgetMutation(f); expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled();
    expect(result.response.error?.code).toBe("QUALIFICATION_EXPIRED");
  });

  it.each([["vendor", false], ["jev", true]] as const)("QUAL-BEFORE %s at deadline-1 remains eligible", async (kind, enabled) => {
    const f = fixture(enabled), gate = availabilityGate(f[kind]);
    const pending = f.service.classify(f.input); await gate.entered; f.setClock(DEADLINE - 1); gate.release();
    const result = await pending;
    expect(result.response.status).toBe("SUCCESS"); expect(f[kind].classify).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot().reservations).toEqual([]); expect(f.budget.snapshot().limits[kind === "jev" ? "jev" : "vendor:current-vendor"]?.spentUsd).toBe(0.1);
  });

  it.each([{kind: "vendor", enabled: false, offset: 0}, {kind: "vendor", enabled: false, offset: 1}, {kind: "jev", enabled: true, offset: 0}, {kind: "jev", enabled: true, offset: 1}] as const)("QUAL-CACHE $kind completed success at deadline+$offset is withheld without resend", async ({kind, enabled, offset}) => {
    const f = fixture(enabled);
    const first = await f.service.classify(f.input); expect(first.response.status).toBe("SUCCESS");
    const accounting = JSON.stringify(f.budget.snapshot()); f.setClock(DEADLINE + offset);
    const cached = await f.service.classify(f.input);
    expect(cached.response.status, "expired cached qualification must not publish SUCCESS").not.toBe("SUCCESS");
    expect(cached.response.error?.code).toBe("QUALIFICATION_EXPIRED");
    expect(f[kind].availability).toHaveBeenCalledTimes(1); expect(f[kind].classify).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f[kind === "jev" ? "vendor" : "jev"].classify).not.toHaveBeenCalled();
    expect(JSON.stringify(f.budget.snapshot())).toBe(accounting); expect(first.response.status).toBe("SUCCESS");
  });

  it("QUAL-TIMEOUT pending availability never reserves or dispatches even after late release", async () => {
    vi.useFakeTimers(); const f = fixture(), gate = availabilityGate(f.vendor);
    f.input.config.timeoutMs = 20; const pending = f.service.classify(f.input); await gate.entered;
    await vi.advanceTimersByTimeAsync(20); const result = await pending;
    expect(result.response.error?.code).toBe("PROVIDER_TIMEOUT"); expectNoBudgetMutation(f);
    gate.release(); await vi.advanceTimersByTimeAsync(0);
    expectNoBudgetMutation(f); expect(f.vendor.classify).not.toHaveBeenCalled();
  });

  it("QUAL-CANCEL pending availability never reserves or dispatches even after late release", async () => {
    const f = fixture(), gate = availabilityGate(f.vendor), controller = new AbortController(); f.input.signal = controller.signal;
    const pending = f.service.classify(f.input); await gate.entered; controller.abort();
    const result = await pending; expect(result.response.status).not.toBe("SUCCESS"); expectNoBudgetMutation(f);
    gate.release(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expectNoBudgetMutation(f); expect(f.vendor.classify).not.toHaveBeenCalled();
  });
});
