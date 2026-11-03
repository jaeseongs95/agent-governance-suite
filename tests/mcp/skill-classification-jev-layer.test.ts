import {describe, expect, it, vi} from "vitest";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, ClassificationProviderError, unavailableResponse,
  validateBuiltinProviderConfiguration, validateLegacyProviderConfiguration, jevNoulWireAdapter, jevNoulSufficiencyWireAdapter,
  jevNoulSharedRulesWireAdapter, jevNoulSharedRulesV5WireAdapter, jevNoulSharedRulesV5LongContextWireAdapter, jevNoulSharedRulesV6WireAdapter,
  jevNoulSharedRulesV6LongContextWireAdapter, jevSkillSelectionChoiceWireAdapter, jevSkillSelectionChoiceLongContextWireAdapter,
  JEV_NOUL_SUFFICIENCY_ADAPTER_REVISION, JEV_NOUL_SHARED_RULES_ADAPTER_REVISION, JEV_NOUL_SHARED_RULES_V5_ADAPTER_REVISION,
  JEV_NOUL_SHARED_RULES_V5_LONG_CONTEXT_ADAPTER_REVISION, JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION, JEV_NOUL_SHARED_RULES_V6_LONG_CONTEXT_ADAPTER_REVISION,
  JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION,
  type ApprovedClassificationRoute, type ClassificationWireAdapter} from "../../mcp-server/src/skill-classification/providers.js";
import {dispatchAdvisoryAttempt, InMemoryClassificationBudget, SkillClassificationService, type AdvisoryDispatchTask} from "../../mcp-server/src/skill-classification/service.js";
import {createClassificationProviderRuntime} from "../../mcp-server/src/skill-classification/runtime.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import type {ProviderConfiguration, ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

const keyHeader = "x-fixture-key";
interface MutableContract {headers: Record<string, string>; credentialHeader?: string; matches: (route: ApprovedClassificationRoute) => boolean}
const contract = (credentialHeader?: string, headers: Record<string, string> = {}): MutableContract => ({headers,
  ...credentialHeader === undefined ? {} : {credentialHeader}, matches: route => route.kind === "remote" && route.adapterRevision === "a1"});

function request(): SkillClassificationRequestV1 {
  return createClassificationRequest({requestId: "r", operationId: "o", originalPrompt: "Read this diff", classificationCriteriaRef: "criteria",
    inventory: {skills: [{skillId: "review", version: "1", description: "Read a supplied diff", enabled: true, installed: true, hostSupported: true, capabilities: ["review"],
      actions: ["read"], targets: ["diff"], constraints: [], applicability: ["supplied diff"], exclusions: ["no diff"], dependencies: [], phases: [], sourceRefs: []}],
    issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "t1"}});
}
function configuration(): ProviderConfiguration {
  return {profileId: "pinned", providerKind: "jev", vendorId: "typesafe", modelId: "fixed-jev", modelRevision: "fixed-jev", reasoningEffort: null,
    supportedOptions: {reasoningEfforts: [null], structuredOutput: true}, approvedRouteRef: "approved-existing", qualificationRevision: "q1", adapterRevision: "a1",
    promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: {neededAt: 0.8, notNeededAt: 0.2}};
}
function qualified(req: SkillClassificationRequestV1, base = configuration()): ProviderProfile {
  const profile: ProviderProfile = {...base, qualification: {status: "PASS", inventoryDigest: req.inventoryDigest, taxonomyRevision: req.taxonomyRevision,
    modelRevision: base.modelRevision, promptRevision: base.promptRevision, validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}};
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
  return profile;
}
function fixture(transport?: MutableContract, key = "SECRET_SENTINEL") {
  const req = request(), profile = qualified(req);
  const credential = vi.fn(async () => key);
  const adapter: ClassificationWireAdapter = transport ? {...jevNoulWireAdapter, transport} : jevNoulWireAdapter;
  const route = bindClassificationRouteTransport({routeRef: profile.approvedRouteRef, approvalRef: "fixture-approval", approved: true, kind: "remote", providerKind: "jev",
    vendorId: "typesafe", adapterRevision: "a1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true,
    endpoint: "https://approved.example.invalid/fixture", getCredential: credential, adapter});
  const body = {model: "fixed-jev", answers: {review: {type: "noul", noul: 0.82}}, usage: {input_tokens: 1, output_tokens: 1}};
  // Synthetic transport only. Building Headers rejects invalid values with the same TypeError as real fetch.
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {new Headers(init?.headers); return new Response(JSON.stringify(body));});
  const provider = new ApprovedRouteClassificationProvider([route], fetcher);
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 1, spentUsd: 0}, vendors: {}});
  const service = new SkillClassificationService({providers: {jev: provider}, budget});
  const input = {request: req, config: {jevEnabled: true, mode: "select" as const, providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: true,
    configRevision: "fixture:c1", timeoutMs: 1000}, registry: {schemaVersion: "1.0.0" as const, profileRevision: "fixture:p1", profiles: [profile]}, currentVendorId: "typesafe"};
  return {request: req, profile, credential, route, fetcher, provider, budget, service, input};
}
const sentHeaders = (fetcher: ReturnType<typeof fixture>["fetcher"]) => new Headers(fetcher.mock.calls[0]![1]!.headers);

describe("A. adapter-owned credential header", () => {
  it("sends the key only in the adapter's non-Bearer header", async () => {
    const f = fixture(contract(keyHeader));
    expect((await f.provider.classify(f.request, f.profile, new AbortController().signal)).response.status).toBe("SUCCESS");
    const headers = sentHeaders(f.fetcher);
    expect(headers.get(keyHeader)).toBe("SECRET_SENTINEL"); expect(headers.has("authorization")).toBe(false);
    expect(String(f.fetcher.mock.calls[0]![0])).not.toContain("SECRET_SENTINEL"); expect(String(f.fetcher.mock.calls[0]![1]!.body)).not.toContain("SECRET_SENTINEL");
  });
  it("keeps Bearer as the default", async () => {
    const f = fixture(contract());
    await f.provider.classify(f.request, f.profile, new AbortController().signal);
    expect(sentHeaders(f.fetcher).get("authorization")).toBe("Bearer SECRET_SENTINEL");
  });
  it.each([
    ["the credential header among extra headers", contract(keyHeader, {"X-Fixture-KEY": "override"})],
    ["authorization as credential header", contract("Authorization")],
    ["content-type as credential header", contract("CONTENT-TYPE")],
    ["an invalid credential header name", contract("bad header")],
    ["a non-ASCII extra header value", contract(undefined, {"x-extra": "값"})],
  ])("rejects %s before credentials", async (_label, transport) => {
    const f = fixture(transport);
    expect((await f.provider.availability(f.profile)).available).toBe(false);
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "ROUTE_NOT_APPROVED", dispatchState: "not-started"});
    expect(f.credential).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("lets neither route JSON nor profile data choose the credential header", () => {
    const f = fixture();
    expect(() => createClassificationProviderRuntime({schemaVersion: "1.0.0", routes: [{kind: "remote", routeRef: "r", approvalRef: "a", approved: true, providerKind: "jev",
      vendorId: "typesafe", adapterRevision: "jev-noul-v1", modelIds: ["fixed-jev"], reasoningEfforts: [null], structuredOutput: true, endpoint: "https://approved.example.invalid/fixture",
      credentialEnvName: "SYNTHETIC_ONLY", wireAdapterRef: "jev-noul-v1", credentialHeader: keyHeader}], budget: {jev: {limitUsd: 1, spentUsd: 0}, vendors: {}, nativeAllowances: {}}})).toThrow();
    Reflect.set(f.profile, "credentialHeader", keyHeader); f.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(f.profile);
    expect(f.service.validateProfile(f.profile, f.request)).toBe("INVALID_PROFILE");
  });
  it.each([["renamed", "x-other-key"], ["back to Bearer", undefined]] as const)("is STALE when the credential header is %s across the credential await", async (_label, next) => {
    const transport = contract(keyHeader), f = fixture(transport);
    f.credential.mockImplementation(async () => {if (next === undefined) delete transport.credentialHeader; else transport.credentialHeader = next; return "SECRET_SENTINEL";});
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("invalidates an accepted result when the credential header changes afterwards", async () => {
    const transport = contract(keyHeader), f = fixture(transport);
    const result = await f.service.classify(f.input);
    expect(result.response.status).toBe("SUCCESS"); expect(f.service.validateResultBinding(result)).toBeNull();
    transport.credentialHeader = "x-other-key";
    expect(f.service.validateResultBinding(result)).toBe("STALE_CLASSIFICATION");
  });
  it.each([["SECRET\r\nx-injected: 1", "CREDENTIAL_MALFORMED"], ["키", "CREDENTIAL_MALFORMED"], ["SECRET\u0000", "CREDENTIAL_MALFORMED"],
    [" \r\n", "CREDENTIAL_UNAVAILABLE"]] as const)("rejects key %j as %s before the fence with no send and no helper-failure evidence", async (key, code) => {
    const f = fixture(undefined, key), reserve = vi.spyOn(f.budget, "reserve");
    const result = await f.service.classify(f.input);
    expect(result.attempts[0]).toMatchObject({errorCode: code, dispatchState: "not-started", reservedCostUsd: 0});
    expect(f.service.helperFailure(result)).toBeNull(); expect(reserve).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
    const beforeDispatch = vi.fn();
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal, beforeDispatch)).rejects.toMatchObject({code, dispatchState: "not-started"});
    expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([["SECRET\r\n", "SECRET"], ["\tSECRET ", "SECRET"], ["SECRET KEY", "SECRET KEY"]] as const)(
    "sends key %j as fetch would normalize it, %j", async (key, sent) => {
      for (const transport of [contract(), contract(keyHeader)]) {
        const f = fixture(transport, key);
        expect((await f.provider.classify(f.request, f.profile, new AbortController().signal)).response.status).toBe("SUCCESS");
        const headers = sentHeaders(f.fetcher);
        expect(transport.credentialHeader === undefined ? headers.get("authorization") : headers.get(keyHeader))
          .toBe(transport.credentialHeader === undefined ? `Bearer ${sent}` : sent);
      }
    });
});

describe("B. TypeSafe rules live in the TypeSafe adapters", () => {
  const builtins: [string, ClassificationWireAdapter][] = [
    [JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, jevSkillSelectionChoiceWireAdapter], [JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION, jevSkillSelectionChoiceLongContextWireAdapter],
    ["jev-noul-v1", jevNoulWireAdapter], [JEV_NOUL_SUFFICIENCY_ADAPTER_REVISION, jevNoulSufficiencyWireAdapter], [JEV_NOUL_SHARED_RULES_ADAPTER_REVISION, jevNoulSharedRulesWireAdapter],
    [JEV_NOUL_SHARED_RULES_V5_ADAPTER_REVISION, jevNoulSharedRulesV5WireAdapter], [JEV_NOUL_SHARED_RULES_V5_LONG_CONTEXT_ADAPTER_REVISION, jevNoulSharedRulesV5LongContextWireAdapter],
    [JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION, jevNoulSharedRulesV6WireAdapter], [JEV_NOUL_SHARED_RULES_V6_LONG_CONTEXT_ADAPTER_REVISION, jevNoulSharedRulesV6LongContextWireAdapter]];
  const choice = new Set<string>([JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION]);
  // The rules before the move, written out: the common jev rule, and the Choice adapters' own hook.
  const oldLegacy = (p: ProviderConfiguration) => p.providerKind === "jev" && (p.reasoningEffort !== null || p.judgmentPolicy === null) ? "UNSUPPORTED_OPTIONS" : null;
  const oldRule = (p: ProviderConfiguration, revision: string) => !choice.has(revision) ? oldLegacy(p)
    : p.providerKind === "jev" && p.adapterRevision === revision && p.promptRevision === JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION
      && p.judgmentPolicy === null && p.reasoningEffort === null ? null : "UNSUPPORTED_OPTIONS";
  const variants = (revision: string) => [null, "low"].flatMap(reasoningEffort => [null, {neededAt: 0.8, notNeededAt: 0.2}].flatMap(judgmentPolicy =>
    [JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION, "p1"].map((promptRevision): ProviderConfiguration => ({...configuration(), adapterRevision: revision, reasoningEffort, judgmentPolicy, promptRevision}))));

  it("gives every builtin adapter its own protocol hook", () => {
    for (const [, adapter] of builtins) expect(typeof adapter.validateConfiguration).toBe("function");
  });
  it.each(builtins)("matches the old rule for %s through builtin lookup and the bound route", async (revision, adapter) => {
    const provider = new ApprovedRouteClassificationProvider([bindClassificationRouteTransport({routeRef: "approved-existing", approvalRef: "fixture-approval", approved: true,
      kind: "remote", providerKind: "jev", vendorId: "typesafe", adapterRevision: revision, modelIds: ["fixed-jev"], reasoningEfforts: [null, "low"], structuredOutput: true,
      endpoint: "https://approved.example.invalid/fixture", getCredential: async () => "unused", adapter})], vi.fn<typeof fetch>());
    for (const profile of variants(revision)) {
      expect(validateBuiltinProviderConfiguration(profile)).toBe(oldRule(profile, revision));
      expect(provider.validateConfiguration(profile)).toBe(oldRule(profile, revision));
    }
  });
  it("keeps the hookless-port fallback equal to the old rule", () => {
    for (const providerKind of ["jev", "vendor"] as const) for (const profile of variants("unregistered-revision"))
      expect(validateLegacyProviderConfiguration({...profile, providerKind})).toBe(oldLegacy({...profile, providerKind}));
  });
  it("keeps an existing PASS profile digest and its acceptance", async () => {
    const f = fixture();
    expect(digestProviderProfileConfiguration(configuration())).toBe("sha256:530929c496e2359add8e48296561727d278787804b36aec0e3036e29a7f61649");
    expect(f.service.validateProfile(f.profile, f.request)).toBeNull();
    expect((await f.service.classify(f.input)).response.status).toBe("SUCCESS");
  });
});

describe("C. a task cannot change the engine's fence or evidence", () => {
  const success = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId,
    requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}],
    unresolvedItems: [], error: null}, usage: {inputTokens: 1, outputTokens: 1, cachedInputTokens: null, actualCostUsd: 0.01}, dispatchState: "started", diagnostics: null});
  function engine(outcome: (req: SkillClassificationRequestV1) => ProviderEvaluation, overrides: Partial<AdvisoryDispatchTask> = {}) {
    const req = request(), profile = qualified(req), sent = vi.fn();
    const provider: SkillClassificationProviderPort = {availability: async () => ({available: true, approved: true, routeKind: "remote", reasonCode: null}),
      classify: async (value, _profile, _signal, beforeDispatch) => {beforeDispatch?.(); sent(); return outcome(value);}};
    const budget = new InMemoryClassificationBudget({jev: {limitUsd: 1, spentUsd: 0}, vendors: {}}), reserve = vi.spyOn(budget, "reserve");
    const task: AdvisoryDispatchTask = {request: req, failureResponse: (code, state, status) => unavailableResponse(req, code, state, status), stale: () => false,
      qualify: () => null, validDiagnostics: () => true, validResponse: () => true, ...overrides};
    const run = () => dispatchAdvisoryAttempt({provider, profile, budget, timeoutMs: 1000, externalClassificationAllowed: true, remoteContentAllowed: true,
      signal: undefined, bindingCurrent: () => true}, task);
    return {req, profile, sent, budget, reserve, run};
  }
  const fail = (code: string, state: "started" | "unknown") => () => {throw new ClassificationProviderError(code, state);};

  it("records evidence for a post-fence allowlisted fault (control)", async () => {
    const e = engine(fail("TRANSPORT_UNAVAILABLE", "unknown"));
    expect((await e.run()).helperFailure).toEqual({profileId: e.profile.profileId, errorCode: "TRANSPORT_UNAVAILABLE"});
  });
  it("ignores an allowlisted code claimed by the task's failure response", async () => {
    const req = request();
    const lying: AdvisoryDispatchTask["failureResponse"] = (_code, state, status) => unavailableResponse(req, "TRANSPORT_UNAVAILABLE", state, status);
    const outcome = await engine(fail("AUTH_UNAVAILABLE", "started"), {failureResponse: lying}).run();
    expect(outcome.attempt.errorCode).toBe("TRANSPORT_UNAVAILABLE"); expect(outcome.helperFailure).toBeNull();
  });
  it("does not turn a provider error thrown by a task validator into evidence", async () => {
    const outcome = await engine(success, {validResponse: fail("TRANSPORT_UNAVAILABLE", "unknown")}).run();
    expect(outcome.attempt).toMatchObject({errorCode: "PROVIDER_UNAVAILABLE"}); expect(outcome.helperFailure).toBeNull();
  });
  it("applies the task's staleness only at the engine's fence and never sends", async () => {
    let calls = 0;
    const e = engine(success, {stale: () => ++calls > 1});
    const outcome = await e.run();
    expect(outcome.attempt).toMatchObject({errorCode: "STALE_CLASSIFICATION", dispatchState: "not-started"}); expect(outcome.helperFailure).toBeNull();
    expect(e.sent).not.toHaveBeenCalled(); expect(calls).toBe(2); expect(e.budget.snapshot().reservations).toEqual([]);
  });
  it("derives the reservation identity from the dispatched request digest", async () => {
    const e = engine(success);
    await e.run();
    expect(e.reserve).toHaveBeenCalledWith(e.profile, JSON.stringify([e.req.operationId, e.req.requestDigest, e.profile.profileId]), e.profile.maximumCostUsd, "remote");
  });
});
