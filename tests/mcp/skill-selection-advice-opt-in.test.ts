import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {fileURLToPath} from "node:url";
import {Ajv2020} from "ajv/dist/2020.js";
import addFormatsModule, {type FormatsPlugin} from "ajv-formats";
import {describe, expect, it, vi} from "vitest";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, resolveClassificationWireAdapter,
  jevSkillSelectionChoiceWireAdapter, jevSkillSelectionChoiceLongContextWireAdapter, JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION, skillSelectionAdvicePrompt, SKILL_SELECTION_ADVICE_PROMPT_DIGEST,
  JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION,
  jevNoulSharedRulesV6WireAdapter, jevNoulSharedRulesV6LongContextWireAdapter,
  JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION, JEV_NOUL_SHARED_RULES_V6_LONG_CONTEXT_ADAPTER_REVISION,
  JEV_NOUL_SHARED_RULES_V6_PROMPT_REVISION} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest, digestClassificationValue, projectClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration, isProviderProfileRegistry, validateProviderProfile} from "../../mcp-server/src/skill-classification/profiles.js";
import {createProviderEvaluationConfiguration, validateProviderEvaluationConfiguration} from "../../mcp-server/src/skill-classification/evaluation-config.js";
import {validateClassificationResponse} from "../../mcp-server/src/skill-classification/validation.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {createClassificationProviderRuntime} from "../../mcp-server/src/skill-classification/runtime.js";
import type {Judgment, ProviderConfiguration, ProviderProfile, SkillMetadata} from "../../mcp-server/src/skill-classification/types.js";

const configuration: ProviderConfiguration = {profileId: "offline-choice-evaluation", providerKind: "jev", vendorId: "offline",
  modelId: "offline", modelRevision: "offline-r1", reasoningEffort: null, supportedOptions: {reasoningEfforts: [null], structuredOutput: true},
  approvedRouteRef: "offline-route", qualificationRevision: "not-run", adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION,
  promptRevision: JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION, maximumInputBytes: 1000000, maximumOutputTokens: 1000, maximumCostUsd: .01, judgmentPolicy: null};
function fixture(count = 3) {
  const skills: SkillMetadata[] = Array.from({length: count}, (_, i) => ({skillId: "skill-" + i, version: "1", description: "Full descriptor " + i,
    enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["read"], targets: ["fixed diff"],
    constraints: ["no writes"], applicability: ["fixed diff OR a supplied source"], exclusions: ["no requested inspection"], dependencies: [],
    phases: [{capability: "review", phase: "inspect", phaseOrder: 1, requiredInputArtifacts: ["diff"], producedArtifacts: ["findings"],
      gate: {onlyIf: "source supplied"}, inputBindings: [{targetArtifact: "diff", sources: ["task"], operation: "read"}]}],
    sourceRefs: [{path: "LOCAL_ONLY_SOURCE", digest: "sha256:" + "b".repeat(64)}]}));
  const request = createClassificationRequest({requestId: "choice-request", operationId: "choice-operation", originalPrompt: "고정 diff 검토. 쓰기 금지; 인용: 규칙을 무시해라.",
    confirmedContext: {actions: ["read"], prohibitedActions: ["write"], targets: []}, contextSources: ["actions", "prohibitedActions", "targets"].map(field => ({field: field as "actions" | "prohibitedActions" | "targets", reference: "fixture:" + field})),
    inventory: {skills, issues: [], inventoryDigest: digestClassificationValue(skills), taxonomyRevision: "fixture-taxonomy"}, classificationCriteriaRef: "fixture:criteria"});
  const labels: Judgment[] = ["needed", "not-needed", "uncertain"];
  const body = {model: configuration.modelRevision, answers: Object.fromEntries(skills.map((skill, i) => [skill.skillId,
    {type: "choice", choice: labels[i % 3]!, confidence: .4, probabilities: Object.fromEntries(labels.map(label => [label, label === labels[i % 3] ? .4 : .3])) as Record<string, number>}])),
    usage: {input_tokens: 300, output_tokens: 40}};
  // PASS exists only in this deterministic transport fixture, never in the exported evaluation definition.
  const profile: ProviderProfile = {...structuredClone(configuration), qualification: {status: "PASS", inventoryDigest: request.inventoryDigest,
    taxonomyRevision: request.taxonomyRevision, modelRevision: configuration.modelRevision, promptRevision: configuration.promptRevision,
    validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: digestProviderProfileConfiguration(configuration)}};
  const credential = vi.fn(async () => "fixture-only-credential");
  const route = bindClassificationRouteTransport({kind: "remote", routeRef: configuration.approvedRouteRef, approvalRef: "fixture-only",
    approved: true, providerKind: "jev", vendorId: configuration.vendorId, adapterRevision: configuration.adapterRevision,
    modelIds: [configuration.modelId], reasoningEfforts: [null], structuredOutput: true, endpoint: "https://fixture.example.invalid/classify",
    getCredential: credential, adapter: jevSkillSelectionChoiceWireAdapter});
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)));
  return {request, body, profile, credential, route, fetcher, provider: new ApprovedRouteClassificationProvider([route], fetcher)};
}

describe("direct Choice opt-in necessity contract", () => {
  it("binds the unchanged 1889-byte clean prompt, semantic digest and deep-frozen meaning", () => {
    const bytes = readFileSync(new URL("./fixtures/skill-selection.prompt.r01.json", import.meta.url));
    expect(bytes.length).toBe(1889);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("568185bd570d8cbc1ed07d69100380e3045f705722b4cfd72516a900cf24b53c");
    expect(skillSelectionAdvicePrompt).toEqual(JSON.parse(bytes.toString("utf8")));
    expect(SKILL_SELECTION_ADVICE_PROMPT_DIGEST).toBe("sha256:1bb8fb5b716cb768c82bbcdc9b71dbcbbbee16f2563b114c97be9c4f3b38232c");
    expect(JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION).toBe(JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION + ":" + SKILL_SELECTION_ADVICE_PROMPT_DIGEST);
    for (const value of [skillSelectionAdvicePrompt, skillSelectionAdvicePrompt.rules, skillSelectionAdvicePrompt.options]) expect(Object.isFrozen(value)).toBe(true);
  });
  it("keeps a low-confidence needed label and distinct not-needed/semantic-uncertain categories", async () => {
    const f = fixture();
    const value = await f.provider.classify(f.request, f.profile, new AbortController().signal);
    expect(value.response.judgments.map(item => item.judgment)).toEqual(["needed", "not-needed", "uncertain"]);
    expect(value.response.judgments[0]!.uncertaintyReason).toBeNull();
    expect(value.response.judgments[2]!.uncertaintyReason).toBe("JEV_MATERIAL_FACT_UNRESOLVED");
    expect(value.response.status).toBe("PARTIAL");
    expect(validateClassificationResponse(f.request, value.response)).toEqual([]);
    expect(value.diagnostics).toEqual({scoreKind: "choice_confidence", scores: f.request.skills.map(skill => ({skillId: skill.skillId, value: .4}))});
    expect(value.usage).toEqual({inputTokens: 300, outputTokens: 40, cachedInputTokens: null, actualCostUsd: null});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([1, 3, 27])("preserves full task/descriptor/phase and independent multi-selection for %i skills", count => {
    const f = fixture(count), before = structuredClone(f.request);
    const wire = jevSkillSelectionChoiceWireAdapter.encode(f.request, f.profile) as {model: string; state: Record<string, unknown>; questions: Record<string, {type: string; instructions: {question: string; skill: unknown}; criteria: unknown}>};
    expect(Object.keys(wire.questions)).toEqual(f.request.skills.map(skill => skill.skillId));
    expect(wire.model).toBe(configuration.modelId);
    expect(wire.state).toMatchObject({originalPrompt: f.request.originalPrompt, confirmedContext: f.request.confirmedContext, classificationRules: skillSelectionAdvicePrompt.rules});
    const projected = projectClassificationRequest(f.request).payload.skills;
    for (const skill of projected) expect(wire.questions[skill.skillId]).toEqual({type: "choice", instructions: {question: skillSelectionAdvicePrompt.question, skill}, criteria: skillSelectionAdvicePrompt.options});
    expect(JSON.stringify(wire)).not.toContain("LOCAL_ONLY_SOURCE");
    Object.values(f.body.answers).forEach(answer => {answer.choice = "needed"; answer.probabilities = {needed: .4, "not-needed": .3, uncertain: .3};});
    const result = jevSkillSelectionChoiceWireAdapter.decode(f.body, f.request, f.profile);
    expect(result.response.judgments.map(item => [item.skillId, item.judgment])).toEqual(f.request.skills.map(skill => [skill.skillId, "needed"]));
    expect(f.request).toEqual(before);
    const reversed = createClassificationRequest({requestId: "reversed", operationId: "reverse", originalPrompt: f.request.originalPrompt,
      inventory: {skills: [...f.request.skills].reverse().slice(0, Math.max(1, count - 1)), issues: [], inventoryDigest: "sha256:" + "c".repeat(64), taxonomyRevision: "new"}, classificationCriteriaRef: "fixture"});
    const second = jevSkillSelectionChoiceWireAdapter.encode(reversed, f.profile) as typeof wire;
    expect(Object.keys(second.questions)).toEqual(reversed.skills.map(skill => skill.skillId));
    for (const skill of projectClassificationRequest(reversed).payload.skills) expect(second.questions[skill.skillId]!.instructions.skill).toEqual(skill);
  });
  it("preserves all 24 real descriptors and 38 phases without a skill-name or count branch", async () => {
    const inventory = await loadSkillInventory({root: fileURLToPath(new URL("../../", import.meta.url))});
    expect(inventory.issues).toEqual([]); expect(inventory.skills).toHaveLength(24);
    expect(inventory.skills.reduce((n, skill) => n + skill.phases.length, 0)).toBe(38);
    const request = createClassificationRequest({requestId: "real-inventory", operationId: "full-wire", originalPrompt: "검토", inventory, classificationCriteriaRef: "fixture"});
    const wire = jevSkillSelectionChoiceWireAdapter.encode(request, configuration) as {questions: Record<string, {instructions: {skill: unknown}}>};
    expect(Object.keys(wire.questions)).toEqual(inventory.skills.map(skill => skill.skillId));
    for (const skill of projectClassificationRequest(request).payload.skills) expect(wire.questions[skill.skillId]!.instructions.skill).toEqual(skill);
  });
  it.each(["missing-id", "extra-id", "type", "label", "model", "confidence-nan", "confidence-infinity", "confidence-negative", "confidence-over", "confidence-type",
    "distribution-missing", "distribution-extra", "distribution-nan", "distribution-negative", "distribution-over", "distribution-sum", "distribution-type",
    "usage-missing", "usage-negative", "usage-fraction", "usage-infinity", "usage-type"])("rejects invalid %s without manufacturing a judgment", variant => {
    const f = fixture(1), body = structuredClone(f.body), answer = body.answers["skill-0"]!;
    if (variant === "missing-id") Reflect.deleteProperty(body.answers, "skill-0");
    if (variant === "extra-id") Object.assign(body.answers, {unexpected: answer});
    if (variant === "type") answer.type = "noul";
    if (variant === "label") Reflect.set(answer, "choice", "unrecognized");
    if (variant === "model") body.model = "wrong-revision";
    if (variant === "confidence-nan") answer.confidence = NaN;
    if (variant === "confidence-infinity") answer.confidence = Infinity;
    if (variant === "confidence-negative") answer.confidence = -.01;
    if (variant === "confidence-over") answer.confidence = 1.01;
    if (variant === "confidence-type") Reflect.set(answer, "confidence", "0.4");
    if (variant === "distribution-missing") Reflect.deleteProperty(answer.probabilities, "uncertain");
    if (variant === "distribution-extra") answer.probabilities.unexpected = 0;
    if (variant === "distribution-nan") answer.probabilities.needed = NaN;
    if (variant === "distribution-negative") answer.probabilities.needed = -.1;
    if (variant === "distribution-over") answer.probabilities.needed = 1.1;
    if (variant === "distribution-sum") answer.probabilities.needed = .8;
    if (variant === "distribution-type") Reflect.set(answer.probabilities, "needed", "0.4");
    if (variant === "usage-missing") Reflect.deleteProperty(body.usage, "input_tokens");
    if (variant === "usage-negative") body.usage.input_tokens = -1;
    if (variant === "usage-fraction") body.usage.output_tokens = .5;
    if (variant === "usage-infinity") body.usage.output_tokens = Infinity;
    if (variant === "usage-type") Reflect.set(body.usage, "output_tokens", "40");
    expect(() => jevSkillSelectionChoiceWireAdapter.decode(body, f.request, f.profile)).toThrow();
  });
  it.each(["model", "answers", "id", "type", "choice", "escaped-choice", "confidence", "probabilities", "probability", "usage", "input_tokens", "output_tokens"])("rejects duplicate raw %s keys through the public provider", async variant => {
    const f = fixture(1); let raw = JSON.stringify(f.body);
    const replacements: Record<string, [string, string]> = {
      model: ['"model":', '"model":"discarded","model":'], answers: ['"answers":', '"answers":{},"answers":'],
      id: ['"skill-0":', '"skill-0":{},"skill-0":'], type: ['"type":', '"type":"noul","type":'],
      choice: ['"choice":', '"choice":"not-needed","choice":'], "escaped-choice": ['"choice":', '"cho\\u0069ce":"not-needed","choice":'],
      confidence: ['"confidence":', '"confidence":0.1,"confidence":'], probabilities: ['"probabilities":', '"probabilities":{},"probabilities":'],
      probability: ['"needed":', '"needed":0.2,"needed":'], usage: ['"usage":', '"usage":{},"usage":'],
      input_tokens: ['"input_tokens":', '"input_tokens":1,"input_tokens":'], output_tokens: ['"output_tokens":', '"output_tokens":1,"output_tokens":'],
    };
    const [from, to] = replacements[variant]!; raw = raw.replace(from, to);
    f.fetcher.mockResolvedValue(new Response(raw));
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects literal-null and malformed JSON at the public response boundary", async () => {
    for (const raw of ["null", "{", JSON.stringify({...fixture(1).body, answers: null})]) {
      const f = fixture(1); f.fetcher.mockResolvedValue(new Response(raw));
      await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE"});
    }
  });
  it("rejects stale prompt/profile policy and permits null only for the exact qualified new identity", () => {
    const f = fixture(1);
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBeNull();
    for (const patch of [{adapterRevision: JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION}, {adapterRevision: "unknown"},
      {promptRevision: "stale"}, {promptRevision: "stale-with-numeric-policy", judgmentPolicy: {neededAt: .8, notNeededAt: .2}}, {judgmentPolicy: {neededAt: .8, notNeededAt: .2}}]) {
      const profile = {...structuredClone(f.profile), ...patch};
      profile.qualification.promptRevision = profile.promptRevision;
      profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
      expect(validateProviderProfile(profile, f.request, Date.now())).toBe("UNSUPPORTED_OPTIONS");
      expect(() => jevSkillSelectionChoiceWireAdapter.encode(f.request, profile)).toThrow("JEV_CHOICE_PROFILE_MISMATCH");
    }
    const changed = structuredClone(f.profile); changed.qualification.profileConfigurationDigest = "sha256:" + "0".repeat(64);
    expect(validateProviderProfile(changed, f.request, Date.now())).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
    const notRun = structuredClone(f.profile); notRun.qualification.status = "NOT_RUN";
    expect(validateProviderProfile(notRun, f.request, Date.now())).toBe("PROFILE_UNQUALIFIED");
  });
  it("keeps default v6/long-context factories and rejects aliasing the new ref into vendor or mismatched routes", () => {
    expect(resolveClassificationWireAdapter(JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION, {providerKind: "jev", adapterRevision: JEV_NOUL_SHARED_RULES_V6_ADAPTER_REVISION})).toBe(jevNoulSharedRulesV6WireAdapter);
    expect(resolveClassificationWireAdapter(JEV_NOUL_SHARED_RULES_V6_LONG_CONTEXT_ADAPTER_REVISION, {providerKind: "jev", adapterRevision: JEV_NOUL_SHARED_RULES_V6_LONG_CONTEXT_ADAPTER_REVISION})).toBe(jevNoulSharedRulesV6LongContextWireAdapter);
    expect(JEV_NOUL_SHARED_RULES_V6_PROMPT_REVISION).toBe("jev-noul-sufficiency-shared-v6:sha256:557819561cc0911c20d1173b77313ceb6c35afe6582010b23df4883ab918ebc1");
    expect(resolveClassificationWireAdapter(JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, {providerKind: "jev", adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION})).toBe(jevSkillSelectionChoiceWireAdapter);
    for (const route of [{providerKind: "vendor" as const, adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION}, {providerKind: "jev" as const, adapterRevision: "old"}])
      expect(() => resolveClassificationWireAdapter(JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, route, new Map([[JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION, jevNoulSharedRulesV6WireAdapter]]))).toThrow("INVALID_JEV_CHOICE_ROUTE");
  });
  it("composes the trusted opt-in runtime with one stub dispatch and no long-context transport", async () => {
    const f = fixture(1);
    const runtime = createClassificationProviderRuntime({schemaVersion: "1.0.0", routes: [{kind: "remote", routeRef: configuration.approvedRouteRef,
      approvalRef: "fixture-only", approved: true, providerKind: "jev", vendorId: configuration.vendorId, adapterRevision: configuration.adapterRevision,
      modelIds: [configuration.modelId], reasoningEfforts: [null], structuredOutput: true, endpoint: "https://fixture.example.invalid/classify", credentialEnvName: "SYNTHETIC_ONLY", wireAdapterRef: configuration.adapterRevision}],
      budget: {jev: {limitUsd: 1, spentUsd: 0}, vendors: {}, nativeAllowances: {}}}, {fetcher: f.fetcher, getCredentialByEnvName: f.credential});
    expect((await runtime.providers.jev.classify(f.request, f.profile, new AbortController().signal)).response.judgments[0]!.judgment).toBe("needed");
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.credential).toHaveBeenCalledTimes(1);
    expect(new Headers(f.fetcher.mock.calls[0]![1]!.headers).has("TypeSafe-Danger-Zone-Long-Context")).toBe(false);
  });
  it("keeps dispatch fences and byte limits instead of permitting a changed experimental profile", async () => {
    const f = fixture(1); f.credential.mockImplementation(async () => {f.profile.promptRevision = "changed-during-await"; return "fixture-only";});
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
    const g = fixture(1); g.profile.maximumInputBytes = 1; g.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(g.profile);
    await expect(g.provider.classify(g.request, g.profile, new AbortController().signal)).rejects.toMatchObject({code: "INPUT_TOO_LONG", dispatchState: "not-started"});
    expect(g.fetcher).not.toHaveBeenCalled();
  });
  it("authors schema-valid NOT_RUN preparation without inventing registry qualification", () => {
    const f = fixture(1), value = createProviderEvaluationConfiguration(configuration, f.request, "2000-01-01T00:00:00.000Z");
    const ajv = new Ajv2020({strict: true}); (addFormatsModule as unknown as FormatsPlugin)(ajv);
    const check = ajv.compile(JSON.parse(readFileSync(new URL("../../contracts/skill-classification-evaluation-configuration.v1.schema.json", import.meta.url), "utf8")));
    const prepared = JSON.parse(readFileSync(new URL("./fixtures/jev-direct-choice-evaluation.NOT_RUN.json", import.meta.url), "utf8"));
    expect(check(prepared)).toBe(true); expect(prepared).toEqual(value);
    expect(check(value)).toBe(true); expect(validateProviderEvaluationConfiguration(value, f.request)).toBeNull();
    expect(value.evaluationState.status).toBe("NOT_RUN"); expect(value.productionRegistryUsable).toBe(false);
    expect(Object.hasOwn(value.configuration, "qualification")).toBe(false);
    expect(isProviderProfileRegistry({schemaVersion: "1.0.0", profileRevision: "fixture", profiles: [value.configuration]})).toBe(false);
  });
});


function longChoiceFixture() {
  const f = fixture(1);
  f.profile.profileId = "offline-choice-long-context-evaluation";
  f.profile.adapterRevision = JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION;
  f.profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(f.profile);
  if (f.route.kind !== "remote") throw new Error("fixture");
  Object.assign(f.route, bindClassificationRouteTransport({...f.route, adapterRevision: f.profile.adapterRevision, adapter: jevSkillSelectionChoiceLongContextWireAdapter}));
  return f;
}

describe("Choice opt-in long-context transport parity", () => {
  it("reuses the frozen v6 long-context header while keeping separate adapter/profile identity and identical Choice semantics", () => {
    const f = longChoiceFixture();
    expect(jevSkillSelectionChoiceLongContextWireAdapter.transport!.headers).toBe(jevNoulSharedRulesV6LongContextWireAdapter.transport!.headers);
    expect(Object.isFrozen(jevSkillSelectionChoiceLongContextWireAdapter.transport)).toBe(true);
    expect(validateProviderProfile(f.profile, f.request, Date.now())).toBeNull();
    const standard = {...f.profile, adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION};
    expect(jevSkillSelectionChoiceLongContextWireAdapter.encode(f.request, f.profile)).toEqual(jevSkillSelectionChoiceWireAdapter.encode(f.request, standard));
    expect(jevSkillSelectionChoiceLongContextWireAdapter.decode(f.body, f.request, f.profile)).toEqual(jevSkillSelectionChoiceWireAdapter.decode(f.body, f.request, standard));
    expect(f.profile.promptRevision).toBe(JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION);
    expect(resolveClassificationWireAdapter(JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION,
      {providerKind: "jev", adapterRevision: JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION})).toBe(jevSkillSelectionChoiceLongContextWireAdapter);
    expect(() => jevSkillSelectionChoiceWireAdapter.encode(f.request, f.profile)).toThrow("JEV_CHOICE_PROFILE_MISMATCH");
    expect(() => jevSkillSelectionChoiceLongContextWireAdapter.encode(f.request, standard)).toThrow("JEV_CHOICE_PROFILE_MISMATCH");
  });
  it("composes the trusted explicit long ref and sends the same header as v6LongContext exactly once", async () => {
    const f = longChoiceFixture();
    const runtime = createClassificationProviderRuntime({schemaVersion: "1.0.0", routes: [{kind: "remote", routeRef: configuration.approvedRouteRef,
      approvalRef: "fixture-only", approved: true, providerKind: "jev", vendorId: configuration.vendorId, adapterRevision: f.profile.adapterRevision,
      modelIds: [configuration.modelId], reasoningEfforts: [null], structuredOutput: true, endpoint: "https://fixture.example.invalid/classify", credentialEnvName: "SYNTHETIC_ONLY", wireAdapterRef: f.profile.adapterRevision}],
      budget: {jev: {limitUsd: 1, spentUsd: 0}, vendors: {}, nativeAllowances: {}}}, {fetcher: f.fetcher, getCredentialByEnvName: f.credential});
    const result = await runtime.providers.jev.classify(f.request, f.profile, new AbortController().signal);
    expect(result.response.judgments[0]!.judgment).toBe("needed");
    expect(f.fetcher).toHaveBeenCalledTimes(1); expect(f.credential).toHaveBeenCalledTimes(1);
    const init = f.fetcher.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("TypeSafe-Danger-Zone-Long-Context")).toBe("true");
    expect(JSON.parse(String(init.body))).toEqual(jevSkillSelectionChoiceWireAdapter.encode(f.request, {...f.profile, adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION}));
    expect(Object.hasOwn(JSON.parse(String(init.body)), "headers")).toBe(false);
  });
  it.each(["missing", "false", "extra", "impostor", "old-transport"])("rejects %s long-context transport before credentials or dispatch", async variant => {
    const f = longChoiceFixture(), valid = jevSkillSelectionChoiceLongContextWireAdapter.transport!;
    if (f.route.kind !== "remote") throw new Error("fixture");
    const transport = {headers: variant === "false" ? {"TypeSafe-Danger-Zone-Long-Context": "false"}
      : variant === "extra" ? {"TypeSafe-Danger-Zone-Long-Context": "true", "x-unapproved": "true"} : valid.headers,
      matches: variant === "impostor" ? () => true : valid.matches};
    const adapter = variant === "missing" ? jevSkillSelectionChoiceWireAdapter
      : variant === "old-transport" ? jevNoulSharedRulesV6LongContextWireAdapter : {...jevSkillSelectionChoiceLongContextWireAdapter, transport};
    const route = bindClassificationRouteTransport({...f.route, adapter});
    await expect(new ApprovedRouteClassificationProvider([route], f.fetcher).classify(f.request, f.profile, new AbortController().signal))
      .rejects.toMatchObject({code: "ROUTE_NOT_APPROVED", dispatchState: "not-started"});
    expect(f.credential).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("does not let a forged transport pass under the standard or native adapter revision", async () => {
    const standard = fixture(1);
    if (standard.route.kind !== "remote") throw new Error("fixture");
    const route = bindClassificationRouteTransport({...standard.route, adapter: jevSkillSelectionChoiceLongContextWireAdapter});
    await expect(new ApprovedRouteClassificationProvider([route], standard.fetcher).classify(standard.request, standard.profile, new AbortController().signal))
      .rejects.toMatchObject({code: "ROUTE_NOT_APPROVED", dispatchState: "not-started"});
    expect(standard.fetcher).not.toHaveBeenCalled();
    const f = longChoiceFixture(), invokeStructured = vi.fn();
    const native = bindClassificationRouteTransport({kind: "native", routeRef: f.profile.approvedRouteRef, approvalRef: "fixture-only", approved: true,
      providerKind: "jev", vendorId: f.profile.vendorId, adapterRevision: f.profile.adapterRevision, modelIds: [f.profile.modelId], reasoningEfforts: [null], structuredOutput: true, invokeStructured});
    expect((await new ApprovedRouteClassificationProvider([native], f.fetcher).availability(f.profile)).available).toBe(false);
    expect(invokeStructured).not.toHaveBeenCalled();
  });
  it.each(["wrong-provider", "wrong-revision"])("reserves the long ref against %s and injected replacement", variant => {
    const route = {providerKind: variant === "wrong-provider" ? "vendor" as const : "jev" as const,
      adapterRevision: variant === "wrong-revision" ? JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION : JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION};
    expect(() => resolveClassificationWireAdapter(JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION, route,
      new Map([[JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION, jevNoulSharedRulesV6LongContextWireAdapter]]))).toThrow("INVALID_JEV_CONTEXT_ROUTE");
  });
  it("rejects a wrong prompt, reused standard qualification, and credential-await transport mutation", async () => {
    const f = longChoiceFixture(), stale = {...f.profile, promptRevision: "wrong-prompt"};
    expect(() => jevSkillSelectionChoiceLongContextWireAdapter.decode(f.body, f.request, stale)).toThrow("JEV_CHOICE_PROFILE_MISMATCH");
    const copied = {...f.profile, adapterRevision: JEV_SKILL_SELECTION_CHOICE_ADAPTER_REVISION};
    expect(validateProviderProfile(copied, f.request, Date.now())).toBe("QUALIFICATION_CONFIGURATION_MISMATCH");
    stale.qualification = {...stale.qualification, promptRevision: stale.promptRevision};
    stale.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(stale);
    expect(validateProviderProfile(stale, f.request, Date.now())).toBe("UNSUPPORTED_OPTIONS");
    f.credential.mockImplementation(async () => {Reflect.deleteProperty(f.route, "transport"); return "fixture-only";});
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "STALE_CLASSIFICATION", dispatchState: "not-started"});
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("publishes a separate schema-valid NOT_RUN long-context definition without inheriting qualification", () => {
    const f = fixture(1), config = {...configuration, profileId: "offline-choice-long-context-evaluation", adapterRevision: JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION};
    const value = createProviderEvaluationConfiguration(config, f.request, "2000-01-01T00:00:00.000Z");
    const prepared = JSON.parse(readFileSync(new URL("./fixtures/jev-direct-choice-long-context-evaluation.NOT_RUN.json", import.meta.url), "utf8"));
    const ajv = new Ajv2020({strict: true}); (addFormatsModule as unknown as FormatsPlugin)(ajv);
    const check = ajv.compile(JSON.parse(readFileSync(new URL("../../contracts/skill-classification-evaluation-configuration.v1.schema.json", import.meta.url), "utf8")));
    expect(check(prepared)).toBe(true); expect(prepared).toEqual(value);
    expect(validateProviderEvaluationConfiguration(prepared, f.request)).toBeNull();
    expect(prepared.configuration.adapterRevision).toBe(JEV_SKILL_SELECTION_CHOICE_LONG_CONTEXT_ADAPTER_REVISION);
    expect(prepared.configuration.promptRevision).toBe(JEV_SKILL_SELECTION_CHOICE_PROMPT_REVISION);
    expect(prepared.productionRegistryUsable).toBe(false); expect(prepared.evaluationState.status).toBe("NOT_RUN");
    expect(Object.hasOwn(prepared.configuration, "qualification")).toBe(false);
    expect(prepared.configurationDigest).not.toBe(digestProviderProfileConfiguration(configuration));
  });
});

describe("Choice selected-label probability consistency", () => {
  it("rejects a Choice label below the maximum probability instead of trusting label membership alone", async () => {
    const f = fixture(1);
    f.body.answers["skill-0"]!.probabilities = {needed: 0, "not-needed": 1, uncertain: 0};
    expect(() => jevSkillSelectionChoiceWireAdapter.decode(f.body, f.request, f.profile)).toThrow("INVALID_JEV_CHOICE_WINNER");
    await expect(f.provider.classify(f.request, f.profile, new AbortController().signal)).rejects.toMatchObject({code: "INVALID_PROVIDER_RESPONSE", invalid: true});
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("allows a selected maximum-probability tie without a confidence threshold", () => {
    const f = fixture(1), answer = f.body.answers["skill-0"]!;
    answer.confidence = .1; answer.probabilities = {needed: .5, "not-needed": .5, uncertain: 0};
    expect(jevSkillSelectionChoiceWireAdapter.decode(f.body, f.request, f.profile).response.judgments[0]!.judgment).toBe("needed");
    answer.choice = "uncertain"; answer.probabilities = {needed: .5, "not-needed": 0, uncertain: .5};
    expect(jevSkillSelectionChoiceWireAdapter.decode(f.body, f.request, f.profile).response.judgments[0]!.judgment).toBe("uncertain");
  });
});
