import path from "node:path";
import {mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {createNativeClassificationAdapters, type NativeClassificationAdapterDefinition, type NativeCliBehavior, type NativeCliRunner} from "../../mcp-server/src/skill-classification/native-adapters.js";
import {bindNativeClassificationDefinitions} from "../../mcp-server/src/skill-classification/native-cli-strategies.js";
import {describe, expect, it, vi} from "vitest";
import {createClassificationProviderRuntime, loadClassificationProviderRuntime, reportClassificationInitializationFailure, type ClassificationProviderRuntimeConfig} from "../../mcp-server/src/skill-classification/runtime.js";
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
  it("reports actual runtime producer failures with closed reasons and no private configuration", async () => {
    const f = fixture(), report = vi.fn(), credential = vi.fn(), fetcher = vi.fn<typeof fetch>();
    const options = {getCredentialByEnvName: credential, fetcher};
    const duplicate = {...f.config, routes: [f.config.routes[0]!, f.config.routes[0]!]};
    const invalidEndpoint = {...f.config, routes: [{...f.config.routes[0]!, endpoint: "http://PRIVATE_ENDPOINT.example.invalid/PRIVATE_PATH"}]};
    for (const [config, reason] of [[duplicate, "DUPLICATE_CLASSIFICATION_ROUTE"], [invalidEndpoint, "INVALID_APPROVED_ENDPOINT"]] as const) {
      let failure: unknown;
      try {createClassificationProviderRuntime(config, options);} catch (error) {failure = error;}
      expect(failure).toBeInstanceOf(Error);
      reportClassificationInitializationFailure(failure, report);
      expect(report).toHaveBeenLastCalledWith({phase: "classification-initialization", reason});
    }
    const directory = await mkdtemp(path.join(tmpdir(), "ags-runtime-diagnostic-"));
    try {
      const file = path.join(directory, "PRIVATE_RUNTIME_FILE.json");
      await writeFile(file, " ".repeat(1024 * 1024 + 1), "utf8");
      let failure: unknown;
      try {await loadClassificationProviderRuntime(file, options);} catch (error) {failure = error;}
      expect(failure).toBeInstanceOf(Error);
      reportClassificationInitializationFailure(failure, report);
      expect(report).toHaveBeenLastCalledWith({phase: "classification-initialization", reason: "CLASSIFICATION_RUNTIME_TOO_LARGE"});
      expect(JSON.stringify(report.mock.calls)).not.toContain(directory);
    } finally {await rm(directory, {recursive: true, force: true});}
    expect(report).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(report.mock.calls)).not.toContain("PRIVATE_");
    expect(credential).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
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


describe("0186 native JSON data and trusted behavior consumption", () => {
  it.each(["success", "encoding-throws"])("carries third-host %s through registry, runtime, provider and service", async mode => {
    const f = fixture();
    const profile: ProviderProfile = {...f.profile, profileId: "third-vendor", providerKind: "vendor", vendorId: "native-fixture-vendor",
      modelId: "opaque-native-model", modelRevision: "opaque-native-model-r1", reasoningEffort: "e-next7",
      supportedOptions: {reasoningEfforts: ["e-next7"], structuredOutput: true}, maximumCostUsd: 0, judgmentPolicy: null,
      qualificationRevision: "native-fixture-q2", qualification: {...f.profile.qualification, modelRevision: "opaque-native-model-r1"}};
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    const data: NativeClassificationAdapterDefinition = {adapterId: "third-native", host: "neutral-cli-z9",
      executable: path.resolve("synthetic-only", "native.exe"), workingDirectory: path.resolve("synthetic-only"),
      approvalRef: "fixture-only-approval", capabilityEvidenceRef: "fixture-only-capability", retryPolicyVerified: true,
      retryPolicyEvidenceRef: "fixture-only-no-retry", isolationEvidenceRef: "fixture-only-isolation", isolationArgs: [],
      timeoutMs: 100, maximumOutputBytes: 64000};
    const response = {schemaVersion: "1.0.0", requestId: f.request.requestId, operationId: f.request.operationId,
      requestDigest: f.request.requestDigest, inventoryDigest: f.request.inventoryDigest, status: "SUCCESS", judgments: [], unresolvedItems: [], error: null};
    const behavior: NativeCliBehavior = {validateIsolationArgs: args => args.length === 0, canEncodeProfile: () => {
      if (mode === "encoding-throws") throw new TypeError("PRIVATE_ENCODING_SENTINEL");
      return true;
    },
      prepare: (_data, selected) => ({args: ["--structured", "--model", selected.modelId, "--effort", selected.reasoningEffort!]}),
      decode: output => ({response: JSON.parse(output.stdout), usage: {...unknownUsage(), inputTokens: 1, outputTokens: 1}})};
    const runner = vi.fn<NativeCliRunner>(async invocation => {
      expect(invocation.executable).toBe(data.executable); expect(invocation.cwd).toBe(data.workingDirectory);
      expect(invocation.args).toEqual(["--structured", "--model", profile.modelId, "--effort", "e-next7"]);
      return {stdout: JSON.stringify(response), exitCode: 0};
    });
    const definitions: NativeClassificationAdapterDefinition[] = JSON.parse(JSON.stringify([data]));
    const nativeAdapters = createNativeClassificationAdapters(bindNativeClassificationDefinitions(definitions, new Map([[data.host, behavior]])), runner);
    const config: ClassificationProviderRuntimeConfig = {schemaVersion: "1.0.0", routes: [{routeRef: profile.approvedRouteRef,
      approvalRef: "fixture-only-route", approved: true, providerKind: "vendor", vendorId: profile.vendorId, adapterRevision: profile.adapterRevision,
      modelIds: [profile.modelId], reasoningEfforts: ["e-next7"], structuredOutput: true, kind: "native",
      nativeAdapterRef: data.adapterId, capabilityEvidenceRef: data.capabilityEvidenceRef, retryPolicyVerified: true}],
      budget: {jev: {limitUsd: null, spentUsd: null}, vendors: {}, nativeAllowances: {[profile.profileId]: {approvalRef: "fixture-only-native-allowance", remainingCalls: 1}}}};
    const runtime = createClassificationProviderRuntime(config, {nativeAdapters});
    const result = await new SkillClassificationService(runtime).classify({request: f.request,
      config: {jevEnabled: false, mode: "select", providerProfileRegistryRef: "synthetic-profiles", externalClassificationAllowed: false, configRevision: "fixture-c1", timeoutMs: 1000},
      registry: {schemaVersion: "1.0.0", profileRevision: "fixture-p2", profiles: [profile]}, currentVendorId: profile.vendorId});
    if (mode === "success") {
      expect(result.response).toEqual(response);
      expect(result.attempts[0]?.usage).toMatchObject({inputTokens: 1, outputTokens: 1, actualCostUsd: null});
      expect(runner).toHaveBeenCalledTimes(1);
    } else {
      expect(result.response).toMatchObject({status: "UNAVAILABLE", error: {code: "NATIVE_PROFILE_ENCODING_UNAVAILABLE"}});
      expect(result.attempts[0]).toMatchObject({errorCode: "NATIVE_PROFILE_ENCODING_UNAVAILABLE", dispatchState: "not-started"});
      expect(JSON.stringify(result)).not.toContain("PRIVATE_ENCODING_SENTINEL");
      expect(runtime.budget.snapshot().reservations).toHaveLength(0);
      expect(runtime.budget.snapshot().nativeAllowances[profile.profileId]!.remainingCalls).toBe(1);
      expect(runner).not.toHaveBeenCalled();
    }
    runner.mockClear();
    expect(() => createNativeClassificationAdapters(bindNativeClassificationDefinitions(definitions), runner))
      .toThrow("NATIVE_ADAPTER_BEHAVIOR_UNAVAILABLE");
    const noRetry: ClassificationProviderRuntimeConfig = {...config, routes: config.routes.map(route =>
      route.kind === "native" ? {...route, retryPolicyVerified: false} : route)};
    expect((await createClassificationProviderRuntime(noRetry, {nativeAdapters}).providers.vendor.availability(profile)).available).toBe(false);
    expect(runner).not.toHaveBeenCalled();
    // Synthetic authority/support only: no real host/profile qualification or live CLI support is established.
  });
});
