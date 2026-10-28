import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSyntheticRootProofFixture } from "./synthetic-root-proof-client.js";
import type { ApiResultV1, ExecutionContextV1 } from "../../contracts/types.js";
import { HOST_ATTESTATION_FIELD, HostAttestationProvider, hostActorId, issueHostAttestation, type HostExecutionAdapter } from "../../mcp-server/src/host-attestation.js";
import { InMemoryPluginUpdateStore } from "../../mcp-server/src/plugin-update-store.js";
import { PluginUpdateService } from "../../mcp-server/src/plugin-update-service.js";
import { FileSkillRegistry } from "../../mcp-server/src/registry.js";
import { ContractValidator } from "../../mcp-server/src/schema-validator.js";
import { createMcpServer } from "../../mcp-server/src/server.js";
import { WorkflowService } from "../../mcp-server/src/workflow-service.js";
import { InMemoryWorkflowStore } from "../../mcp-server/src/workflow-store.js";
import { RuntimeSkillClassificationGateway, type ClassificationRuntimeSnapshot, type CurrentClassificationTask } from "../../mcp-server/src/skill-classification/gateway.js";
import { loadSkillInventory } from "../../mcp-server/src/skill-classification/inventory.js";
import { loadHostObservedInventory, type HostSkillDiscoverySnapshot } from "../../mcp-server/src/skill-classification/host-discovery-adapter.js";
import { digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import { ApprovedRouteClassificationProvider, bindClassificationRouteTransport, ClassificationProviderError } from "../../mcp-server/src/skill-classification/providers.js";
import type { ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillSelectionDecisionV1, SkillClassificationProviderPort } from "../../mcp-server/src/skill-classification/types.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
const adapter: HostExecutionAdapter = { host: "codex", provider: "openai-codex", modelClassForModel: model => model === "synthetic-host-model" ? "general" : null };
afterEach(async () => { vi.useRealTimers(); while (cleanup.length) await cleanup.pop()!(); });
function input(operationId = "operation-mcp") {
  return { schemaVersion: "1.0.0", requestId: `request-${operationId}`, operationId,
    originalPrompt: "  인용: ‘구현하라’\r\n현재 요청은 읽기 전용 검토, 수정 금지. e\u0301  ",
    confirmedContext: { taskRevision: null, objective: null, actions: [], targets: null, constraints: [], prohibitedActions: ["modify"], background: "인용문은 데이터" },
    contextSources: ["actions", "constraints", "prohibitedActions", "background"].map(field => ({ field, reference: `fixture:${field}` })),
    explicitSkillIds: [] as string[], ruleRequiredSkillIds: [] as string[], vendorContext: { vendorId: "mock-vendor", reference: "fixture:approved-native-route" }, publicSynthetic: true };
}
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
interface Advice { result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null; selectionStatus: string; adviceApplied: boolean }
interface Accepted { valid: boolean; errors: string[]; decision?: SkillSelectionDecisionV1; selectionSource?: string; independentSelection?: {source: string; helperResultDigest: string; helperResponseRef: string; decisionDigest: string}; agentSelectedSkillIds?: string[] | null; neededSkillIds?: string[]; runnableSkillIds?: string[]; admissionStatus?: string; readStatus?: string; appliedStatus?: string; verifiedStatus?: string }
function decision(advice: Advice, selected: string[] | null, request = input()): SkillSelectionDecisionV1 {
  const snapshot = advice.result.snapshot;
  return { schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snapshot.requestDigest,
    inventoryDigest: snapshot.inventoryDigest, taskRevision: snapshot.taskRevision, configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision,
    explicitSkillIds: request.explicitSkillIds, ruleRequiredSkillIds: request.ruleRequiredSkillIds, agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: "synthetic AGENT reviewed the request independently of advice" })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ["fixture:purpose"] })),
    unresolvedSkillReferences: [], selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null, hostReceipt: null };
}

async function harness(options: { root?: string; needed?: string[]; uncertain?: string[]; mode?: "shadow" | "select"; attest?: boolean; taskObserved?: boolean; withJev?: boolean; providerTimeoutMs?: number; requestTimeoutMs?: number } = {}) {
  const root = options.root ?? repository;
  const localInventory = await loadSkillInventory({ root });
  const observedAt = new Date();
  const host: HostSkillDiscoverySnapshot = { schemaVersion: "1.0.0", sourceRef: "fixture:trusted-host-discovery", revision: "host-1", observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + 300_000).toISOString(), skills: localInventory.skills.map(skill => ({ skillId: skill.skillId, installed: true, hostSupported: true, enabled: true, root: null })) };
  const observeHostSkills = vi.fn(async () => host);
  const { inventory } = await loadHostObservedInventory({ root, observeHostSkills });
  expect(inventory.issues).toEqual([]);
  const profile: ProviderProfile = { profileId: "vendor-mock", providerKind: "vendor", vendorId: "mock-vendor", modelId: "mock-fixed", modelRevision: "mock-fixed-v1", reasoningEffort: "low",
    supportedOptions: { reasoningEfforts: ["low"], structuredOutput: true }, approvedRouteRef: "fixture:approved-native-route", qualificationRevision: "mock-quality-only",
    qualification: { status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "mock-fixed-v1", promptRevision: "prompt-1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: `sha256:${"0".repeat(64)}` },
    adapterRevision: "adapter-1", promptRevision: "prompt-1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null };
  const runtime: ClassificationRuntimeSnapshot = { config: { jevEnabled: false, mode: options.mode ?? "select", providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: false,
    configRevision: "config-1", timeoutMs: options.providerTimeoutMs ?? 2000 }, registry: { schemaVersion: "1.0.0", profileRevision: "profile-1", profiles: [profile] }, allowRemotePrivateContent: false };
  if (options.withJev) {
    runtime.config.jevEnabled = true;
    runtime.registry.profiles.unshift({ ...structuredClone(profile), profileId: "jev-mock", providerKind: "jev", vendorId: "typesafe",
      reasoningEffort: null, supportedOptions: { reasoningEfforts: [null], structuredOutput: true }, judgmentPolicy: { neededAt: 0.8, notNeededAt: 0.2 } });
  }
  for (const configuredProfile of runtime.registry.profiles) configuredProfile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(configuredProfile);
  const classify = vi.fn(async (request: SkillClassificationRequestV1, _profile?: ProviderProfile, _signal?: AbortSignal, beforeDispatch?: () => void): Promise<ProviderEvaluation> => { beforeDispatch?.(); return { response: { schemaVersion: "1.0.0", requestId: request.requestId,
    operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: options.uncertain?.length ? "PARTIAL" : "SUCCESS",
    judgments: request.skills.map(skill => ({ skillId: skill.skillId, judgment: options.uncertain?.includes(skill.skillId) ? "uncertain" : (options.needed ?? ["code-review"]).includes(skill.skillId) ? "needed" : "not-needed",
      reasonRefs: ["fixture:mock-source-role"], uncertaintyReason: options.uncertain?.includes(skill.skillId) ? "optional synthetic uncertainty" : null })),
    unresolvedItems: (options.uncertain ?? []).map(skillId => ({ skillId, reasonCode: "OPTIONAL_UNCERTAIN" })), error: null },
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0 }, dispatchState: "started", diagnostics: null }; });
  const availability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevAvailability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevClassify = vi.fn(classify);
  const budget = new InMemoryClassificationBudget({ jev: { limitUsd: 0, spentUsd: 0 }, vendors: { "mock-vendor": {limitUsd: 5, spentUsd: 0} }, nativeAllowances: { "vendor-mock": { approvalRef: "fixture:native-quota", remainingCalls: 100 }, "jev-mock": { approvalRef: "fixture:mock-jev-quota", remainingCalls: 100 } } });
  const vendorProvider: SkillClassificationProviderPort = {availability, classify}, jevProvider: SkillClassificationProviderPort = {availability: jevAvailability, classify: jevClassify};
  const service = new SkillClassificationService({ providers: {vendor: vendorProvider, ...(options.withJev ? {jev: jevProvider} : {})},
    budget });
  // This synthetic host-owned map models the changing task source; caller JSON never supplies it.
  const taskStates = new Map<string, CurrentClassificationTask>();
  const runtimeBytes = { additionalSource: "fixture:route-source-v1" };
  const readRuntime = vi.fn(async () => runtime);
  const observeTask = vi.fn((request: SkillClassificationRequestV1, observation: ExecutionContextV1 | null) => {
      if (options.taskObserved === false || !observation) return null;
      if (!taskStates.has(request.requestId)) taskStates.set(request.requestId, { taskRevision: request.confirmedContext.taskRevision,
        requestDigest: request.requestDigest, cancelled: false, sourceRef: "fixture:host-owned-task-source" });
      return taskStates.get(request.requestId)!;
    });
  const gateway = new RuntimeSkillClassificationGateway({ root, service, readRuntime,
    observeRuntime: () => digestClassificationValue({ runtime, additionalSource: runtimeBytes.additionalSource }), observeTask, observeHostSkills });
  const validator = new ContractValidator(), store = new InMemoryWorkflowStore();
  const rootProof = createSyntheticRootProofFixture();
  const attestation = options.attest === false ? null : new HostAttestationProvider(store, adapter);
  const workflow = new WorkflowService(new FileSkillRegistry(path.join(repository, "skills/registry.json"), validator), validator, store, null, attestation);
  const updateFetcher = vi.fn(async () => { throw new Error("NETWORK_FORBIDDEN_IN_MOCK_TEST"); });
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: updateFetcher });
  const server = createMcpServer(workflow, updates, undefined, undefined, undefined, validator, "default", attestation, null, undefined, null, gateway, rootProof.proofs);
  const client = new Client({ name: "classification-offline-boundary", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  cleanup.push(async () => { await client.close(); await server.close(); expect(updateFetcher).not.toHaveBeenCalled(); });
  let sequence = 0;
  const sign = (args: Record<string, unknown>, now?: Date, tool = "record_skill_selection", sessionId = "synthetic-session") => {
    const token = issueHostAttestation(store, adapter, { tool, input: args, model: "synthetic-host-model", reasoningEffort: "high",
      actorId: hostActorId("codex", sessionId), sessionId, turnId: "synthetic-turn", toolUseId: `fixture-call-${++sequence}`, ...(now ? { now } : {}) });
    expect(token).not.toBeNull(); return { ...args, [HOST_ATTESTATION_FIELD]: token };
  };
  const call = async <T>(name: string, args: Record<string, unknown>, expectClassificationFailure = false, sessionId = "synthetic-session"): Promise<ApiResultV1<T>> => {
    const observedInput = name === "classify_skills" && options.attest !== false ? sign(args, undefined, name, sessionId) : args;
    const response = await client.callTool({ name, arguments: rootProof.argumentsFor(name, observedInput, { host: adapter.host, sessionId }) }, undefined,
      options.requestTimeoutMs === undefined ? undefined : { timeout: options.requestTimeoutMs });
    const text = response.content as { type: string; text?: string }[];
    const result = JSON.parse(text.find(x => x.type === "text")!.text!) as ApiResultV1<T>;
    if (!expectClassificationFailure && name === "classify_skills" && result.error === null && result.data && typeof result.data === "object" && "result" in result.data) {
      const advice = result.data as unknown as Advice;
      expect(advice.result.response.error).toBeNull();
      expect(["SUCCESS", "PARTIAL"]).toContain(advice.result.response.status);
    }
    return result;
  };
  return { call, sign, classify, client, gateway, runtime, inventory, taskStates, availability, jevAvailability, jevClassify, readRuntime, runtimeBytes, observeTask, service, budget, host, vendorProvider, jevProvider };
}

const independentSource = "independent-agent-after-helper-failure";
const recordInput = (advice: Advice, selected: string[] | null = ["code-review"], request = input()) => ({
  schemaVersion: "1.0.0", operationId: request.operationId, selectionSource: independentSource,
  decision: {...decision(advice, selected, request), adviceApplied: false},
});
function failHelper(h: Awaited<ReturnType<typeof harness>>, code = "TRANSPORT_UNAVAILABLE", fenced = true) {
  h.classify.mockImplementation(async (_request, _profile, _signal, fence) => {
    if (fenced) fence?.();
    throw new ClassificationProviderError(code, "unknown", code === "INVALID_PROVIDER_RESPONSE");
  });
}
async function failed(h: Awaited<ReturnType<typeof harness>>, request = input()): Promise<Advice> {
  return (await h.call<Advice>("classify_skills", request, true)).data!;
}
const observed = (taskId: string): ExecutionContextV1 => ({schemaVersion: "1.0.0", model: "opaque-model", modelClass: "general", reasoningEffort: "high", source: "runtime",
  observedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300000).toISOString(), observationId: "fixture-direct-observation", taskId,
  actorId: hostActorId("codex", "synthetic-session")});

describe("Agent continuation after a server-owned helper failure", () => {
  it.each([500, 502, 503, 504, 401, 403, 400, 404, 408, 422, 501, 505, 599, 429, 529])("HTTP helper failure %i retains its exact continuation boundary through MCP", async status => {
    const h = await harness();
    h.runtime.config.externalClassificationAllowed = true;
    h.runtime.allowRemotePrivateContent = true; // Trusted fixture config; no operational content is present.
    const profile = h.runtime.registry.profiles[0]!;
    const decode = vi.fn((): ProviderEvaluation => { throw new Error("error responses must not decode"); });
    const route = bindClassificationRouteTransport({routeRef: profile.approvedRouteRef, approvalRef: "fixture:transport-approval", approved: true,
      kind: "remote", providerKind: profile.providerKind, vendorId: profile.vendorId, adapterRevision: profile.adapterRevision,
      modelIds: [profile.modelId], reasoningEfforts: [profile.reasoningEffort], structuredOutput: true,
      endpoint: "https://controlled.example.invalid/classify", getCredential: async () => "synthetic-placeholder",
      adapter: {encode: () => ({}), decode}});
    const fetcher = vi.fn<typeof fetch>(async () => new Response("untrusted error body SERVER_UNAVAILABLE", {status}));
    const remote = new ApprovedRouteClassificationProvider([route], fetcher);
    h.vendorProvider.availability = remote.availability.bind(remote);
    h.vendorProvider.routeKind = remote.routeKind.bind(remote);
    h.vendorProvider.captureConfigurationFence = remote.captureConfigurationFence.bind(remote);
    h.classify.mockImplementation(remote.classify.bind(remote) as Parameters<typeof h.classify.mockImplementation>[0]);
    const advice = await failed(h);
    const serverFailure = [500, 502, 503, 504].includes(status), rateLimited = status === 429 || status === 529;
    const before = structuredClone(advice.result), budget = h.budget.snapshot();
    const accepted = (await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data!;
    expect(accepted.valid).toBe(serverFailure || rateLimited);
    expect(advice.result.response.error?.code).toBe(serverFailure ? "SERVER_UNAVAILABLE" : rateLimited ? "RATE_LIMITED" : status === 401 || status === 403 ? "AUTH_UNAVAILABLE" : "API_UNAVAILABLE");
    if (!serverFailure && !rateLimited) expect(accepted.errors).toContain("HELPER_FAILURE_NOT_ELIGIBLE");
    expect(advice.result).toEqual(before); expect(h.budget.snapshot()).toEqual(budget);
    expect(fetcher).toHaveBeenCalledTimes(1); expect(decode).not.toHaveBeenCalled();
  });
  it.each(["returned-error", "missing-fence"])("HTTP helper failure never trusts SERVER_UNAVAILABLE from %s", async mode => {
    const h = await harness(), evaluate = h.classify.getMockImplementation()!;
    if (mode === "missing-fence") failHelper(h, "SERVER_UNAVAILABLE", false);
    else h.classify.mockImplementation(async (...args) => {
      const evaluation = await evaluate(...args);
      return {...evaluation, response: {...evaluation.response, status: "UNAVAILABLE", judgments: [],
        unresolvedItems: [{skillId: null, reasonCode: "SERVER_UNAVAILABLE"}],
        error: {code: "SERVER_UNAVAILABLE", retryable: false, dispatchState: "started"}}};
    });
    const advice = await failed(h);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(false);
    expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("AO01 retains old v1 failure-to-SELECTED rejection through the actual consumer", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), args = recordInput(advice), legacy = {schemaVersion: args.schemaVersion, operationId: args.operationId, decision: args.decision};
    const accepted = await h.call<Accepted>("record_skill_selection", h.sign(legacy));
    expect(accepted.data?.valid).toBe(false);
    expect(accepted.data?.errors).toContain("CLASSIFICATION_UNAVAILABLE_CANNOT_COMPLETE_SELECTION");
  });
  it("AO05/AO02/AO17 consumes explicit Agent selection without an extra policy gate and preserves failed helper accounting", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), before = structuredClone(advice.result), budget = h.budget.snapshot();
    const reply = await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)));
    expect(reply.error).toBeNull(); const accepted = reply.data!;
    expect(accepted?.valid).toBe(true);
    expect(accepted.decision?.agentSelectedSkillIds).toEqual(["code-review"]);
    expect(accepted.selectionSource).toBe(independentSource);
    expect(accepted.independentSelection).toMatchObject({source: independentSource, helperResponseRef: advice.classificationResponseRef,
      helperResultDigest: digestClassificationValue(before), decisionDigest: digestClassificationValue(recordInput(advice).decision)});
    expect(accepted).toMatchObject({admissionStatus: "NOT_EVALUATED", readStatus: "NOT_OBSERVED", appliedStatus: "NOT_OBSERVED", verifiedStatus: "NOT_RUN"});
    expect(advice.result).toEqual(before); expect(advice.result.response.error?.code).toBe("TRANSPORT_UNAVAILABLE");
    expect(h.budget.snapshot()).toEqual(budget); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it.each(["allowFailure", "helperFailure", "provenance", "eligible"])("AO03 rejects caller-owned %s authority", async field => {
    const h = await harness(); failHelper(h); const advice = await failed(h);
    expect((await h.call<Accepted>("record_skill_selection", h.sign({...recordInput(advice), [field]: true}))).error?.code).toBe("INVALID_INPUT");
  });
  it("AO04 binds failure evidence to the exact service and unchanged terminal result", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h);
    const original = await h.service.classify({request: advice.result.request, config: h.runtime.config, registry: h.runtime.registry,
      currentVendorId: "mock-vendor", remoteContentAllowed: false});
    expect(h.service.helperFailure(original)).not.toBeNull();
    // MCP results are deserialized copies and cannot retrieve the service's private evidence.
    expect(h.service.helperFailure(structuredClone(advice.result))).toBeNull();
    const other = new SkillClassificationService({providers: {}, budget: h.budget});
    expect(other.helperFailure(original)).toBeNull();
    original.response.error!.code = "tampered"; expect(h.service.helperFailure(original)).toBeNull();
  });
  it("AO06 continues after post-fence invalid output while retaining an independently reported charge", async () => {
    const h = await harness(); const evaluate = h.classify.getMockImplementation()!;
    const profile = h.runtime.registry.profiles[0]!; profile.maximumCostUsd = 1;
    profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
    h.classify.mockImplementation(async (...args) => { const response = await evaluate(...args); response.usage.actualCostUsd = 0.25; response.response.requestDigest = `sha256:${"f".repeat(64)}`; return response; });
    const advice = await failed(h); expect(advice.result.response.error?.code).toBe("INVALID_PROVIDER_RESPONSE");
    expect(advice.result.attempts[0]?.usage.actualCostUsd).toBe(0.25);
    const before = structuredClone(advice.result), budget = h.budget.snapshot();
    expect(budget.limits["vendor:mock-vendor"]?.spentUsd).toBe(0.25);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(true);
    expect(h.budget.snapshot()).toEqual(budget); expect(advice.result).toEqual(before); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it.each(["missing-fence", "unknown-error", "permission", "availability", "budget", "helper-success"])("AO16 never rescues %s failures from the same public code", async mode => {
    const h = await harness();
    if (mode === "budget") vi.spyOn(h.budget, "reserve").mockReturnValue(false);
    else if (mode === "availability") h.availability.mockResolvedValue({available: false, approved: false, routeKind: "native", reasonCode: null});
    else if (mode === "unknown-error") h.classify.mockImplementation(async (_r, _p, _s, fence) => { fence?.(); throw new Error("TRANSPORT_UNAVAILABLE"); });
    else if (mode !== "helper-success") failHelper(h, mode === "permission" ? "AUTH_UNAVAILABLE" : "TRANSPORT_UNAVAILABLE", mode !== "missing-fence");
    const advice = await failed(h);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(false);
  });
  it.each(["API_UNAVAILABLE", "NATIVE_SPAWN_UNAVAILABLE", "NATIVE_PROCESS_UNAVAILABLE"])("AO16 rejects coarse %s causes even after a genuine fence", async code => {
    const h = await harness(); failHelper(h, code); const advice = await failed(h);
    expect(advice.result.response.error?.code).toBe(code);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(false);
  });
  it.each(["required", "reason", "applicability", "unknown", "duplicate", "unresolved", "response-ref", "advice"])("AO08 keeps %s selection guards", async mode => {
    const h = await harness(); failHelper(h); const request = {...input(), explicitSkillIds: ["code-review"]}, advice = await failed(h, request), args = recordInput(advice, ["code-review"], request);
    if (mode === "required") args.decision.agentSelectedSkillIds = [];
    if (mode === "reason") args.decision.selectionReasons = [];
    if (mode === "applicability") args.decision.applicabilityChecks = [];
    if (mode === "unknown") args.decision.agentSelectedSkillIds = ["not-an-inventory-id"];
    if (mode === "duplicate") args.decision.agentSelectedSkillIds = ["code-review", "code-review"];
    if (mode === "unresolved") args.decision.unresolvedSkillReferences = [{reference: "unknown", reason: "unresolved"}];
    if (mode === "response-ref") args.decision.classificationResponseRef = `sha256:${"f".repeat(64)}`;
    if (mode === "advice") args.decision.adviceApplied = true;
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args))).data?.valid).toBe(false);
  });
  it("AO09 requires current actor, task, exact-call attestation and no caller receipt", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), args = recordInput(advice);
    expect((await h.call<Accepted>("record_skill_selection", args)).data?.valid).toBe(false);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args, undefined, "record_skill_selection", "different-session"))).data?.valid).toBe(false);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args, new Date("2000-01-01T00:00:00Z")))).error?.code).toBe("INVALID_INPUT");
    args.decision.hostReceipt = {receiptId: "caller", host: "opaque", requestDigest: args.decision.requestDigest, inventoryDigest: args.decision.inventoryDigest, agentSelectedSkillIds: ["code-review"], acceptedAt: new Date().toISOString()};
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args))).error?.code).toBe("INVALID_INPUT");
  });
  it.each(["config", "profile", "runtime", "qualification", "cancel", "task-source"])("AO10/AO11 rejects %s changes during held current-runtime reads", async mode => {
    const h = await harness(); failHelper(h); const advice = await failed(h), entered = barrier(), release = barrier();
    h.readRuntime.mockImplementationOnce(async () => { entered.open(); await release.promise; return h.runtime; });
    const accepting = h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)));
    await entered.promise;
    if (mode === "config") h.runtime.config.configRevision += ":changed";
    if (mode === "profile") h.runtime.registry.profileRevision += ":changed";
    if (mode === "runtime") h.runtimeBytes.additionalSource += ":changed";
    if (mode === "qualification") h.runtime.registry.profiles[0]!.qualification.validUntil = "2000-01-01T00:00:00Z";
    const task = h.taskStates.get(advice.result.request.requestId)!;
    if (mode === "cancel") task.cancelled = true;
    if (mode === "task-source") task.sourceRef += ":changed";
    release.open(); expect((await accepting).data?.valid).toBe(false);
  });
  it("AO12 commits one source-bound slot under concurrent decisions and replays the same body idempotently", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), a = recordInput(advice), b = recordInput(advice, []);
    const replies = await Promise.all([h.call<Accepted>("record_skill_selection", h.sign(a)), h.call<Accepted>("record_skill_selection", h.sign(b))]);
    expect(replies.filter(r => r.data?.valid)).toHaveLength(1);
    const winner = replies[0]?.data?.valid ? a : b, accepted = replies.find(r => r.data?.valid)!.data!;
    const replay = (await h.call<Accepted>("record_skill_selection", h.sign(winner))).data!;
    expect(replay.decision).toEqual(accepted.decision); expect(replay.independentSelection).toEqual(accepted.independentSelection);
    const legacy = {schemaVersion: winner.schemaVersion, operationId: winner.operationId, decision: winner.decision}; legacy.decision.selectionStatus = "PARTIAL";
    expect((await h.call<Accepted>("record_skill_selection", h.sign(legacy))).error?.code).toBe("INVALID_INPUT");
  });
  it("AO14 rejects unknown versions and dropped source instead of relabeling the failed v1 result", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), args = recordInput(advice);
    expect((await h.call<Accepted>("record_skill_selection", h.sign({...args, schemaVersion: "2.0.0"}))).error?.code).toBe("INVALID_INPUT");
    expect((await h.call<Accepted>("record_skill_selection", h.sign({...args, selectionSource: "caller-error-string"}))).error?.code).toBe("INVALID_INPUT");
  });
  it("AO15 distinguishes observed empty selection from unobserved null", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h);
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice, null)))).error?.code).toBe("INVALID_INPUT");
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice, [])))).data?.decision?.agentSelectedSkillIds).toEqual([]);
  });
  it("AO10 rechecks profile expiry at the commit fence without a revision or host expiry change", async () => {
    vi.useFakeTimers({toFake: ["Date"]}); const start = Date.now(), h = await harness();
    h.runtime.registry.profiles[0]!.qualification.validUntil = new Date(start + 1000).toISOString();
    failHelper(h); const advice = await failed(h), entered = barrier(), release = barrier();
    h.readRuntime.mockImplementationOnce(async () => { entered.open(); await release.promise; return h.runtime; });
    const accepting = h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice))); await entered.promise;
    vi.setSystemTime(start + 2000); release.open();
    const result = await accepting; expect(result.data?.valid).toBe(false); expect(result.data?.errors).toContain("QUALIFICATION_EXPIRED");
  });
  it("AO10 rechecks source bytes after the last awaited inventory read", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "agent-continuation-source-"));
    cleanup.push(() => rm(root, {recursive: true, force: true}));
    await cp(path.join(repository, "skills"), path.join(root, "skills"), {recursive: true});
    const h = await harness({root}); failHelper(h); const advice = await failed(h), original = h.observeTask.getMockImplementation()!, file = path.join(root, "skills/code-review/SKILL.md"), bytes = await readFile(file);
    let reads = 0;
    h.observeTask.mockImplementation((...args) => { const task = original(...args); if (++reads === 2) writeFileSync(file, Buffer.concat([bytes, Buffer.from("\nfixture source changed\n")])); return task; });
    const accepted = await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)));
    expect(accepted.data?.valid).toBe(false); expect(accepted.data?.errors).toContain("CLASSIFICATION_SOURCE_CHANGED");
  });
  it.each(["late-success", "late-failure"])("AO07/AO13 preserves timeout failure, reservations and selection after %s", async late => {
    const h = await harness({providerTimeoutMs: 25}), request = input("late"), entered = barrier(), drained = barrier();
    let resolve!: (value: ProviderEvaluation) => void, reject!: (cause: Error) => void;
    const pending = new Promise<ProviderEvaluation>((ok, fail) => {resolve = ok; reject = fail;});
    h.classify.mockImplementation(async (_r, _p, _s, fence) => {fence?.(); entered.open(); try {return await pending;} finally {drained.open();}});
    vi.useFakeTimers({toFake: ["setTimeout", "clearTimeout"]});
    const inflight = h.gateway.classify(request, observed(request.requestId)); await entered.promise;
    await vi.advanceTimersByTimeAsync(25); const advice = await inflight as Advice;
    expect(advice.result.response.error?.code).toBe("PROVIDER_TIMEOUT");
    const original = digestClassificationValue(advice.result), budget = h.budget.snapshot();
    const accepted = await h.gateway.accept(recordInput(advice, [], request), observed(advice.result.request.requestDigest)) as Accepted;
    expect(accepted.valid).toBe(true);
    if (late === "late-failure") reject(new ClassificationProviderError("TRANSPORT_UNAVAILABLE", "unknown"));
    else resolve({response: {...advice.result.response, status: "SUCCESS", error: null}, usage: {inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, actualCostUsd: 0}, dispatchState: "started", diagnostics: null});
    await drained.promise; await Promise.resolve();
    expect(digestClassificationValue(advice.result)).toBe(original); expect(h.budget.snapshot()).toEqual(budget);
    expect(h.classify).toHaveBeenCalledTimes(1);
    const replay = await h.gateway.classify(request, observed(request.requestId)) as Advice & {independentSelection: unknown};
    expect(replay.independentSelection).toEqual(accepted.independentSelection);
  });
  it("AO11 rejects cancel at the final task fence without creating a selection slot", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), original = h.observeTask.getMockImplementation()!; let reads = 0;
    h.observeTask.mockImplementation((...args) => {const task = original(...args); if (++reads === 2 && task) task.cancelled = true; return task;});
    const result = await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)));
    expect(result.data?.valid).toBe(false);
  });
  it("AO12 rejects pending acceptance and preserves one original intake", async () => {
    const h = await harness(); failHelper(h); const advice = await failed(h), request = input("still-pending"), entered = barrier(), release = barrier();
    h.availability.mockImplementationOnce(async () => {entered.open(); await release.promise; return {available: true, approved: true, routeKind: "native", reasonCode: null};});
    const work = h.gateway.classify(request, observed(request.requestId)); await entered.promise;
    await expect(h.gateway.accept(recordInput(advice, [], request), observed(advice.result.request.requestDigest))).rejects.toThrow("UNKNOWN_CLASSIFICATION_OPERATION");
    release.open(); await work;
  });

  it("AO05 preserves a genuine JEV failure when no vendor fallback profile is configured", async () => {
    const h = await harness({withJev: true}); h.runtime.registry.profiles = h.runtime.registry.profiles.filter(p => p.providerKind === "jev");
    failHelper(h); const advice = await failed(h);
    expect(advice.result.attempts).toHaveLength(1); expect(advice.result.attempts[0]?.providerKind).toBe("jev");
    expect(advice.result.response.error?.code).toBe("PROFILE_UNAVAILABLE");
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(true);
  });

  it.each(["validator", "classify", "availability", "route-kind", "capture-hook", "captured-route"])("D271 retains the D270 %s identity on a failed helper after the last await", async changed => {
    const h = await harness(); let routeCurrent = true;
    h.vendorProvider.validateConfiguration = () => null;
    h.vendorProvider.routeKind = () => "native";
    h.vendorProvider.captureConfigurationFence = () => () => routeCurrent;
    failHelper(h); const advice = await failed(h), before = structuredClone(advice.result), budget = h.budget.snapshot();
    const entered = barrier(), release = barrier();
    h.readRuntime.mockImplementationOnce(async () => {entered.open(); await release.promise; return h.runtime;});
    const accepting = h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice))); await entered.promise;
    if (changed === "validator") h.vendorProvider.validateConfiguration = () => null;
    if (changed === "classify") {const classify = h.vendorProvider.classify; h.vendorProvider.classify = (...args) => classify(...args);}
    if (changed === "availability") {const available = h.vendorProvider.availability; h.vendorProvider.availability = (...args) => available(...args);}
    if (changed === "route-kind") h.vendorProvider.routeKind = () => "native";
    if (changed === "capture-hook") h.vendorProvider.captureConfigurationFence = () => () => true;
    if (changed === "captured-route") routeCurrent = false;
    expect(h.service.validateProfile(h.runtime.registry.profiles[0]!, advice.result.request)).toBeNull();
    release.open(); const result = await accepting;
    expect(result.data?.valid).toBe(false); expect(advice.result).toEqual(before); expect(h.budget.snapshot()).toEqual(budget); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("D271 carries the original JEV binding through absent fallback without accepting replacement identity", async () => {
    const h = await harness({withJev: true}); h.runtime.registry.profiles = h.runtime.registry.profiles.filter(p => p.providerKind === "jev");
    h.jevProvider.validateConfiguration = () => null;
    failHelper(h); const advice = await failed(h); expect(advice.result.response.error?.code).toBe("PROFILE_UNAVAILABLE");
    h.jevProvider.validateConfiguration = () => null;
    expect(h.service.validateProfile(h.runtime.registry.profiles[0]!, advice.result.request)).toBeNull();
    expect((await h.call<Accepted>("record_skill_selection", h.sign(recordInput(advice)))).data?.valid).toBe(false);
    expect(h.classify).toHaveBeenCalledTimes(1);
  });

});
