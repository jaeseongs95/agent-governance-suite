import {afterAll, describe, expect, it, vi} from "vitest";
import {readFileSync, writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationRequest, digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {createClassificationProviderRuntime} from "../../mcp-server/src/skill-classification/runtime.js";
import {buildVendorMessages} from "../../mcp-server/src/skill-classification/providers.js";
import {SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {validateClassificationResponse} from "../../mcp-server/src/skill-classification/validation.js";
import {oracleDigest} from "../skill-classification/evaluation.js";
import type {ProviderProfile, ProviderEvaluation, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// SS20 only. The SS03 prompt is SS20's embedded input; no SS03 execution/scoring.
// Production runtime/service/gateway execute; fetch, credentials, qualification and balances are synthetic.
// No signed observation, host receipt, external request, CLI invocation or product mutation is made.
const root = process.cwd();
const out = process.env.SS20_EVIDENCE_DIR ?? "SS20-reproduction-output";
const fixtureBytes = readFileSync(`${root}/tests/skill-classification/fixtures.json`);
const corpus = JSON.parse(fixtureBytes.toString("utf8"));
const ss20 = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS20");
const ss03 = corpus.cases.find((c: {caseId: string}) => c.caseId === "SS03");
const required = ["ponytail", "cs-engineering", "test-engineering", "orchestrator"];
if (createHash("sha256").update(fixtureBytes).digest("hex") !== "17ade7e27cc11ffee8cc0b7b2070785617861d4c3384448cf24fce75f40d87e9") throw Error("FIXTURE_MISMATCH");
if (oracleDigest(corpus) !== "sha256:5db1d67cef8719c40b17b0ab07003f01f765746d34ced0b326e59fadb2efe055") throw Error("ORACLE_MISMATCH");
if (ss20.originalPrompt !== null || ss20.oracle !== null) throw Error("OPERATING_CASE_CHANGED");
if (JSON.stringify(ss20.variants) !== JSON.stringify(["normal", "missing-profile", "unavailable-model", "unsupported-option"])) throw Error("VARIANT_MISMATCH");
const records: Record<string, unknown>[] = [];
afterAll(() => writeFileSync(`${out}/observations.json`, JSON.stringify({caseId: "SS20", executionKind: "offline-mock", API0: true,
  source: ss20, inputReference: {caseId: "SS03", purpose: "SS20 specified input only", originalPrompt: ss03.originalPrompt},
  semanticAccuracy: null, selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN", records}, null, 2)));

async function fixture(variant: string) {
  const inventory = await loadSkillInventory({root});
  expect(inventory.issues).toEqual([]);
  expect(inventory.skills.map(s => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
  const intake = {schemaVersion: "1.0.0", requestId: `SS20-${variant}`, operationId: `SS20-${variant}`, originalPrompt: ss03.originalPrompt,
    confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
    contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "SS20-synthetic-vendor", reference: "SS20-offline-input"}, publicSynthetic: true};
  const request = createClassificationRequest({requestId: intake.requestId, operationId: intake.operationId, originalPrompt: intake.originalPrompt,
    confirmedContext: intake.confirmedContext, contextSources: intake.contextSources, inventory, classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
  const profile: ProviderProfile = {profileId: "SS20-synthetic-vendor", providerKind: "vendor", vendorId: "SS20-synthetic-vendor", modelId: "SS20-fixed-model", modelRevision: "SS20-fixed-model", reasoningEffort: "low",
    supportedOptions: {reasoningEfforts: ["low"], structuredOutput: true}, approvedRouteRef: "SS20-vendor-route", qualificationRevision: "SS20-SYNTHETIC-NOT-LIVE-QUALIFICATION",
    qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: "SS20-fixed-model", promptRevision: "SS20-p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
    adapterRevision: "SS20-a1", promptRevision: "SS20-p1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: null};
  const requalify = () => profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  requalify();
  const jevProfile: ProviderProfile = {...structuredClone(profile), profileId: "SS20-jev", providerKind: "jev", vendorId: "typesafe", modelId: "SS20-jev-fixed", modelRevision: "SS20-jev-fixed", reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "SS20-jev-route", judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
  jevProfile.qualification.modelRevision = jevProfile.modelRevision;
  jevProfile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(jevProfile);
  const vendorRoute = {routeRef: profile.approvedRouteRef, approvalRef: "SS20-SYNTHETIC-APPROVAL", approved: true, providerKind: "vendor" as const, vendorId: profile.vendorId,
    adapterRevision: profile.adapterRevision, modelIds: [profile.modelId], reasoningEfforts: ["low"], structuredOutput: true, kind: "remote" as const,
    endpoint: "https://SS20-offline.example.invalid/classify", credentialEnvName: "SS20_SYNTHETIC_VENDOR", wireAdapterRef: "SS20-fixture-vendor"};
  const runtimeRaw = {schemaVersion: "1.0.0", routes: [vendorRoute, {...vendorRoute, routeRef: jevProfile.approvedRouteRef, providerKind: "jev", vendorId: "typesafe", modelIds: [jevProfile.modelId], reasoningEfforts: [null], credentialEnvName: "SS20_SYNTHETIC_JEV", wireAdapterRef: "jev-noul-v1"}],
    budget: {jev: {limitUsd: 5, spentUsd: 0}, vendors: {[profile.vendorId]: {limitUsd: 2 as number | null, spentUsd: 0 as number | null}}, nativeAllowances: {}}};
  const settings = {config: {jevEnabled: false, mode: "select" as const, providerProfileRegistryRef: "SS20-offline-profiles", externalClassificationAllowed: true, configRevision: "SS20-c1", timeoutMs: 1000},
    registry: {schemaVersion: "1.0.0" as const, profileRevision: "SS20-pr1", profiles: [jevProfile, profile]}, allowRemotePrivateContent: false, approvedPublicRequestDigests: [request.requestDigest]};
  const responseFor = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest,
    status: "SUCCESS", judgments: req.skills.map(s => ({skillId: s.skillId, judgment: required.includes(s.skillId) ? "needed" : "not-needed", reasonRefs: ["SS20-synthetic-injection"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: 100, outputTokens: 80, cachedInputTokens: null, actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const credential = vi.fn(async (name: string) => name === "SS20_SYNTHETIC_VENDOR" ? "<REDACTED_SYNTHETIC_KEY>" : (() => {throw Error("JEV_KEY_LOOKUP_FORBIDDEN");})());
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(responseFor(request)), {status: 200}));
  const encode = vi.fn((req: SkillClassificationRequestV1, p: ProviderProfile) => ({model: p.modelId, reasoning: p.reasoningEffort, max_output_tokens: p.maximumOutputTokens, messages: buildVendorMessages(req)}));
  const decode = vi.fn((body: unknown) => body as ProviderEvaluation);
  if (variant === "missing-profile") settings.registry.profiles = [jevProfile];
  if (variant === "unavailable-model") vendorRoute.modelIds = ["SS20-other-model"];
  if (variant === "unsupported-option") {profile.supportedOptions.reasoningEfforts = ["high"]; requalify();}
  if (variant === "route-option-mismatch") vendorRoute.reasoningEfforts = ["high"];
  if (variant === "qualification-missing") profile.qualification.status = "NOT_RUN";
  if (variant === "qualification-expired") profile.qualification.validUntil = "2000-01-01T00:00:00Z";
  if (variant === "route-unapproved") vendorRoute.approved = false;
  if (variant === "budget-unknown") runtimeRaw.budget.vendors[profile.vendorId].spentUsd = null;
  if (variant === "vendor-auth-failure") fetcher.mockImplementation(async () => new Response("ignored", {status: 401}));
  if (variant === "credential-missing") credential.mockResolvedValue(null as unknown as string);
  if (variant === "invalid-resp-known-cost") fetcher.mockImplementation(async () => {
    const body = responseFor(request); body.response.requestDigest = `sha256:${"0".repeat(64)}`; body.usage.actualCostUsd = 0.7;
    return new Response(JSON.stringify(body), {status: 200});
  });
  if (variant === "timeout-overflow") {
    settings.config.timeoutMs = 2_147_483_648;
    fetcher.mockImplementation(async (_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(Error("SS20-synthetic-abort")), {once: true})));
  }
  const runtime = createClassificationProviderRuntime(runtimeRaw, {fetcher, getCredentialByEnvName: credential, wireAdapters: new Map([["SS20-fixture-vendor", {encode, decode}]])});
  const jevAvailability = vi.spyOn(runtime.providers.jev, "availability"), jevClassify = vi.spyOn(runtime.providers.jev, "classify");
  const vendorAvailability = vi.spyOn(runtime.providers.vendor, "availability"), vendorClassify = vi.spyOn(runtime.providers.vendor, "classify");
  const service = new SkillClassificationService({...runtime, now: () => Date.parse("2026-10-09T00:00:00Z")});
  const gateway = new RuntimeSkillClassificationGateway({root, service, readRuntime: async () => settings});
  return {inventory, intake, request, profile, settings, runtimeRaw, runtime, gateway, credential, fetcher, encode, decode, jevAvailability, jevClassify, vendorAvailability, vendorClassify};
}

async function check(variant: string, expected: Record<string, unknown>, assertion: (f: Awaited<ReturnType<typeof fixture>>, result: any) => Promise<void> | void) {
  const f = await fixture(variant);
  const start = performance.now();
  const observed: any = await f.gateway.classify(f.intake);
  const wires = f.fetcher.mock.calls.map(([url, init]) => ({endpoint: String(url), method: init?.method, redirect: init?.redirect, headers: {authorization: "[REDACTED_SYNTHETIC]", "content-type": "application/json"}, body: JSON.parse(String(init?.body))}));
  const row: Record<string, unknown> = {variant, kind: ss20.variants.includes(variant) ? "required-variant" : "SS20-derived-boundary", executionKind: "offline-mock", expected,
    input: {intake: f.intake, config: f.settings.config, profiles: f.settings.registry, runtime: f.runtimeRaw},
    observed: {elapsedMs: performance.now() - start, classification: observed, responseValidationErrors: validateClassificationResponse(f.request, observed.result.response),
      counts: {jevAvailability: f.jevAvailability.mock.calls.length, jevClassify: f.jevClassify.mock.calls.length, jevCredential: f.credential.mock.calls.filter(([n]) => n === "SS20_SYNTHETIC_JEV").length,
        vendorAvailability: f.vendorAvailability.mock.calls.length, vendorClassify: f.vendorClassify.mock.calls.length, vendorCredential: f.credential.mock.calls.filter(([n]) => n === "SS20_SYNTHETIC_VENDOR").length, mockFetch: f.fetcher.mock.calls.length},
      wires, decodedProviderEvaluations: f.decode.mock.results.filter(r => r.type === "return").map(r => r.value),
      budget: f.runtime.budget.snapshot(), selected: "NOTRUN", read: "NOTRUN", applied: "NOTRUN", verified: "NOTRUN", agentSelectedSkillIds: observed.agentSelectedSkillIds, hostReceipt: null},
    API0: {jev: 0, vendor: 0, claude: 0, host: 0}, status: "NOTRUN"};
  records.push(row);
  try {
    expect(f.jevAvailability).not.toHaveBeenCalled(); expect(f.jevClassify).not.toHaveBeenCalled();
    expect(f.credential.mock.calls.filter(([n]) => n === "SS20_SYNTHETIC_JEV")).toEqual([]);
    expect(observed.agentSelectedSkillIds).toBeNull(); expect(observed.selectionStatus).toBe("PROPOSED"); expect(observed.adviceApplied).toBe(false);
    expect(validateClassificationResponse(f.request, observed.result.response)).toEqual([]);
    expect(observed.result.attempts.every((a: {providerKind: string}) => a.providerKind === "vendor")).toBe(true);
    expect(f.settings.config.jevEnabled).toBe(false);
    await assertion(f, observed);
    row.status = "PASS";
  } catch (error) {
    row.status = "FAIL"; row.assertionError = error instanceof Error ? error.message : String(error); throw error;
  }
}

describe("SS20 vendor separation: four frozen variants", () => {
  it.each(["normal", "missing-profile", "unavailable-model", "unsupported-option"])("SS20 %s", async variant => {
    const errorCodes: Record<string, string | null> = {normal: null, "missing-profile": "PROFILE_UNAVAILABLE", "unavailable-model": "ROUTE_CAPABILITY_MISMATCH", "unsupported-option": "UNSUPPORTED_OPTIONS"};
    await check(variant, {status: variant === "normal" ? "SUCCESS" : "UNAVAILABLE", errorCode: errorCodes[variant], vendorTransport: variant === "normal" ? 1 : 0, jevCalls: 0, model: "SS20-fixed-model", effort: "low", selected: null}, async (f, observed) => {
      expect(observed.result.response.status).toBe(variant === "normal" ? "SUCCESS" : "UNAVAILABLE");
      expect(observed.result.response.error?.code ?? null).toBe(errorCodes[variant]);
      expect(f.fetcher).toHaveBeenCalledTimes(variant === "normal" ? 1 : 0);
      if (variant === "normal") {
        expect(observed.result.response.judgments.filter((j: {judgment: string}) => j.judgment === "needed").map((j: {skillId: string}) => j.skillId).sort()).toEqual([...required].sort());
        expect(observed.result.response.judgments).toHaveLength(f.inventory.skills.length);
        const wire = JSON.parse(String(f.fetcher.mock.calls[0][1]?.body));
        expect(wire.model).toBe(f.profile.modelId); expect(wire.reasoning).toBe(f.profile.reasoningEffort); expect(wire.max_output_tokens).toBe(f.profile.maximumOutputTokens);
        const user = JSON.parse(wire.messages[1].content);
        expect(user.originalPrompt).toBe(ss03.originalPrompt);
        expect(user.confirmedContext).toEqual(f.intake.confirmedContext);
        expect(user.skills.map((s: {skillId: string}) => s.skillId).sort()).toEqual([...corpus.inventorySkillIds].sort());
        expect(user.requestDigest).toBe(f.request.requestDigest); expect(user.inventoryDigest).toBe(f.inventory.inventoryDigest);
        expect(observed.result.attempts).toMatchObject([{profileId: f.profile.profileId, modelId: f.profile.modelId, reasoningEffort: "low", status: "SUCCESS"}]);
        expect(f.runtime.budget.snapshot().limits[`vendor:${f.profile.vendorId}`].spentUsd).toBe(0.1);
        // This is an explicitly synthetic attempted copy; no runtime host observation or receipt is forged.
        const attemptedCopy = {schemaVersion: "1.0.0", classificationResponseRef: digestClassificationValue(observed.result.response), requestDigest: f.request.requestDigest, inventoryDigest: f.request.inventoryDigest,
          taskRevision: null, configRevision: f.settings.config.configRevision, profileRevision: f.settings.registry.profileRevision, explicitSkillIds: [], ruleRequiredSkillIds: [],
          agentSelectedSkillIds: required, selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [], selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null};
        const acceptance = await f.gateway.accept({schemaVersion: "1.0.0", operationId: f.intake.operationId, decision: attemptedCopy}, null);
        (records.at(-1)!.observed as Record<string, unknown>).syntheticUnobservedCopyRejection = acceptance;
        expect(acceptance).toMatchObject({valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null});
      } else {
        expect(observed.result.response.judgments).toEqual([]); // Empty advice is not a selected [] result.
        if (variant === "missing-profile" || variant === "unsupported-option") expect(f.vendorAvailability).not.toHaveBeenCalled();
        expect(f.credential).not.toHaveBeenCalled();
      }
    });
  });
});

describe("SS20 missing boundary coverage", () => {
  it.each([
    ["route-option-mismatch", "ROUTE_CAPABILITY_MISMATCH", 0],
    ["qualification-missing", "PROFILE_UNQUALIFIED", 0],
    ["qualification-expired", "QUALIFICATION_EXPIRED", 0],
    ["route-unapproved", "ROUTE_NOT_APPROVED", 0],
    ["budget-unknown", "BUDGET_UNAVAILABLE", 0],
    ["credential-missing", "CREDENTIAL_UNAVAILABLE", 0],
    ["vendor-auth-failure", "AUTH_UNAVAILABLE", 1],
  ] as const)("SS20 boundary %s", async (variant, errorCode, sends) => {
    await check(variant, {status: "UNAVAILABLE", errorCode, mockVendorSends: sends, jevCalls: 0, autoUpgrade: false, selected: null}, (f, observed) => {
      expect(observed.result.response.status).toBe("UNAVAILABLE"); expect(observed.result.response.error.code).toBe(errorCode);
      expect(f.fetcher).toHaveBeenCalledTimes(sends); expect(f.vendorClassify.mock.calls.length).toBeLessThanOrEqual(1);
      expect(observed.result.attempts.every((a: {modelId: string; reasoningEffort: string}) => a.modelId === "SS20-fixed-model" && a.reasoningEffort === "low")).toBe(true);
      expect(observed.result.response.judgments).toEqual([]);
    });
  });
});

describe("SS20 known-boundary defects: no duplicate root cause", () => {
  it("SS20 known-boundary invalid RESP preserves valid billed cost and invalidates breached ceiling", async () => {
    await check("invalid-resp-known-cost", {errorCode: "INVALID_PROVIDER_RESPONSE", spentUsd: 0.7, invalidCostCeilings: ["SS20-synthetic-vendor"], mockVendorSends: 1, jevCalls: 0,
      knownRootCause: "valid-cost-lost-with-invalid-RESP"}, (f, observed) => {
      expect(observed.result.response.error.code).toBe("INVALID_PROVIDER_RESPONSE"); expect(f.fetcher).toHaveBeenCalledTimes(1);
      expect(f.runtime.budget.snapshot().limits[`vendor:${f.profile.vendorId}`].spentUsd).toBe(0.7);
      expect(f.runtime.budget.snapshot().invalidCostCeilings).toContain(f.profile.profileId);
    });
  });
  it("SS20 known-boundary overflowing timer is rejected before vendor transport", async () => {
    await check("timeout-overflow", {errorCode: "INVALID_TIMEOUT", mockVendorSends: 0, jevCalls: 0, knownRootCause: "timeout-overflow"}, (f, observed) => {
      expect(observed.result.response.error.code).toBe("INVALID_TIMEOUT"); expect(f.fetcher).not.toHaveBeenCalled();
    });
  });
});
