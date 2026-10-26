import { createHash, createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReasoningEffortV1, TaskEnvelopeV1 } from "../../contracts/types.js";
import { convergenceDigest } from "../../mcp-server/src/convergence-logic.js";
import {
  HOST_ATTESTATION_FIELD, HostAttestationProvider, hostActorId, issueHostAttestation,
  resolveAdapterModelCapability, type HostExecutionAdapter, type ResolvedModelCapabilityV1,
} from "../../mcp-server/src/host-attestation.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";

// Proposal only: copy into the integrated candidate before QA. Actual issuer,
// verifier, workflow gates and in-memory claim store; fake trusted adapter input.
// This is not native/default registered producer new-name positive evidence.
const NOW = Date.parse("2026-10-27T00:00:00.000Z");
const HOST = "owned-observation-host", SESSION = "owned-session", MODEL = "opaque-approved-model";
const KEY = Buffer.alloc(32, 47);
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
  // Owned, deterministic real signing key. No operational DB/key/native state is read.
  store.getOrCreateSecret("host_attestation_key_v1", () => KEY.toString("base64url"));
  const provider = new HostAttestationProvider(store, adapter), validator = new ContractValidator();
  const service = new WorkflowService(new FileSkillRegistry(registryPath, validator), validator, store, null, provider);
  const args = { schemaVersion: "1.0.0", taskEnvelope: task() };
  const observation = { tool: "plan_workflow", input: args, model: MODEL, reasoningEffort: "high" as ReasoningEffortV1,
    actorId: hostActorId(HOST, SESSION), sessionId: SESSION, turnId: "owned-turn", toolUseId: "owned-call", now: new Date(NOW) };
  return { provider, args, observation,
    issue(model = MODEL) { return issueHostAttestation(store, adapter, { ...observation, model })!; },
    run(token: string) { return provider.run("plan_workflow", { ...args, [HOST_ATTESTATION_FIELD]: token }, clean => service.planWorkflow(clean, true)); },
  };
}
function decoded(token: string): Record<string, unknown> {
  expect(token).toMatch(/^aghs2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
  return JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
}
function v1Fixture(args: ReturnType<typeof fixture>["args"], capability: ResolvedModelCapabilityV1,
  patch: Record<string, unknown> = {}): string {
  // Frozen v1 wire contract from the before source; not the new issuer or a fake verifier.
  const identity = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
  const scope = { host: HOST, session: identity(SESSION), agent: null, turn: identity("owned-turn"), call: identity("owned-call") };
  const payload = { v: 1, ...scope, provider: capability.provider, tool: "plan_workflow", inputDigest: convergenceDigest(args),
    phase: "bootstrap", taskId: args.taskEnvelope.taskId, runId: null, stageId: null, revision: null,
    model: MODEL, resolvedModel: capability.resolvedModel, modelClass: capability.modelClass, reasoningEffort: "high",
    policyRevision: capability.policyRevision, provenance: capability.provenance, actorId: hostActorId(HOST, SESSION),
    observationId: createHash("sha256").update(JSON.stringify(scope)).digest("base64url"), observedAt: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 300_000).toISOString(), ...patch };
  const body = `aghs1.${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
  return `${body}.${createHmac("sha256", KEY).update(body).digest("base64url")}`;
}

describe("C observation token eligibility controls", () => {
  it("preserves the existing legacy effective revision and actual workflow positive (C-F1)", () => {
    const legacy: HostExecutionAdapter = { host: HOST, modelClassForModel: model => model === MODEL ? "deep" : null };
    expect(resolveAdapterModelCapability(legacy, MODEL)?.policyRevision).toBe("1.0.0");
    const f = fixture(legacy), token = f.issue();
    expect(decoded(token)).toMatchObject({ policyRevision: "1.0.0", eligibility: { modelClass: "deep", policyRevision: "1.0.0" } });
    expect(f.run(token)).toMatchObject({ ok: true });
  });
  it("signs unsupported legacy observations without inventing eligibility or a revision", () => {
    const f = fixture({ host: HOST, modelClassForModel: () => null }), token = f.issue("opaque-unsupported");
    expect(decoded(token)).toMatchObject({ model: "opaque-unsupported", policyRevision: null, eligibility: null });
    expect(f.run(token)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    expect(f.provider.lastObservedCapability()).toBeNull();
  });
  it("does not invent a revision for a modern descriptor that supplies none", () => {
    const { adapter, state } = modern(false);
    state.value = { ...state.value, policyRevision: "" };
    const f = fixture(adapter), token = f.issue();
    expect(decoded(token).policyRevision).toBeNull();
    expect(f.run(token)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
  });
  it("accepts an unchanged signed v1 fixture and rejects missing required class", () => {
    const { adapter, state } = modern(), valid = fixture(adapter);
    expect(valid.run(v1Fixture(valid.args, state.value))).toMatchObject({ ok: true });
    const missingClass = fixture(adapter);
    expect(missingClass.run(v1Fixture(missingClass.args, state.value, { modelClass: undefined })))
      .toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
  });
  it.each(["v1-first", "v2-first"])("shares the actual one-use workflow claim across versions: %s", order => {
    const { adapter, state } = modern(), f = fixture(adapter), v1 = v1Fixture(f.args, state.value), v2 = f.issue();
    const v1Payload = JSON.parse(Buffer.from(v1.split(".")[1]!, "base64url").toString("utf8")) as { observationId: string };
    expect(decoded(v2).observationId).toBe(v1Payload.observationId);
    const [first, second] = order === "v1-first" ? [v1, v2] : [v2, v1];
    expect(f.run(first!)).toMatchObject({ ok: true });
    const replay = f.run(second!);
    expect(replay).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    expect(replay.error?.message).toContain("already consumed");
  });
  it.each(["modelClass", "provider", "resolvedModel"] as const)("rejects same-revision signed snapshot drift: %s", field => {
    const { adapter, state } = modern(), f = fixture(adapter), token = f.issue();
    state.value = field === "modelClass" ? { ...state.value, modelClass: "frontier" }
      : { ...state.value, [field]: "different-policy-value" };
    const result = f.run(token);
    expect(result).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    expect(result.error?.message).toContain("matching trusted execution capability");
  });
  it.each(["support", "minimum"] as const)("keeps issuer-time %s denial after current policy is relaxed", mode => {
    const { adapter, state } = modern();
    state.value = { ...state.value, supportedEfforts: mode === "support" ? ["xhigh"] : ["high", "xhigh"],
      minimumReasoningEffort: mode === "minimum" ? "xhigh" : "high" };
    const f = fixture(adapter), token = f.issue();
    expect(decoded(token).eligibility).toBeNull();
    state.value = { ...state.value, supportedEfforts: ["high", "xhigh"], minimumReasoningEffort: "high" };
    expect(f.run(token)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
  });
  it.each(["support", "minimum"] as const)("enforces verifier-time %s after valid issuance", mode => {
    const { adapter, state } = modern(), f = fixture(adapter), token = f.issue();
    expect(decoded(token).eligibility).not.toBeNull();
    state.value = { ...state.value, supportedEfforts: mode === "support" ? ["xhigh"] : ["high", "xhigh"],
      minimumReasoningEffort: mode === "minimum" ? "xhigh" : "high" };
    expect(f.run(token)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
  });
  it.each([true, false])("preserves rotation for declared/descriptor-only revisions: declared=%s", declared => {
    const { adapter, state } = modern(declared), f = fixture(adapter), stale = f.issue();
    state.value = { ...state.value, policyRevision: "owned-r2" };
    expect(f.run(stale)).toMatchObject({ ok: false, error: { code: "BINDING_INVALID" } });
    const fresh = f.issue();
    expect(decoded(fresh).policyRevision).toBe("owned-r2");
    expect(f.run(fresh)).toMatchObject({ ok: true });
  });
});
