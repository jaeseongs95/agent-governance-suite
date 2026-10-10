import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {Ajv2020} from "ajv/dist/2020.js";
import addFormatsModule, {type FormatsPlugin} from "ajv-formats";
import {createProviderEvaluationConfiguration, isProviderEvaluationConfiguration, validateProviderEvaluationConfiguration} from "../../mcp-server/src/skill-classification/evaluation-config.js";
import {digestProviderProfileConfiguration, isProviderProfileRegistry, validateProviderProfile} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderConfiguration, ProviderProfile, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

const inventory = {inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "test-taxonomy"};
const configuration: ProviderConfiguration = {profileId: "offline-evaluation", providerKind: "jev", vendorId: "offline", modelId: "offline", modelRevision: "offline-r1",
  reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "offline-route", qualificationRevision: "not-run",
  adapterRevision: "offline-adapter", promptRevision: "offline-prompt", maximumInputBytes: 10000, maximumOutputTokens: 1000, maximumCostUsd: .001, judgmentPolicy: {neededAt: .8, notNeededAt: .2}};
const create = () => createProviderEvaluationConfiguration(configuration, inventory, "2000-01-01T00:00:00.000Z");
const ajv = new Ajv2020({strict: true}); (addFormatsModule as unknown as FormatsPlugin)(ajv);
const schema = ajv.compile(JSON.parse(readFileSync(new URL("../../contracts/skill-classification-evaluation-configuration.v1.schema.json", import.meta.url), "utf8")));

describe("nonexpiring preparation remains separate from production qualification", () => {
  it("authors a bound NOT_RUN definition without qualification or expiry and preserves the provenance", () => {
    const value = create();
    expect(schema(value)).toBe(true); expect(isProviderEvaluationConfiguration(value)).toBe(true);
    expect(validateProviderEvaluationConfiguration(value, inventory)).toBeNull();
    expect(value.preparedAt).toBe("2000-01-01T00:00:00.000Z");
    expect(Object.hasOwn(value.configuration, "qualification")).toBe(false);
    expect(Object.hasOwn(value.evaluationState, "validUntil")).toBe(false);
    expect(isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "test", profiles: [value.configuration]})).toBe(false);
    configuration.modelId = "changed-after-authoring";
    expect(value.configuration.modelId).toBe("offline"); configuration.modelId = "offline";
  });
  it.each(["inventoryDigest", "taxonomyRevision"] as const)("binds %s instead of accepting a prepared definition for another inventory", key => {
    const other = {...inventory, [key]: key === "inventoryDigest" ? `sha256:${"b".repeat(64)}` : "other"};
    expect(validateProviderEvaluationConfiguration(create(), other)).toBe("EVALUATION_BINDING_MISMATCH");
  });
  it.each(["modelRevision", "promptRevision", "maximumInputBytes", "approvedRouteRef"] as const)("rejects configuration mutation %s", key => {
    const value = create(); (value.configuration as unknown as Record<string, unknown>)[key] = typeof value.configuration[key] === "number" ? 1 : "other";
    expect(isProviderEvaluationConfiguration(value)).toBe(false);
  });
  it.each(["PASS", "FAIL"])("cannot mint evaluation status %s", status => {
    const value = {...create(), evaluationState: {...create().evaluationState, status}};
    expect(schema(value)).toBe(false); expect(isProviderEvaluationConfiguration(value)).toBe(false);
  });
  it("rejects omitted/fabricated expiry, production fields and malformed provenance", () => {
    for (const value of [{...create(), validUntil: null}, {...create(), evaluationState: {...create().evaluationState, validUntil: "2000-01-01T00:00:00.000Z"}},
      {...create(), productionRegistryUsable: true}, {...create(), configuration: {...configuration, qualification: {status: "PASS"}}}, {...create(), preparedAt: "Infinity"}]) {
      expect(schema(value)).toBe(false); expect(isProviderEvaluationConfiguration(value)).toBe(false);
    }
  });
  it("retains production NOT_RUN rejection, valid PASS and real qualification expiry", () => {
    const profile: ProviderProfile = {...configuration, qualification: {status: "NOT_RUN", ...inventory, modelRevision: configuration.modelRevision,
      promptRevision: configuration.promptRevision, validUntil: "2026-10-10T01:00:00.000Z", profileConfigurationDigest: digestProviderProfileConfiguration(configuration)}};
    const request = {...inventory} as SkillClassificationRequestV1;
    const before = Date.parse("2026-10-10T00:00:00.000Z"), after = Date.parse("2026-10-10T02:00:00.000Z");
    expect(validateProviderProfile(profile, request, before)).toBe("PROFILE_UNQUALIFIED");
    profile.qualification.status = "PASS";
    expect(validateProviderProfile(profile, request, before)).toBeNull();
    expect(validateProviderProfile(profile, request, after)).toBe("QUALIFICATION_EXPIRED");
  });
});
