import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {InMemoryTransport} from "@modelcontextprotocol/sdk/inMemory.js";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {ApiResultV1, ExecutionContextV1} from "../../contracts/types.js";
import type {CallerExecution, CallerIngress} from "../../mcp-server/src/caller-identity.js";
import {HostAttestationProvider, type HostExecutionAdapter} from "../../mcp-server/src/host-attestation.js";
import {InMemoryPluginUpdateStore} from "../../mcp-server/src/plugin-update-store.js";
import {PluginUpdateService} from "../../mcp-server/src/plugin-update-service.js";
import {FileSkillRegistry} from "../../mcp-server/src/registry.js";
import {ContractValidator} from "../../mcp-server/src/schema-validator.js";
import {createMcpServer} from "../../mcp-server/src/server.js";
import {WorkflowService} from "../../mcp-server/src/workflow-service.js";
import {InMemoryWorkflowStore} from "../../mcp-server/src/workflow-store.js";
import {RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot} from "../../mcp-server/src/skill-classification/gateway.js";
import {loadHostObservedInventory, type HostSkillDiscoverySnapshot} from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import {loadSkillInventory} from "../../mcp-server/src/skill-classification/inventory.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, ClassificationProviderError, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {InMemoryClassificationBudget, SkillClassificationService} from "../../mcp-server/src/skill-classification/service.js";
import type {ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillSelectionDecisionV1} from "../../mcp-server/src/skill-classification/types.js";
import {callerMeta, metaIngress} from "../helpers/caller.js";

// 원 결함과 검수 지적의 기대값을 먼저 고정한 API 회귀 시험이다.
// 기존 gateway·AL08·AL09의 실제 MCP 전송·서버·합성 관측 틀을 재사용한다.
// 외부 공급자와 native 실행만 대체한다. 실해석기·모델 품질·설치후 소비 증거는 아니다.
const repository = fileURLToPath(new URL("../../", import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
// 정상 API 경로의 합성 능력을 명시한다. 실제 호스트 능력 관측의 증거는 아니다.
const adapter: HostExecutionAdapter = {host: "fixture-host", provider: "fixture-provider", policyRevision: "fixture-host-policy-r1",
  modelClassForModel: model => model === "fixture-host-model" ? "general" : null,
  resolveModel: (model, provenance = "fixture:host-owned") => model === "fixture-host-model" ? {
    host: "fixture-host", provider: "fixture-provider", rawModel: model, resolvedModel: model, modelClass: "general",
    minimumReasoningEffort: "high", supportedEfforts: ["high"], aliasUsed: false, policyRevision: "fixture-host-policy-r1", provenance,
  } : null};
afterEach(async () => {while (cleanup.length) await cleanup.pop()!();});
// The host reports the caller's execution in its own call metadata; this test-owned key carries it beside callerMeta().
const EXECUTION_META = "agent-governance.test/execution";
function executionIngress(): CallerIngress {
  const named = metaIngress();
  return (tool, meta) => {
    const result = named(tool, meta), execution = meta?.[EXECUTION_META] as CallerExecution | undefined;
    return result.provenance === "host-observed" && execution ? {provenance: "host-observed", caller: {...result.caller, execution}} : result;
  };
}
function input() {
  return {schemaVersion: "1.0.0", requestId: "api-request", operationId: "api-operation", originalPrompt: "비공개 합성 자료를 읽기만 하고 수정하지 마라.",
    confirmedContext: {taskRevision: null, objective: null, actions: null, targets: null, constraints: null, prohibitedActions: null, background: null},
    contextSources: [], explicitSkillIds: [], ruleRequiredSkillIds: [], vendorContext: {vendorId: "fixture-vendor", reference: "fixture:approved-route"}, publicSynthetic: false};
}
interface Advice {result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null; selectionStatus: string; adviceApplied: boolean}
type Accepted = {valid: false; errors: string[]; agentSelectedSkillIds: null}
  | {valid: true; errors: string[]; decision: SkillSelectionDecisionV1};
interface NeedsInput {status: string; errors: string[]; response: null; agentSelectedSkillIds: null}
function decision(advice: Advice): SkillSelectionDecisionV1 {
  const snapshot = advice.result.snapshot;
  return {schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, taskRevision: snapshot.taskRevision,
    configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision, inventoryDigest: snapshot.inventoryDigest, requestDigest: snapshot.requestDigest,
    explicitSkillIds: [], ruleRequiredSkillIds: [], agentSelectedSkillIds: [], selectionReasons: [], applicabilityChecks: [], unresolvedSkillReferences: [],
    selectionStatus: "SELECTED", adviceApplied: true, hostReceipt: null};
}
function evaluation(request: SkillClassificationRequestV1): ProviderEvaluation {
  return {response: {schemaVersion: "1.0.0", requestId: request.requestId, operationId: request.operationId, requestDigest: request.requestDigest,
    inventoryDigest: request.inventoryDigest, status: "SUCCESS", judgments: request.skills.map(skill => ({skillId: skill.skillId, judgment: "not-needed", reasonRefs: ["fixture:read-only"], uncertaintyReason: null})),
    unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0}, dispatchState: "started", diagnostics: null};
}
async function harness(options: {withJev?: boolean; vendorRoute?: "native" | "remote"; allowPrivate?: boolean} = {}) {
  const clock = {now: new Date()}, local = await loadSkillInventory({root: repository});
  const host: HostSkillDiscoverySnapshot = {schemaVersion: "1.0.0", sourceRef: "fixture:server-owned-host", revision: "host-1", observedAt: clock.now.toISOString(),
    expiresAt: "2099-01-01T00:00:00.000Z", skills: local.skills.map(skill => ({skillId: skill.skillId, installed: true, hostSupported: true, enabled: true, root: null}))};
  const observeHostSkills = async () => host;
  const {inventory} = await loadHostObservedInventory({root: repository, observeHostSkills, now: () => clock.now});
  expect(inventory.issues).toEqual([]);
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: "fixture-vendor", modelId: "fixture-model", modelRevision: "m1",
      reasoningEffort: kind === "jev" ? null : "high", supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["high"], structuredOutput: true},
      approvedRouteRef: kind + "-route", adapterRevision: "fixture-a1", promptRevision: "p1", qualificationRevision: "fixture-q1",
      qualification: {status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "m1", promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
      maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const vendorProfile = profile("vendor"), jevProfile = profile("jev");
  const fetcher = vi.fn<typeof fetch>(async () => {throw new Error("EXTERNAL_NETWORK_FORBIDDEN");});
  const provider = (selected: ProviderProfile, kind: "native" | "remote") => {
    const effect = vi.fn(), credential = vi.fn(async () => "PRIVATE_CREDENTIAL_SENTINEL");
    const invoke = vi.fn<(request: SkillClassificationRequestV1, profile: ProviderProfile, signal: AbortSignal, fence?: () => void) => Promise<ProviderEvaluation>>(async (request, _profile, _signal, fence) => {
      fence?.(); effect(); return evaluation(request);
    });
    const common = {routeRef: selected.approvedRouteRef, approvalRef: "fixture:route-approval", approved: true, providerKind: selected.providerKind,
      vendorId: selected.vendorId, adapterRevision: selected.adapterRevision, modelIds: [selected.modelId], reasoningEfforts: [selected.reasoningEffort], structuredOutput: true};
    const route = bindClassificationRouteTransport(kind === "native" ? {...common, kind, invokeStructured: invoke} : {...common, kind,
      endpoint: "https://fixture.invalid/classify", getCredential: credential, adapter: {encode: () => ({}), decode: (_body, request) => evaluation(request)}});
    const port = new ApprovedRouteClassificationProvider([route], fetcher);
    return {port, invoke, effect, credential, availability: vi.spyOn(port, "availability"), classify: vi.spyOn(port, "classify"), routeKind: vi.spyOn(port, "routeKind")};
  };
  const vendor = provider(vendorProfile, options.vendorRoute ?? "native"), jev = provider(jevProfile, "remote");
  const providers: {vendor?: ApprovedRouteClassificationProvider; jev?: ApprovedRouteClassificationProvider} = {vendor: vendor.port, ...(options.withJev ? {jev: jev.port} : {})};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"fixture-vendor": {limitUsd: 5, spentUsd: 0}},
    nativeAllowances: {vendor: {approvalRef: "fixture:allowance", remainingCalls: 10}, jev: {approvalRef: "fixture:allowance", remainingCalls: 10}}});
  const reserve = vi.spyOn(budget, "reserve");
  const service = new SkillClassificationService({providers, budget, now: () => clock.now.getTime()});
  const runtime: ClassificationRuntimeSnapshot = {config: {jevEnabled: options.withJev ?? false, mode: "select", providerProfileRegistryRef: "fixture:profiles",
    externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 2000}, registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [...(options.withJev ? [jevProfile] : []), vendorProfile]},
    allowRemotePrivateContent: options.allowPrivate ?? false, approvedPublicRequestDigests: []};
  const readRuntime = vi.fn(async () => runtime), observed = {last: null as ExecutionContextV1 | null};
  const gateway = new RuntimeSkillClassificationGateway({root: repository, service, readRuntime, observeHostSkills, now: () => clock.now,
    observeTask: (request, observation) => {
      observed.last = observation;
      return observation ? {taskRevision: request.confirmedContext.taskRevision, requestDigest: request.requestDigest, cancelled: false, sourceRef: "fixture:current-task"} : null;
    }});
  const validator = new ContractValidator(), store = new InMemoryWorkflowStore();
  const attestation = new HostAttestationProvider(adapter);
  const workflow = new WorkflowService(new FileSkillRegistry(path.join(repository, "skills/registry.json"), validator), validator, store, null, attestation);
  const updateFetcher = vi.fn(async () => {throw new Error("EXTERNAL_UPDATE_FORBIDDEN");});
  const server = createMcpServer(workflow, new PluginUpdateService(new InMemoryPluginUpdateStore(), {fetcher: updateFetcher}), undefined, undefined, undefined, validator, "default", attestation, null, undefined, null, gateway, executionIngress());
  const client = new Client({name: "jev-cause-api-regression", version: "1.0.0"});
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  cleanup.push(async () => {try {await client.close();} finally {await server.close(); expect(fetcher).not.toHaveBeenCalled(); expect(updateFetcher).not.toHaveBeenCalled();}});
  await server.connect(serverTransport); await client.connect(clientTransport);
  // The caller is always observed; `execution` is what the host reported for this call (null: nothing reported).
  const call = async <T>(name: string, args: Record<string, unknown>,
    execution: CallerExecution | null = {model: "fixture-host-model", effort: "high", turnId: "fixture-turn", provenance: "fixture:host-owned"}): Promise<ApiResultV1<T>> => {
    const reply = await client.callTool({name, arguments: args,
      _meta: {...callerMeta({host: adapter.host, sessionId: "fixture-session"}), ...(execution ? {[EXECUTION_META]: execution} : {})}});
    return JSON.parse((reply.content as Array<{type: string; text?: string}>).find(item => item.type === "text")!.text!) as ApiResultV1<T>;
  };
  return {call, runtime, vendorProfile, jevProfile, vendor, jev, providers, budget, reserve, readRuntime, clock, observed};
}

describe("JEV 원인과 권한의 실제 MCP 응답", () => {
  it.each([
    ["profile", "PROFILE_UNAVAILABLE"], ["provider", "PROVIDER_UNAVAILABLE"], ["qualification", "PROFILE_UNQUALIFIED"], ["input", "INPUT_TOO_LONG"],
  ] as const)("API67 %s: 대체 성공 응답에도 호출 전 제외 원인이 남는다", async (kind, code) => {
    const h = await harness({withJev: true, allowPrivate: true});
    if (kind === "profile") h.runtime.registry.profiles.shift();
    if (kind === "provider") delete h.providers.jev;
    if (kind === "qualification") h.jevProfile.qualification.status = "FAIL";
    if (kind === "input") {h.jevProfile.maximumInputBytes = 1; h.jevProfile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(h.jevProfile);}
    const reply = await h.call<Advice>("classify_skills", input());
    expect(reply.error).toBeNull();
    expect(reply.data!.result.response.status).toBe("SUCCESS");
    expect(reply.data!.result.skipped).toEqual([{providerKind: "jev", profileId: kind === "profile" ? null : "jev", reasonCode: code, dispatchState: "not-started"}]);
    expect(reply.data!.result.attempts.map(attempt => attempt.providerKind)).toEqual(["vendor"]);
    expect(reply.data).toMatchObject({agentSelectedSkillIds: null, selectionStatus: "PROPOSED", adviceApplied: false});
    expect(h.jev.availability).not.toHaveBeenCalled(); expect(h.jev.classify).not.toHaveBeenCalled(); expect(h.jev.credential).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledTimes(1); expect(h.reserve.mock.calls[0]![0].providerKind).toBe("vendor"); expect(h.vendor.invoke).toHaveBeenCalledTimes(1);
  });

  it("API69 만료: 승인 관측이 비동기 읽기 중 만료되면 정확한 요청 상태 원인을 반환한다", async () => {
    const h = await harness(), advice = (await h.call<Advice>("classify_skills", input())).data!;
    h.readRuntime.mockImplementationOnce(async () => {
      expect(h.observed.last?.expiresAt).toEqual(expect.any(String));
      h.clock.now = new Date(Date.parse(h.observed.last!.expiresAt!) + 60_000);
      return h.runtime;
    });
    const reply = await h.call<Accepted>("record_skill_selection", {schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice)});
    expect(reply).toMatchObject({ok: false, data: null, error: {code: "INVALID_INPUT", details: {category: "request-state", reasonCode: "HOST_SELECTION_OBSERVATION_EXPIRED"}}});
    expect(JSON.stringify(reply)).not.toContain("fixture-host-model");
    expect(h.vendor.invoke).toHaveBeenCalledTimes(1);
  });

  it("API69 결속: 관측·호출자 원문은 숨긴다", async () => {
    const h = await harness();
    // The host reported an effort outside the closed set: since 3.1.1 it is kept as unknown rather than refused,
    // and the raw value is never echoed back.
    const reply = await h.call<Advice>("classify_skills", input(), {model: "fixture-host-model", effort: "PRIVATE_EFFORT_SENTINEL", turnId: "fixture-turn", provenance: "fixture:host-owned"});
    expect(JSON.stringify(reply)).not.toContain("REASONING_EFFORT_INVALID");
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_EFFORT_SENTINEL");
    const before = [h.vendor.availability, h.reserve, h.vendor.invoke].map((spy) => spy.mock.calls.length);
    // A caller-supplied observation field is refused at the server entry before classification, without echoing it.
    const forged = await h.call<Advice>("classify_skills", {...input(), _hostAttestation: "PRIVATE_HOST_TOKEN_SENTINEL"});
    expect(forged).toMatchObject({ok: false, data: null, error: {code: "INVALID_INPUT", details: {reasonCode: "RESERVED_CALLER_FIELD", field: "_hostAttestation"}}});
    expect(JSON.stringify(forged)).not.toContain("PRIVATE_HOST_TOKEN_SENTINEL");
    expect([h.vendor.availability, h.reserve, h.vendor.invoke].map((spy) => spy.mock.calls.length)).toEqual(before);
  });

  it("API69 설정: 유효 입력의 설정 읽기 실패는 입력 오류와 구별하고 비밀을 숨긴다", async () => {
    const h = await harness(); h.readRuntime.mockRejectedValueOnce(new Error("PRIVATE_CONFIGURATION_PATH token=PRIVATE_CONFIGURATION_SECRET"));
    const reply = await h.call<Advice>("classify_skills", input());
    expect(reply).toMatchObject({ok: false, data: null, error: {code: "MCP_UNAVAILABLE"}});
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_CONFIGURATION");
    expect(h.vendor.availability).not.toHaveBeenCalled(); expect(h.reserve).not.toHaveBeenCalled(); expect(h.vendor.invoke).not.toHaveBeenCalled();
  });

  it("API74 native: 원격 비공개 전송 비승인과 공개 승인 부재에도 승인된 native 루트는 진행한다", async () => {
    const h = await harness(), reply = await h.call<Advice>("classify_skills", input());
    expect(h.runtime.allowRemotePrivateContent).toBe(false); expect(h.runtime.approvedPublicRequestDigests).toEqual([]);
    expect(reply.error).toBeNull(); expect(reply.data!.result.response).toMatchObject({status: "SUCCESS", error: null});
    expect(reply.data!.result.attempts).toHaveLength(1); expect(reply.data!.result.attempts[0]).toMatchObject({providerKind: "vendor", dispatchState: "started", errorCode: null});
    expect(h.vendor.invoke).toHaveBeenCalledTimes(1); expect(h.vendor.effect).toHaveBeenCalledTimes(1); expect(h.reserve).toHaveBeenCalledTimes(1);
    expect(h.vendor.credential).not.toHaveBeenCalled(); expect(reply.data).toMatchObject({agentSelectedSkillIds: null, selectionStatus: "PROPOSED", adviceApplied: false});
  });

  it("API74 remote: 전송 비승인 응답은 가용성·자격증명·예약·전송 부작용보다 먼저 나온다", async () => {
    const h = await harness({vendorRoute: "remote"}), reply = await h.call<NeedsInput>("classify_skills", input());
    expect(reply.error).toBeNull(); expect(reply.data).toEqual({status: "NEEDS_INPUT", errors: ["REMOTE_CONTENT_NOT_APPROVED"], response: null, agentSelectedSkillIds: null});
    expect(h.vendor.availability).not.toHaveBeenCalled(); expect(h.vendor.credential).not.toHaveBeenCalled(); expect(h.vendor.classify).not.toHaveBeenCalled();
    expect(h.reserve).not.toHaveBeenCalled(); expect(h.vendor.effect).not.toHaveBeenCalled(); expect(h.budget.snapshot().reservations).toEqual([]);
    expect(JSON.stringify(reply)).not.toContain("PRIVATE_CREDENTIAL_SENTINEL");
  });

  it("API74 대체: 원격 JEV를 조회하지 않고 승인된 native 공급자로 진행한다", async () => {
    const h = await harness({withJev: true}), reply = await h.call<Advice>("classify_skills", input());
    expect(reply.error).toBeNull(); expect(reply.data!.result.response.status).toBe("SUCCESS");
    expect(reply.data!.result.attempts.map(attempt => [attempt.providerKind, attempt.errorCode, attempt.dispatchState])).toEqual([
      ["jev", "REMOTE_CONTENT_NOT_APPROVED", "not-started"], ["vendor", null, "started"],
    ]);
    expect(h.jev.availability).not.toHaveBeenCalled(); expect(h.jev.credential).not.toHaveBeenCalled(); expect(h.jev.classify).not.toHaveBeenCalled();
    expect(h.reserve).toHaveBeenCalledTimes(1); expect(h.vendor.invoke).toHaveBeenCalledTimes(1); expect(h.vendor.effect).toHaveBeenCalledTimes(1);
  });

  it("API74 전송직전: native로 관측한 루트가 remote로 바뀌면 실제 부작용을 차단한다", async () => {
    const h = await harness();
    h.vendor.invoke.mockImplementationOnce(async (request, _profile, _signal, fence) => {
      h.vendor.routeKind.mockReturnValue("remote"); fence?.(); h.vendor.effect(); return evaluation(request);
    });
    const reply = await h.call<Advice>("classify_skills", input());
    expect(reply.error).toBeNull(); expect(reply.data!.result.response).toMatchObject({status: "UNAVAILABLE", judgments: [], error: {code: "REMOTE_CONTENT_NOT_APPROVED", dispatchState: "not-started"}});
    expect(reply.data!.result.attempts[0]).toMatchObject({errorCode: "REMOTE_CONTENT_NOT_APPROVED", dispatchState: "not-started"});
    expect(h.vendor.effect).not.toHaveBeenCalled(); expect(h.vendor.credential).not.toHaveBeenCalled(); expect(h.budget.snapshot().reservations).toEqual([]);
    expect(h.budget.snapshot().nativeAllowances.vendor!.remainingCalls).toBe(10);
  });

  it.each([
    ["helper-advice", "CLASSIFICATION_UNAVAILABLE_CANNOT_COMPLETE_SELECTION"],
    ["independent-agent-after-helper-failure", "INDEPENDENT_SELECTION_CANNOT_APPLY_FAILED_ADVICE"],
  ] as const)("API71 %s: 오염 결과를 응답에 싣거나 실패 조언으로 선택 완료하지 않는다", async (selectionSource, errorCode) => {
    const h = await harness();
    // 합성 port 오류이며 실제 native decoder를 실행한 증거로 쓰지 않는다.
    h.vendor.invoke.mockImplementationOnce(async (_request, _profile, _signal, fence) => {
      fence?.();
      throw Object.assign(new ClassificationProviderError("NATIVE_ISOLATION_VIOLATION", "started", true), {
        poisonedHelperResult: {judgments: [{skillId: "PRIVATE_POISONED_JUDGMENT", judgment: "needed"}], diagnostics: "PRIVATE_POISONED_DIAGNOSTICS"},
      });
    });
    const classified = await h.call<Advice>("classify_skills", input());
    expect(classified.error).toBeNull();
    const advice = classified.data!;
    expect(advice.result.response).toMatchObject({status: "INVALID", judgments: [], error: {code: "NATIVE_ISOLATION_VIOLATION", dispatchState: "started"}});
    expect(advice.result.attempts[0]).toMatchObject({errorCode: "NATIVE_ISOLATION_VIOLATION", diagnostics: null});
    expect(JSON.stringify(classified)).not.toContain("PRIVATE_POISONED");
    const reply = await h.call<Accepted>("record_skill_selection", {schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice),
      ...(selectionSource === "helper-advice" ? {} : {selectionSource})});
    expect(reply.error).toBeNull(); expect(reply.data).toMatchObject({valid: false, agentSelectedSkillIds: null}); expect(reply.data!.errors).toContain(errorCode);
    expect(reply.data).not.toHaveProperty("decision"); expect(JSON.stringify(reply)).not.toContain("PRIVATE_POISONED");
    const repeated = await h.call<Advice>("classify_skills", input());
    expect(repeated.data).toMatchObject({agentSelectedSkillIds: null, selectionStatus: "PROPOSED", adviceApplied: false});
    expect(h.vendor.invoke).toHaveBeenCalledTimes(1); expect(h.reserve).toHaveBeenCalledTimes(1);
  });
  it("API71-CONTINUE 독립선택: 격리 위반 조언을 폐기해도 본 에이전트의 깨끗한 선택은 계속 기록한다", async () => {
    const h = await harness();
    const request = {...input(), originalPrompt: "code-review 스킬로 코드를 읽고 검토해. 수정하지 마.", explicitSkillIds: ["code-review"]};
    // 실제 native 해석기 실행이 아니라 전송 경계를 통과한 합성 공급자 오류다.
    h.vendor.invoke.mockImplementationOnce(async (_request, _profile, _signal, fence) => {
      fence?.();
      throw Object.assign(new ClassificationProviderError("NATIVE_ISOLATION_VIOLATION", "started", true), {
        poisonedHelperResult: {judgments: [{skillId: "PRIVATE_POISONED_JUDGMENT", judgment: "needed"}], diagnostics: "PRIVATE_POISONED_DIAGNOSTICS"},
      });
    });
    const classified = await h.call<Advice>("classify_skills", request);
    expect(classified.error).toBeNull();
    const advice = classified.data!, review = advice.result.request.skills.find(skill => skill.skillId === "code-review")!;
    expect(review).toMatchObject({enabled: true, installed: true, hostSupported: true, dependencies: []});
    expect(review.sourceRefs.some(source => source.path === "skills/code-review/SKILL.md")).toBe(true);
    expect(advice.result.response).toMatchObject({status: "INVALID", judgments: [], error: {code: "NATIVE_ISOLATION_VIOLATION", dispatchState: "started"}});
    expect(advice.result.attempts).toHaveLength(1);
    expect(advice.result.attempts[0]).toMatchObject({errorCode: "NATIVE_ISOLATION_VIOLATION", dispatchState: "started", diagnostics: null,
      usage: {inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: null}});
    const accounting = h.budget.snapshot();
    expect(accounting.reservations).toHaveLength(1);
    expect(accounting.reservations[0]).toMatchObject({profileId: "vendor", nativeProfileId: "vendor", maximumUsd: 0});
    const independent: SkillSelectionDecisionV1 = {...decision(advice), explicitSkillIds: ["code-review"], agentSelectedSkillIds: ["code-review"], adviceApplied: false,
      selectionReasons: [{skillId: "code-review", reason: "본 요청은 code-review를 명시한 읽기 전용 검토이며 수정은 금지된다. 실패한 공급자 조언을 쓰지 않고 요청과 스킬 원문으로 선택한다."}],
      applicabilityChecks: [{skillId: "code-review", applies: true, excluded: false, reasonRefs: ["skills/code-review/SKILL.md:3", "fixture:explicit-read-only-review"]}]};
    const selectionSource = "independent-agent-after-helper-failure";
    type Receipt = {source: string; operationId: string; helperFailureCode: string; helperResponseRef: string};
    const recorded = await h.call<Accepted & {selectionSource: string; independentSelection: Receipt; admissionStatus: string; readStatus: string; appliedStatus: string; verifiedStatus: string}>(
      "record_skill_selection", {schemaVersion: "1.0.0", operationId: request.operationId, decision: independent, selectionSource});
    expect(recorded.error).toBeNull();
    // gateway.accept는 성공한 선택을 decision과 hostReceipt로 반환한다(gateway.ts:220).
    expect(recorded.data).toMatchObject({valid: true, errors: [], selectionSource,
      decision: {agentSelectedSkillIds: ["code-review"], explicitSkillIds: ["code-review"], adviceApplied: false,
        hostReceipt: {host: "fixture-host", requestDigest: independent.requestDigest, inventoryDigest: independent.inventoryDigest, agentSelectedSkillIds: ["code-review"]}},
      independentSelection: {source: selectionSource, operationId: request.operationId, helperFailureCode: "NATIVE_ISOLATION_VIOLATION", helperResponseRef: advice.classificationResponseRef},
      admissionStatus: "NOT_EVALUATED", readStatus: "NOT_OBSERVED", appliedStatus: "NOT_OBSERVED", verifiedStatus: "NOT_RUN"});
    const repeated = await h.call<Advice & {selectionSource: string; independentSelection: Receipt}>("classify_skills", request);
    expect(repeated.error).toBeNull();
    expect(repeated.data).toMatchObject({agentSelectedSkillIds: ["code-review"], selectionStatus: "SELECTED", adviceApplied: false, selectionSource});
    expect(repeated.data!.independentSelection).toEqual(recorded.data!.independentSelection);
    expect(repeated.data!.result).toEqual(advice.result);
    expect(h.budget.snapshot()).toEqual(accounting);
    expect(h.vendor.invoke).toHaveBeenCalledTimes(1); expect(h.reserve).toHaveBeenCalledTimes(1); expect(h.vendor.effect).not.toHaveBeenCalled();
    for (const reply of [classified, recorded, repeated]) expect(JSON.stringify(reply)).not.toContain("PRIVATE_POISONED");
  });

});
