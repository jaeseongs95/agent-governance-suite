import {describe, expect, it, vi} from "vitest";
import {fileURLToPath} from "node:url";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, jevNoulWireAdapter,
  JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION,
  jevSkillSelectionChoiceLongContextWireAdapter, JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION,
  resolveClassificationWireAdapter, type ClassificationWireAdapter} from "../../mcp-server/src/skill-classification/providers.js";
import {validateProviderProfile, digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {createClassificationRequest, digestClassificationValue} from "../../mcp-server/src/skill-classification/request.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import {createClassificationProviderRuntime} from "../../mcp-server/src/skill-classification/runtime.js";
import {RuntimeSkillClassificationGateway} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {loadHostObservedInventory, type HostSkillDiscoverySnapshot} from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import type {ExecutionContextV1} from "../../contracts/types.js";
import type {ProviderConfiguration, ProviderProfile, SkillInventory, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";

const revision = "fixture-independent-protocol-r7", prompt = "fixture:independent-meaning";
const oneSkill: SkillInventory = {skills: [{skillId: "review", version: "1", description: "Read a supplied diff", enabled: true, installed: true, hostSupported: true,
  capabilities: ["review"], actions: ["read"], targets: ["diff"], constraints: [], applicability: ["supplied diff"], exclusions: ["no diff"], dependencies: [], phases: [], sourceRefs: []}],
  inventoryDigest: "sha256:" + "a".repeat(64), taxonomyRevision: "fixture" , issues: []};
function fixture(inventory = oneSkill) {
  const request = createClassificationRequest({requestId: "bound-request", operationId: "bound-operation", originalPrompt: "Read this diff", inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md"});
  const profile: ProviderProfile = {profileId: "independent", providerKind: "jev", vendorId: "fixture", modelId: "fixture-model", modelRevision: "fixture-model-r1",
    reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "fixture:approved", qualificationRevision: "synthetic-only",
    qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "fixture-model-r1", promptRevision: prompt,
      validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: revision, promptRevision: prompt,
    maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: .1, judgmentPolicy: null};
  requalify(profile);
  const state = {allowed: true};
  // Trusted installation code supplies this policy. It is absent from every JSON profile/schema.
  const validate = vi.fn((value: ProviderConfiguration) => state.allowed && value.adapterRevision === revision && value.promptRevision === prompt
    && value.judgmentPolicy === null && value.reasoningEffort === null ? null : "UNSUPPORTED_OPTIONS");
  const adapter: ClassificationWireAdapter = {validateConfiguration: validate, encode: () => ({}), decode: (_body, req) => ({
    response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest,
      status: "SUCCESS", judgments: req.skills.map(skill => ({skillId: skill.skillId, judgment: "needed", reasonRefs: ["fixture:meaning"], uncertaintyReason: null})), unresolvedItems: [], error: null},
    usage: {inputTokens: 1, outputTokens: 1, cachedInputTokens: null, actualCostUsd: .01}, dispatchState: "started", diagnostics: null})};
  const credential = vi.fn(async () => "synthetic-only");
  const route = bindClassificationRouteTransport({routeRef: profile.approvedRouteRef, approvalRef: "fixture:approval", approved: true, kind: "remote", providerKind: profile.providerKind,
    vendorId: profile.vendorId, adapterRevision: revision, modelIds: [profile.modelId], reasoningEfforts: [null], structuredOutput: true,
    endpoint: "https://fixture.example.invalid/classify", getCredential: credential, adapter});
  const fetcher = vi.fn<typeof fetch>(async () => new Response("{}"));
  const provider = new ApprovedRouteClassificationProvider([route], fetcher);
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 1, spentUsd: 0}, vendors: {}});
  const service = new SkillClassificationService({providers: {jev: provider}, budget});
  const input = {request, config: {jevEnabled: true, mode: "select" as const, providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: true,
    configRevision: "fixture:c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0" as const, profileRevision: "fixture:p1", profiles: [profile]}, currentVendorId: "fixture"};
  return {request, profile, state, validate, adapter, route, credential, fetcher, provider, budget, service, input};
}
function requalify(profile: ProviderProfile) {profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);}

describe("trusted bound adapter protocol validation", () => {
  it("supports a new protocol without a common revision whitelist and keeps preflight pure", async () => {
    const f = fixture(), available = vi.spyOn(f.provider, "availability");
    // The old public inspection API cannot invent this installation-specific protocol.
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBe("UNSUPPORTED_OPTIONS");
    expect(f.service.hasNativeRoute(f.input)).toBe(false);
    expect(available).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    const result = await f.service.classify(f.input);
    expect(result.response.status).toBe("SUCCESS"); expect(result.response.judgments[0]!.judgment).toBe("needed");
    expect(f.service.validateProfile(f.profile, f.request)).toBeNull();
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(available).toHaveBeenCalledTimes(1);
    expect(f.budget.snapshot()).toMatchObject({limits: {jev: {spentUsd: .01}}, reservations: []});
  });
  it("uses the actual adapter instead of a profile's builtin Choice self-claim", async () => {
    const f = fixture(); f.profile.adapterRevision = JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION;
    f.profile.promptRevision = f.profile.qualification.promptRevision = JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION;
    requalify(f.profile);
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBeNull();
    expect(f.service.validateProfile(f.profile, f.request)).toBe("UNSUPPORTED_OPTIONS");
    expect((await f.service.classify(f.input)).response.error).not.toBeNull();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled();
  });
  it.each(["digest", "not-run", "fail", "expiry", "inventory", "prompt", "options", "cost"])("never lets an accepting adapter bypass common %s validation", variant => {
    const f = fixture(); f.adapter.validateConfiguration = () => null;
    const codes: Record<string, string> = {digest: "QUALIFICATION_CONFIGURATION_MISMATCH", "not-run": "PROFILE_UNQUALIFIED", fail: "PROFILE_UNQUALIFIED", expiry: "QUALIFICATION_EXPIRED",
      inventory: "QUALIFICATION_MISMATCH", prompt: "QUALIFICATION_MISMATCH", options: "UNSUPPORTED_OPTIONS", cost: "COST_UNKNOWN"};
    if (variant === "digest") f.profile.qualification.profileConfigurationDigest = "sha256:" + "0".repeat(64);
    if (variant === "not-run") f.profile.qualification.status = "NOT_RUN";
    if (variant === "fail") f.profile.qualification.status = "FAIL";
    if (variant === "expiry") f.profile.qualification.validUntil = "2000-01-01T00:00:00Z";
    if (variant === "inventory") f.profile.qualification.inventoryDigest = "other";
    if (variant === "prompt") f.profile.qualification.promptRevision = "other";
    if (variant === "options") {f.profile.supportedOptions.structuredOutput = false; requalify(f.profile);}
    if (variant === "cost") {f.profile.maximumCostUsd = null; requalify(f.profile);}
    expect(f.service.validateProfile(f.profile, f.request)).toBe(codes[variant]); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("fails closed when a trusted validator throws", async () => {
    const f = fixture(); f.adapter.validateConfiguration = () => {throw new Error("private-sentinel");};
    expect(f.service.validateProfile(f.profile, f.request)).toBe("UNSUPPORTED_OPTIONS");
    expect(JSON.stringify(await f.service.classify(f.input))).not.toContain("private-sentinel"); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("revalidates after availability and before reservation", async () => {
    const f = fixture(), reserve = vi.spyOn(f.budget, "reserve");
    vi.spyOn(f.provider, "availability").mockImplementation(async () => {f.state.allowed = false; return {available: true, approved: true, routeKind: "remote", reasonCode: null};});
    const result = await f.service.classify(f.input);
    expect(result.attempts[0]!.errorCode).toBe("UNSUPPORTED_OPTIONS"); expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("revalidates before dispatch and settles an unused reservation", async () => {
    const f = fixture(); f.adapter.encode = () => {f.state.allowed = false; return {};};
    const result = await f.service.classify(f.input);
    expect(result.attempts[0]).toMatchObject({errorCode: "STALE_CLASSIFICATION", dispatchState: "not-started", reservedCostUsd: .1});
    expect(f.budget.snapshot().reservations).toEqual([]); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects late successful advice when the bound protocol is no longer valid", async () => {
    const f = fixture(); f.fetcher.mockImplementation(async () => {f.state.allowed = false; return new Response("{}");});
    const result = await f.service.classify(f.input);
    expect(result.response).toMatchObject({status: "UNAVAILABLE", judgments: [], error: {code: "UNSUPPORTED_OPTIONS"}}); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("fences validator identity across credential await even when the replacement also accepts", async () => {
    const f = fixture(); f.credential.mockImplementation(async () => {f.adapter.validateConfiguration = () => null; return "synthetic-only";});
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("keeps credential-await cancellation closed", async () => {
    const f = fixture(), controller = new AbortController(); f.credential.mockImplementation(async () => {controller.abort(); return "synthetic-only";});
    await expect(f.provider.classify(f.request, f.profile, controller.signal)).rejects.toMatchObject({code: "CANCELLED"}); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("keeps the legacy v1 factory's a1 route alias", () => {
    expect(resolveClassificationWireAdapter("jev-noul-v1", {providerKind: "jev", adapterRevision: "a1"})).toBe(jevNoulWireAdapter);
  });
  it.each(["jev", "vendor"] as const)("lets a trusted registered %s protocol validate through the runtime factory", async kind => {
    const f = fixture(); f.profile.providerKind = kind; requalify(f.profile);
    const runtime = createClassificationProviderRuntime({schemaVersion: "1.0.0", routes: [{kind: "remote", routeRef: f.profile.approvedRouteRef, approvalRef: "fixture:approval", approved: true,
      providerKind: kind, vendorId: f.profile.vendorId, adapterRevision: revision, modelIds: [f.profile.modelId], reasoningEfforts: [null], structuredOutput: true,
      endpoint: "https://fixture.example.invalid/classify", credentialEnvName: "FIXTURE_UNUSED_ENV", wireAdapterRef: "fixture-registered-protocol"}],
      budget: {jev: {limitUsd: 1, spentUsd: 0}, vendors: {fixture: {limitUsd: 1, spentUsd: 0}}, nativeAllowances: {}}},
    {wireAdapters: new Map([["fixture-registered-protocol", f.adapter]]), fetcher: f.fetcher, getCredentialByEnvName: f.credential});
    const service = new SkillClassificationService(runtime), input = {...f.input, config: {...f.input.config, jevEnabled: kind === "jev"}};
    expect((await service.classify(input)).response.status).toBe("SUCCESS"); expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("does not use the legacy builtin lookup as authority for a port without its own hook", async () => {
    const f = fixture(); f.profile.adapterRevision = JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION;
    f.profile.promptRevision = f.profile.qualification.promptRevision = JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION; requalify(f.profile);
    const available = vi.spyOn(f.provider, "availability"), classify = vi.spyOn(f.provider, "classify");
    const port = {availability: available, classify};
    const service = new SkillClassificationService({providers: {jev: port}, budget: f.budget});
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBeNull();
    expect((await service.classify(f.input)).response.error).not.toBeNull(); expect(available).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("rejects a validator supplied as profile data and a non-null hook result", () => {
    const f = fixture(); Reflect.set(f.profile, "validateConfiguration", "profile-chosen-policy"); requalify(f.profile);
    expect(f.service.validateProfile(f.profile, f.request)).toBe("INVALID_PROFILE");
    Reflect.deleteProperty(f.profile, "validateConfiguration"); requalify(f.profile);
    Reflect.set(f.adapter, "validateConfiguration", () => undefined);
    expect(f.service.validateProfile(f.profile, f.request)).toBe("UNSUPPORTED_OPTIONS");
  });
  it("checks the service dispatch fence independently of provider-owned fences", async () => {
    const f = fixture(), sent = vi.fn();
    const port = {validateConfiguration: f.validate, availability: async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null}),
      classify: async (...args: Parameters<ApprovedRouteClassificationProvider["classify"]>) => {
        f.state.allowed = false; args[3]?.(); sent(); return f.adapter.decode({}, args[0], args[1]);
      }};
    const service = new SkillClassificationService({providers: {jev: port}, budget: f.budget});
    const result = await service.classify(f.input);
    expect(result.attempts[0]).toMatchObject({errorCode: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(sent).not.toHaveBeenCalled(); expect(f.budget.snapshot().reservations).toEqual([]);
  });
  it("does not authorize a new Choice protocol from native invokeStructured metadata alone", async () => {
    const f = fixture(); f.profile.adapterRevision = JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION;
    f.profile.promptRevision = f.profile.qualification.promptRevision = JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION; requalify(f.profile);
    const invokeStructured = vi.fn(async () => f.adapter.decode({}, f.request, f.profile));
    const native = new ApprovedRouteClassificationProvider([bindClassificationRouteTransport({kind: "native", routeRef: f.profile.approvedRouteRef, approvalRef: "fixture:approval", approved: true,
      providerKind: "jev", vendorId: f.profile.vendorId, adapterRevision: f.profile.adapterRevision, modelIds: [f.profile.modelId], reasoningEfforts: [null], structuredOutput: true, invokeStructured})]);
    const service = new SkillClassificationService({providers: {jev: native}, budget: f.budget});
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBeNull();
    expect(service.hasNativeRoute(f.input)).toBe(false);
    expect((await native.availability(f.profile)).available).toBe(true); // capability is distinct from protocol authority
    await expect(native.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(invokeStructured).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("pins reserved transport metadata when the trusted factory table is registered", () => {
    const adapter = jevSkillSelectionChoiceLongContextWireAdapter, descriptor = Object.getOwnPropertyDescriptor(adapter, "transport")!;
    try {
      Reflect.deleteProperty(adapter, "transport");
      expect(() => resolveClassificationWireAdapter(JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION,
        {providerKind: "vendor", adapterRevision: "self-claimed"})).toThrow("INVALID_JEV_CONTEXT_ROUTE");
    } finally {Object.defineProperty(adapter, "transport", descriptor);}
  });
  it.each([false, true])("uses the same bound protocol at actual gateway acceptance; rejectAfterRead=%s", async rejectAfterRead => {
    const root = fileURLToPath(new URL("../../", import.meta.url)), local = await loadSkillInventory({root}), observedAt = new Date().toISOString();
    const host: HostSkillDiscoverySnapshot = {schemaVersion: "1.0.0", sourceRef: "fixture:host", revision: "1", observedAt,
      expiresAt: "2099-01-01T00:00:00Z", skills: local.skills.map(skill => ({skillId: skill.skillId, installed: true, enabled: true, hostSupported: true, root: null}))};
    const observeHostSkills = async () => host;
    const {inventory} = await loadHostObservedInventory({root, observeHostSkills}); expect(inventory.issues).toEqual([]);
    const f = fixture(inventory), runtime = {config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: true};
    const observation: ExecutionContextV1 = {schemaVersion: "1.0.0", model: "fixture-model", modelClass: "general", reasoningEffort: "high", taskId: "initial", actorId: "fixture:actor", source: "runtime", observationId: "fixture:observation", observedAt, expiresAt: "2099-01-01T00:00:00Z"};
    let accepting = false;
    const gateway = new RuntimeSkillClassificationGateway({root, service: f.service, observeHostSkills,
      readRuntime: async () => {if (accepting && rejectAfterRead) f.state.allowed = false; return runtime;},
      observeTask: req => ({taskRevision: req.confirmedContext.taskRevision, requestDigest: req.requestDigest, cancelled: false, sourceRef: "fixture:task"})});
    const advice = await gateway.classify({schemaVersion: "1.0.0", requestId: f.request.requestId, operationId: f.request.operationId, originalPrompt: f.request.originalPrompt,
      confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "fixture", reference: "fixture:vendor"}, publicSynthetic: false}, observation);
    if (!("result" in advice) || typeof advice.classificationResponseRef !== "string") throw new Error("EXPECTED_CLASSIFICATION_RESULT");
    expect(advice.result.response.status).toBe("SUCCESS");
    const result = advice.result, snap = result.snapshot;
    const decision: SkillSelectionDecisionV1 = {schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snap.requestDigest,
      inventoryDigest: snap.inventoryDigest, taskRevision: snap.taskRevision, configRevision: snap.configRevision, profileRevision: snap.profileRevision,
      explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [], selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [],
      selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null};
    observation.taskId = snap.requestDigest; accepting = true;
    const accepted = await gateway.accept({schemaVersion: "1.0.0", operationId: f.request.operationId, decision}, observation);
    expect(accepted.valid).toBe(!rejectAfterRead);
    if (rejectAfterRead) expect(accepted.errors).toContain("UNSUPPORTED_OPTIONS");
    else {if (!("decision" in accepted)) throw new Error("EXPECTED_ACCEPTED_DECISION"); expect(accepted.decision.agentSelectedSkillIds).toEqual([]);}
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(digestClassificationValue(runtime)).toBe(digestClassificationValue({config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: true}));
  });
});

it.each([false, true])("D270 diagnostic accepting validator identity after dispatch replaceHook=%s", async replaceHook => {
  const f = fixture();
  const adapter = f.adapter, initialHook = f.adapter.validateConfiguration;
  const encode = f.adapter.encode, decode = f.adapter.decode;
  const profileDigest = digestClassificationValue(f.profile);
  const configDigest = digestClassificationValue(f.input.config);
  const routeRevision = f.route.adapterRevision;
  let hookChanged = false;
  f.fetcher.mockImplementation(async () => {
    // Synthetic transport only: this is the sole fetch stub, never real fetch.
    // Resume after the provider reached its already-approved dispatch point.
    await Promise.resolve();
    if (replaceHook) {
      f.adapter.validateConfiguration = () => null;
      hookChanged = true;
    }
    return new Response("{}");
  });
  const result = await f.service.classify(f.input);
  expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.route.kind).toBe("remote");
  if (f.route.kind !== "remote") throw new Error("DIAGNOSTIC_EXPECTED_REMOTE_FIXTURE");
  expect(f.route.adapter).toBe(adapter);
  expect(f.adapter).toBe(adapter);
  expect(f.adapter.encode).toBe(encode); expect(f.adapter.decode).toBe(decode);
  expect(f.route.adapterRevision).toBe(routeRevision);
  expect(digestClassificationValue(f.profile)).toBe(profileDigest);
  expect(digestClassificationValue(f.input.config)).toBe(configDigest);
  expect(f.service.validateProfile(f.profile, f.request)).toBeNull();
  expect(hookChanged).toBe(replaceHook);
  if (replaceHook) expect(f.adapter.validateConfiguration).not.toBe(initialHook);
  else expect(f.adapter.validateConfiguration).toBe(initialHook);
  console.info(JSON.stringify({diagnostic: "D270_ACCEPTING_VALIDATOR_IDENTITY_AFTER_DISPATCH", replaceHook,
    status: result.response.status, error: result.response.error, attempts: result.attempts,
    profileDigestUnchanged: digestClassificationValue(f.profile) === profileDigest,
    configDigestUnchanged: digestClassificationValue(f.input.config) === configDigest,
    adapterObjectUnchanged: f.route.adapter === adapter, hookFunctionChanged: f.adapter.validateConfiguration !== initialHook,
    syntheticFetcherCalls: f.fetcher.mock.calls.length, realExternalCalls: 0}));
  if (replaceHook) expect(result.response.error, "A response from the previous validator identity must not be accepted under a replacement identity").not.toBeNull();
  else expect(result.response.status).toBe("SUCCESS");
});

// Public provider boundaries: changes must fail even when the new policy accepts.
it.each(["body", "raw", "decode"] as const)("fences accepting validator identity at the %s boundary", async stage => {
  const f = fixture(), decode = f.adapter.decode;
  const replace = () => {f.adapter.validateConfiguration = () => null;};
  if (stage === "body") f.fetcher.mockImplementation(async () => new Response(new ReadableStream({
    async pull(controller) {await Promise.resolve(); replace(); controller.enqueue(new TextEncoder().encode("{}")); controller.close();}
  })));
  if (stage === "raw") f.adapter.validateRawResponse = () => {replace();};
  if (stage === "decode") f.adapter.decode = (...args) => {const evaluation = decode(...args); replace(); return evaluation;};
  await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "started"});
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it.each(["adapter", "route", "provider-validator"] as const)("fences the actual %s identity at decoded return", async changed => {
  const f = fixture(), decode = f.adapter.decode;
  f.adapter.decode = (...args) => {
    const evaluation = decode(...args);
    if (changed === "adapter") {if (f.route.kind !== "remote") throw new Error("EXPECTED_REMOTE"); f.route.adapter = {...f.adapter};}
    if (changed === "route") f.route.approvalRef = "fixture:new-approval";
    if (changed === "provider-validator") f.provider.validateConfiguration = () => null;
    return evaluation;
  };
  await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "started"});
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("fences a replacement from the last dispatch callback before transport", async () => {
  const f = fixture();
  await expect(f.provider.classify(f.request, f.profile, new AbortController().signal,
    () => {f.adapter.validateConfiguration = () => null;})).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
  expect(f.fetcher).not.toHaveBeenCalled();
});

it.each([false, true])("D270 diagnostic accepting validator identity at gateway commit replaceHook=%s", async replaceHook => {
  const root = fileURLToPath(new URL("../../", import.meta.url)), local = await loadSkillInventory({root}), observedAt = new Date().toISOString();
  const host: HostSkillDiscoverySnapshot = {schemaVersion: "1.0.0", sourceRef: "fixture:host", revision: "1", observedAt,
    expiresAt: "2099-01-01T00:00:00Z", skills: local.skills.map(skill => ({skillId: skill.skillId, installed: true, enabled: true, hostSupported: true, root: null}))};
  const observeHostSkills = async () => host;
  const {inventory} = await loadHostObservedInventory({root, observeHostSkills}); expect(inventory.issues).toEqual([]);
  const f = fixture(inventory), runtime = {config: f.input.config, registry: f.input.registry, allowRemotePrivateContent: true};
  if (f.route.kind !== "remote") throw new Error("DIAGNOSTIC_EXPECTED_REMOTE_FIXTURE");
  const adapter = f.adapter, originalHook = adapter.validateConfiguration, encode = adapter.encode, decode = adapter.decode;
  const profileDigest = digestClassificationValue(f.profile), runtimeDigest = digestClassificationValue(runtime), routeRevision = f.route.adapterRevision;
  const observation: ExecutionContextV1 = {schemaVersion: "1.0.0", model: "fixture-model", modelClass: "general", reasoningEffort: "high", taskId: "initial", actorId: "fixture:actor", source: "runtime", observationId: "fixture:observation", observedAt, expiresAt: "2099-01-01T00:00:00Z"};
  let accepting = false, acceptReadCount = 0;
  const gateway = new RuntimeSkillClassificationGateway({root, service: f.service, observeHostSkills,
    readRuntime: async () => {
      if (accepting) {acceptReadCount++; if (replaceHook) f.adapter.validateConfiguration = () => null;}
      return runtime;
    },
    observeTask: req => ({taskRevision: req.confirmedContext.taskRevision, requestDigest: req.requestDigest, cancelled: false, sourceRef: "fixture:task"})});
  const advice = await gateway.classify({schemaVersion: "1.0.0", requestId: f.request.requestId, operationId: f.request.operationId, originalPrompt: f.request.originalPrompt,
    confirmedContext: f.request.confirmedContext, contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "fixture", reference: "fixture:vendor"}, publicSynthetic: false}, observation);
  if (!("result" in advice) || typeof advice.classificationResponseRef !== "string") throw new Error("EXPECTED_CLASSIFICATION_RESULT");
  expect(advice.result.response.status).toBe("SUCCESS"); expect(adapter.validateConfiguration).toBe(originalHook);
  const snap = advice.result.snapshot;
  const decision: SkillSelectionDecisionV1 = {schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snap.requestDigest,
    inventoryDigest: snap.inventoryDigest, taskRevision: snap.taskRevision, configRevision: snap.configRevision, profileRevision: snap.profileRevision,
    explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [], selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [],
    selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null};
  observation.taskId = snap.requestDigest; accepting = true;
  const accepted = await gateway.accept({schemaVersion: "1.0.0", operationId: f.request.operationId, decision}, observation);
  expect(acceptReadCount).toBe(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
  expect(f.route.adapter).toBe(adapter); expect(adapter.encode).toBe(encode); expect(adapter.decode).toBe(decode);
  expect(f.route.adapterRevision).toBe(routeRevision); expect(digestClassificationValue(f.profile)).toBe(profileDigest);
  expect(digestClassificationValue(runtime)).toBe(runtimeDigest); expect(f.state.allowed).toBe(true);
  expect(f.service.validateProfile(f.profile, f.request)).toBeNull();
  expect(adapter.validateConfiguration === originalHook).toBe(!replaceHook);
  console.info(JSON.stringify({diagnostic: "D270_ACCEPTING_VALIDATOR_IDENTITY_GATEWAY_COMMIT", replaceHook,
    classifyStatus: advice.result.response.status, acceptedValid: accepted.valid, acceptedErrors: accepted.errors,
    decisionRecorded: "decision" in accepted, hookFunctionChanged: adapter.validateConfiguration !== originalHook,
    adapterObjectUnchanged: f.route.adapter === adapter, profileDigestUnchanged: digestClassificationValue(f.profile) === profileDigest,
    runtimeDigestUnchanged: digestClassificationValue(runtime) === runtimeDigest, acceptReadCount,
    syntheticFetcherCalls: f.fetcher.mock.calls.length, realExternalCalls: 0}));
  expect(accepted.valid, "Gateway must retain the advice validator identity until selection commit").toBe(!replaceHook);
  if (!replaceHook) {if (!("decision" in accepted)) throw new Error("EXPECTED_ACCEPTED_DECISION"); expect(accepted.decision.agentSelectedSkillIds).toEqual([]);}
});
