import {afterAll, describe, expect, it, vi} from "vitest";
import {writeFileSync} from "node:fs";
import {ApprovedRouteClassificationProvider, unknownUsage, type ApprovedClassificationRoute} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {createClassificationProviderRuntime} from "../../mcp-server/src/skill-classification/runtime.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// SS32 only. The fixture originalPrompt/oracle are null. This explicitly synthetic
// request supplies a valid transport payload; it is never a semantic golden answer.
const observations: unknown[] = [];
afterAll(() => writeFileSync("evidence/SS32/isolated.observations.json", JSON.stringify(observations, null, 2) + "\n"));
function gate() { let open!: () => void; const promise = new Promise<void>(resolve => {open = resolve;}); return {promise, open}; }
function evaluation(request: SkillClassificationRequestV1): ProviderEvaluation {
  return {response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId,
    requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS",
    judgments: request.skills.map(skill => ({skillId: skill.skillId, judgment: "needed", reasonRefs: ["mock:SS32"], uncertaintyReason: null})),
    unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null};
}
function fixture(jevEnabled = true) {
  const inventory = {skills: [{skillId: "review", version: "1", description: "합성 읽기 전용 검토", enabled: true, installed: true,
    hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"],
    applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}],
    issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "synthetic-SS32"};
  const makeRequest = (prompt = "SS32 합성 transport: 읽기 전용 검토; 수정 금지.", operationId = "SS32-operation") =>
    createClassificationRequest({requestId: "SS32-request", operationId, originalPrompt: prompt, inventory, classificationCriteriaRef: "mock:SS32"});
  const request = makeRequest();
  const profiles: ProviderProfile[] = (["jev", "vendor"] as const).map(kind => {
    const profile: ProviderProfile = {profileId: `mock-${kind}`, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "mock-vendor",
      modelId: `mock-${kind}-fixed`, modelRevision: `mock-${kind}-fixed`, reasoningEffort: null,
      supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: `mock-${kind}-route`,
      qualificationRevision: "synthetic-only-not-production-qualified", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest,
        taxonomyRevision: request.taxonomyRevision, modelRevision: `mock-${kind}-fixed`, promptRevision: "mock-p1",
        validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "mock-a1", promptRevision: "mock-p1",
      maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4,
      judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    return profile;
  });
  const input: ClassificationServiceInput = {request, config: {jevEnabled, mode: "select", providerProfileRegistryRef: "mock-profiles",
    externalClassificationAllowed: true, configRevision: "mock-c1", timeoutMs: 2000},
    registry: {schemaVersion: "1.0.0", profileRevision: "mock-pr1", profiles}, currentVendorId: "mock-vendor"};
  const wires: {kind: string; requestId: string; operationId: string; digest: string}[] = [];
  const replies = {jev: async () => new Response("{}"), vendor: async () => new Response("{}")};
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const kind = String(url).includes("/jev") ? "jev" : "vendor";
    const wire = JSON.parse(String(init?.body));
    wires.push({kind, requestId: wire.requestId, operationId: wire.operationId, digest: wire.requestDigest});
    return replies[kind]();
  });
  const routes: ApprovedClassificationRoute[] = profiles.map(profile => ({routeRef: profile.approvedRouteRef,
    approvalRef: "mock-approved-only", approved: true, kind: "remote", providerKind: profile.providerKind, vendorId: profile.vendorId,
    adapterRevision: profile.adapterRevision, modelIds: [profile.modelId], reasoningEfforts: [null], structuredOutput: true,
    endpoint: `https://ss32.example.invalid/${profile.providerKind}`, getCredential: async () => "PUBLIC_SYNTHETIC_STAND_IN",
    adapter: {encode: req => req, decode: (_body, req) => evaluation(req)}}));
  const providers = {jev: new ApprovedRouteClassificationProvider(routes.filter(x => x.providerKind === "jev"), fetcher),
    vendor: new ApprovedRouteClassificationProvider(routes.filter(x => x.providerKind === "vendor"), fetcher)};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"mock-vendor": {limitUsd: 2, spentUsd: 0}}});
  const service = new SkillClassificationService({providers, budget, now: () => Date.parse("2026-10-09T00:00:00Z")});
  return {input, makeRequest, profiles, routes, replies, fetcher, wires, providers, budget, service};
}
function capture(id: string, variant: string, input: unknown, expected: unknown, observed: unknown) {
  observations.push({caseId: "SS32", id, variant, executionKind: "new-isolated-offline-mock", input, expected, observed,
    externalAPI: {jev: 0, vendor: 0, claude: 0}, hostStages: {selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN"},
    agentSelectedSkillIds: null, semanticAccuracy: null});
}
function retryAfterValues(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => /^retry[-_]?after$/iu.test(key) ? [item] : retryAfterValues(item));
}

describe("SS32 isolated specification checks", () => {
  it.each([429, 529])("SS32/429 HTTP %i maps unavailable and falls back exactly once", async status => {
    const f = fixture(); const before = structuredClone(f.input);
    f.replies.jev = async () => new Response("private body ignored", {status, headers: {"Retry-After": "120"}});
    const result = await f.service.classify(f.input);
    capture(`fallback-${status}`, "429", {request: f.input.request, httpStatus: status, retryAfter: "120"},
      {attemptKinds: ["jev", "vendor"], jevStatus: "UNAVAILABLE", error: "RATE_LIMITED", transports: 2, inputUnchanged: true},
      {result, wires: f.wires, budget: f.budget.snapshot(), inputUnchanged: JSON.stringify(before) === JSON.stringify(f.input)});
    expect(result.attempts.map(x => x.providerKind)).toEqual(["jev", "vendor"]);
    expect(result.attempts[0]).toMatchObject({status: "UNAVAILABLE", errorCode: "RATE_LIMITED", dispatchState: "started"});
    expect(result.response.status).toBe("SUCCESS"); expect(f.wires.map(x => x.kind)).toEqual(["jev", "vendor"]);
    expect(f.input).toEqual(before); expect(result).not.toHaveProperty("agentSelectedSkillIds");
    expect(f.budget.snapshot().reservations).toHaveLength(1);
  });
  it("SS32/429 both providers rate limited return UNAVAILABLE without extra attempts", async () => {
    const f = fixture(); f.replies.jev = async () => new Response("", {status: 429}); f.replies.vendor = async () => new Response("", {status: 529});
    const result = await f.service.classify(f.input);
    capture("both-rate-limited", "429", {request: f.input.request, statuses: [429, 529]},
      {status: "UNAVAILABLE", transports: 2, unknownCostReservations: 2}, {result, wires: f.wires, budget: f.budget.snapshot()});
    expect(result.response).toMatchObject({status: "UNAVAILABLE", judgments: [], error: {code: "RATE_LIMITED", retryable: false}});
    expect(f.wires.map(x => x.kind)).toEqual(["jev", "vendor"]); expect(f.budget.snapshot().reservations).toHaveLength(2);
  });
  it.each([[429, "120"], [529, "Fri, 09 Oct 2026 03:00:00 GMT"]] as const)("SS32/429 preserves Retry-After for HTTP %i", async (status, header) => {
    const f = fixture(false); f.replies.vendor = async () => new Response("", {status, headers: {"Retry-After": header}});
    const result = await f.service.classify(f.input); const retained = retryAfterValues(result);
    capture(`retry-after-${status}`, "429", {request: f.input.request, httpStatus: status, retryAfter: header},
      {retryAfterObservation: header, transportCount: 1}, {retryAfterValues: retained, result, wires: f.wires});
    expect(f.wires).toHaveLength(1); expect(result.response.status).toBe("UNAVAILABLE");
    expect(retained, "Embedded SS32 허용선택 requires observed Retry-After to be preserved").toContain(header);
  });
  it.each([429, 529])("SS32/sdk-retry-negative HTTP %i never consumes queued retry success", async status => {
    const f = fixture(false); let calls = 0;
    f.replies.vendor = async () => ++calls === 1 ? new Response("", {status, headers: {"Retry-After": "0"}}) : new Response("{}");
    const result = await f.service.classify(f.input); const repeated = await f.service.classify(f.input);
    capture(`no-retry-${status}`, "sdk-retry-negative", {request: f.input.request, responseQueue: [status, 200], retryAfter: "0"},
      {status: "UNAVAILABLE", transportCount: 1, completedResubmitSharesResult: true}, {result, repeated, wires: f.wires, calls});
    expect(result.response.status).toBe("UNAVAILABLE"); expect(calls).toBe(1); expect(repeated).toEqual(result);
  });
  it("SS32/sdk-retry-negative rejects native routes without verified no-retry policy", async () => {
    const f = fixture(false); const invokeStructured = vi.fn(async () => evaluation(f.input.request)); const profile = f.profiles[1]!;
    const runtime = createClassificationProviderRuntime({schemaVersion: "1.0.0", routes: [{routeRef: profile.approvedRouteRef,
      approvalRef: "mock-only", approved: true, providerKind: "vendor", vendorId: "mock-vendor", adapterRevision: "mock-a1",
      modelIds: [profile.modelId], reasoningEfforts: [null], structuredOutput: true, kind: "native", nativeAdapterRef: "mock-sdk",
      capabilityEvidenceRef: "mock-capability", retryPolicyVerified: false}], budget: {jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {}}},
      {nativeAdapters: new Map([["mock-sdk", {capabilityEvidenceRef: "mock-capability", retryPolicy: "no-retry", invokeStructured}]])});
    const availability = await runtime.providers.vendor.availability(profile);
    capture("unverified-native-retry-policy", "sdk-retry-negative", {retryPolicyVerified: false},
      {available: false, nativeInvocations: 0}, {availability, nativeInvocations: invokeStructured.mock.calls.length});
    expect(availability.available).toBe(false); expect(invokeStructured).not.toHaveBeenCalled();
  });
  it("SS32/duplicate-inflight shares a genuinely delayed transport and completed result", async () => {
    const f = fixture(); const entered = gate(), release = gate();
    f.replies.jev = async () => {entered.open(); await release.promise; return new Response("{}");};
    const first = f.service.classify(f.input); await entered.promise; const second = f.service.classify(structuredClone(f.input));
    const countWhilePending = f.wires.length; release.open(); const [a, b] = await Promise.all([first, second]);
    const completed = await f.service.classify(f.input);
    capture("delayed-identical-submissions", "duplicate-inflight", {request: f.input.request, simultaneousSubmissions: 2, completedResubmissions: 1},
      {transportCount: 1, sameResult: true, settledCostUsd: 0.1}, {a, b, completed, countWhilePending, wires: f.wires, budget: f.budget.snapshot()});
    expect(countWhilePending).toBe(1); expect(f.wires).toHaveLength(1); expect(a).toEqual(b); expect(completed).toEqual(a);
    expect(f.budget.snapshot().limits.jev?.spentUsd).toBe(0.1); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  it("SS32/duplicate-inflight shares the rate-limit fallback without duplicate billing", async () => {
    const f = fixture(); const entered = gate(), release = gate();
    f.replies.jev = async () => new Response("", {status: 429});
    f.replies.vendor = async () => {entered.open(); await release.promise; return new Response("{}");};
    const first = f.service.classify(f.input); await entered.promise; const second = f.service.classify(f.input);
    release.open(); const [a, b] = await Promise.all([first, second]);
    capture("delayed-fallback-identical-submissions", "duplicate-inflight", {request: f.input.request, simultaneousSubmissions: 2, jevHttpStatus: 429},
      {attemptKinds: ["jev", "vendor"], sameResult: true, settledVendorCostUsd: 0.1}, {a, b, wires: f.wires, budget: f.budget.snapshot()});
    expect(f.wires.map(x => x.kind)).toEqual(["jev", "vendor"]); expect(a).toEqual(b);
    expect(f.budget.snapshot().limits["vendor:mock-vendor"]?.spentUsd).toBe(0.1);
  });
  it("SS32/duplicate-inflight never reissues an unknown-cost timed-out request", async () => {
    const f = fixture(false); const entered = gate(), release = gate(); f.input.config.timeoutMs = 20;
    f.replies.vendor = async () => {entered.open(); await release.promise; return new Response("{}");};
    const pending = f.service.classify(f.input); await entered.promise; const result = await pending;
    const again = await f.service.classify(f.input); const beforeLateCompletion = JSON.stringify(result);
    release.open(); await new Promise(resolve => setImmediate(resolve));
    capture("unknown-cost-identical-resubmit", "duplicate-inflight", {request: f.input.request, timeoutMs: 20, completedResubmissions: 1},
      {transports: 1, status: "UNCERTAIN", error: "PROVIDER_TIMEOUT", unknownCostReservations: 1, lateCompletionIgnored: true},
      {result, again, wires: f.wires, budget: f.budget.snapshot(), lateCompletionIgnored: JSON.stringify(result) === beforeLateCompletion});
    expect(result.response).toMatchObject({status: "UNCERTAIN", error: {code: "PROVIDER_TIMEOUT"}});
    expect(again).toEqual(result); expect(f.wires).toHaveLength(1); expect(f.budget.snapshot().reservations).toHaveLength(1);
    expect(JSON.stringify(result)).toBe(beforeLateCompletion);
  });
  it("SS32/duplicate-inflight rechecks task cancellation after delayed credential resolution", async () => {
    const f = fixture(false); const entered = gate(), release = gate(); let credentialCalls = 0;
    const route = f.routes.find(x => x.providerKind === "vendor")!;
    if (route.kind !== "remote") throw new Error("mock route must be remote");
    route.getCredential = async () => {if (++credentialCalls === 2) {entered.open(); await release.promise;} return "PUBLIC_SYNTHETIC_STAND_IN";};
    const snapshot = {taskRevision: null, configRevision: "mock-c1", profileRevision: "mock-pr1",
      inventoryDigest: f.input.request.inventoryDigest, requestDigest: f.input.request.requestDigest, cancelled: false};
    f.input.getCurrentSnapshot = () => snapshot;
    const first = f.service.classify(f.input); await entered.promise; const second = f.service.classify(f.input);
    snapshot.cancelled = true; release.open(); const [a, b] = await Promise.all([first, second]);
    capture("cancelled-before-shared-dispatch", "duplicate-inflight", {request: f.input.request, cancellationBoundary: "after availability/reservation, before transport credential await completes", simultaneousSubmissions: 2},
      {transports: 0, error: "STALE_CLASSIFICATION"}, {a, b, wires: f.wires, credentialCalls, budget: f.budget.snapshot()});
    expect(a.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(b.response.error?.code).toBe("STALE_CLASSIFICATION");
    expect(f.wires, "Known concurrency/pre-dispatch recheck gap: cancellation must prevent transmission").toHaveLength(0);
  });
  it.each(["same-operation", "different-operation"])("SS32/digest-collision rejects %s while the original is in flight", async variant => {
    const f = fixture(); const entered = gate(), release = gate();
    f.replies.jev = async () => {entered.open(); await release.promise; return new Response("{}");};
    const first = f.service.classify(f.input); await entered.promise;
    const changed = {...f.input, request: f.makeRequest("SS32 alternate synthetic content", variant === "same-operation" ? "SS32-operation" : "SS32-other-operation")};
    const conflict = await f.service.classify(changed); release.open(); const original = await first; const cached = await f.service.classify(f.input);
    capture(`collision-${variant}`, "digest-collision", {original: f.input.request, changed: changed.request},
      {status: "INVALID", error: variant === "same-operation" ? "OPERATION_DIGEST_CONFLICT" : "REQUEST_ID_CONFLICT", transports: 1, originalUncontaminated: true},
      {conflict, original, cached, wires: f.wires, budget: f.budget.snapshot()});
    expect(changed.request.requestDigest).not.toBe(f.input.request.requestDigest);
    expect(conflict.response).toMatchObject({status: "INVALID", error: {code: variant === "same-operation" ? "OPERATION_DIGEST_CONFLICT" : "REQUEST_ID_CONFLICT"}});
    expect(conflict.attempts).toEqual([]); expect(f.wires).toHaveLength(1); expect(original.response.status).toBe("SUCCESS"); expect(cached).toEqual(original);
  });
});
