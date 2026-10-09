import {describe, expect, it, vi} from "vitest";
import {createClassificationProviderRuntime, type ClassificationProviderRuntimeConfig} from "../../mcp-server/src/skill-classification/runtime.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {ClassificationProviderError, sanitizeRateLimitObservation, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

function fixture() {
  const request = createClassificationRequest({requestId: "r", operationId: "o", originalPrompt: "공개 합성 설명", inventory: {skills: [], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}, classificationCriteriaRef: "criteria"});
  const profile: ProviderProfile = {profileId: "jev", providerKind: "jev", vendorId: "typesafe", modelId: "fixed-jev", modelRevision: "fixed-jev", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "approved", qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: "t1", modelRevision: "fixed-jev", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.1, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  const config: ClassificationProviderRuntimeConfig = {schemaVersion: "1.0.0", routes: [{routeRef: "approved", approvalRef: "fixture-approval", approved: true, providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, kind: "remote", endpoint: "https://approved.example.invalid/fixture", credentialEnvName: "EXPLICIT_FIXTURE_CREDENTIAL_NAME", wireAdapterRef: "jev-noul-v1"}], budget: {jev: {limitUsd: 5, spentUsd: 0}, vendors: {}, nativeAllowances: {}}};
  return {request, profile, config};
}
describe("trusted provider runtime composition", () => {
  it("forwards the final state fence across runtime composition after a native adapter await", async () => {
    const f = fixture(); f.config.routes = [{routeRef: "approved", approvalRef: "synthetic-only", approved: true, providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, kind: "native", nativeAdapterRef: "native", capabilityEvidenceRef: "synthetic", retryPolicyVerified: true}];
    const effect = vi.fn();
    const invokeStructured = async (request: SkillClassificationRequestV1, _profile: ProviderProfile, _signal: AbortSignal, beforeDispatch?: () => void) => {
      await Promise.resolve(); beforeDispatch?.(); effect();
      return {response: {schemaVersion: "1.0.0" as const, requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: "SUCCESS" as const, judgments: [], unresolvedItems: [], error: null}, usage: unknownUsage(), dispatchState: "started" as const, diagnostics: null};
    };
    const runtime = createClassificationProviderRuntime(f.config, {nativeAdapters: new Map([["native", {capabilityEvidenceRef: "synthetic", retryPolicy: "no-retry", invokeStructured}]])});
    await expect(runtime.providers.jev.classify(f.request, f.profile, new AbortController().signal, () => {throw new ClassificationProviderError("STALE_CLASSIFICATION", "not-started");})).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(effect).not.toHaveBeenCalled();
  });
  it("keeps only canonical rate-limit observations and removes raw or malformed provider metadata", () => {
    expect(sanitizeRateLimitObservation({httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: 0}})).toEqual({httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: 0}});
    expect(sanitizeRateLimitObservation({httpStatus: 529, retryAfter: {kind: "http-date", at: "2026-10-09T00:00:00.000Z"}})).toEqual({httpStatus: 529, retryAfter: {kind: "http-date", at: "2026-10-09T00:00:00.000Z"}});
    expect(sanitizeRateLimitObservation({httpStatus: 429, retryAfter: null})).toEqual({httpStatus: 429, retryAfter: null});
    for (const value of [null, [], {httpStatus: 500, retryAfter: null}, {httpStatus: 429, retryAfter: null, body: "PRIVATE_SENTINEL"}, {httpStatus: 429, retryAfter: "PRIVATE_SENTINEL"}, {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: -1}}, {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: Number.MAX_SAFE_INTEGER + 1}}, {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: 1, header: "PRIVATE_SENTINEL"}}, {httpStatus: 429, retryAfter: {kind: "http-date", at: "2026-10-09"}}]) expect(sanitizeRateLimitObservation(value)).toBeNull();
  });
  it("SS19 explicit configuration preserves OFF zero JEV credential lookups", async () => {
    const f = fixture(); const key = vi.fn(async () => "SECRET_SENTINEL"); const fetcher = vi.fn<typeof fetch>();
    const runtime = createClassificationProviderRuntime(f.config, {getCredentialByEnvName: key, fetcher});
    const service = new SkillClassificationService(runtime);
    await service.classify({request: f.request, config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 50}, registry: {schemaVersion: "1.0.0", profileRevision: "p1", profiles: [f.profile]}, currentVendorId: "current-vendor"});
    expect(key).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
  it("SS21 resolves only the configured credential environment name and performs the real adapter transform", async () => {
    const f = fixture(); const key = vi.fn(async () => "SECRET_SENTINEL"); const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({model: "fixed-jev", answers: {}, usage: {input_tokens: 1, output_tokens: 1}})));
    const runtime = createClassificationProviderRuntime(f.config, {getCredentialByEnvName: key, fetcher});
    const provider = runtime.providers.jev; expect((await provider.availability(f.profile)).available).toBe(true);
    const evaluation = await provider.classify(f.request, f.profile, new AbortController().signal);
    expect(key).toHaveBeenCalledWith("EXPLICIT_FIXTURE_CREDENTIAL_NAME"); expect(fetcher).toHaveBeenCalledTimes(1);
    expect(evaluation.response.status).toBe("SUCCESS"); expect(JSON.stringify(evaluation)).not.toContain("SECRET_SENTINEL");
  });
  it("SS39 missing adapters and unverified native retry policies are unavailable without credential or transport", async () => {
    const f = fixture(); const common = f.config.routes[0]!;
    const native = {routeRef: common.routeRef, approvalRef: common.approvalRef, approved: true, providerKind: "jev" as const, vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, kind: "native" as const, nativeAdapterRef: "observed-native", capabilityEvidenceRef: "evidence", retryPolicyVerified: false};
    f.config.routes = [native]; const invokeStructured = vi.fn();
    let runtime = createClassificationProviderRuntime(f.config, {nativeAdapters: new Map([["observed-native", {capabilityEvidenceRef: "evidence", retryPolicy: "no-retry", invokeStructured}]])});
    expect((await runtime.providers.jev.availability(f.profile)).available).toBe(false); expect(invokeStructured).not.toHaveBeenCalled();
    native.retryPolicyVerified = true; runtime = createClassificationProviderRuntime(f.config); expect((await runtime.providers.jev.availability(f.profile)).available).toBe(false);
  });
  it("SS39 evidence-bound native callback is invoked once; a callback is not free-form success", async () => {
    const f = fixture(); f.config.routes = [{routeRef: "approved", approvalRef: "approved-host-route", approved: true, providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, kind: "native", nativeAdapterRef: "native", capabilityEvidenceRef: "evidence", retryPolicyVerified: true}];
    const invokeStructured = vi.fn(async () => ({response: {schemaVersion: "1.0.0" as const, requestId: "r", operationId: "o", requestDigest: f.request.requestDigest, inventoryDigest: f.request.inventoryDigest, status: "SUCCESS" as const, judgments: [], unresolvedItems: [], error: null}, usage: unknownUsage(), dispatchState: "started" as const, diagnostics: null}));
    const runtime = createClassificationProviderRuntime(f.config, {nativeAdapters: new Map([["native", {capabilityEvidenceRef: "evidence", retryPolicy: "no-retry", invokeStructured}]])});
    expect((await runtime.providers.jev.availability(f.profile)).routeKind).toBe("native"); await runtime.providers.jev.classify(f.request, f.profile, new AbortController().signal); expect(invokeStructured).toHaveBeenCalledTimes(1);
  });
  it("SS33 rejects inline keys, duplicate route IDs and credential-bearing endpoints", () => {
    const f = fixture(); expect(() => createClassificationProviderRuntime({...f.config, apiKey: "SECRET_SENTINEL"})).toThrow();
    f.config.routes.push(f.config.routes[0]!); expect(() => createClassificationProviderRuntime(f.config)).toThrow("DUPLICATE_CLASSIFICATION_ROUTE");
    f.config.routes.pop(); const route = f.config.routes[0]!; if (route.kind === "remote") route.endpoint = "https://name:secret@approved.example.invalid/";
    expect(() => createClassificationProviderRuntime(f.config)).toThrow("INVALID_APPROVED_ENDPOINT");
  });
});
