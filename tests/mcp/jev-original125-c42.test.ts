import {afterEach, describe, expect, it, vi} from "vitest";
import {ApprovedRouteClassificationProvider, bindClassificationRouteTransport, ClassificationProviderError, jevNoulWireAdapter, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import type {ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// C-42: 초회 JEV 1회, 동일 공급자 재시도 0회, 별도 vendor 대체 최대 1회.
// 기존 service/provider 합성 fixture의 자격·예산·50ms timeout을 재사용한다.
// 실제 운영 승인·실 JEV·제품 retry 설정의 근거가 아니며 모든 발신은 fake다.
type Failure = 429 | 503 | "timeout";
const cases = [[429, "RATE_LIMITED"], [503, "SERVER_UNAVAILABLE"], ["timeout", "PROVIDER_TIMEOUT"]] as const;
function fixture(failure: Failure, terminal: "success" | "failure" = "success", hold = false) {
  const request = createClassificationRequest({requestId: "request", operationId: "operation", originalPrompt: "읽기 전용, 수정 금지. 검토만 해라.",
    inventory: {skills: [{skillId: "review", version: "1", description: "고정 변경분 검토", enabled: true, installed: true, hostSupported: true, capabilities: ["review"], actions: ["review"], targets: ["diff"], constraints: ["read-only"], applicability: ["fixed diff"], exclusions: ["implementation"], dependencies: [], phases: [], sourceRefs: []}], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "typesafe" : "current-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`, reasoningEffort: kind === "jev" ? null : "low",
      supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`, qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""}, adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0.4, judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value); return value;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 50},
    registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "current-vendor"};
  const failureResponse = () => new Response("PRIVATE_C42_BODY", {status: failure === 429 ? 429 : 503, headers: {"retry-after": "15"}});
  let release: (() => void) | undefined;
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (!hold && failure !== "timeout") return failureResponse();
    return new Promise<Response>((resolve, reject) => {
      release = () => resolve(failureResponse());
      const abort = () => reject(new DOMException("합성 취소", "AbortError"));
      if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener("abort", abort, {once: true});
    });
  });
  const jev = new ApprovedRouteClassificationProvider([bindClassificationRouteTransport({routeRef: "jev-route", approvalRef: "fixture-approval", approved: true, kind: "remote", providerKind: "jev", vendorId: "typesafe", adapterRevision: "a1", modelIds: ["jev-fixed"], reasoningEfforts: [null], structuredOutput: true,
    endpoint: "https://approved.example.invalid/fixture", getCredential: async () => "synthetic-c42-only", adapter: jevNoulWireAdapter})], fetcher);
  const jevClassify = vi.spyOn(jev, "classify"), vendorDispatch = vi.fn();
  const evaluation = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest, status: "SUCCESS", judgments: [{skillId: "review", judgment: "needed", reasonRefs: ["fixture"], uncertaintyReason: null}], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0.1}, dispatchState: "started", diagnostics: null});
  const vendor: SkillClassificationProviderPort = {availability: vi.fn(async () => ({available: true, approved: true, routeKind: "remote" as const, reasonCode: null})), classify: vi.fn(async (req, _profile, _signal, beforeDispatch) => {
    beforeDispatch?.(); vendorDispatch();
    if (terminal === "failure") throw new ClassificationProviderError("SERVER_UNAVAILABLE", "started");
    return evaluation(req);
  })};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"current-vendor": {limitUsd: 2, spentUsd: 0}}});
  const service = new SkillClassificationService({providers: {jev, vendor}, budget});
  return {input, service, fetcher, jevClassify, vendor, vendorDispatch, releaseFailure: () => release?.()};
}
function clock() {vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-01T00:00:00Z"));}
afterEach(() => {vi.useRealTimers(); vi.restoreAllMocks();});

describe("원125 C-42 재시도 없는 명시적 대체 경계", () => {
  it.each(cases)("C42-SUCCESS %s: 동시·완료 중복과 Retry-After 경과에도 JEV1·vendor1", async (failure, code) => {
    clock(); const f = fixture(failure);
    const first = f.service.classify(f.input), duplicate = f.service.classify(f.input);
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(51);
    const [result, shared] = await Promise.all([first, duplicate]);
    expect(shared).toEqual(result); expect(result.response.status).toBe("SUCCESS");
    expect(result.attempts.map(a => [a.providerKind, a.errorCode])).toEqual([["jev", code], ["vendor", null]]);
    expect(result.attempts[0]).toMatchObject({timedOut: failure === "timeout", dispatchState: failure === "timeout" ? "unknown" : "started",
      rateLimitObservation: failure === 429 ? {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: 15}} : null});
    expect(f.jevClassify).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(f.vendorDispatch).toHaveBeenCalledTimes(1);
    expect(await f.service.classify(f.input)).toEqual(result);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await f.service.classify(f.input)).toEqual(result);
    expect(f.jevClassify).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(f.vendorDispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_C42_BODY");
  });
  it.each(cases)("C42-FAILURE %s: 별도 vendor 실패 뒤 양쪽 재시도·중복 전송 없음", async (failure, code) => {
    clock(); const f = fixture(failure, "failure");
    const first = f.service.classify(f.input), duplicate = f.service.classify(f.input);
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(51);
    const [result, shared] = await Promise.all([first, duplicate]);
    expect(shared).toEqual(result); expect(result.response.error).toMatchObject({code: "SERVER_UNAVAILABLE", retryable: false});
    expect(result.attempts.map(a => [a.providerKind, a.errorCode])).toEqual([["jev", code], ["vendor", "SERVER_UNAVAILABLE"]]);
    expect(result.attempts[0]?.rateLimitObservation).toEqual(failure === 429 ? {httpStatus: 429, retryAfter: {kind: "delay-seconds", seconds: 15}} : null);
    expect(await f.service.classify(f.input)).toEqual(result);
    await vi.advanceTimersByTimeAsync(15001);
    expect(await f.service.classify(f.input)).toEqual(result);
    expect(f.jevClassify).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.vendor.classify).toHaveBeenCalledTimes(1); expect(f.vendorDispatch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_C42_BODY");
  });
  it.each(cases)("C42-CANCEL %s: 시작 후 취소와 늦은 실패는 vendor 대체를 허용하지 않음", async failure => {
    clock(); const f = fixture(failure, "success", true), controller = new AbortController(); f.input.signal = controller.signal;
    const first = f.service.classify(f.input), duplicate = f.service.classify(f.input);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.jevClassify).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    controller.abort();
    const results = await Promise.all([first, duplicate]);
    for (const result of results) {
      expect(result.response.error?.code).toBe("STALE_CLASSIFICATION");
      expect(result.attempts).toHaveLength(1); expect(result.attempts[0]).toMatchObject({providerKind: "jev", errorCode: "CANCELLED"});
    }
    f.releaseFailure(); await vi.advanceTimersByTimeAsync(15001);
    expect(f.jevClassify).toHaveBeenCalledTimes(1); expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.vendor.availability).not.toHaveBeenCalled(); expect(f.vendor.classify).not.toHaveBeenCalled(); expect(f.vendorDispatch).not.toHaveBeenCalled();
  });
});
