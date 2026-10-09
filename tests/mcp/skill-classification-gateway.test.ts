import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createClassificationRequest, digestClassificationValue } from "../../mcp-server/src/skill-classification/request.js";
import { digestProviderProfileConfiguration } from "../../mcp-server/src/skill-classification/profiles.js";
import { InMemoryClassificationBudget, SkillClassificationService } from "../../mcp-server/src/skill-classification/service.js";
import type { ClassificationResult, ProviderEvaluation, ProviderProfile, SkillClassificationRequestV1, SkillInventory, SkillSelectionDecisionV1 } from "../../mcp-server/src/skill-classification/types.js";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
const adapter: HostExecutionAdapter = { host: "codex", modelClassForModel: model => model === "synthetic-host-model" ? "general" : null };
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function input(operationId = "operation-mcp") {
  return { schemaVersion: "1.0.0", requestId: `request-${operationId}`, operationId,
    originalPrompt: "  인용: ‘구현하라’\r\n현재 요청은 읽기 전용 검토, 수정 금지. e\u0301  ",
    confirmedContext: { taskRevision: null, objective: null, actions: [], targets: null, constraints: [], prohibitedActions: ["modify"], background: "인용문은 데이터" },
    contextSources: ["actions", "constraints", "prohibitedActions", "background"].map(field => ({ field, reference: `fixture:${field}` })),
    explicitSkillIds: [] as string[], ruleRequiredSkillIds: [] as string[], vendorContext: { vendorId: "mock-vendor", reference: "fixture:approved-native-route" }, publicSynthetic: true };
}
function publicRequestDigest(request: Pick<SkillClassificationRequestV1, "requestId" | "operationId" | "originalPrompt" | "confirmedContext" | "contextSources">, inventory: SkillInventory): string {
  return createClassificationRequest({ requestId: request.requestId, operationId: request.operationId, originalPrompt: request.originalPrompt,
    confirmedContext: request.confirmedContext, contextSources: request.contextSources, inventory,
    classificationCriteriaRef: "skills/orchestrator/references/skill-classification.md" }).requestDigest;
}
function requalifyMockProfile(profile: ProviderProfile, qualificationRevision: string): void {
  profile.qualificationRevision = qualificationRevision;
  profile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(profile);
}
function barrier() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
interface Advice { result: ClassificationResult; classificationResponseRef: string; agentSelectedSkillIds: string[] | null; selectionStatus: string; adviceApplied: boolean }
interface Accepted { valid: boolean; errors: string[]; decision?: SkillSelectionDecisionV1; agentSelectedSkillIds?: string[] | null; neededSkillIds?: string[]; runnableSkillIds?: string[]; admissionStatus?: string; readStatus?: string; appliedStatus?: string; verifiedStatus?: string }
function decision(advice: Advice, selected: string[] | null, request = input()): SkillSelectionDecisionV1 {
  const snapshot = advice.result.snapshot;
  return { schemaVersion: "1.0.0", classificationResponseRef: advice.classificationResponseRef, requestDigest: snapshot.requestDigest,
    inventoryDigest: snapshot.inventoryDigest, taskRevision: snapshot.taskRevision, configRevision: snapshot.configRevision, profileRevision: snapshot.profileRevision,
    explicitSkillIds: request.explicitSkillIds, ruleRequiredSkillIds: request.ruleRequiredSkillIds, agentSelectedSkillIds: selected,
    selectionReasons: (selected ?? []).map(skillId => ({ skillId, reason: "synthetic AGENT reviewed the request independently of advice" })),
    applicabilityChecks: (selected ?? []).map(skillId => ({ skillId, applies: true, excluded: false, reasonRefs: ["fixture:purpose"] })),
    unresolvedSkillReferences: [], selectionStatus: selected === null ? "NEEDS_INPUT" : "SELECTED", adviceApplied: selected !== null, hostReceipt: null };
}

async function harness(options: { root?: string; needed?: string[]; uncertain?: string[]; mode?: "shadow" | "select"; attest?: boolean; taskObserved?: boolean; withJev?: boolean } = {}) {
  const root = options.root ?? repository;
  const localInventory = await loadSkillInventory({ root });
  const observedAt = new Date();
  const host: HostSkillDiscoverySnapshot = { schemaVersion: "1.0.0", sourceRef: "fixture:trusted-host-discovery", revision: "host-1", observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + 300_000).toISOString(), skills: localInventory.skills.map(skill => ({ skillId: skill.skillId, installed: true, hostSupported: true, enabled: true, root: null })) };
  const observeHostSkills = async () => host;
  const { inventory } = await loadHostObservedInventory({ root, observeHostSkills });
  expect(inventory.issues).toEqual([]);
  const profile: ProviderProfile = { profileId: "vendor-mock", providerKind: "vendor", vendorId: "mock-vendor", modelId: "mock-fixed", modelRevision: "mock-fixed-v1", reasoningEffort: "low",
    supportedOptions: { reasoningEfforts: ["low"], structuredOutput: true }, approvedRouteRef: "fixture:approved-native-route", qualificationRevision: "mock-quality-only",
    qualification: { status: "PASS", inventoryDigest: inventory.inventoryDigest, taxonomyRevision: inventory.taxonomyRevision, modelRevision: "mock-fixed-v1", promptRevision: "prompt-1", validUntil: "2099-01-01T00:00:00Z", profileConfigurationDigest: `sha256:${"0".repeat(64)}` },
    adapterRevision: "adapter-1", promptRevision: "prompt-1", maximumInputBytes: 2_000_000, maximumOutputTokens: 1000, maximumCostUsd: 0, judgmentPolicy: null };
  const runtime: ClassificationRuntimeSnapshot = { config: { jevEnabled: false, mode: options.mode ?? "select", providerProfileRegistryRef: "fixture:profiles", externalClassificationAllowed: false,
    configRevision: "config-1", timeoutMs: 2000 }, registry: { schemaVersion: "1.0.0", profileRevision: "profile-1", profiles: [profile] }, allowRemotePrivateContent: false };
  if (options.withJev) {
    runtime.config.jevEnabled = true;
    runtime.registry.profiles.unshift({ ...structuredClone(profile), profileId: "jev-mock", providerKind: "jev", vendorId: "typesafe",
      reasoningEffort: null, supportedOptions: { reasoningEfforts: [null], structuredOutput: true }, judgmentPolicy: { neededAt: 0.8, notNeededAt: 0.2 } });
  }
  for (const configuredProfile of runtime.registry.profiles) configuredProfile.qualification.profileConfigurationDigest = digestProviderProfileConfiguration(configuredProfile);
  const classify = vi.fn(async (request: SkillClassificationRequestV1): Promise<ProviderEvaluation> => ({ response: { schemaVersion: "1.0.0", requestId: request.requestId,
    operationId: request.operationId, requestDigest: request.requestDigest, inventoryDigest: request.inventoryDigest, status: options.uncertain?.length ? "PARTIAL" : "SUCCESS",
    judgments: request.skills.map(skill => ({ skillId: skill.skillId, judgment: options.uncertain?.includes(skill.skillId) ? "uncertain" : (options.needed ?? ["code-review"]).includes(skill.skillId) ? "needed" : "not-needed",
      reasonRefs: ["fixture:mock-source-role"], uncertaintyReason: options.uncertain?.includes(skill.skillId) ? "optional synthetic uncertainty" : null })),
    unresolvedItems: (options.uncertain ?? []).map(skillId => ({ skillId, reasonCode: "OPTIONAL_UNCERTAIN" })), error: null },
    usage: { inputTokens: null, outputTokens: null, cachedInputTokens: null, actualCostUsd: 0 }, dispatchState: "started", diagnostics: null }));
  const availability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevAvailability = vi.fn(async () => ({ available: true, approved: true, routeKind: "native" as const, reasonCode: null }));
  const jevClassify = vi.fn(classify);
  const service = new SkillClassificationService({ providers: { vendor: { availability, classify }, ...(options.withJev ? { jev: { availability: jevAvailability, classify: jevClassify } } : {}) },
    budget: new InMemoryClassificationBudget({ jev: { limitUsd: 0, spentUsd: 0 }, vendors: {}, nativeAllowances: {
      "vendor-mock": { approvalRef: "fixture:native-quota", remainingCalls: 100 }, "jev-mock": { approvalRef: "fixture:mock-jev-quota", remainingCalls: 100 } } }) });
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
  const attestation = options.attest === false ? null : new HostAttestationProvider(store, adapter);
  const workflow = new WorkflowService(new FileSkillRegistry(path.join(repository, "skills/registry.json"), validator), validator, store, null, attestation);
  const updateFetcher = vi.fn(async () => { throw new Error("NETWORK_FORBIDDEN_IN_MOCK_TEST"); });
  const updates = new PluginUpdateService(new InMemoryPluginUpdateStore(), { fetcher: updateFetcher });
  const server = createMcpServer(workflow, updates, undefined, undefined, undefined, validator, "default", attestation, null, undefined, null, gateway);
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
    const response = await client.callTool({ name, arguments: name === "classify_skills" && options.attest !== false ? sign(args, undefined, name, sessionId) : args });
    const text = response.content as { type: string; text?: string }[];
    const result = JSON.parse(text.find(x => x.type === "text")!.text!) as ApiResultV1<T>;
    if (!expectClassificationFailure && name === "classify_skills" && result.error === null && result.data && typeof result.data === "object" && "result" in result.data) {
      const advice = result.data as unknown as Advice;
      expect(advice.result.response.error).toBeNull();
      expect(["SUCCESS", "PARTIAL"]).toContain(advice.result.response.status);
    }
    return result;
  };
  return { call, sign, classify, client, gateway, runtime, inventory, taskStates, availability, jevAvailability, jevClassify, readRuntime, runtimeBytes, observeTask };
}

describe("offline classification through actual MCP Client/Server transport", () => {
  it.each(["availability", "classification"] as const)("joins only identical concurrent intake while %s is pending", async stage => {
    const h = await harness(), request = input("identical-flight"), entered = barrier(), release = barrier();
    if (stage === "availability") h.availability.mockImplementation(async () => { entered.open(); await release.promise; return { available: true, approved: true, routeKind: "native", reasonCode: null }; });
    else { const evaluate = h.classify.getMockImplementation()!; h.classify.mockImplementation(async req => { entered.open(); await release.promise; return evaluate(req); }); }
    const first = h.call<Advice>("classify_skills", request); await entered.promise;
    const second = h.call<Advice>("classify_skills", request);
    try { await vi.waitFor(() => expect(new Set(h.observeTask.mock.calls.flatMap(([, obs]) => obs ? [obs.observationId] : [])).size).toBe(2)); }
    finally { release.open(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.error).toBeNull(); expect(b.error).toBeNull(); expect(a.data).toEqual(b.data);
    expect(h.availability).toHaveBeenCalledTimes(1); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it.each((["availability", "classification"] as const).flatMap(stage => (["explicit", "rule", "actor", "vendor"] as const).map(change => ({ stage, change }))))("rejects overlapping $change intake during $stage without replacing the first obligations", async ({ stage, change }) => {
    const h = await harness(), request = { ...input("conflicting-flight"), explicitSkillIds: ["cs-engineering"] }, entered = barrier(), release = barrier();
    if (stage === "availability") h.availability.mockImplementation(async () => { entered.open(); await release.promise; return { available: true, approved: true, routeKind: "native", reasonCode: null }; });
    else { const evaluate = h.classify.getMockImplementation()!; h.classify.mockImplementation(async req => { entered.open(); await release.promise; return evaluate(req); }); }
    const first = h.call<Advice>("classify_skills", request); await entered.promise;
    const changed = { ...request, ...(change === "explicit" ? { explicitSkillIds: [] } : change === "rule" ? { ruleRequiredSkillIds: ["software-security-auditor"] } :
      change === "vendor" ? { vendorContext: { vendorId: "other-synthetic-vendor", reference: "fixture:other-vendor" } } : {}) };
    const second = h.call<Advice>("classify_skills", changed, false, change === "actor" ? "other-synthetic-session" : "synthetic-session");
    try { await vi.waitFor(() => expect(new Set(h.observeTask.mock.calls.flatMap(([, obs]) => obs ? [obs.observationId] : [])).size).toBe(2)); }
    finally { release.open(); }
    const [a, b] = await Promise.all([first, second]);
    expect(a.error).toBeNull();
    expect.soft(b.error?.code).toBe("INVALID_INPUT"); expect.soft(b.data).toBeNull();
    expect.soft(h.availability).toHaveBeenCalledTimes(1); expect.soft(h.classify).toHaveBeenCalledTimes(1);
    const accepted = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(a.data!, ["cs-engineering"], request) }));
    expect.soft(accepted.data?.valid).toBe(true); expect.soft(accepted.data?.decision?.explicitSkillIds).toEqual(["cs-engineering"]);
    expect.soft(accepted.data?.decision?.ruleRequiredSkillIds).toEqual([]);
  });
  it.each(["actor", "vendor"] as const)("rejects cached %s mismatch even with the same logical request", async change => {
    const h = await harness(), request = input("cached-identity"), first = (await h.call<Advice>("classify_skills", request)).data!;
    const changed = change === "vendor" ? { ...request, vendorContext: { vendorId: "other-synthetic-vendor", reference: "fixture:other-vendor" } } : request;
    const conflict = await h.call<Advice>("classify_skills", changed, false, change === "actor" ? "other-synthetic-session" : "synthetic-session");
    expect(conflict.error?.code).toBe("INVALID_INPUT"); expect(h.classify).toHaveBeenCalledTimes(1);
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(first, ["code-review"]) }))).data!.valid).toBe(true);
  });
  it("advertises the three tools and exposes healthy full inventory including non-registry roles", async () => {
    const h = await harness();
    expect((await h.client.listTools()).tools.map(x => x.name)).toEqual(expect.arrayContaining(["get_skill_inventory", "classify_skills", "record_skill_selection"]));
    const inventory = await h.call<SkillInventory>("get_skill_inventory", {});
    expect(inventory.error).toBeNull(); expect(inventory.data!.issues).toEqual([]);
    expect(inventory.data!.skills).toHaveLength(24);
    expect(inventory.data!.skills.map(x => x.skillId)).toEqual(expect.arrayContaining(["orchestrator", "context-continuity", "session-board"]));
    expect(h.classify).not.toHaveBeenCalled();
  });
  it("preserves original negation, provenance, null and known-empty at the real service boundary", async () => {
    const h = await harness(), request = input();
    const advice = await h.call<Advice>("classify_skills", request);
    expect(advice.error).toBeNull(); expect(advice.data!.agentSelectedSkillIds).toBeNull();
    expect(advice.data!.selectionStatus).toBe("PROPOSED"); expect(advice.data!.adviceApplied).toBe(false);
    expect(h.classify).toHaveBeenCalledTimes(1);
    const transmitted = h.classify.mock.calls[0]![0];
    expect(transmitted.originalPrompt).toBe(request.originalPrompt);
    expect(transmitted.confirmedContext).toEqual(request.confirmedContext);
    expect(transmitted.contextSources).toEqual(request.contextSources);
    expect(transmitted.skills).toHaveLength(24);
    expect(advice.data!.result.response.judgments).toHaveLength(24);
    expect(advice.data!.result.response.judgments.find(x => x.skillId === "code-review")!.judgment).toBe("needed");
  });
  it("requires signed exact-call host observation and never trusts a caller selection receipt", async () => {
    const h = await harness(), advice = (await h.call<Advice>("classify_skills", input())).data!;
    const args = { schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) };
    const missing = await h.call<Accepted>("record_skill_selection", args);
    expect(missing.data).toMatchObject({ valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null });
    const callerReceipt = { ...args, decision: { ...args.decision, hostReceipt: { receiptId: "caller-made", host: "codex", requestDigest: advice.result.request.requestDigest,
      inventoryDigest: advice.result.request.inventoryDigest, agentSelectedSkillIds: ["code-review"], acceptedAt: new Date().toISOString() } } };
    expect((await h.call<Accepted>("record_skill_selection", h.sign(callerReceipt))).error?.code).toBe("INVALID_INPUT");
    const accepted = (await h.call<Accepted>("record_skill_selection", h.sign(args))).data!;
    expect(accepted.valid).toBe(true); expect(accepted.decision!.agentSelectedSkillIds).toEqual(["code-review"]);
    expect(accepted.decision!.hostReceipt!.host).toBe("codex");
    expect(accepted).toMatchObject({ admissionStatus: "NOT_EVALUATED", readStatus: "NOT_OBSERVED", appliedStatus: "NOT_OBSERVED", verifiedStatus: "NOT_RUN" });
  });
  it("rejects changed-argument signatures and expired observations", async () => {
    const h = await harness(), advice = (await h.call<Advice>("classify_skills", input())).data!;
    const args = { schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) };
    const signed = h.sign(args);
    expect((await h.call<Accepted>("record_skill_selection", { ...signed, decision: decision(advice, []) })).error?.code).toBe("INVALID_INPUT");
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args, new Date("2000-01-01T00:00:00Z")))).error?.code).toBe("INVALID_INPUT");
    expect((await h.call<Accepted>("record_skill_selection", { ...signed, [HOST_ATTESTATION_FIELD]: `${signed[HOST_ATTESTATION_FIELD]}tampered` })).error?.code).toBe("INVALID_INPUT");
  });
  it("does not create selected status when host attestation is unavailable", async () => {
    const h = await harness({ attest: false }), advice = (await h.call<Advice>("classify_skills", input())).data!;
    const args = { schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) };
    const result = await h.call<Accepted>("record_skill_selection", args);
    expect(result.data).toMatchObject({ valid: false, errors: ["HOST_SELECTION_NOT_OBSERVED"], agentSelectedSkillIds: null });
    expect((await h.call<Accepted>("record_skill_selection", h.sign(args))).error?.code).toBe("INVALID_INPUT");
  });
  it("keeps AGENT choices independent of the same advice and handles accepted no-skill distinctly", async () => {
    const h = await harness({ needed: [] });
    const first = input("choice-a"), second = input("choice-b");
    const a = (await h.call<Advice>("classify_skills", first)).data!, b = (await h.call<Advice>("classify_skills", second)).data!;
    expect(a.result.response.judgments.map(x => x.judgment)).toEqual(b.result.response.judgments.map(x => x.judgment));
    const acceptedA = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: first.operationId, decision: decision(a, [], first) }));
    const acceptedB = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: second.operationId, decision: decision(b, ["code-review"], second) }));
    expect(acceptedA.data!.valid).toBe(true); expect(acceptedA.data!.decision!.agentSelectedSkillIds).toEqual([]);
    expect(acceptedB.data!.valid).toBe(true); expect(acceptedB.data!.decision!.agentSelectedSkillIds).toEqual(["code-review"]);
    const unresolved = input("null-selection"), unclear = (await h.call<Advice>("classify_skills", unresolved)).data!;
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: unresolved.operationId, decision: decision(unclear, null, unresolved) }))).error?.code).toBe("INVALID_INPUT");
  });
  it("rejects required omissions, treats repeated same decision idempotently and rejects replacement", async () => {
    const h = await harness(), request = { ...input(), explicitSkillIds: ["code-review"] };
    const advice = (await h.call<Advice>("classify_skills", request)).data!;
    const omitted = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, [], request) }));
    expect(omitted.data!.valid).toBe(false); expect(omitted.data!.errors).toContain("REQUIRED_SKILL_OMITTED:code-review");
    const args = { schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"], request) };
    const first = (await h.call<Accepted>("record_skill_selection", h.sign(args))).data!;
    const repeat = (await h.call<Accepted>("record_skill_selection", h.sign(args))).data!;
    expect(repeat.decision).toEqual(first.decision);
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ ...args, decision: { ...args.decision, selectionReasons: [{ skillId: "code-review", reason: "changed intent" }] } }))).error?.code).toBe("INVALID_INPUT");
  });
  it.each(["config", "profile"] as const)("rejects %s revision changes between classification and acceptance", async kind => {
    const h = await harness(), advice = (await h.call<Advice>("classify_skills", input())).data!;
    if (kind === "config") h.runtime.config.configRevision = "config-2"; else h.runtime.registry.profileRevision = "profile-2";
    const result = (await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) }))).data!;
    expect(result.valid).toBe(false); expect(result.errors).toContain(kind === "config" ? "STALE_configRevision" : "STALE_profileRevision");
    expect(result.agentSelectedSkillIds).toBeNull();
  });
  it("rejects runtime profile source changes even if revision strings are unchanged", async () => {
    const h = await harness(), advice = (await h.call<Advice>("classify_skills", input())).data!;
    h.runtime.registry.profiles[0]!.modelId = "changed-without-revision";
    const result = (await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) }))).data!;
    expect(result.valid).toBe(false); expect(result.errors).toContain("RUNTIME_SOURCE_CHANGED");
  });
  it("fences OFF changes during JEV availability before any old-snapshot provider dispatch", async () => {
    const h = await harness({ withJev: true });
    h.jevAvailability.mockImplementation(async () => {
      h.runtime.config.jevEnabled = false;
      return { available: true, approved: true, routeKind: "native", reasonCode: null };
    });
    const response = await h.call<Advice>("classify_skills", input(), true);
    expect(response.data!.result.response.error?.code).toBe("STALE_CLASSIFICATION");
    expect(response.data!.agentSelectedSkillIds).toBeNull();
    expect(h.jevAvailability).toHaveBeenCalledTimes(1);
    expect(h.jevClassify).not.toHaveBeenCalled(); expect(h.classify).not.toHaveBeenCalled();
    expect(h.availability).not.toHaveBeenCalled();
  });
  it("rejects changed runtime bytes during async read before availability or classification", async () => {
    const h = await harness();
    h.readRuntime.mockImplementation(async () => { h.runtimeBytes.additionalSource = "changed-during-read"; return h.runtime; });
    await expect(h.gateway.classify(input())).rejects.toThrow("RUNTIME_SNAPSHOT_CHANGED_DURING_READ");
    expect(h.availability).not.toHaveBeenCalled(); expect(h.classify).not.toHaveBeenCalled();
  });
  it("does not reuse a completed selected operation after model content changes without revision", async () => {
    const h = await harness(), request = input(), advice = (await h.call<Advice>("classify_skills", request)).data!;
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"]) }))).data!.valid).toBe(true);
    h.runtime.registry.profiles[0]!.modelId = "changed-without-revision";
    const response = await h.call<Advice>("classify_skills", request);
    expect(response.error?.code).toBe("INVALID_INPUT"); expect(response.data).toBeNull();
    expect(h.classify).toHaveBeenCalledTimes(1);
    const originalObservation = h.observeTask.mock.calls.find(([, observed]) => observed !== null)![1];
    await expect(h.gateway.classify(request, originalObservation)).rejects.toThrow("STALE_CLASSIFICATION_OPERATION");
  });
  it("does not reuse old selected after native route source bytes change with identical parsed runtime", async () => {
    const h = await harness(), request = input(), advice = (await h.call<Advice>("classify_skills", request)).data!;
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"]) }))).data!.valid).toBe(true);
    h.runtimeBytes.additionalSource = "fixture:route-source-v2";
    const response = await h.call<Advice>("classify_skills", request);
    expect(response.error?.code).toBe("INVALID_INPUT"); expect(response.data).toBeNull();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("rejects acceptance after native route source bytes changed even when parsed runtime matches", async () => {
    const h = await harness(), request = input(), advice = (await h.call<Advice>("classify_skills", request)).data!;
    h.runtimeBytes.additionalSource = "fixture:revoked-native-route-v2";
    const response = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"]) }));
    expect(response.data!.valid).toBe(false); expect(response.data!.errors).toContain("RUNTIME_SOURCE_CHANGED");
    expect(response.data!.agentSelectedSkillIds).toBeNull();
    expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("exposes configured discovery failure instead of claiming complete healthy host inventory", async () => {
    const h = await harness(); h.readRuntime.mockRejectedValue(new Error("synthetic config parse failure SECRET_SENTINEL"));
    const result = await h.call<SkillInventory>("get_skill_inventory", {});
    expect(result.data!.skills).toHaveLength(24);
    expect(result.data!.issues).toContainEqual({ skillId: null, code: "CONFIGURED_DISCOVERY_UNAVAILABLE", field: "classificationConfig" });
    expect(JSON.stringify(result)).not.toContain("SECRET_SENTINEL"); expect(h.classify).not.toHaveBeenCalled();
  });
  it("does not treat caller publicSynthetic=true as remote content approval", async () => {
    const h = await harness(), request = input(); h.runtime.config.externalClassificationAllowed = true;
    const blocked = await h.call<{ status: string; errors: string[]; agentSelectedSkillIds: null }>("classify_skills", request);
    expect(blocked.data).toMatchObject({ status: "NEEDS_INPUT", errors: ["REMOTE_CONTENT_NOT_APPROVED"], agentSelectedSkillIds: null });
    expect(h.classify).not.toHaveBeenCalled();
    const approved = { ...request, operationId: "approved-public", requestId: "approved-public-request" };
    h.runtime.approvedPublicRequestDigests = [publicRequestDigest(approved, h.inventory)];
    const allowed = await h.call<Advice>("classify_skills", approved);
    expect(allowed.data!.result.response.status).toBe("SUCCESS"); expect(h.classify).toHaveBeenCalledTimes(1);
  });
  it("does not approve changed confirmed context merely because the original prompt was approved", async () => {
    const h = await harness(), request = input("approved-context"); h.runtime.config.externalClassificationAllowed = true;
    h.runtime.approvedPublicRequestDigests = [publicRequestDigest(request, h.inventory)];
    for (const context of [{ ...request.confirmedContext, background: "synthetic changed context" },
      { ...request.confirmedContext, constraints: ["additional synthetic constraint"] }]) {
      const changed = { ...request, confirmedContext: context };
      expect(changed.originalPrompt).toBe(request.originalPrompt);
      expect(publicRequestDigest(changed, h.inventory)).not.toBe(h.runtime.approvedPublicRequestDigests[0]);
      const blocked = await h.call<{ status: string; errors: string[]; agentSelectedSkillIds: null }>("classify_skills", changed);
      expect(blocked.data).toMatchObject({ status: "NEEDS_INPUT", errors: ["REMOTE_CONTENT_NOT_APPROVED"], agentSelectedSkillIds: null });
    }
    expect(h.availability).not.toHaveBeenCalled(); expect(h.classify).not.toHaveBeenCalled();
  });
  it("does not approve changed inventory or source metadata despite an eligible fixed profile", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "ags-public-request-inventory-"));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    await cp(path.join(repository, "skills"), path.join(temp, "skills"), { recursive: true });
    const h = await harness({ root: temp }), request = input("approved-inventory"); h.runtime.config.externalClassificationAllowed = true;
    h.runtime.approvedPublicRequestDigests = [publicRequestDigest(request, h.inventory)];
    const file = path.join(temp, "skills/code-review/classification.json"), metadata = JSON.parse(await readFile(file, "utf8"));
    metadata.actions.push("synthetic-additional-inventory-action");
    await writeFile(file, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    const changed = await loadSkillInventory({ root: temp }); expect(changed.issues).toEqual([]);
    expect(changed.inventoryDigest).not.toBe(h.inventory.inventoryDigest);
    expect(publicRequestDigest(request, changed)).not.toBe(h.runtime.approvedPublicRequestDigests[0]);
    // Keep qualification valid so profile failure cannot accidentally substitute for the egress guard.
    h.runtime.registry.profiles[0]!.qualification.inventoryDigest = changed.inventoryDigest;
    requalifyMockProfile(h.runtime.registry.profiles[0]!, "inventory-egress-fixture-q2");
    expect(h.runtime.registry.profiles[0]!.qualification.status).toBe("PASS");
    const blocked = await h.call<{ status: string; errors: string[]; agentSelectedSkillIds: null }>("classify_skills", request);
    expect(blocked.data).toMatchObject({ status: "NEEDS_INPUT", errors: ["REMOTE_CONTENT_NOT_APPROVED"], agentSelectedSkillIds: null });
    expect(h.availability).not.toHaveBeenCalled(); expect(h.classify).not.toHaveBeenCalled();
  });
  it.each(["missing", "taskRevision", "requestDigest", "cancelled", "sourceRef"] as const)("rejects %s host task observations between classify and accept", async field => {
    const h = await harness({ taskObserved: field !== "missing" }), request = input();
    const advice = (await h.call<Advice>("classify_skills", request)).data!;
    if (field !== "missing") {
      const state = h.taskStates.get(request.requestId)!;
      if (field === "cancelled") state.cancelled = true;
      else if (field === "requestDigest") state.requestDigest = `sha256:${"d".repeat(64)}`;
      else if (field === "sourceRef") state.sourceRef = "fixture:new-task-source";
      else state.taskRevision = "new-task-revision";
    }
    const accepted = await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: decision(advice, ["code-review"]) }));
    expect(accepted.data).toMatchObject({ valid: false, errors: ["HOST_TASK_CHANGED_OR_NOT_OBSERVED"], agentSelectedSkillIds: null });
  });
  it("accepts settled independent PARTIAL work and enforces shadow adviceApplied=false", async () => {
    const h = await harness({ uncertain: ["orchestrator"] }), request = input();
    const advice = (await h.call<Advice>("classify_skills", request)).data!;
    const partial = { ...decision(advice, ["code-review"]), selectionStatus: "PARTIAL" as const };
    expect((await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: partial }))).data!.valid).toBe(true);
    const shadow = await harness({ mode: "shadow" }), a = (await shadow.call<Advice>("classify_skills", request)).data!;
    const d = decision(a, ["code-review"]);
    expect((await shadow.call<Accepted>("record_skill_selection", shadow.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: d }))).data!.errors).toContain("SHADOW_ADVICE_APPLIED");
    d.adviceApplied = false;
    expect((await shadow.call<Accepted>("record_skill_selection", shadow.sign({ schemaVersion: "1.0.0", operationId: request.operationId, decision: d }))).data!.valid).toBe(true);
  });
  it("rejects fresh-source inventory changes at acceptance without changing production files", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "ags-mcp-classification-"));
    cleanup.push(() => rm(temp, { recursive: true, force: true }));
    await cp(path.join(repository, "skills"), path.join(temp, "skills"), { recursive: true });
    const h = await harness({ root: temp }), advice = (await h.call<Advice>("classify_skills", input())).data!;
    const metadataPath = path.join(temp, "skills/code-review/classification.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    metadata.actions.push("synthetic-read-only-observation");
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
    const changed = await loadSkillInventory({ root: temp });
    expect(changed.issues).toEqual([]); expect(changed.inventoryDigest).not.toBe(advice.result.snapshot.inventoryDigest);
    expect(digestClassificationValue(advice.result.response)).toBe(advice.classificationResponseRef);
    const result = (await h.call<Accepted>("record_skill_selection", h.sign({ schemaVersion: "1.0.0", operationId: input().operationId, decision: decision(advice, ["code-review"]) }))).data!;
    expect(result.valid).toBe(false); expect(result.errors).toContain("STALE_inventoryDigest");
  });
});
