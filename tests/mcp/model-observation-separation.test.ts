import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskEnvelopeV1 } from "../../contracts/types.js";
import {
  HostAttestationProvider, resolveAdapterModelCapability, type HostExecutionAdapter, type ResolvedModelCapabilityV1,
} from "../../mcp-server/src/host-attestation.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { rootCaller } from "../helpers/caller.js";

// Actual provider, workflow gates and in-memory claim store; fake trusted adapter input and a host-observed caller.
// This is not native/default registered producer new-name positive evidence.
const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const HOST = "owned-observation-host", SESSION = "owned-session", MODEL = "opaque-approved-model";
const registryPath = fileURLToPath(new URL("../../skills/registry.json", import.meta.url));
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function task(): TaskEnvelopeV1 {
  return {
    schemaVersion: "1.0.0", taskId: "owned-observation-task", objective: "Verify observation eligibility and replay boundaries.",
    scope: { included: ["fixture"], excluded: ["deployment"] }, acceptanceCriteria: ["Preserve trusted eligibility and one-use claims."],
    riskLevel: "high", workUnits: [{ id: "unit-1", objective: "Check the boundary.", dependencies: [], writeTargets: ["fixture.md"] }],
    requiredCapabilities: ["task-decomposition"], constraints: ["Owned synthetic fixture only."],
    authorization: { allowedActions: ["test"], prohibitedActions: ["deploy"], approvalRequired: [] },
    decision: { complexity: "simple", hasConflicts: false }, orchestration: { requested: true, mcpAvailable: true },
  };
}
function modern(declaredRevision = true) {
  const state: { value: ResolvedModelCapabilityV1 } = { value: {
    host: HOST, provider: "owned-provider", rawModel: MODEL, resolvedModel: "approved-policy-model",
    modelClass: "deep", minimumReasoningEffort: "high", supportedEfforts: ["high", "xhigh"],
    aliasUsed: true, policyRevision: "owned-r1", provenance: "owned-observation",
  } };
  const adapter: HostExecutionAdapter = {
    host: HOST, modelClassForModel: model => model === MODEL ? state.value.modelClass : null,
    resolveModel: model => model === MODEL ? { ...state.value, rawModel: model } : null,
  };
  if (declaredRevision) Object.defineProperty(adapter, "policyRevision", { get: () => state.value.policyRevision, enumerable: true });
  return { adapter, state };
}
function fixture(adapter: HostExecutionAdapter) {
  const store = new InMemoryWorkflowStore();
  const provider = new HostAttestationProvider(adapter), validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const args = { schemaVersion: "1.0.0", taskEnvelope: task() };
  let sequence = 0;
  return { provider, args,
    /** One host call (a fresh call ID unless given) whose observed execution is `model` at high effort. */
    run(model = MODEL, callId = `owned-call-${++sequence}`) {
      const caller = rootCaller(HOST, SESSION, { callId, execution: { model, effort: "high", turnId: "owned-turn", provenance: "owned-observation" } });
      return provider.run("plan_workflow", caller, () => service.planWorkflow(args, true));
    },
  };
}

/** The modern adapter with its descriptor patched; the declared revision is fixed when given. */
function patched(adapter: HostExecutionAdapter, patch: Partial<ResolvedModelCapabilityV1>, declaredRevision?: string): HostExecutionAdapter {
  const resolveModel = adapter.resolveModel!;
  return { host: adapter.host, modelClassForModel: adapter.modelClassForModel, ...(declaredRevision === undefined ? {} : { policyRevision: declaredRevision }),
    resolveModel: (model: string) => { const resolved = resolveModel(model); return resolved && { ...resolved, ...patch }; } };
}

describe("C call-time execution eligibility controls", () => {
  it("D0089: a legacy class callback observes without eligibility; an explicit descriptor keeps the workflow positive (C-F1)", () => {
    // Before D0089 this adapter got all efforts and policy revision "1.0.0" synthesized from its class answer.
    const classify = vi.fn((model: string) => model === MODEL ? "deep" as const : null);
    const legacy: HostExecutionAdapter = { host: HOST, provider: "owned-provider", modelClassForModel: classify };
    expect(resolveAdapterModelCapability(legacy, MODEL)).toBeNull();
    const f = fixture(legacy);
    // 3.1.1: it runs unclassified; the class answer is never used.
    expect(f.run()).toMatchObject({ ok: true, data: { bootstrapExecution: { context: { modelClass: null, policyNotes: ["MISSING_MODEL_CAPABILITY"] } } } });
    expect(f.provider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
    // The same opaque model name passes once the adapter states a trusted descriptor: the name itself is never the reason.
    const described: HostExecutionAdapter = { ...legacy, policyRevision: "owned-r1",
      resolveModel: (rawModel, provenance = `${HOST}:runtime`) => rawModel === MODEL ? { host: HOST, provider: "owned-provider", rawModel,
        resolvedModel: rawModel, modelClass: "deep", minimumReasoningEffort: null, supportedEfforts: ["high"], aliasUsed: false,
        policyRevision: "owned-r1", provenance } : null };
    const g = fixture(described);
    expect(g.run()).toMatchObject({ ok: true });
    expect(resolveAdapterModelCapability(described, MODEL)).toMatchObject({ modelClass: "deep", supportedEfforts: ["high"], policyRevision: "owned-r1" });
  });
  it("observes unsupported legacy observations without inventing eligibility or a revision", () => {
    const f = fixture({ host: HOST, provider: "owned-provider", modelClassForModel: () => null });
    expect(f.run("opaque-unsupported")).toMatchObject({ ok: true, data: { bootstrapExecution: { context: { model: "opaque-unsupported", modelClass: null } } } });
    expect(f.provider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
  });
  it("does not invent a revision for a modern descriptor that supplies none", () => {
    const { adapter, state } = modern(false);
    state.value = { ...state.value, policyRevision: "" };
    const f = fixture(adapter);
    expect(f.run()).toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode: "QUALIFICATION_POLICY_REVISION_MISMATCH" } } });
    expect(f.provider.observe({ phase: "bootstrap", taskId: "after-call", runId: null, stageId: null, revision: null })).toBeNull();
  });
  it.each([
    { name: "a declared adapter revision that differs from the descriptor", patch: {}, declared: "owned-r0", reasonCode: "QUALIFICATION_POLICY_REVISION_MISMATCH" },
    { name: "a descriptor for another host", patch: { host: "other-host" }, declared: undefined, reasonCode: "QUALIFICATION_CAPABILITY_MISMATCH" },
    { name: "a descriptor for another raw model", patch: { rawModel: "other-model" }, declared: undefined, reasonCode: "QUALIFICATION_CAPABILITY_MISMATCH" },
  ])("rejects $name", ({ patch, declared, reasonCode }) => {
    const { adapter } = modern(false);
    expect(fixture(patched(adapter, patch, declared)).run()).toMatchObject({ ok: false, error: { code: "BINDING_INVALID", details: { reasonCode } } });
    expect(fixture(patched(adapter, {})).run()).toMatchObject({ ok: true });
  });
  it("consumes the observation of one host call only once", () => {
    const { adapter } = modern(), f = fixture(adapter);
    expect(f.run(MODEL, "owned-call")).toMatchObject({ ok: true });
    const replay = f.run(MODEL, "owned-call");
    expect(replay).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    expect(replay.error?.message).toContain("already consumed");
    expect(f.run(MODEL, "owned-next-call")).toMatchObject({ ok: true });
  });
  it.each(["support", "minimum"] as const)("records the call-time %s policy without refusing the call", mode => {
    const { adapter, state } = modern(), f = fixture(adapter);
    expect(f.run()).toMatchObject({ ok: true });
    state.value = { ...state.value, supportedEfforts: mode === "support" ? ["xhigh"] : ["high", "xhigh"],
      minimumReasoningEffort: mode === "minimum" ? "xhigh" : "high" };
    expect(f.run()).toMatchObject({ ok: true, data: { bootstrapExecution: { context: { reasoningEffort: "high",
      policyNotes: [mode === "support" ? "CURRENT_POLICY_EFFORT_UNSUPPORTED" : "CURRENT_POLICY_EFFORT_BELOW_MINIMUM"] } } } });
  });
  it.each([true, false])("qualifies under the rotated revision for declared/descriptor-only revisions: declared=%s", declared => {
    const { adapter, state } = modern(declared), f = fixture(adapter);
    expect(f.run()).toMatchObject({ ok: true });
    state.value = { ...state.value, policyRevision: "owned-r2" };
    expect(f.run()).toMatchObject({ ok: true });
    expect(resolveAdapterModelCapability(adapter, MODEL)?.policyRevision).toBe("owned-r2");
  });
});
