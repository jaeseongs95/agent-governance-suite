import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModelClassV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import {
  HostAttestationProvider, hostActorId,
  judgeAdapterModelCapability, resolveAdapterModelCapability,
  type HostExecutionAdapter, type ResolvedModelCapabilityV1,
} from "../../mcp-server/src/host-attestation.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { rootCaller } from "../helpers/caller.js";

const HOST = "synthetic-d0089-host", PROVIDER = "synthetic-d0089-provider";
const KNOWN = "gpt-6-astra", OPAQUE = "opaque-d0089-unregistered";
const SESSION = "synthetic-d0089-session", PROVENANCE = "synthetic-d0089-observation";
const NOW = Date.parse("2026-11-01T00:00:00.000Z");
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function fixture(adapter: HostExecutionAdapter) {
  const store = new InMemoryWorkflowStore();
  const provider = new HostAttestationProvider(adapter), validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const taskEnvelope: TaskEnvelopeV1 = {
    schemaVersion: "1.0.0", taskId: "synthetic-d0089-task", objective: "레거시 관측과 실행 자격의 분리를 확인한다.",
    scope: { included: ["합성 시험"], excluded: ["배포"] }, acceptanceCriteria: ["명시적 능력 없이 실행 자격을 만들지 않는다."],
    riskLevel: "high", workUnits: [{ id: "unit-1", objective: "관측 경계를 확인한다.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"], constraints: ["합성 메모리 fixture만 사용한다."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
  const args = { schemaVersion: "1.0.0", taskEnvelope };
  return { store, provider, args,
    /** One host call whose caller the host observed running `model` at high effort. */
    run(model: string, callId = "d0089-call") {
      const caller = rootCaller(HOST, SESSION, { callId, execution: { model, effort: "high", turnId: "d0089-turn", provenance: PROVENANCE } });
      return provider.run("plan_workflow", caller, () => service.planWorkflow(args, true));
    },
  };
}

const legacyModels: { label: string; model: string; modelClass: ModelClassV1 | null }[] = [
  { label: "알려진이름-frontier", model: KNOWN, modelClass: "frontier" },
  { label: "opaque-frontier", model: OPAQUE, modelClass: "frontier" },
  { label: "opaque-null", model: OPAQUE, modelClass: null },
];
const revisions = [
  { revisionLabel: "누락", revision: undefined, expectedRevision: null },
  { revisionLabel: "빈문자열", revision: "", expectedRevision: "" },
  { revisionLabel: "명시", revision: "synthetic-d0089-r1", expectedRevision: "synthetic-d0089-r1" },
];

describe("D0089 레거시 분류 콜백은 능력 관측이 아니다", () => {
  // 사전 oracle: 이름·class 응답과 무관하게 명시 descriptor가 없으면 미결정이다.
  it.each(legacyModels.flatMap(model => revisions.map(revision => ({ ...model, ...revision }))))(
    "자격을 합성하지 않는다: $label/$revisionLabel (D89-LEGACY)", ({ model, modelClass, revision, expectedRevision }) => {
      const classify = vi.fn<HostExecutionAdapter["modelClassForModel"]>().mockReturnValue(modelClass);
      const adapter: HostExecutionAdapter = { host: HOST, provider: PROVIDER, ...(revision === undefined ? {} : { policyRevision: revision }), modelClassForModel: classify };
      expect(judgeAdapterModelCapability(adapter, model, PROVENANCE)).toEqual({
        status: "undetermined", reason: "MISSING_MODEL_CAPABILITY", host: HOST, rawModel: model,
        provider: null, modelClass: null, policyRevision: expectedRevision, provenance: PROVENANCE,
      });
      expect(resolveAdapterModelCapability(adapter, model, PROVENANCE)).toBeNull();
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it.each([KNOWN, OPAQUE])("공급자 신원 부재 원인은 보존한다: %s (D89-PROVIDER)", model => {
    const classify = vi.fn<HostExecutionAdapter["modelClassForModel"]>().mockReturnValue("frontier");
    // @ts-expect-error 공급자도 resolver도 없는 외부 레거시 입력의 실행 시 거부를 확인한다.
    const adapter: HostExecutionAdapter = { host: HOST, policyRevision: "synthetic-d0089-r1", modelClassForModel: classify };
    expect(judgeAdapterModelCapability(adapter, model, PROVENANCE)).toEqual({
      status: "undetermined", reason: "MISSING_PROVIDER_IDENTITY", host: HOST, rawModel: model,
      provider: null, modelClass: null, policyRevision: "synthetic-d0089-r1", provenance: PROVENANCE,
    });
    expect(resolveAdapterModelCapability(adapter, model, PROVENANCE)).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([KNOWN, OPAQUE].flatMap(model => [undefined, "synthetic-d0089-r1"].map(revision => ({ model, revision }))))(
    "high 원관측을 워크플로 권한으로 승격하지 않는다: $model/$revision (D89-OBSERVATION)", ({ model, revision }) => {
      const classify = vi.fn<HostExecutionAdapter["modelClassForModel"]>().mockReturnValue("frontier");
      const adapter: HostExecutionAdapter = { host: HOST, provider: PROVIDER, ...(revision === undefined ? {} : { policyRevision: revision }), modelClassForModel: classify };
      const f = fixture(adapter);
      const result = f.run(model);
      // 3.1.1: the model runs, but the legacy callback's "frontier" never becomes its class.
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(result.data!.bootstrapExecution!.context).toMatchObject({ model, modelClass: null, policyNotes: ["MISSING_MODEL_CAPABILITY"] });
      expect(f.provider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
      expect(classify).not.toHaveBeenCalled();
    },
  );

  it.each(["resolve", "judge"] as const)("명시 %s 기술자의 미등록 opaque 모델은 실제 소비자가 허용한다 (D89-TRUSTED)", mode => {
    const classify = vi.fn<HostExecutionAdapter["modelClassForModel"]>().mockReturnValue(null);
    const resolve = (model: string, provenance = PROVENANCE): ResolvedModelCapabilityV1 | null => model === OPAQUE ? {
      host: HOST, provider: PROVIDER, rawModel: model, resolvedModel: "synthetic-d0089-resolved",
      modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["high", "xhigh"],
      aliasUsed: true, policyRevision: "synthetic-d0089-r1", provenance,
    } : null;
    const base = { host: HOST, provider: PROVIDER, policyRevision: "synthetic-d0089-r1", modelClassForModel: classify };
    const adapter: HostExecutionAdapter = mode === "resolve" ? { ...base, resolveModel: resolve } : {
      ...base, judgeModel(model, provenance = PROVENANCE) {
        const capability = resolve(model, provenance);
        return capability ? { status: "resolved", ...capability } : {
          status: "undetermined", reason: "MODEL_NOT_IN_CATALOG", host: HOST, rawModel: model,
          provider: null, modelClass: null, policyRevision: "synthetic-d0089-r1", provenance,
        };
      },
    };
    expect(resolveAdapterModelCapability(adapter, "unobserved-opaque-model")).toBeNull();
    const f = fixture(adapter);
    // 관측의 유효한 소비와 같은 호스트 호출의 단회 사용을 보존한다.
    const accepted = f.run(OPAQUE);
    expect(accepted).toMatchObject({ ok: true, data: { bootstrapExecution: { context: {
      model: OPAQUE, modelClass: "deep", reasoningEffort: "high", actorId: hostActorId(HOST, SESSION), source: "runtime",
    } } } });
    expect(resolveAdapterModelCapability(adapter, OPAQUE, PROVENANCE)).toMatchObject({ provider: PROVIDER, resolvedModel: "synthetic-d0089-resolved", supportedEfforts: ["high", "xhigh"] });
    expect(f.run(OPAQUE)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    expect(f.run(OPAQUE, "d0089-fresh-call")).toMatchObject({ ok: true });
    expect(classify).not.toHaveBeenCalled();
  });
});
