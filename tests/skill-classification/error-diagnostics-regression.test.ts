import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";
import {afterEach, describe, expect, it, vi} from "vitest";
import {createClassificationRequest} from "../../mcp-server/src/skill-classification/request.js";
import {digestProviderProfileConfiguration} from "../../mcp-server/src/skill-classification/profiles.js";
import {ClassificationProviderError, unknownUsage} from "../../mcp-server/src/skill-classification/providers.js";
import {InMemoryClassificationBudget, SkillClassificationService, type ClassificationServiceInput} from "../../mcp-server/src/skill-classification/service.js";
import {createNativeClassificationAdapters, type NativeClassificationAdapterDefinition, type NativeCliBehavior, type NativeCliRunner} from "../../mcp-server/src/skill-classification/native-adapters.js";
import {bindNativeClassificationDefinitions} from "../../mcp-server/src/skill-classification/native-cli-strategies.js";
import * as runtime from "../../mcp-server/src/skill-classification/runtime.js";
import type {ClassificationSnapshot, ProviderEvaluation, ProviderProfile, SkillClassificationProviderPort, SkillClassificationRequestV1} from "../../mcp-server/src/skill-classification/types.js";

// 공개 서비스·어댑터 경계 회귀. 실제 공급자 호출은 없으며 자격·한도는 합성값이다.
// 같은 시험 바이트로 기준 소스의 실패와 수정 소스의 성공을 TEST에서 비교한다.
const directories: string[] = [];
afterEach(async () => {for (const directory of directories.splice(0)) await rm(directory, {recursive: true, force: true});});
function fixture() {
  const request = createClassificationRequest({requestId: "req", operationId: "op", originalPrompt: "읽기만 하고 수정하지 마라.",
    inventory: {skills: [], issues: [], inventoryDigest: `sha256:${"a".repeat(64)}`, taxonomyRevision: "taxonomy"}, classificationCriteriaRef: "criteria"});
  const profile = (kind: "jev" | "vendor"): ProviderProfile => {
    const value: ProviderProfile = {profileId: kind, providerKind: kind, vendorId: kind === "jev" ? "fixture-jev" : "fixture-vendor", modelId: `${kind}-fixed`, modelRevision: `${kind}-fixed`,
      reasoningEffort: kind === "jev" ? null : "low", supportedOptions: {reasoningEfforts: kind === "jev" ? [null] : ["low"], structuredOutput: true}, approvedRouteRef: `${kind}-route`,
      qualificationRevision: "q1", qualification: {status: "PASS", inventoryDigest: request.inventoryDigest, taxonomyRevision: request.taxonomyRevision, modelRevision: `${kind}-fixed`, promptRevision: "p1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: ""},
      adapterRevision: "a1", promptRevision: "p1", maximumInputBytes: 100000, maximumOutputTokens: 1000, maximumCostUsd: 0,
      judgmentPolicy: kind === "jev" ? {neededAt: 0.8, notNeededAt: 0.2} : null};
    value.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(value);
    return value;
  };
  const input: ClassificationServiceInput = {request, config: {jevEnabled: true, mode: "select", providerProfileRegistryRef: "profiles", externalClassificationAllowed: true, configRevision: "c1", timeoutMs: 10000},
    registry: {schemaVersion: "1.0.0", profileRevision: "pr1", profiles: [profile("jev"), profile("vendor")]}, currentVendorId: "fixture-vendor"};
  const evaluation = (req: SkillClassificationRequestV1): ProviderEvaluation => ({response: {schemaVersion: "1.0.0", requestId: req.requestId, operationId: req.operationId, requestDigest: req.requestDigest, inventoryDigest: req.inventoryDigest,
    status: "SUCCESS", judgments: [], unresolvedItems: [], error: null}, usage: {...unknownUsage(), actualCostUsd: 0}, dispatchState: "started", diagnostics: null});
  let bindingCurrent = true;
  const provider = (): SkillClassificationProviderPort => ({validateConfiguration: () => null, captureConfigurationFence: () => () => bindingCurrent,
    routeKind: () => "native", availability: vi.fn(async () => ({available: true, approved: true, routeKind: "native" as const, reasonCode: null})),
    classify: vi.fn(async (req, _profile, _signal, beforeDispatch) => {beforeDispatch?.(); return evaluation(req);})});
  const jev = provider(), vendor = provider();
  const providers: {jev?: SkillClassificationProviderPort; vendor?: SkillClassificationProviderPort} = {jev, vendor};
  const budget = new InMemoryClassificationBudget({jev: {limitUsd: 5, spentUsd: 0}, vendors: {"fixture-vendor": {limitUsd: 5, spentUsd: 0}},
    nativeAllowances: {jev: {approvalRef: "synthetic", remainingCalls: 2}, vendor: {approvalRef: "synthetic", remainingCalls: 2}}});
  const reserve = vi.spyOn(budget, "reserve");
  const snapshot: ClassificationSnapshot = {taskRevision: request.confirmedContext.taskRevision, configRevision: "c1", profileRevision: "pr1", inventoryDigest: request.inventoryDigest, requestDigest: request.requestDigest, cancelled: false};
  input.getCurrentSnapshot = () => snapshot;
  const service = new SkillClassificationService({providers, budget, now: () => Date.parse("2026-11-01T00:00:00Z")});
  return {input, jev, vendor, providers, budget, reserve, snapshot, service, invalidateBinding: () => {bindingCurrent = false;}};
}

const skipCases = [
  // 4.0.0: JEV's qualification status no longer excludes it (advice layer); a configuration digest that does not match still does.
  ["profile", "PROFILE_UNAVAILABLE"], ["provider", "PROVIDER_UNAVAILABLE"], ["configuration", "QUALIFICATION_CONFIGURATION_MISMATCH"], ["input", "INPUT_TOO_LONG"],
] as const;
describe("D0067 호출 전 제외 진단", () => {
  it.each(skipCases)("SKIP %s: 성공·실패·재검증에도 원인을 보존하고 호출을 늘리지 않는다", async (kind, code) => {
    for (const outcome of ["success", "failure", "stale", "stale-binding", "vendor-preflight"] as const) {
      const f = fixture(), jev = f.input.registry.profiles[0]!;
      if (kind === "profile") f.input.registry.profiles.shift();
      if (kind === "provider") delete f.providers.jev;
      if (kind === "configuration") jev.qualification.profileConfigurationDigest = `sha256:${"0".repeat(64)}`;
      if (kind === "input") {jev.maximumInputBytes = 1; jev.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(jev);}
      if (outcome === "failure") vi.mocked(f.vendor.classify).mockRejectedValue(new ClassificationProviderError("AUTH_UNAVAILABLE", "not-started"));
      if (outcome === "vendor-preflight") f.input.registry.profiles.find(p => p.providerKind === "vendor")!.qualification.status = "FAIL";
      const result = await f.service.classify(f.input);
      const expected = [{providerKind: "jev", profileId: kind === "profile" ? null : "jev", reasonCode: code, dispatchState: "not-started"}];
      expect(result.skipped).toEqual(expected);
      expect(result.attempts).toHaveLength(outcome === "vendor-preflight" ? 0 : 1);
      expect(f.jev.availability).not.toHaveBeenCalled(); expect(f.jev.classify).not.toHaveBeenCalled();
      expect(f.reserve).toHaveBeenCalledTimes(outcome === "vendor-preflight" ? 0 : 1);
      expect(f.reserve.mock.calls.every(([profile]) => profile.providerKind === "vendor")).toBe(true);
      expect(f.vendor.classify).toHaveBeenCalledTimes(outcome === "vendor-preflight" ? 0 : 1);
      expect(f.service.helperFailure(result)).toBeNull();
      if (outcome === "stale") f.snapshot.configRevision = "changed";
      if (outcome === "stale-binding") f.invalidateBinding();
      const rechecked = await f.service.classify(f.input);
      expect(rechecked.skipped).toEqual(expected);
      expect(rechecked.response.error?.code ?? null).toBe(outcome === "stale" || outcome === "stale-binding" ? "STALE_CLASSIFICATION" : outcome === "failure" ? "AUTH_UNAVAILABLE" : outcome === "vendor-preflight" ? "PROFILE_UNQUALIFIED" : null);
      expect(f.vendor.classify).toHaveBeenCalledTimes(outcome === "vendor-preflight" ? 0 : 1);
    }
  });
  it("SKIP-OFF 비활성 공급자는 제외 진단이나 호출을 만들지 않는다", async () => {
    const f = fixture(); f.input.config.jevEnabled = false;
    const result = await f.service.classify(f.input);
    expect(result.skipped).toEqual([]); expect(result.attempts).toHaveLength(1); expect(f.jev.availability).not.toHaveBeenCalled();
  });
});

async function nativeFixture() {
  const f = fixture(), cwd = await mkdtemp(path.join(tmpdir(), "ags-error-diagnostics-")); directories.push(cwd);
  f.input.config.jevEnabled = false;
  const definition: NativeClassificationAdapterDefinition = {adapterId: "fixture", host: "codex", executable: path.join(cwd, "fixture.exe"), workingDirectory: cwd, approvalRef: "synthetic", capabilityEvidenceRef: "synthetic",
    retryPolicyVerified: true, retryPolicyEvidenceRef: "synthetic", isolationEvidenceRef: "synthetic", isolationArgs: [], timeoutMs: 1000, maximumOutputBytes: 64000};
  return {...f, definition, profile: f.input.registry.profiles[1]!};
}
const nativeCases = [
  ["NATIVE_RESULT_FAILURE", {type: "turn.failed", error: {message: "PRIVATE_NATIVE_SENTINEL"}}],
  ["NATIVE_ISOLATION_VIOLATION", {type: "item.completed", item: {type: "mcp_tool_call", arguments: "PRIVATE_NATIVE_SENTINEL"}}],
  ["NATIVE_MESSAGE_MISSING", {type: "item.completed", item: {type: "agent_message"}}],
  ["NATIVE_RESULT_AMBIGUOUS", {type: "turn.completed"}],
] as const;
describe("D0071 안전 네이티브 원인과 기존 권한 경계", () => {
  it.each(nativeCases)("NATIVE %s를 보존하며 실제 전송 검사 뒤의 기존 증거만 발급한다", async (code, event) => {
    for (const fenced of [true, false]) {
      const f = await nativeFixture(), runner = vi.fn<NativeCliRunner>(async () => ({stdout: JSON.stringify(event), exitCode: 0}));
      const adapter = createNativeClassificationAdapters(bindNativeClassificationDefinitions([f.definition]), runner).get("fixture")!;
      vi.mocked(f.vendor.classify).mockImplementation((req, profile, signal, beforeDispatch) => adapter.invokeStructured(req, profile, signal, fenced ? beforeDispatch : undefined));
      const result = await f.service.classify(f.input);
      expect(result.response.error?.code).toBe(code); expect(result.response.status).toBe("INVALID");
      expect(result.attempts).toHaveLength(1); expect(result.attempts[0]).toMatchObject({errorCode: code, dispatchState: "started"});
      expect(runner).toHaveBeenCalledTimes(1); expect(f.reserve).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_SENTINEL");
      expect(f.service.helperFailure(result)?.errorCode ?? null).toBe(fenced ? code : null);
      expect(f.service.helperFailure(structuredClone(result))).toBeNull();
      if (fenced) {
        const skipped = result.skipped ?? [];
        result.skipped = [{providerKind: "jev", profileId: null, reasonCode: "PROFILE_UNAVAILABLE", dispatchState: "not-started"}];
        expect(f.service.helperFailure(result)).toBeNull();
        result.skipped = skipped; expect(f.service.helperFailure(result)?.errorCode).toBe(code);
      }
      f.invalidateBinding(); expect(f.service.helperFailure(result)).toBeNull();
    }
  });
  it("NATIVE-FENCE 오래된 요청은 실행과 후속 증거를 모두 막는다", async () => {
    const f = await nativeFixture(), runner = vi.fn<NativeCliRunner>();
    const adapter = createNativeClassificationAdapters(bindNativeClassificationDefinitions([f.definition]), runner).get("fixture")!;
    vi.mocked(f.vendor.classify).mockImplementation((req, profile, signal, beforeDispatch) => {
      f.snapshot.cancelled = true;
      return adapter.invokeStructured(req, profile, signal, beforeDispatch);
    });
    const result = await f.service.classify(f.input);
    expect(result.response.error?.code).toBe("STALE_CLASSIFICATION"); expect(runner).not.toHaveBeenCalled(); expect(f.service.helperFailure(result)).toBeNull();
    expect(f.budget.snapshot().reservations).toEqual([]);
  });
  it("NATIVE-PRIVATE 임의 오류·접근자·프록시는 안전한 일반 코드만 공개한다", async () => {
    const getter = vi.fn(() => "NATIVE_RESULT_FAILURE"), trap = vi.fn(() => {throw new Error("PRIVATE_NATIVE_SENTINEL");});
    const failures: unknown[] = [new Error("PRIVATE_NATIVE_SENTINEL"), new Error("NATIVE_RESULT_FAILURE PRIVATE_NATIVE_SENTINEL"),
      Object.defineProperty({}, "message", {get: getter}), new Proxy({}, {getOwnPropertyDescriptor: trap})];
    for (const failure of failures) {
      const f = await nativeFixture(), runner = vi.fn<NativeCliRunner>(async () => ({stdout: "PRIVATE_NATIVE_SENTINEL", exitCode: 0}));
      const behavior: NativeCliBehavior = {validateIsolationArgs: () => true, canEncodeProfile: () => true, prepare: () => ({args: []}), decode: () => {throw failure;}};
      const adapter = createNativeClassificationAdapters([{data: {...f.definition, host: "fixture-host"}, behavior}], runner).get("fixture")!;
      vi.mocked(f.vendor.classify).mockImplementation((req, profile, signal, beforeDispatch) => adapter.invokeStructured(req, profile, signal, beforeDispatch));
      const result = await f.service.classify(f.input);
      expect(result.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE"); expect(JSON.stringify(result)).not.toContain("PRIVATE_NATIVE_SENTINEL");
      expect(f.service.helperFailure(result)?.errorCode).toBe("INVALID_PROVIDER_RESPONSE");
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });
});

describe("D0068 초기화 안전 원인 재사용", () => {
  it("INIT 알려진 원인만 오류와 보고에 보관하고 원본 객체를 보관하지 않는다", () => {
    expect(runtime.classificationInitializationFailureReason).toBeTypeOf("function");
    for (const source of [new Error("INVALID_NATIVE_ISOLATION_ARGUMENT"), new Error("PRIVATE_INITIALIZATION_SENTINEL")]) {
      const expected = source.message === "INVALID_NATIVE_ISOLATION_ARGUMENT" ? source.message : "CLASSIFICATION_CONFIGURATION_UNAVAILABLE";
      const error = new runtime.ClassificationInitializationError(source), report = vi.fn();
      expect(runtime.classificationInitializationFailureReason(source)).toBe(expected);
      expect(error).toMatchObject({phase: "classification-initialization", message: expected}); expect(error).not.toHaveProperty("cause");
      runtime.reportClassificationInitializationFailure(error, report);
      expect(report).toHaveBeenCalledExactlyOnceWith({phase: "classification-initialization", reason: expected});
      expect(JSON.stringify(error)).not.toContain("PRIVATE_INITIALIZATION_SENTINEL");
    }
  });
  it("INIT-PRIVATE 접근자·프록시·해제된 프록시는 읽지 않고 닫힌 기본값을 쓴다", () => {
    const getter = vi.fn(), trap = vi.fn(), revoked = Proxy.revocable({}, {}); revoked.revoke();
    for (const error of [Object.defineProperty({}, "message", {get: getter}), new Proxy({}, {getOwnPropertyDescriptor: trap}), revoked.proxy]) {
      expect(runtime.classificationInitializationFailureReason(error)).toBe("CLASSIFICATION_CONFIGURATION_UNAVAILABLE");
      expect(new runtime.ClassificationInitializationError(error).message).toBe("CLASSIFICATION_CONFIGURATION_UNAVAILABLE");
    }
    expect(getter).not.toHaveBeenCalled(); expect(trap).not.toHaveBeenCalled();
  });
});
