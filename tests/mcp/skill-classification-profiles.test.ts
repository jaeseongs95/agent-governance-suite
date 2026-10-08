import {describe, expect, it} from "vitest";
import {digestProviderProfileConfiguration, estimateTokenCostUsd, isProviderProfileRegistry, selectFixedProfile, validateProviderProfile} from "../../mcp-server/src/skill-classification/profiles.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import type {ProviderProfile, ProviderProfileRegistry} from "../../mcp-server/src/skill-classification/types.js";
import {readFileSync} from "node:fs";
import {Ajv2020} from "ajv/dist/2020.js";

const request = createClassificationRequest({requestId: "r", operationId: "o", originalPrompt: "공개 합성 입력", inventory: {skills: [], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}, classificationCriteriaRef: "criteria"});
function profile(vendorId = "vendor-a", profileId = vendorId): ProviderProfile {
  const value: ProviderProfile = {profileId, providerKind: "vendor", vendorId, modelId: `${vendorId}-model`, modelRevision: "m1", reasoningEffort: "low", supportedOptions: {structuredOutput: true, reasoningEfforts: ["low"]}, approvedRouteRef: "approved", qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: "t1", modelRevision: "m1", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 10000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
  return value;
}
function requalifyFixtureProfile(value: ProviderProfile, revision: string) {
  // Synthetic records for another validation boundary; this is not real model quality evidence.
  value.qualificationRevision = revision;
  value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
}
describe("qualified fixed profiles and offline cost review", () => {
  it("SS39 selects only the current vendor; absent and ambiguous profiles do not invent defaults", () => {
    const registry: ProviderProfileRegistry = {schemaVersion: "1.0.0", profileRevision: "1", profiles: [profile(), profile("vendor-b")]};
    expect(selectFixedProfile(registry, "vendor", "vendor-a")?.modelId).toBe("vendor-a-model");
    expect(selectFixedProfile(registry, "vendor", "vendor-b")?.modelId).toBe("vendor-b-model");
    expect(selectFixedProfile(registry, "vendor", "unknown")).toBeNull();
    registry.profiles.push(profile("vendor-a", "another")); expect(selectFixedProfile(registry, "vendor", "vendor-a")).toBeNull();
  });
  it.each(["inventoryDigest", "taxonomyRevision", "modelRevision", "promptRevision"] as const)("SS39 qualification binding mismatch %s is rejected", field => {
    const p = profile(); p.qualification[field] = "other"; expect(validateProviderProfile(p, request, Date.parse("2026-01-01"))).toBe("QUALIFICATION_MISMATCH");
  });
  it("SS39 removes unqualified, expired and unsupported candidates without model promotion", () => {
    const p = profile(); expect(validateProviderProfile(p, request, Date.parse("2026-01-01"))).toBeNull();
    p.qualification.status = "FAIL"; expect(validateProviderProfile(p, request, 0)).toBe("PROFILE_UNQUALIFIED");
    p.qualification.status = "PASS"; p.reasoningEffort = "high"; requalifyFixtureProfile(p, "synthetic-unsupported-effort"); expect(validateProviderProfile(p, request, 0)).toBe("UNSUPPORTED_OPTIONS");
    p.reasoningEffort = "low"; requalifyFixtureProfile(p, "synthetic-expired"); p.qualification.validUntil = "2000-01-01T00:00:00Z"; expect(validateProviderProfile(p, request, Date.parse("2026-01-01"))).toBe("QUALIFICATION_EXPIRED");
  });
  it("SS39 unknown costs remain unknown; NaN and duplicate profile IDs reject the registry", () => {
    const p = profile(); p.maximumCostUsd = null; requalifyFixtureProfile(p, "synthetic-unknown-cost"); expect(validateProviderProfile(p, request, 0)).toBe("COST_UNKNOWN");
    p.maximumCostUsd = NaN; expect(isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "1", profiles: [p]})).toBe(false);
    expect(isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "1", profiles: [profile(), profile()]})).toBe(false);
  });
  it("SS39 cost oracle includes uncached/cache/output independently and changes the cheaper candidate", () => {
    const a = {uncachedInputUsdPer1k: 2, cachedInputUsdPer1k: 0.2, outputUsdPer1k: 1};
    const b = {uncachedInputUsdPer1k: 1, cachedInputUsdPer1k: 0.8, outputUsdPer1k: 5};
    expect(estimateTokenCostUsd(a, 1000, 800, 100)).toBeCloseTo(0.66);
    expect(estimateTokenCostUsd(b, 1000, 800, 100)).toBeCloseTo(1.34);
    expect(estimateTokenCostUsd(a, 1000, 0, 100)).toBeCloseTo(2.10);
    expect(estimateTokenCostUsd(b, 1000, 0, 100)).toBeCloseTo(1.50);
    expect(estimateTokenCostUsd({...a, cachedInputUsdPer1k: null}, 1000, 800, 100)).toBeNull();
    expect(estimateTokenCostUsd(a, 1, 2, 0)).toBeNull();
  });
  it("PRE profile fingerprint binds the full configuration and includes qualificationRevision", () => {
    const p = profile(); const digest = digestProviderProfileConfiguration(p);
    const reordered = Object.fromEntries(Object.entries(p).reverse()) as unknown as ProviderProfile;
    expect(digestProviderProfileConfiguration(reordered)).toBe(digest);
    p.qualification.status = "NOT_RUN"; expect(digestProviderProfileConfiguration(p)).toBe(digest);
    expect(validateProviderProfile(p, request, 0)).toBe("PROFILE_UNQUALIFIED");
    p.qualificationRevision = "new-evaluation"; expect(digestProviderProfileConfiguration(p)).not.toBe(digest);
    p.qualification.status = "PASS"; expect(validateProviderProfile(p, request, 0)).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
  });
  const changes: [string, (p: ProviderProfile) => void][] = [
    ["model ID", p => {p.modelId = "new-model";}],
    ["model revision", p => {p.modelRevision = "m2";}],
    ["lower effort", p => {p.reasoningEffort = "low";}],
    ["supported options", p => {p.supportedOptions.reasoningEfforts.push("medium");}],
    ["adapter revision", p => {p.adapterRevision = "a2";}],
    ["prompt revision", p => {p.promptRevision = "p2";}],
    ["judgment policy", p => {p.judgmentPolicy = {neededAt: 0.9, notNeededAt: 0.1};}],
    ["approved route", p => {p.approvedRouteRef = "another-approved-route";}],
    ["input ceiling", p => {p.maximumInputBytes++;}],
    ["output ceiling", p => {p.maximumOutputTokens++;}],
    ["cost ceiling", p => {p.maximumCostUsd = 0.5;}],
    ["qualification revision", p => {p.qualificationRevision = "q2";}],
  ];
  it.each(changes)("PRE old PASS cannot qualify changed %s", (label, change) => {
    const p = profile();
    if (label === "lower effort") {p.reasoningEffort = "high"; p.supportedOptions.reasoningEfforts = ["high", "low"]; requalifyFixtureProfile(p, "synthetic-high-qualified");}
    expect(validateProviderProfile(p, request, 0)).toBeNull(); const oldFingerprint = p.qualification.profileConfigurationDigest;
    change(p);
    expect(p.qualification.status).toBe("PASS"); expect(p.qualification.profileConfigurationDigest).toBe(oldFingerprint);
    expect(isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "registry", profiles: [p]})).toBe(true);
    expect(validateProviderProfile(p, request, 0)).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
  });
  it("PRE missing or malformed fingerprints fail the closed registry/schema contract", () => {
    const schema = JSON.parse(readFileSync(new URL("../../contracts/skill-classification-provider-profiles.v1.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({strict: false, validateFormats: false}).compile(schema);
    const registry = {schemaVersion: "1.0.0", profileRevision: "registry", profiles: [profile()]};
    expect(validate(registry)).toBe(true);
    const missing = structuredClone(registry) as unknown as {profiles: {qualification: Record<string, unknown>}[]};
    delete missing.profiles[0]!.qualification.profileConfigurationDigest;
    expect(validate(missing)).toBe(false); expect(isProviderProfileRegistry(missing)).toBe(false);
    registry.profiles[0]!.qualification.profileConfigurationDigest = "not-a-digest";
    expect(validate(registry)).toBe(false); expect(isProviderProfileRegistry(registry)).toBe(false);
  });
  it("PRE PASS alone cannot revive a changed policy with the old configuration fingerprint", () => {
    const p = profile(); p.qualification.status = "NOT_RUN"; p.judgmentPolicy = {neededAt: 0.9, notNeededAt: 0.1}; p.qualification.status = "PASS";
    expect(validateProviderProfile(p, request, 0)).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
  });
  it("PRE explicit new synthetic qualification binds new configuration without bypassing workload checks", () => {
    const p = profile(); p.adapterRevision = "a2";
    expect(validateProviderProfile(p, request, 0)).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
    requalifyFixtureProfile(p, "synthetic-adapter-reevaluated"); expect(validateProviderProfile(p, request, 0)).toBeNull();
    p.qualification.inventoryDigest = "different-inventory"; expect(validateProviderProfile(p, request, 0)).toBe("QUALIFICATION_MISMATCH");
  });
});
